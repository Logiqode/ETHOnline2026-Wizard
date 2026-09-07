// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {CampaignEscrow} from "../src/CampaignEscrow.sol";
import {CampaignReward} from "../src/CampaignReward.sol";
import {CampaignRulesLib} from "../src/CampaignRulesLib.sol";

/// @title CampaignWorkflow — integration tests for factory → escrow → reward
contract CampaignWorkflowTest is Test {
    CampaignFactory public factory;
    CampaignEscrow public escrowImpl;

    address public workflowOwner = address(0xBEEF);
    address public brandA = address(0xA11CE);
    address public brandB = address(0xB0B);
    address public customer = address(0xC0FFEE);
    address public attacker = address(0xBAD);

    uint256 public campaignId;
    address public escrowAddr;
    address public rewardAddr;
    uint256 public rewardTokenId;

    // Demo numbers: $12 spend → 1.20 Bpoints at 10% cashback, cap $20/user
    uint256 public constant RATE_BPS = 1000;   // 10%
    uint256 public constant MIN_SPEND = 10e18; // $10
    uint256 public constant CAP = 20e18;       // $20

    // Fee / deposit fixtures
    address public constant COMPANY_A = address(0xA11CE);
    address public constant COMPANY_B = address(0xB0B);
    uint256 public constant FEE_SPLIT_BPS = 2500; // 25% A / 75% B
    uint256 public constant PLATFORM_FEE_BPS = 1000; // 10%
    address public constant PLATFORM_FEE_ACCOUNT = address(0xFEE);

    function _terms(uint64 start, uint64 end) internal pure returns (CampaignEscrow.CampaignTerms memory) {
        return CampaignEscrow.CampaignTerms({
            rateBps: RATE_BPS,
            start: start,
            end: end,
            reward: address(0), // set by factory
            rewardTokenId: 0,   // set by factory
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: true,
                minSpend: MIN_SPEND,
                capEnabled: true,
                cap: CAP,
                dayOfWeekEnabled: false,
                daysOfWeek: 0,
                flatEnabled: false,
                flatValue: 0,
                redeemable: true,
                perTxCapEnabled: false,
                perTxCap: 0
            }),
            platformFeeBps: PLATFORM_FEE_BPS,
            platformFeeAccount: PLATFORM_FEE_ACCOUNT
        });
    }

    // Convenience wrapper for the new createCampaign signature (non-payable, fee split, salt).
    function _createCampaign(
        CampaignEscrow.CampaignTerms memory terms,
        address workflowOwner_,
        string memory rewardUri,
        bytes32 salt
    ) internal returns (uint256 id) {
        id = factory.createCampaign(
            terms,
            workflowOwner_,
            address(0), // reportOwner defaults to workflowOwner_
            rewardUri,
            salt,
            COMPANY_A,
            COMPANY_B,
            FEE_SPLIT_BPS
        );
    }

    function setUp() public {
        vm.warp(1_700_000_000); // realistic wall-clock (2023-11-14), avoids uint64 underflow
        // Deploy escrow implementation + factory
        escrowImpl = new CampaignEscrow();
        factory = new CampaignFactory(address(escrowImpl));

        // Create a campaign: terms + workflowOwner + reward URI
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        campaignId = _createCampaign(_terms(start, end), workflowOwner, "https://example.com/metadata/{id}.json", keccak256("salt-1"));
        (escrowAddr, rewardAddr, rewardTokenId, , ) = factory.campaigns(campaignId);
    }

    /*//////////////////////////////////////////////////////////////
                              FACTORY
    //////////////////////////////////////////////////////////////*/

    function test_FactoryDeploysCloneAndReward() public view {
        assertTrue(escrowAddr != address(0), "escrow deployed");
        assertTrue(rewardAddr != address(0), "reward deployed");
        assertEq(CampaignEscrow(escrowAddr).workflowOwner(), workflowOwner, "workflowOwner wired");
        (uint256 rateBps_, , , address reward_, uint256 tokenId_, CampaignRulesLib.Rules memory rules_, uint256 pfBps_, address pfAccount_) =
            CampaignEscrow(escrowAddr).terms();
        assertEq(rateBps_, RATE_BPS, "terms rate wired");
        assertEq(rules_.minSpend, MIN_SPEND, "terms minSpend wired");
        assertTrue(rules_.minSpendEnabled, "minSpend rule enabled");
        assertEq(rules_.cap, CAP, "terms cap wired");
        assertTrue(rules_.capEnabled, "cap rule enabled");
        assertEq(reward_, rewardAddr, "terms reward wired");
        assertEq(tokenId_, rewardTokenId, "terms tokenId wired");
        assertEq(pfBps_, PLATFORM_FEE_BPS, "platform fee bps wired");
        assertEq(pfAccount_, PLATFORM_FEE_ACCOUNT, "platform fee account wired");
        assertEq(rewardTokenId, factory.REWARD_TOKEN_RANGE(), "first campaign tokenId = 1 * RANGE");
    }

    function test_FactoryMultipleCampaignsIsolateState() public {
        uint64 start = uint64(block.timestamp - 1 hours);
        uint64 end = uint64(block.timestamp + 30 days);
        uint256 id2 = _createCampaign(_terms(start, end), workflowOwner, "https://example.com/metadata/{id}.json", keccak256("salt-2"));
        (address escrow2, address reward2, uint256 tokenId2, , ) = factory.campaigns(id2);

        assertTrue(escrowAddr != escrow2, "distinct escrow clones");
        assertTrue(rewardAddr != reward2, "distinct reward contracts");
        assertEq(tokenId2, id2 * factory.REWARD_TOKEN_RANGE(), "tokenId range per campaign");
    }

    /*//////////////////////////////////////////////////////////////
                               REWARD GATING
    //////////////////////////////////////////////////////////////*/

    function test_RewardMintOnlyEscrow() public {
        vm.prank(workflowOwner);
        vm.expectRevert(); // attacker not escrow
        CampaignReward(rewardAddr).mint(attacker, rewardTokenId, 1e18);
    }

    function test_RewardBurnOnlyEscrow() public {
        vm.prank(customer);
        vm.expectRevert(); // attacker not escrow
        CampaignReward(rewardAddr).burn(customer, rewardTokenId, 1e18);
    }

    /*//////////////////////////////////////////////////////////////
                              CLAIM (CRE write)
    //////////////////////////////////////////////////////////////*/

    function test_ClaimMintsPoints() public {
        bytes32 nf = keccak256("nullifier-1");
        vm.prank(workflowOwner);
        uint256 points = CampaignEscrow(escrowAddr).claim(nf, customer, 12e18);

        assertEq(points, 1.2e18, "10% of $12 = 1.20");
        assertEq(CampaignReward(rewardAddr).balanceOf(customer, rewardTokenId), 1.2e18, "tokens minted");
        assertEq(CampaignEscrow(escrowAddr).availableBalance(customer), 1.2e18, "ledger balance");
        assertEq(CampaignEscrow(escrowAddr).lifetimeEarned(customer), 1.2e18, "lifetime earned");
        assertTrue(CampaignEscrow(escrowAddr).usedNullifiers(nf), "nullifier recorded");
    }

    function test_ClaimOnlyWorkflowOwner() public {
        bytes32 nf = keccak256("nullifier-2");
        vm.prank(attacker);
        vm.expectRevert(); // OnlyWorkflowOwner
        CampaignEscrow(escrowAddr).claim(nf, customer, 12e18);
    }

    function test_ClaimNullifierReuseReverts() public {
        bytes32 nf = keccak256("nullifier-3");
        vm.startPrank(workflowOwner);
        CampaignEscrow(escrowAddr).claim(nf, customer, 12e18);
        vm.expectRevert(); // NullifierAlreadyUsed
        CampaignEscrow(escrowAddr).claim(nf, customer, 12e18);
        vm.stopPrank();
    }

    function test_ClaimCapEnforced() public {
        vm.startPrank(workflowOwner);
        // Cap = $20 → 10% × $200 = $20, exactly at cap
        uint256 p1 = CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 200e18);
        assertEq(p1, 20e18, "cap reached");
        // Next claim > cap → revert (remaining == 0)
        vm.expectRevert(); // CapExceeded / ZeroPoints
        CampaignEscrow(escrowAddr).claim(keccak256("n2"), customer, 12e18);
        vm.stopPrank();
    }

    /// @notice Per-tx cap clamps a single transaction's reward regardless of
    ///         ledger state; the lifetime cap still applies on top.
    function test_PerTxCapClampsSingleClaim() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        // Deploy with min-spend off, lifetime cap on ($100), per-tx cap $50.
        CampaignEscrow.CampaignTerms memory terms = CampaignEscrow.CampaignTerms({
            rateBps: RATE_BPS, // 10%
            start: start,
            end: end,
            reward: address(0),
            rewardTokenId: 0,
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: false,
                minSpend: 0,
                capEnabled: true,
                cap: 100e18,
                dayOfWeekEnabled: false,
                daysOfWeek: 0,
                flatEnabled: false,
                flatValue: 0,
                redeemable: true,
                perTxCapEnabled: true,
                perTxCap: 50e18
            }),
            platformFeeBps: PLATFORM_FEE_BPS,
            platformFeeAccount: PLATFORM_FEE_ACCOUNT
        });
        uint256 id = _createCampaign(terms, workflowOwner, "https://example.com/metadata/{id}.json", keccak256("per-tx-cap"));
        (address esc, , , , ) = factory.campaigns(id);

        // $300 spend → 10% = $30… wait, that is UNDER the $50 per-tx cap. Use
        // $800: 10% = $80 → clamped to the $50 per-tx cap.
        vm.startPrank(workflowOwner);
        uint256 p1 = CampaignEscrow(esc).claim(keccak256("tx-1"), customer, 800e18);
        assertEq(p1, 50e18, "per-tx cap clamps 80 to 50");

        // Preview must mirror the same math (what the DON report is checked against).
        assertEq(CampaignEscrow(esc).computePointsPreview(800e18, 50e18), 50e18, "preview clamps too");

        // Exactly at the per-tx boundary: 10% of $500 = $50 → no clamp, full 50.
        uint256 p2 = CampaignEscrow(esc).claim(keccak256("tx-2"), customer, 500e18);
        assertEq(p2, 50e18, "boundary tx earns exactly the per-tx cap");

        // Lifetime cap interplay: earned 100 = cap → next claim reverts even
        // though each individual tx was within the per-tx cap.
        vm.expectRevert(); // CapExceeded
        CampaignEscrow(esc).claim(keccak256("tx-3"), customer, 100e18);
        vm.stopPrank();
    }

    function test_ClaimBeforeWindowReverts() public {
        uint64 start = uint64(block.timestamp + 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        uint256 id = _createCampaign(_terms(start, end), workflowOwner, "https://example.com/metadata/{id}.json", keccak256("salt-before"));
        (address esc, , , , ) = factory.campaigns(id);
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignNotLive
        CampaignEscrow(esc).claim(keccak256("x"), customer, 12e18);
    }

    function test_ClaimAfterWindowReverts() public {
        uint64 start = uint64(block.timestamp - 30 days);
        uint64 end = uint64(block.timestamp - 1 days);
        uint256 id = _createCampaign(_terms(start, end), workflowOwner, "https://example.com/metadata/{id}.json", keccak256("salt-after"));
        (address esc, , , , ) = factory.campaigns(id);
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignEnded
        CampaignEscrow(esc).claim(keccak256("x"), customer, 12e18);
    }

    /*//////////////////////////////////////////////////////////////
                    REDEEM (Company B, merchant-only)
    //////////////////////////////////////////////////////////////*/

    function test_RedeemBurnsAndUpdatesLedger() public {
        vm.startPrank(workflowOwner);
        CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 12e18); // 1.20 earned
        vm.stopPrank();
        assertEq(CampaignReward(rewardAddr).balanceOf(customer, rewardTokenId), 1.2e18);

        // Authorize Brand B as the merchant redeemer
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);

        vm.prank(brandB);
        CampaignEscrow(escrowAddr).redeemFor(customer, 1e18); // merchant spends 1.00 on user

        assertEq(CampaignReward(rewardAddr).balanceOf(customer, rewardTokenId), 0.2e18, "0.20 left");
        assertEq(CampaignEscrow(escrowAddr).availableBalance(customer), 0.2e18, "ledger balance 0.20");
        assertEq(CampaignEscrow(escrowAddr).lifetimeEarned(customer), 1.2e18, "lineage preserved (1.20)");
    }

    function test_RedeemMoreThanBalanceReverts() public {
        vm.prank(workflowOwner);
        CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 12e18); // 1.20 earned
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(brandB);
        vm.expectRevert(); // InsufficientBalance
        CampaignEscrow(escrowAddr).redeemFor(customer, 2e18);
    }

    function test_RedeemZeroDoesNothing() public {
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(brandB);
        CampaignEscrow(escrowAddr).redeemFor(customer, 0);
        assertEq(CampaignEscrow(escrowAddr).availableBalance(customer), 0, "no-op");
    }

    function test_RedeemOnlyAuthorizedRedeemer() public {
        vm.prank(workflowOwner);
        CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 12e18); // give user points
        // Customer themselves is NOT a redeemer → must revert
        vm.prank(customer);
        vm.expectRevert(); // OnlyRedeemer
        CampaignEscrow(escrowAddr).redeemFor(customer, 1e18);
        // Unauthorized attacker also reverts
        vm.prank(attacker);
        vm.expectRevert(); // OnlyRedeemer
        CampaignEscrow(escrowAddr).redeemFor(customer, 1e18);
    }

    function test_RedeemRevokedRedeemer() public {
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, false);
        vm.prank(brandB);
        vm.expectRevert(); // OnlyRedeemer (revoked)
        CampaignEscrow(escrowAddr).redeemFor(customer, 1e18);
    }

    function test_RedeemZeroTargetReverts() public {
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(brandB);
        vm.expectRevert(); // InvalidRedeemTarget
        CampaignEscrow(escrowAddr).redeemFor(address(0), 1e18);
    }
    /*//////////////////////////////////////////////////////////////
                       DECIMAL GUARD (≤ 2 decimals)
    //////////////////////////////////////////////////////////////*/

    function test_ClaimRejectsTooManyDecimals() public {
        vm.prank(workflowOwner);
        vm.expectRevert(); // TooManyDecimals — $3.125 has 3 decimals
        CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 3.125e18);
    }

    function test_ClaimAllowsExactlyTwoDecimals() public {
        vm.prank(workflowOwner);
        uint256 points = CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 12.25e18); // $12.25 (above min-spend, 2 decimals)
        assertEq(points, 1.225e18, "10% of $12.25 = 1.225 Bpoints");
    }

    function test_RedeemForRejectsTooManyDecimals() public {
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(brandB);
        vm.expectRevert(); // TooManyDecimals — $3.125 has 3 decimals
        CampaignEscrow(escrowAddr).redeemFor(customer, 3.125e18);
    }

    function test_RedeemForAllowsExactlyTwoDecimals() public {
        // Give the user 1.20 then redeem exactly 1.20 (2 decimals)
        vm.prank(workflowOwner);
        CampaignEscrow(escrowAddr).claim(keccak256("n1"), customer, 12e18); // 1.20 earned
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(brandB);
        CampaignEscrow(escrowAddr).redeemFor(customer, 1.2e18); // 2 decimals — ok
        assertEq(CampaignEscrow(escrowAddr).availableBalance(customer), 0, "all spent");
    }

    /*//////////////////////////////////////////////////////////////
               RULE SHAPES — deploy per-rule / mixed campaigns
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a fresh campaign with the given rule flags and return its escrow.
    function _deployWithRules(
        bool minSpendOn,
        uint256 minSpend,
        bool capOn,
        uint256 cap,
        bool dayOn,
        uint8 daysOfWeek,
        uint64 start,
        uint64 end
    ) internal returns (address esc) {
        CampaignEscrow.CampaignTerms memory terms = CampaignEscrow.CampaignTerms({
            rateBps: RATE_BPS,
            start: start,
            end: end,
            reward: address(0),
            rewardTokenId: 0,
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: minSpendOn,
                minSpend: minSpend,
                capEnabled: capOn,
                cap: cap,
                dayOfWeekEnabled: dayOn,
                daysOfWeek: daysOfWeek,
                flatEnabled: false,
                flatValue: 0,
                redeemable: true,
                perTxCapEnabled: false,
                perTxCap: 0
            }),
            platformFeeBps: PLATFORM_FEE_BPS,
            platformFeeAccount: PLATFORM_FEE_ACCOUNT
        });
        uint256 id = _createCampaign(terms, workflowOwner, "https://example.com/metadata/{id}.json", keccak256(abi.encodePacked(minSpendOn, capOn, dayOn, start, end, block.timestamp)));
        (esc, , , , ) = factory.campaigns(id);
    }

    /// @notice Deploy a campaign with the given reward mechanics (flat / redeemable mix).
    ///         Returns the escrow, its paired reward contract, and the reward tokenId.
    function _deployWithMechanics(
        bool flatOn,
        uint256 flatValue,
        bool redeemable,
        uint64 start,
        uint64 end
    ) internal returns (address esc, address reward_, uint256 tokenId_) {
        CampaignEscrow.CampaignTerms memory terms = CampaignEscrow.CampaignTerms({
            rateBps: RATE_BPS,
            start: start,
            end: end,
            reward: address(0),
            rewardTokenId: 0,
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: false,
                minSpend: 0,
                capEnabled: false,
                cap: 0,
                dayOfWeekEnabled: false,
                daysOfWeek: 0,
                flatEnabled: flatOn,
                flatValue: flatValue,
                redeemable: redeemable,
                perTxCapEnabled: false,
                perTxCap: 0
            }),
            platformFeeBps: PLATFORM_FEE_BPS,
            platformFeeAccount: PLATFORM_FEE_ACCOUNT
        });
        uint256 id = _createCampaign(terms, workflowOwner, "https://example.com/metadata/{id}.json", keccak256(abi.encodePacked(flatOn, flatValue, redeemable, start, end, block.timestamp)));
        (esc, reward_, tokenId_, , ) = factory.campaigns(id);
    }

    /// @notice 1. MIN-SPEND ONLY — below-min reverts; at/above min mints.
    function test_RuleShapeMinSpendOnly() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        address esc = _deployWithRules(true, MIN_SPEND, false, 0, false, 0, start, end);

        // Below min-spend → reverts
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.BelowMinSpend
        CampaignEscrow(esc).claim(keccak256("below"), customer, 9e18);

        // At/above min-spend → mints; uncapped (cap rule off) so 10% of $20 = 2.00
        vm.prank(workflowOwner);
        uint256 points = CampaignEscrow(esc).claim(keccak256("ok"), customer, 20e18);
        assertEq(points, 2e18, "10% of $20 = 2.00, uncapped");
    }

    /// @notice 2. REWARD-CAP ONLY — uncapped until cap, then reverts.
    function test_RuleShapeCapOnly() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        address esc = _deployWithRules(false, 0, true, CAP, false, 0, start, end);

        // No min-spend: a $3 claim mints 0.30 (uncapped)
        vm.prank(workflowOwner);
        uint256 p1 = CampaignEscrow(esc).claim(keccak256("a"), customer, 3e18);
        assertEq(p1, 0.3e18, "no min-spend, uncapped below cap");

        // $200 claim → 20.00, exactly the cap
        vm.prank(workflowOwner);
        uint256 p2 = CampaignEscrow(esc).claim(keccak256("b"), customer, 200e18);
        assertEq(p2, 20e18 - 0.3e18, "clamps to remaining cap");

        // Next claim → cap exhausted → reverts
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.CapExceeded
        CampaignEscrow(esc).claim(keccak256("c"), customer, 12e18);
    }

    /// @notice 3. DAY-OF-WEEK ONLY — disallowed day reverts; allowed day mints; and the
    ///         window boundary is never bypassed (NotAllowedDay only fires in-window).
    function test_RuleShapeDayOfWeekOnly() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        // Allow Monday only. In CampaignRulesLib, dayIndex: 0=Mon..6=Sun, so bit 0 = Monday.
        address esc = _deployWithRules(false, 0, false, 0, true, 1, start, end);

        // Find a Monday (dayIndex 0) within the campaign window [start, end].
        // dayIndex = (ts/86400 + 3) % 7. We want dayIndex == 0, so ts/86400 % 7 == 4.
        uint256 mondayTs;
        for (uint256 ts = start; ts <= end; ts += 1 days) {
            if (((ts / 86400) + 3) % 7 == 0) { mondayTs = ts; break; }
        }
        assertTrue(mondayTs != 0, "found a Monday in-window");
        vm.warp(mondayTs);

        // Monday allowed → mints (no min-spend, no cap)
        vm.prank(workflowOwner);
        uint256 p = CampaignEscrow(esc).claim(keccak256("monday"), customer, 12e18);
        assertEq(p, 1.2e18, "Monday allowed -> mints");

        // Disallowed day (Tuesday, dayIndex 1) → reverts NotAllowedDay
        vm.warp(mondayTs + 1 days);
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.NotAllowedDay
        CampaignEscrow(esc).claim(keccak256("tuesday"), customer, 12e18);
    }

    /// @notice 3b. Day-of-week cannot bypass the campaign window: before start or after end
    ///         always reverts the window error even if the day is allowed.
    function test_RuleShapeDayOfWeekCannotBypassWindow() public {
        // Campaign window is entirely in the future relative to now, on an allowed day.
        uint64 start = uint64(block.timestamp + 5 days);
        uint64 end = uint64(block.timestamp + 30 days);
        address esc = _deployWithRules(false, 0, false, 0, true, 1, start, end);

        // Before start, even on an allowed weekday → reverts CampaignNotLive (not day-of-week)
        vm.prank(workflowOwner);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.CampaignEscrow__CampaignNotLive.selector, block.timestamp, start, end));
        CampaignEscrow(esc).claim(keccak256("pre"), customer, 12e18);

        // After end → reverts CampaignEnded
        uint64 pastStart = uint64(block.timestamp - 30 days);
        uint64 pastEnd = uint64(block.timestamp - 5 days);
        address esc2 = _deployWithRules(false, 0, false, 0, true, 1, pastStart, pastEnd);
        vm.prank(workflowOwner);
        vm.expectRevert(abi.encodeWithSelector(CampaignEscrow.CampaignEscrow__CampaignEnded.selector, block.timestamp, pastEnd));
        CampaignEscrow(esc2).claim(keccak256("post"), customer, 12e18);
    }

    /// @notice 4. ALL / MIXED — all three gates apply together.
    function test_RuleShapeAllRules() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        address esc = _deployWithRules(true, MIN_SPEND, true, CAP, true, 1, start, end);

        // Warp to a Monday (dayIndex 0) in-window so the day-of-week gate passes.
        uint256 mondayTs;
        for (uint256 ts = start; ts <= end; ts += 1 days) {
            if (((ts / 86400) + 3) % 7 == 0) { mondayTs = ts; break; }
        }
        vm.warp(mondayTs);

        // Below min-spend reverts (even on an allowed day)
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.BelowMinSpend
        CampaignEscrow(esc).claim(keccak256("low"), customer, 5e18);

        // Allowed day + above min-spend → mints capped
        vm.prank(workflowOwner);
        uint256 p = CampaignEscrow(esc).claim(keccak256("ok"), customer, 20e18);
        assertEq(p, 2e18, "10% of $20 = 2.00");

        // Disallowed day reverts even above min-spend
        vm.warp(mondayTs + 1 days); // Tuesday (dayIndex 1)
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.NotAllowedDay
        CampaignEscrow(esc).claim(keccak256("wrongday"), customer, 20e18);
    }

    /*//////////////////////////////////////////////////////////////
              PARALLEL CAMPAIGNS — three rule mixes, all live at once
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy three campaigns in the same window (all live in parallel), each
    ///         with a different rule mix, and assert each enforces ONLY its own mix.
    ///         This proves the rules are per-campaign and don't cross-contaminate.
    function test_ParallelCampaignsDifferentRuleMixes() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);

        // Three parallel campaigns, distinct rule mixes, distinct escrows:
        address escA = _deployWithRules(true, MIN_SPEND, false, 0, false, 0, start, end); // min-spend only
        address escB = _deployWithRules(false, 0, true, CAP, false, 0, start, end);       // cap only
        address escC = _deployWithRules(false, 0, false, 0, true, 1, start, end);         // day-of-week only (Mon)

        // All three are live in the same window (parallel). Warp to a Monday in-window so
        // campaign C's day gate passes, and campaigns A/B ignore days entirely.
        uint256 mondayTs;
        for (uint256 ts = start; ts <= end; ts += 1 days) {
            if (((ts / 86400) + 3) % 7 == 0) { mondayTs = ts; break; }
        }
        vm.warp(mondayTs);

        // ── Campaign A (min-spend only) ──
        // Below min-spend → reverts even though cap/day are off
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.BelowMinSpend
        CampaignEscrow(escA).claim(keccak256("a-low"), customer, 9e18);
        // At/above min-spend → mints, UNCAPPED (cap rule off)
        vm.prank(workflowOwner);
        uint256 a = CampaignEscrow(escA).claim(keccak256("a-ok"), customer, 20e18);
        assertEq(a, 2e18, "A: 10% of $20 = 2.00, uncapped (cap off)");

        // ── Campaign B (cap only) ──
        // No min-spend: a $3 claim mints even though it's below A's min-spend
        vm.prank(workflowOwner);
        uint256 b1 = CampaignEscrow(escB).claim(keccak256("b-small"), customer, 3e18);
        assertEq(b1, 0.3e18, "B: no min-spend, $3 -> 0.30");
        // Cap enforced: a $200 claim clamps to the remaining cap
        vm.prank(workflowOwner);
        uint256 b2 = CampaignEscrow(escB).claim(keccak256("b-cap"), customer, 200e18);
        assertEq(b2, 20e18 - 0.3e18, "B: clamps to remaining cap");

        // ── Campaign C (day-of-week only) ──
        // Monday (allowed) → mints, no min-spend/cap
        vm.prank(workflowOwner);
        uint256 c1 = CampaignEscrow(escC).claim(keccak256("c-mon"), customer, 12e18);
        assertEq(c1, 1.2e18, "C: Monday allowed, 10% of $12 = 1.20");
        // Disallowed day (Tuesday) → reverts
        vm.warp(mondayTs + 1 days);
        vm.prank(workflowOwner);
        vm.expectRevert(); // CampaignRulesLib.NotAllowedDay
        CampaignEscrow(escC).claim(keccak256("c-tue"), customer, 12e18);

        // ── Cross-campaign isolation: the SAME customer wallet is tracked independently.
        // In A they earned 2.00 (uncapped); in B they earned 0.30 + capped; in C 1.20.
        assertEq(CampaignEscrow(escA).lifetimeEarned(customer), 2e18, "A independent");
        assertEq(CampaignEscrow(escB).lifetimeEarned(customer), 20e18, "B independent (capped)");
        assertEq(CampaignEscrow(escC).lifetimeEarned(customer), 1.2e18, "C independent");
    }

    /*//////////////////////////////////////////////////////////////
              REWARD MECHANICS — flat cashback & discount proof-of-savings
    //////////////////////////////////////////////////////////////*/

    /// @notice FLAT CASHBACK — every qualifying purchase earns the same fixed
    ///         amount regardless of spend size (vs percent cashback).
    function test_FlatCashbackFixedPerPurchase() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        (address esc, address reward_, uint256 tokenId_) = _deployWithMechanics(true, 2e18, true, start, end); // $2 per purchase

        vm.startPrank(workflowOwner);
        // $12 purchase → flat $2 (NOT 10% × $12 = $1.20)
        uint256 p1 = CampaignEscrow(esc).claim(keccak256("f-1"), customer, 12e18);
        assertEq(p1, 2e18, "flat: $12 purchase earns the fixed $2");
        // $90 purchase → still exactly $2 (a percent campaign would pay $9)
        uint256 p2 = CampaignEscrow(esc).claim(keccak256("f-2"), customer, 90e18);
        assertEq(p2, 2e18, "flat: spend size does not change the earn");
        vm.stopPrank();

        // Full UTXO ledger: spendable at a POS like percent cashback
        assertEq(CampaignEscrow(esc).availableBalance(customer), 4e18, "flat: unspent accumulates");
        assertEq(CampaignEscrow(esc).lifetimeEarned(customer), 4e18, "flat: lineage accumulates");
        assertEq(CampaignReward(reward_).balanceOf(customer, tokenId_), 4e18, "flat: tokens minted");
    }

    /// @notice FLAT CASHBACK — flatValue must be 2-decimal clean at init.
    function test_FlatValueRejectsTooManyDecimals() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        // $2.005 per purchase — 3 decimals — must revert at initialize (via factory)
        vm.expectRevert(); // CampaignEscrow__TooManyDecimals
        _deployWithMechanics(true, 2.005e18, true, start, end);
    }

    /// @notice FLAT CASHBACK — flatValue 0 reverts at init.
    function test_FlatValueZeroReverts() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        vm.expectRevert(); // CampaignEscrow__ZeroPoints
        _deployWithMechanics(true, 0, true, start, end);
    }

    /// @notice DISCOUNT — proof-of-savings: totalBalance accumulates (the user's
    ///         totalSaved counter), unspentBalance stays 0, NO tokens minted, and
    ///         redemption is impossible at any POS (nothing to spend).
    function test_DiscountTracksTotalSavedNotSpendable() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        (address esc, address reward_, uint256 tokenId_) = _deployWithMechanics(true, 5e18, false, start, end); // $5-off voucher

        vm.startPrank(workflowOwner);
        uint256 p1 = CampaignEscrow(esc).claim(keccak256("d-1"), customer, 30e18);
        assertEq(p1, 5e18, "discount: $5 saved on a $30 purchase");
        uint256 p2 = CampaignEscrow(esc).claim(keccak256("d-2"), customer, 12e18);
        assertEq(p2, 5e18, "discount: fixed saving regardless of spend");
        vm.stopPrank();

        // The counter IS the product: totalSaved grows, unspent never does.
        assertEq(CampaignEscrow(esc).lifetimeEarned(customer), 10e18, "discount: totalSaved = $10");
        assertEq(CampaignEscrow(esc).availableBalance(customer), 0, "discount: unspent stays 0 - nothing redeemable");

        // No ERC-1155 minted for a non-redeemable campaign.
        assertEq(CampaignReward(reward_).balanceOf(customer, tokenId_), 0, "discount: no tokens minted");

        // Redemption is structurally impossible (insufficient balance, always).
        vm.prank(address(factory));
        CampaignEscrow(esc).setRedeemer(brandB, true);
        vm.prank(brandB);
        vm.expectRevert(); // CampaignEscrow__InsufficientBalance
        CampaignEscrow(esc).redeemFor(customer, 1e18);
    }

    /// @notice DISCOUNT via the CRE report path — points re-verification must accept
    ///         the flat mechanic and the ledger must stay proof-of-savings.
    function test_DiscountOnReportPath() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        (address esc, , ) = _deployWithMechanics(true, 5e18, false, start, end);

        // computePointsPreview must mirror the flat mechanic off-chain too.
        uint256 expected = CampaignEscrow(esc).computePointsPreview(30e18, 0);
        assertEq(expected, 5e18, "discount: preview uses flatValue");

        bytes32 nf = keccak256("d-report-1");
        vm.prank(CRE_FORWARDER);
        CampaignEscrow(esc).onReport(_metadata(workflowOwner), _report(nf, customer, 30e18, true, expected));

        assertEq(CampaignEscrow(esc).lifetimeEarned(customer), 5e18, "discount: totalSaved via report");
        assertEq(CampaignEscrow(esc).availableBalance(customer), 0, "discount: still nothing spendable");
        assertTrue(CampaignEscrow(esc).usedNullifiers(nf), "discount: nullifier consumed");
    }

    /// @notice PERCENT cashback remains the default when flatEnabled is false
    ///         (regression guard for the mechanic switch).
    function test_PercentCashbackStillDefault() public {
        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 30 days);
        (address esc, , ) = _deployWithMechanics(false, 0, true, start, end);
        vm.prank(workflowOwner);
        uint256 p = CampaignEscrow(esc).claim(keccak256("pc-1"), customer, 20e18);
        assertEq(p, 2e18, "percent default: 10% of $20 = $2");
    }

    /*//////////////////////////////////////////////////////////////
            LAUNCH / DEPOSIT / FEE SPLIT / PLATFORM FEE
    //////////////////////////////////////////////////////////////*/

    /// @notice CREATE2: the predicted escrow address matches the actually deployed one.
    function test_Create2DeterministicAddress() public view {
        // The campaign created in setUp used salt keccak256("salt-1"); its escrow
        // address must equal the factory's deterministic prediction.
        assertEq(factory.predictEscrowAddress(keccak256("salt-1")), escrowAddr, "predicted == deployed");
    }

    /// @notice Operating deposit is recorded as owed per the fee-split parameter:
    /// A owes feeSplitBps% of MIN_OPERATING_DEPOSIT, B the complement — both to
    /// the platform reserves. No ETH moves at launch (settled off-chain).
    function test_OperatingDepositOwedRecords() public {
        address a = address(0x1111);
        address b = address(0x2222);
        uint256 balABefore = a.balance;
        uint256 balBBefore = b.balance;
        uint256 factoryBefore = address(factory).balance;
        uint256 id = factory.createCampaign(
            _terms(uint64(block.timestamp), uint64(block.timestamp + 30 days)),
            workflowOwner,
            address(0), // reportOwner defaults to workflowOwner_
            "https://example.com/metadata/{id}.json",
            keccak256("salt-split"),
            a,
            b,
            2500
        );
        // 25% A / 75% B of the 0.01 ether deposit is recorded as OWED via the
        // OperatingDeposit event; assert no ETH moved on-chain.
        assertEq(a.balance, balABefore, "A pays nothing on-chain at launch");
        assertEq(b.balance, balBBefore, "B pays nothing on-chain at launch");
        assertEq(address(factory).balance, factoryBefore, "factory custodies no ETH");
    }

    /// @notice Launch no longer takes an on-chain deposit — createCampaign is
    /// non-payable (Solidity enforces this at compile time; sending ETH is a
    /// type error in tests and reverts at runtime for external callers).

    /// @notice Launch reverts on an invalid fee split (> 10000 bps).
    function test_InvalidFeeSplitReverts() public {
        vm.expectRevert(); // CampaignFactory__InvalidFeeSplit
        factory.createCampaign(
            _terms(uint64(block.timestamp), uint64(block.timestamp + 30 days)),
            workflowOwner,
            address(0), // reportOwner defaults to workflowOwner_
            "https://example.com/metadata/{id}.json",
            keccak256("salt-fee-split"),
            COMPANY_A,
            COMPANY_B,
            10_001
        );
    }

    /// @notice Platform fee accrues on claims and redeems.
    function test_PlatformFeeAccrues() public {
        // Claim 1.20 (10% of $12). Platform fee 10% -> 0.12 accrued.
        vm.prank(workflowOwner);
        CampaignEscrow(escrowAddr).claim(keccak256("pf-1"), customer, 12e18);
        assertEq(CampaignEscrow(escrowAddr).platformFeesAccrued(), 0.12e18, "fee after claim");

        // Redeem 0.50. Platform fee 10% -> 0.05 accrued (total 0.17).
        vm.prank(address(factory));
        CampaignEscrow(escrowAddr).setRedeemer(brandB, true);
        vm.prank(brandB);
        CampaignEscrow(escrowAddr).redeemFor(customer, 0.5e18);
        assertEq(CampaignEscrow(escrowAddr).platformFeesAccrued(), 0.17e18, "fee after redeem");
    }

    /// @notice A zero platform fee accrues nothing.
    function test_PlatformFeeZeroAccruesNothing() public {
        uint64 start = uint64(block.timestamp);
        uint64 end = uint64(block.timestamp + 30 days);
        CampaignEscrow.CampaignTerms memory t = _terms(start, end);
        t.platformFeeBps = 0;
        uint256 id = _createCampaign(t, workflowOwner, "https://example.com/metadata/{id}.json", keccak256("salt-nofee"));
        (address esc, , , , ) = factory.campaigns(id);
        vm.prank(workflowOwner);
        CampaignEscrow(esc).claim(keccak256("nf"), customer, 12e18);
        assertEq(CampaignEscrow(esc).platformFeesAccrued(), 0, "no fee when bps=0");
    }

/*//////////////////////////////////////////////////////////////
                  CRE REPORT PATH (onReport / IReceiver)
//////////////////////////////////////////////////////////////*/

/// @dev Base Sepolia CRE production forwarder (docs: Forwarder Directory).
address constant CRE_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

/// @dev Build forwarder metadata: workflowId(32) || workflowName(10) || workflowOwner(20).
function _metadata(address wfOwner) internal pure returns (bytes memory) {
    return abi.encodePacked(bytes32(uint256(123)), bytes10(0x77697a6172642d747465), wfOwner);
}

/// @dev Build the report payload the enclave encodes.
function _report(bytes32 nullifier, address recipient, uint256 amountSpentWei, bool eligible, uint256 pointsWei)
    internal pure returns (bytes memory)
{
    return abi.encode(nullifier, recipient, amountSpentWei, eligible, pointsWei);
}

function test_OnReportMintsThroughForwarder() public {
    bytes32 nf = keccak256("report-claim-1");
    uint256 spend = 50e18; // $50 at 10% => 5 points
    uint256 points = 5e18;

    vm.prank(CRE_FORWARDER);
    CampaignEscrow(escrowAddr).onReport(_metadata(workflowOwner), _report(nf, customer, spend, true, points));

    assertEq(CampaignEscrow(escrowAddr).lifetimeEarned(customer), points, "ledger updated");
    assertEq(CampaignEscrow(escrowAddr).availableBalance(customer), points, "unspent updated");
    assertEq(CampaignReward(rewardAddr).balanceOf(customer, rewardTokenId), points, "ERC-1155 minted");
    assertTrue(CampaignEscrow(escrowAddr).usedNullifiers(nf), "nullifier consumed");
}

function test_OnReportRejectsNonForwarderCaller() public {
    bytes32 nf = keccak256("report-claim-2");
    vm.prank(address(0xBAD));
    vm.expectRevert(CampaignEscrow.CampaignEscrow__InvalidForwarder.selector);
    CampaignEscrow(escrowAddr).onReport(_metadata(workflowOwner), _report(nf, customer, 50e18, true, 5e18));
}

function test_OnReportRejectsWrongWorkflowOwner() public {
    bytes32 nf = keccak256("report-claim-3");
    vm.prank(CRE_FORWARDER);
    vm.expectRevert();
    CampaignEscrow(escrowAddr).onReport(_metadata(address(0xDEAD)), _report(nf, customer, 50e18, true, 5e18));
}

function test_OnReportRejectsIneligibleVerdict() public {
    bytes32 nf = keccak256("report-claim-4");
    vm.prank(CRE_FORWARDER);
    vm.expectRevert(CampaignEscrow.CampaignEscrow__ReportNotEligible.selector);
    CampaignEscrow(escrowAddr).onReport(_metadata(workflowOwner), _report(nf, customer, 50e18, false, 0));
}

function test_OnReportRejectsOverMintedPoints() public {
    bytes32 nf = keccak256("report-claim-5");
    // Enclave (or a compromised report) claims 50 points for a $50 spend at 10% —
    // on-chain re-verification against computePointsPreview must reject.
    vm.prank(CRE_FORWARDER);
    vm.expectRevert(CampaignEscrow.CampaignEscrow__InvalidReport.selector);
    CampaignEscrow(escrowAddr).onReport(_metadata(workflowOwner), _report(nf, customer, 50e18, true, 50e18));
}

function test_OnReportReplayRejected() public {
    bytes32 nf = keccak256("report-claim-6");
    bytes memory meta = _metadata(workflowOwner);
    bytes memory rep = _report(nf, customer, 50e18, true, 5e18);
    vm.prank(CRE_FORWARDER);
    CampaignEscrow(escrowAddr).onReport(meta, rep);
    vm.prank(CRE_FORWARDER);
    vm.expectRevert(); // NullifierAlreadyUsed (arg-carrying error: bare expectation)
    CampaignEscrow(escrowAddr).onReport(meta, rep);
}

function test_OnReportMinSpendStillEnforced() public {
    // setUp terms have minSpend enabled at $10 (default _terms); $5 spend computes
    // points fine on-chain preview, but enforceMinSpend must revert in the claim core.
    bytes32 nf = keccak256("report-claim-7");
    vm.prank(CRE_FORWARDER);
    vm.expectRevert(); // BelowMinSpend from CampaignRulesLib
    CampaignEscrow(escrowAddr).onReport(_metadata(workflowOwner), _report(nf, customer, 5e18, true, 0.5e18));
}

function test_SupportsInterfaceForForwarderHandshake() public {
    // The Keystone forwarder probes ERC-165 before delivering: the receiver
    // must advertise IReceiver (0x805f2132 — onReport selector; IReceiver
    // inherits IERC165 so interfaceId excludes inherited fns) and IERC165.
    assertTrue(CampaignEscrow(escrowAddr).supportsInterface(0x805f2132), "IReceiver advertised");
    assertTrue(CampaignEscrow(escrowAddr).supportsInterface(0x01ffc9a7), "IERC165 advertised");
    assertFalse(CampaignEscrow(escrowAddr).supportsInterface(0xffffffff), "unknown interface rejected");
}

function test_SetReportOwnerHandover() public {
    // The forwarder stamps the CRE *registry* owner (workflow deployer) into
    // metadata; reportOwner can be handed over to accept a redeployed workflow.
    address registryOwner = address(0x8996);
    // Non-workflowOwner cannot hand over.
    vm.prank(address(0x999));
    vm.expectRevert();
    CampaignEscrow(escrowAddr).setReportOwner(registryOwner);
    // workflowOwner hands over; onReport then accepts the registry owner's reports.
    vm.prank(workflowOwner);
    CampaignEscrow(escrowAddr).setReportOwner(registryOwner);
    assertEq(CampaignEscrow(escrowAddr).reportOwner(), registryOwner, "handover applied");
    bytes32 nf = keccak256("report-claim-handover");
    vm.prank(CRE_FORWARDER);
    CampaignEscrow(escrowAddr).onReport(_metadata(registryOwner), _report(nf, customer, 50e18, true, 5e18));
    assertEq(CampaignEscrow(escrowAddr).lifetimeEarned(customer), 5e18, "ledger updated under new reportOwner");
}

}
