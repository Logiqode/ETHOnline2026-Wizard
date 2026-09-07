// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CampaignReward} from "./CampaignReward.sol";
import {CampaignRulesLib} from "./CampaignRulesLib.sol";

/// @title CampaignEscrow
/// @notice Per-campaign state & authorization contract for a B2B cross-brand campaign.
/// @dev Named "escrow" per the design spec; it does NOT custody assets in the demo.
///      Terms, UTXO-style ledger, and nullifier registry live here; the ERC-1155 assets
///      live in the paired CampaignReward. Mint/burn on that reward is authorized here.
///
///      SECURITY MODEL (read carefully):
///      - `claim()` is callable ONLY by the workflow-owner EOA configured at init.
///        That EOA is the address the Chainlink CRE `evm.write` capability uses to submit
///        the enclave's verdict. This contract CANNOT verify TEE attestation — attestation
///        is verified at the CRE workflow-DON level, not on-chain. If the workflow-owner
///        key is compromised, claims can be replayed/forged. This is the honest trust
///        boundary for the hackathon demo; a production contract would additionally
///        verify an on-chain report/author/forwarder (see cre-templates ReceiverTemplate).
///      - Defense-in-depth: the contract re-validates on-chain what it CAN check
///        (date window, per-user cap vs ledger, nullifier freshness) and re-computes
///        points from public terms + on-chain ledger. It CANNOT verify `amountSpent`
///        (only the enclave saw the POS payload) — that truthfulness is the enclave's job.
///
///      UTXO MODEL:
///      - `unspentBalance` = currently spendable reward (ERC-1155 balance mirrors this)
///      - `totalBalance`    = lifetime earned; never shrinks (lineage for M&A provenance)
///      - Earn (claim)   : unspentBalance += points; totalBalance += points; mint tokens
///      - Spend (redeem) : unspentBalance -= amount (totalBalance untouched); burn tokens
///      Spent (history) is derivable as totalBalance - unspentBalance, but the lineage
///      number itself (totalBalance) is preserved forever.
///
///      REWARD MECHANICS (rules.redeemable / rules.flatEnabled):
///      - Cashback (redeemable = true): percent (rateBps% of spend) or flat
///        (rules.flatValue per purchase) — full UTXO ledger, spendable at a POS.
///      - Discount (redeemable = false): proof-of-savings. points = dollars saved;
///        totalBalance accumulates as the user's totalSaved counter, unspentBalance
///        stays 0, nothing is minted, nothing is redeemable at any POS.
contract CampaignEscrow {
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error CampaignEscrow__NotInitialized();
    error CampaignEscrow__AlreadyInitialized();
    error CampaignEscrow__InvalidWorkflowOwner();
    error CampaignEscrow__OnlyWorkflowOwner(address caller, address owner);
    error CampaignEscrow__InvalidForwarder();
    error CampaignEscrow__ReportNotEligible();
    error CampaignEscrow__InvalidReport();
    error CampaignEscrow__CampaignNotLive(uint256 timestamp, uint256 start, uint256 end);
    error CampaignEscrow__CampaignEnded(uint256 timestamp, uint256 end);
    error CampaignEscrow__NullifierAlreadyUsed(bytes32 nullifier);
    error CampaignEscrow__ZeroPoints();
    error CampaignEscrow__InsufficientBalance(uint256 balance, uint256 amount);
    error CampaignEscrow__OnlyOwner(address caller, address owner);
    error CampaignEscrow__OnlyRedeemer(address caller);
    error CampaignEscrow__InvalidRedeemTarget(address user);
    error CampaignEscrow__TooManyDecimals(uint256 value);

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Claim(bytes32 indexed nullifier, address indexed recipient, uint256 points, uint256 amountSpent);
    event Redeem(address indexed recipient, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                              TYPES / STORAGE
    //////////////////////////////////////////////////////////////*/

    struct CampaignTerms {
        uint256 rateBps;                  // cashback rate in basis points, e.g. 1000 = 10%
        uint64 start;                     // campaign start (unix)
        uint64 end;                       // campaign end (unix)
        address reward;                   // paired CampaignReward (ERC-1155)
        uint256 rewardTokenId;
        CampaignRulesLib.Rules rules;     // toggleable eligibility gates (see CampaignRulesLib)
        uint256 platformFeeBps;           // per-transaction platform fee uplift, e.g. 1000 = 10%
        address platformFeeAccount;       // where the platform fee accrues
    }

    struct CampaignProof {
        uint256 totalBalance;    // lifetime earned (lineage — never shrinks)
        uint256 unspentBalance;  // currently spendable (shrinks on redemption)
        uint256 originalBlock;   // first participation block (provenance)
    }

    /// @notice Reset guard — every setting is stuck at its initial value after initialize().
    bool private initialized_;
    CampaignTerms public terms;

    /// @notice UTXO-style ledger: tokenId => wallet => proof.
    mapping(uint256 => mapping(address => CampaignProof)) public campaignLedger;

    /// @notice Anti-double-claim registry of used nullifiers (CRE enclave computes them).
    mapping(bytes32 => bool) public usedNullifiers;

    /// @notice The dedicated EOA that CRE `evm.write` submits verdicts from.
    address public workflowOwner;

    /// @notice The CRE *registry* owner the forwarder stamps into report
    ///         metadata (the EOA that deployed the workflow). Checked by
    ///         onReport; handover-able via setReportOwner().
    address public reportOwner;

    /// @notice The CRE Forwarder trusted to deliver DON reports (Base Sepolia
    ///         production forwarder). Set at initialize; address(0) disables
    ///         the onReport path entirely (EOA-claim-only deployments).
    address public forwarder;

    /// @notice Admin who can manage redeemers. Set to the initializer (the factory).
    address public owner;

    /// @notice Whitelist of Company B (merchant) wallets allowed to redeem on
    ///         behalf of users. Only they can trigger a redemption.
    mapping(address => bool) public authorizedRedeemers;

    /// @notice Cumulative platform fee accrued (mock-denominated reward units).
    ///         In the demo the escrow doesn't custody ETH — this tracks the per-tx
    ///         platform-fee uplift (platformFeeBps of each claim/redeem) so the
    ///         operating-fund model is testable without real settlement.
    uint256 public platformFeesAccrued;

    /*//////////////////////////////////////////////////////////////
                              INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /// @param terms_ Campaign terms (all public; agreed by both brands at launch).
    /// @param workflowOwner_ The CRE workflow-owner EOA (dedicated claim submitter).
    /// @param forwarder_ The CRE Forwarder allowed to deliver DON reports
    ///        (Base Sepolia: 0xF8344CFd5c43616a4366C34E3EEE75af79a74482).
    ///        May be address(0) to disable the onReport path (EOA claims only).
    /// @param reportOwner_ The CRE *registry* owner the forwarder stamps into
    ///        report metadata (the EOA that deployed the workflow). Falls back
    ///        to workflowOwner_ when zero (single-key deployments).
    function initialize(CampaignTerms calldata terms_, address workflowOwner_, address forwarder_, address reportOwner_)
        external
    {
        if (initialized_) revert CampaignEscrow__AlreadyInitialized();
        initialized_ = true;
        if (workflowOwner_ == address(0)) revert CampaignEscrow__InvalidWorkflowOwner();
        if (terms_.rateBps == 0 && !terms_.rules.flatEnabled) revert CampaignEscrow__ZeroPoints();
        // Flat mechanic: the per-purchase value must be positive and 2-decimal clean.
        if (terms_.rules.flatEnabled) {
            if (terms_.rules.flatValue == 0) revert CampaignEscrow__ZeroPoints();
            _requireAtMost2Decimals(terms_.rules.flatValue);
        }
        // Only validate the per-user cap's granularity when the cap rule is actually on.
        // (When cap is disabled, `cap=0` is the natural "no cap" value and is valid.)
        if (terms_.rules.capEnabled) _requireAtMost2Decimals(terms_.rules.cap);
        owner = msg.sender; // the factory (which cloned + initialized us)
        terms = terms_;
        workflowOwner = workflowOwner_;
        forwarder = forwarder_;
        reportOwner = reportOwner_ == address(0) ? workflowOwner_ : reportOwner_;
    }

    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Owner-only: grant/revoke Company B's right to redeem on behalf of users.
    function setRedeemer(address wallet, bool allowed) external {
        _onlyOwner();
        authorizedRedeemers[wallet] = allowed;
    }

    /// @notice Hand over report-identity acceptance to a new CRE registry owner
    ///         (e.g. after redeploying the workflow under a new owner EOA).
    ///         Only the current workflowOwner (or the escrow admin) may call.
    function setReportOwner(address newReportOwner) external {
        if (msg.sender != workflowOwner && msg.sender != owner) {
            revert CampaignEscrow__OnlyWorkflowOwner(msg.sender, workflowOwner);
        }
        if (newReportOwner == address(0)) revert CampaignEscrow__InvalidWorkflowOwner();
        reportOwner = newReportOwner;
    }

    /*//////////////////////////////////////////////////////////////
                        ERC-165 (CRE Forwarder handshake)
    //////////////////////////////////////////////////////////////*/

    /// @notice The Keystone CRE Forwarder probes ERC-165 before delivering a
    ///         report: the receiver must advertise IReceiver and IERC165.
    ///         IReceiver inherits IERC165, so type(IReceiver).interfaceId is
    ///         just the onReport(bytes,bytes) selector 0x805f2132 (inherited
    ///         functions are excluded from interfaceId computation).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x805f2132 // IReceiver: onReport(bytes,bytes)
            || interfaceId == 0x01ffc9a7; // IERC165
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIM  (CRE write)
    //////////////////////////////////////////////////////////////*/

    /// @notice Record a confidential eligibility verdict from the CRE enclave.
    /// @param nullifier H(CAMPAIGN_SECRET || recipient || campaignId), enclave-computed.
    /// @param recipient The claimant's Privy embedded-wallet address (identity anchor).
    /// @param amountSpent The POS payload amount (USD, 18-decimals); ONLY the enclave
    ///                    verified it — on-chain truthfulness is the enclave's trust.
    /// @return points Reward units minted (re-computed on-chain from public terms).
    function claim(bytes32 nullifier, address recipient, uint256 amountSpent)
        external
        returns (uint256 points)
    {
        _onlyWorkflowOwner();
        points = _claimInternal(nullifier, recipient, amountSpent);
    }

    /*//////////////////////////////////////////////////////////////
                        CRE REPORT PATH  (IReceiver)
    //////////////////////////////////////////////////////////////*/

    /// @notice Receive a DON-consensus report from the CRE Forwarder and execute
    ///         the claim it carries. This is the production write path: the
    ///         Workflow DON signs the verdict; only the trusted forwarder may
    ///         deliver it; workflow identity is pinned in the metadata.
    /// @dev Report payload: abi.encode(bytes32 nullifier, address recipient,
    ///      uint256 amountSpentWei, bool eligible, uint256 pointsWei).
    ///      Metadata (encodePacked by the forwarder): workflowId(32) ||
    ///      workflowName(10) || workflowOwner(20).
    /// @param metadata Report metadata (workflow identity).
    /// @param report The enclave's signed verdict payload.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (forwarder == address(0) || msg.sender != forwarder) revert CampaignEscrow__InvalidForwarder();

        // Workflow identity check: the forwarder stamps the CRE *registry* owner
        // (the EOA that deployed the workflow) into the metadata — that address
        // generally differs from `workflowOwner` (the EOA submitter for the
        // claim() path). `reportOwner` is set at init and may be handed over
        // by the workflowOwner via setReportOwner().
        address reportWorkflowOwner = _extractWorkflowOwner(metadata);
        if (reportWorkflowOwner != reportOwner) revert CampaignEscrow__OnlyWorkflowOwner(reportWorkflowOwner, reportOwner);

        if (report.length != 160) revert CampaignEscrow__InvalidReport(); // 4 x 32 + address padding
        (bytes32 nullifier, address recipient, uint256 amountSpentWei, bool eligible, uint256 pointsWei) =
            abi.decode(report, (bytes32, address, uint256, bool, uint256));
        if (!eligible) revert CampaignEscrow__ReportNotEligible();

        // Points re-verified on-chain from public terms + ledger (defense-in-depth):
        // the delivered pointsWei must match what the rules library computes for
        // (amountSpent, recipient's already-earned). The enclave cannot over-mint.
        uint256 expected = this.computePointsPreview(amountSpentWei, _totalEarned(recipient));
        if (pointsWei != expected) revert CampaignEscrow__InvalidReport();

        _claimInternalWithPoints(nullifier, recipient, amountSpentWei, pointsWei);
    }

    /// @dev Extract the workflow-owner address from forwarder metadata:
    ///      workflowId(32) || workflowName(10) || workflowOwner(20).
    function _extractWorkflowOwner(bytes calldata metadata) internal pure returns (address) {
        if (metadata.length < 62) revert CampaignEscrow__InvalidReport();
        return address(bytes20(metadata[42:62]));
    }

    /// @dev Points are computed by CampaignRulesLib (capped only if the cap rule is on).
    ///      Keep this view for off-chain reads of a raw claim.
    function computePointsPreview(uint256 amountSpent, uint256 alreadyEarned) external view returns (uint256) {
        return CampaignRulesLib.computePoints(terms.rules, terms.rateBps, amountSpent, alreadyEarned);
    }

    /*//////////////////////////////////////////////////////////////
                        REDEEM  (Company B, merchant-only)
    //////////////////////////////////////////////////////////////*/

    /// @notice Spend a user's earned rewards. Callable ONLY by an authorized Company B
    ///         (merchant) wallet — the user redeems inside Company B's portal/app, and
    ///         Company B's backend drives this on their behalf. Burns tokens as "spend";
    ///         the ledger's `totalBalance` preserves lifetime lineage.
    /// @param user The customer whose rewards are spent.
    /// @param amount Reward units to spend.
    function redeemFor(address user, uint256 amount) external {
        _onlyRedeemer();
        _requireLive();
        _requireAtMost2Decimals(amount); // $3.125-style inputs rejected
        if (user == address(0)) revert CampaignEscrow__InvalidRedeemTarget(address(0));

        CampaignProof storage proof = campaignLedger[terms.rewardTokenId][user];
        if (proof.unspentBalance < amount) {
            revert CampaignEscrow__InsufficientBalance(proof.unspentBalance, amount);
        }
        proof.unspentBalance -= amount; // totalBalance untouched (lineage preserved)

        _accruePlatformFee(amount);
        emit Redeem(user, amount);
        CampaignReward(terms.reward).burn(user, terms.rewardTokenId, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Lifetime earned for a wallet (lineage-preserving, never shrinks).
    function lifetimeEarned(address wallet) external view returns (uint256) {
        return campaignLedger[terms.rewardTokenId][wallet].totalBalance;
    }

    /// @notice Currently spendable balance for a wallet.
    function availableBalance(address wallet) external view returns (uint256) {
        return campaignLedger[terms.rewardTokenId][wallet].unspentBalance;
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _onlyWorkflowOwner() internal view {
        if (msg.sender != workflowOwner) revert CampaignEscrow__OnlyWorkflowOwner(msg.sender, workflowOwner);
    }

    /// @dev Shared claim core for both paths (EOA `claim` + CRE `onReport`).
    function _claimInternal(bytes32 nullifier, address recipient, uint256 amountSpent) internal returns (uint256 points) {
        _requireLive();
        _requireAtMost2Decimals(amountSpent); // $3.125-style inputs rejected

        // Rule gates — each only fires if its flag is set. Window check above runs first,
        // so day-of-week can never override the campaign's [start, end] boundaries.
        CampaignRulesLib.requireAllowedDay(terms.rules, block.timestamp);

        if (usedNullifiers[nullifier]) revert CampaignEscrow__NullifierAlreadyUsed(nullifier);

        CampaignProof storage proof = campaignLedger[terms.rewardTokenId][recipient];
        if (proof.originalBlock == 0) proof.originalBlock = block.number;

        uint256 alreadyEarned = proof.totalBalance;
        // min-spend gate (reverts if under), then points (capped only if capEnabled).
        CampaignRulesLib.enforceMinSpend(terms.rules, amountSpent);
        points = CampaignRulesLib.computePoints(terms.rules, terms.rateBps, amountSpent, alreadyEarned);

        _applyEarn(proof, nullifier, recipient, amountSpent, points);
    }

    /// @dev onReport variant: points were already computed by the enclave AND
    ///      re-verified on-chain against computePointsPreview — apply as-is.
    function _claimInternalWithPoints(bytes32 nullifier, address recipient, uint256 amountSpent, uint256 points) internal {
        _requireLive();
        _requireAtMost2Decimals(amountSpent);

        // Rule gates (same order as the EOA path): window first, then day, then
        // min-spend — the report being DON-signed does not waive campaign rules.
        CampaignRulesLib.requireAllowedDay(terms.rules, block.timestamp);
        CampaignRulesLib.enforceMinSpend(terms.rules, amountSpent);
        if (usedNullifiers[nullifier]) revert CampaignEscrow__NullifierAlreadyUsed(nullifier);

        CampaignProof storage proof = campaignLedger[terms.rewardTokenId][recipient];
        if (proof.originalBlock == 0) proof.originalBlock = block.number;

        _applyEarn(proof, nullifier, recipient, amountSpent, points);
    }

    function _applyEarn(
        CampaignProof storage proof,
        bytes32 nullifier,
        address recipient,
        uint256 amountSpent,
        uint256 points
    ) internal {
        // totalBalance always accumulates — for discount campaigns it IS the
        // product: a proof-of-savings counter (totalSaved), never spendable.
        proof.totalBalance += points;

        // Redeemable (cashback) campaigns grow the spendable balance and mint
        // ERC-1155. Discount campaigns (redeemable = false) stop here: unspent
        // stays 0 forever, so any redeemFor reverts InsufficientBalance — there
        // is nothing to spend at a POS.
        if (terms.rules.redeemable) {
            proof.unspentBalance += points;
            _accruePlatformFee(points);
            CampaignReward(terms.reward).mint(recipient, terms.rewardTokenId, points);
        }

        usedNullifiers[nullifier] = true;
        emit Claim(nullifier, recipient, points, amountSpent);
    }

    /// @dev Recipient's lifetime earned (for onReport's points re-verification).
    function _totalEarned(address wallet) internal view returns (uint256) {
        return campaignLedger[terms.rewardTokenId][wallet].totalBalance;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert CampaignEscrow__OnlyOwner(msg.sender, owner);
    }

    function _requireLive() internal view {
        uint256 ts = block.timestamp;
        if (ts < terms.start) revert CampaignEscrow__CampaignNotLive(ts, terms.start, terms.end);
        if (ts > terms.end) revert CampaignEscrow__CampaignEnded(ts, terms.end);
    }

    function _onlyRedeemer() internal view {
        if (!authorizedRedeemers[msg.sender]) revert CampaignEscrow__OnlyRedeemer(msg.sender);
    }

    /// @dev Accrue the per-transaction platform fee (platformFeeBps of `amount`) to the
    ///      platform's running total. In the demo this is a mock-denominated counter, not
    ///      an ETH transfer — the operating-fund settlement is deferred.
    function _accruePlatformFee(uint256 amount) internal {
        if (terms.platformFeeBps == 0) return;
        platformFeesAccrued += (amount * terms.platformFeeBps) / 10_000;
    }

    /// @dev Reject values with more than 2 decimals (i.e. finer than a cent).
    ///      1 cent = 1e16 wei-style units; anything below that granularity would
    ///      round/accumulate inconsistently. The workflow should ALSO validate this —
    ///      this is input hygiene at the contract boundary, not a security gate.
    function _requireAtMost2Decimals(uint256 value) internal pure {
        if (value % 1e16 != 0) revert CampaignEscrow__TooManyDecimals(value);
    }
}