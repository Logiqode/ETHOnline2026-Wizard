// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {CampaignRulesLib} from "../src/CampaignRulesLib.sol";

contract WCheck is Test {
    function prove() public pure {
        emit log_named_uint("9/7 block", CampaignRulesLib.windowStart(2, 2, 1788739200));
        emit log_named_uint("expected", 1788134400);
    }
}
