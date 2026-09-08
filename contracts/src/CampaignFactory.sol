// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CampaignEscrow} from "./CampaignEscrow.sol";
import {CampaignReward} from "./CampaignReward.sol";

/// @title CampaignFactory
/// @notice Master factory for Wizard — deploys configured campaign clones.
/// @dev Each campaign = one EIP-1167 clone of the CampaignEscrow implementation + one
///      CampaignReward (ERC-1155) deployed in the same transaction (isolated mint authority).
///      The escrow is deployed via CREATE2 with a caller-supplied salt so its address is
///      deterministic (predictable before launch). Deployment is funded by a launch-time
///      operating deposit (`msg.value`), split per a fee-split parameter between the two
///      brands' fee accounts.
contract CampaignFactory {
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error CampaignFactory__InvalidTokenId(uint256 tokenId);
    error CampaignFactory__InvalidUri();
    error CampaignFactory__InvalidFeeSplit(uint256 bps);
    error CampaignFactory__InvalidFeeAccount(address account);
    error CampaignFactory__DepositRequired(uint256 required, uint256 received);
    error CampaignFactory__InvalidSalt();
    error CampaignFactory__InvalidCampaign(uint256 campaignId);

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event CampaignCreated(uint256 indexed campaignId, address indexed escrow, address indexed reward);
    event CampaignRedeemerSet(uint256 indexed campaignId, address indexed wallet, bool allowed);
    event OperatingDeposit(
        uint256 indexed campaignId,
        uint256 total,
        address companyA,
        address companyB,
        uint256 companyAShare,
        uint256 companyBShare,
        uint256 feeSplitBps
    );

    /*//////////////////////////////////////////////////////////////
                              TYPES / STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Escrow logic implementation (clones delegate to it).
    address public immutable escrowImplementation;

    struct CampaignInfo {
        address escrow;
        address reward;
        uint256 rewardTokenId;
        uint64 start;
        uint64 end;
    }

    /// @notice campaignId => campaign info.
    mapping(uint256 => CampaignInfo) public campaigns;

    uint256 public nextCampaignId = 1; // tokenId 0 reserved; first campaign gets id 1

    /// @notice Per-campaign reward tokenId range — each campaign gets its own id.
    uint256 public constant REWARD_TOKEN_RANGE = 1_000_000;

    /// @notice Launch-time operating deposit each company owes the platform
    ///         reserves (18-decimals). A owes feeSplitBps% of this, B the rest.
    ///         Demo: recorded via the OperatingDeposit event, settled off-chain;
    ///         the platform wallet (not the companies) pays campaign gas.
    uint256 public constant MIN_OPERATING_DEPOSIT = 0.01 ether;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param escrowImplementation_ The CampaignEscrow logic implementation address.
    constructor(address escrowImplementation_) {
        escrowImplementation = escrowImplementation_;
    }

    /*//////////////////////////////////////////////////////////////
                            CAMPAIGN CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a new campaign: escrow clone + paired reward contract.
    /// @param terms_ Campaign terms (rateBps + rules, start, end).
    /// @param workflowOwner_ CRE workflow-owner EOA that will submit claims.
    /// @param reportOwner_ CRE *registry* owner the forwarder stamps into report
    ///        metadata (the EOA that deployed the workflow); zero = use workflowOwner_.
    /// @param rewardUri_ ERC-1155 metadata URI template (e.g. ".../{id}.json").
    /// @param salt_ CREATE2 salt for deterministic escrow address (e.g. hash of campaignId).
    /// @param companyA_ Company A (POS) fee recipient.
    /// @param companyB_ Company B (reward) fee recipient.
    /// @param feeSplitBps_ Company A's share of the operating deposit, in basis points
    ///        (0-10000); the remainder goes to Company B. e.g. 2500 = 25% A / 75% B.
    /// @return campaignId Incrementing id. The escrow's rewardTokenId = campaignId * REWARD_TOKEN_RANGE.
    function createCampaign(
        CampaignEscrow.CampaignTerms calldata terms_,
        address workflowOwner_,
        address reportOwner_,
        string calldata rewardUri_,
        bytes32 salt_,
        address companyA_,
        address companyB_,
        uint256 feeSplitBps_
    ) external returns (uint256 campaignId) {
        if (bytes(rewardUri_).length == 0) revert CampaignFactory__InvalidUri();
        if (feeSplitBps_ > 10_000) revert CampaignFactory__InvalidFeeSplit(feeSplitBps_);
        if (companyA_ == address(0) || companyB_ == address(0)) revert CampaignFactory__InvalidFeeAccount(companyA_ == address(0) ? companyA_ : companyB_);

        campaignId = nextCampaignId++;
        uint256 tokenId = campaignId * REWARD_TOKEN_RANGE; // tokenId 0 reserved
        if (tokenId == 0) revert CampaignFactory__InvalidTokenId(tokenId);

        // Deterministic escrow address via CREATE2 (predictable before launch).
        address escrow = Clones.cloneDeterministic(escrowImplementation, salt_);

        // Deploy the paired reward contract, then wire the escrow's terms to it.
        CampaignReward reward = new CampaignReward(escrow, rewardUri_);
        CampaignEscrow.CampaignTerms memory termsWithReward = terms_;
        termsWithReward.reward = address(reward);
        termsWithReward.rewardTokenId = tokenId;
        _initEscrow(escrow, termsWithReward, workflowOwner_, reportOwner_);

        campaigns[campaignId] = CampaignInfo({
            escrow: escrow,
            reward: address(reward),
            rewardTokenId: tokenId,
            start: terms_.start,
            end: terms_.end
        });

        // Record the operating deposit each company OWES the platform reserves
        // (feeSplitBps% to A, the complement to B). No ETH moves at launch —
        // the platform wallet pays campaign gas; deposits are settled off-chain.
        _recordDeposit(campaignId, companyA_, companyB_, feeSplitBps_);

        emit CampaignCreated(campaignId, escrow, address(reward));
    }

    /// @notice Predict the escrow address a campaign would get for a given salt.
    function predictEscrowAddress(bytes32 salt_) external view returns (address) {
        return Clones.predictDeterministicAddress(escrowImplementation, salt_);
    }

    /// @notice Factory-admin passthrough: grant/revoke a redeemer on a campaign's
    ///         escrow. The escrow's `owner` IS this factory, and clones are
    ///         immutable — without this passthrough the escrow's
    ///         `authorizedRedeemers` whitelist is dead code (gen-5 lesson: every
    ///         redeem on deployed escrows reverted OnlyRedeemer forever). The
    ///         demo platform (deployer) uses it to authorize the relay wallet
    ///         post-launch; production would route it through per-company policy.
    function setCampaignRedeemer(uint256 campaignId, address wallet, bool allowed) external {
        CampaignInfo memory info = campaigns[campaignId];
        if (info.escrow == address(0)) revert CampaignFactory__InvalidCampaign(campaignId);
        CampaignEscrow(info.escrow).setRedeemer(wallet, allowed);
        emit CampaignRedeemerSet(campaignId, wallet, allowed);
    }

    /// @dev Base Sepolia CRE production forwarder — the only caller allowed to
    ///      deliver DON reports to the escrow's onReport path. Helper keeps the
    ///      createCampaign stack shallow (the reportOwner param tipped it over).
    function _initEscrow(
        address escrow,
        CampaignEscrow.CampaignTerms memory terms_,
        address workflowOwner_,
        address reportOwner_
    ) internal {
        CampaignEscrow(escrow).initialize(terms_, workflowOwner_, 0xF8344CFd5c43616a4366C34E3EEE75af79a74482, reportOwner_);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    /// @dev Record the operating deposit owed BY each company TO the platform
    /// reserves: feeSplitBps% of MIN_OPERATING_DEPOSIT by A, complement by B.
    /// Demo semantics — no ETH transfer happens; the platform wallet funds gas.
    function _recordDeposit(
        uint256 campaignId,
        address companyA,
        address companyB,
        uint256 feeSplitBps
    ) internal {
        uint256 total = MIN_OPERATING_DEPOSIT;
        uint256 companyAOwes = (total * feeSplitBps) / 10_000;
        uint256 companyBOwes = total - companyAOwes;
        emit OperatingDeposit(campaignId, total, companyA, companyB, companyAOwes, companyBOwes, feeSplitBps);
    }
}