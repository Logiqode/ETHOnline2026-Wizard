// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {CampaignEscrow} from "../src/CampaignEscrow.sol";
import {CampaignRulesLib} from "../src/CampaignRulesLib.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";

/// @title SeedCampaigns — create demo campaigns (percent / flat / discount) on the
///        freshly deployed factory, so the workflow simulate battery can exercise
///        every reward mechanic end-to-end on Base Sepolia.
///
/// Env: PRIVATE_KEY (broadcaster = workflow owner), FACTORY (new factory address).
contract SeedCampaigns is Script {
    function run() external {
        uint256 chainId = block.chainid;
        require(chainId == 84532, "base-sepolia only");

        address factoryAddr = vm.envAddress("FACTORY");
        CampaignFactory factory = CampaignFactory(factoryAddr);
        address workflowOwner = vm.envAddress("WORKFLOW_OWNER");
        // CRE *registry* owner the forwarder stamps into report metadata — the
        // EOA that deployed the workflow (project.yaml account). Defaults to
        // WORKFLOW_OWNER; never leave at msg.sender — a mismatch makes the
        // escrow revert in onReport, which surfaces as forwarder success=00
        // with state NotAttempted and looks like a transient DON hiccup.
        // (2026-09-07: a reseed defaulting to msg.sender bricked delivery on
        // all 3 gen-3 escrows until setReportOwner() repaired it.)
        address reportOwner = vm.envOr("REPORT_OWNER", workflowOwner);

        uint64 start = uint64(block.timestamp - 1 days);
        uint64 end = uint64(block.timestamp + 365 days);

        vm.startBroadcast();

        // Campaign 1 — PERCENT cashback (10%), min spend $10, cap $100, redeemable.
        CampaignEscrow.CampaignTerms memory pct = CampaignEscrow.CampaignTerms({
            rateBps: 1000,
            start: start,
            end: end,
            reward: address(0),
            rewardTokenId: 0,
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: true, minSpend: 10e18,
                capEnabled: true, cap: 100e18,
                dayOfWeekEnabled: false, daysOfWeek: 0,
                flatEnabled: false, flatValue: 0, redeemable: true,
                perTxCapEnabled: false, perTxCap: 0, capWindow: 0, capWindowCount: 1, capWindowTime: 0
            }),
            platformFeeBps: 0,
            platformFeeAccount: address(0)
        });
        uint256 id1 = factory.createCampaign(pct, workflowOwner, reportOwner, "https://wizard.example/api/metadata/{id}.json", keccak256("seed-percent-v2"), address(0xA11CE), address(0xB0B), 2500);

        // Campaign 2 — FLAT cashback: $2.00 per qualifying purchase, redeemable.
        CampaignEscrow.CampaignTerms memory flat = CampaignEscrow.CampaignTerms({
            rateBps: 0,
            start: start,
            end: end,
            reward: address(0),
            rewardTokenId: 0,
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: true, minSpend: 10e18,
                capEnabled: false, cap: 0,
                dayOfWeekEnabled: false, daysOfWeek: 0,
                flatEnabled: true, flatValue: 2e18, redeemable: true,
                perTxCapEnabled: false, perTxCap: 0, capWindow: 0, capWindowCount: 1, capWindowTime: 0
            }),
            platformFeeBps: 0,
            platformFeeAccount: address(0)
        });
        uint256 id2 = factory.createCampaign(flat, workflowOwner, reportOwner, "https://wizard.example/api/metadata/{id}.json", keccak256("seed-flat-v2"), address(0xA11CE), address(0xB0B), 2500);

        // Campaign 3 — DISCOUNT: $5.00 saved per purchase, proof-of-savings (NOT redeemable).
        CampaignEscrow.CampaignTerms memory disc = CampaignEscrow.CampaignTerms({
            rateBps: 0,
            start: start,
            end: end,
            reward: address(0),
            rewardTokenId: 0,
            rules: CampaignRulesLib.Rules({
                minSpendEnabled: true, minSpend: 10e18,
                capEnabled: false, cap: 0,
                dayOfWeekEnabled: false, daysOfWeek: 0,
                flatEnabled: true, flatValue: 5e18, redeemable: false,
                perTxCapEnabled: false, perTxCap: 0, capWindow: 0, capWindowCount: 1, capWindowTime: 0
            }),
            platformFeeBps: 0,
            platformFeeAccount: address(0)
        });
        uint256 id3 = factory.createCampaign(disc, workflowOwner, reportOwner, "https://wizard.example/api/metadata/{id}.json", keccak256("seed-discount-v2"), address(0xA11CE), address(0xB0B), 2500);

        vm.stopBroadcast();

        // Log each campaign separately (stack-too-deep with all in one scope).
        (address e1, address r1, uint256 t1, , ) = factory.campaigns(id1);
        console2.log("campaign 1 (percent 10%, redeemable):", e1);
        console2.log("  reward:", r1, "tokenId:", t1);
        _logCampaign(factory, id2, "campaign 2 (flat $2, redeemable)");
        _logCampaign(factory, id3, "campaign 3 (discount $5, proof-of-savings)");
    }

    function _logCampaign(CampaignFactory factory, uint256 id, string memory label) internal view {
        (address esc, address rew, uint256 tok, , ) = factory.campaigns(id);
        console2.log(label, esc);
        console2.log("  reward:", rew, "tokenId:", tok);
    }
}
