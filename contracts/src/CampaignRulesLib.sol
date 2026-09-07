// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CampaignRulesLib
/// @notice The campaign-rule library the master factory imports. Each rule is an
///         explicit field + enforce function. Adding a rule to the product = extend
///         this struct and its enforcement — no factory logic change (the factory
///         passes the struct straight through to the escrow).
/// @dev Day-of-week uses UTC (block.timestamp). The CRE enclave can still do precise
///      timezone math on top for the demo; on-chain we stay deterministic.
library CampaignRulesLib {
    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error BelowMinSpend(uint256 minSpend, uint256 amountSpent);
    error CapExceeded(uint256 alreadyEarned, uint256 raw, uint256 cap);
    error NotAllowedDay(uint8 dayIndex, uint8 daysOfWeek);

    /*//////////////////////////////////////////////////////////////
                                STRUCT
    //////////////////////////////////////////////////////////////*/

    struct Rules {
        bool   minSpendEnabled;  // gate on a minimum purchase total
        uint256 minSpend;        // 18-decimals USD (e.g. 10e18 = $10)
        bool   capEnabled;       // gate on a per-user reward cap
        uint256 cap;             // per-user reward cap
        bool   dayOfWeekEnabled; // gate on allowed days of the week
        uint8  daysOfWeek;       // bitmask: Mon(1)..Sun(64); 0 = any day
        bool   flatEnabled;      // reward mechanic: false = percent (rateBps% of spend), true = flat (flatValue per purchase)
        uint256 flatValue;       // flat cashback per qualifying purchase (18-decimals reward units)
        bool   redeemable;       // true = cashback (points spendable at a POS); false = discount proof-of-savings (totalSaved only, nothing redeemable)
        bool   perTxCapEnabled;  // cap the reward earned by a SINGLE transaction
        uint256 perTxCap;        // per-transaction reward cap (18-decimals reward units)
    }

    /*//////////////////////////////////////////////////////////////
                              ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Minimum-spend gate. Reverts if the rule is on and the spend is too low.
    function enforceMinSpend(Rules memory r, uint256 amountSpent) internal pure {
        if (r.minSpendEnabled && amountSpent < r.minSpend) {
            revert BelowMinSpend(r.minSpend, amountSpent);
        }
    }

    /// @notice Compute reward points, applying the per-user cap only if the rule is on.
    ///         Two mechanics: flat (flatEnabled → flatValue per purchase) and percent
    ///         (rateBps% of spend). For non-redeemable campaigns (discount) "points"
    ///         are dollars saved — they accumulate in totalBalance only.
    /// @return points Reward to mint. Uncapped when capEnabled is false.
    function computePoints(
        Rules memory r,
        uint256 rateBps,
        uint256 amountSpent,
        uint256 alreadyEarned
    ) internal pure returns (uint256 points) {
        points = r.flatEnabled ? r.flatValue : (rateBps * amountSpent) / 10_000;
        // Per-transaction cap first (independent of ledger state), then the
        // per-user lifetime cap. Tightest wins.
        if (r.perTxCapEnabled && points > r.perTxCap) points = r.perTxCap;
        if (!r.capEnabled) return points;
        uint256 remaining = r.cap - alreadyEarned;
        points = points > remaining ? remaining : points;
        if (points == 0) revert CapExceeded(alreadyEarned, points, r.cap);
    }

    /// @notice Day-of-week gate. Returns true if the rule is off, or the timestamp's
    ///         UTC day is in the allowed bitmask. Reverts when a disallowed day is
    ///         passed and the rule is on.
    function requireAllowedDay(Rules memory r, uint256 timestamp) internal pure {
        if (!r.dayOfWeekEnabled) return;
        uint8 dayIndex = uint8(((timestamp / 86400) + 3) % 7); // 0=Mon..6=Sun (epoch was Thu)
        if (((r.daysOfWeek >> dayIndex) & 1) != 1) revert NotAllowedDay(dayIndex, r.daysOfWeek);
    }

    /// @notice Whether a given UTC day is allowed (for tests/views).
    function isDayAllowed(Rules memory r, uint256 timestamp) internal pure returns (bool) {
        if (!r.dayOfWeekEnabled) return true;
        uint8 dayIndex = uint8(((timestamp / 86400) + 3) % 7);
        return ((r.daysOfWeek >> dayIndex) & 1) == 1;
    }
}
