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
        uint8  capWindow;        // cap reset window: 0 = lifetime, 1 = day, 2 = week (Mon), 3 = month (1st), 4 = year (Jan 1) — all UTC calendar-aligned
        uint8  capWindowCount;   // window spans N periods ("every 2 weeks" → capWindow 2, count 2); ignored for lifetime
        uint16 capWindowTime;    // seconds past midnight UTC for the reset instant (e.g. 16200 = 04:30 UTC); 0 = midnight
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

    /// @notice Unix timestamp of the start of the cap-reset window containing `ts`.
    ///         capWindow: 0 = lifetime (never resets), 1 = day, 2 = week (Monday),
    ///         3 = month (1st), 4 = year (Jan 1) — all UTC calendar-aligned.
    ///         capWindowCount spans N periods: "every 2 weeks" = windows anchored
    ///         at N-week boundaries from the epoch anchor; "every 6 months" =
    ///         N-month calendar blocks; "every 40 days" = N-day epoch-aligned
    ///         blocks. Month/year use the civil-date algorithm (Hinnant) — pure,
    ///         no oracle, no DST.
    function windowStart(uint8 capWindow, uint8 capWindowCount, uint256 timeOfDay, uint256 ts) internal pure returns (uint256) {
        uint256 n = capWindowCount == 0 ? 1 : capWindowCount; // 0 treated as 1
        uint256 off = timeOfDay >= 1 days ? 0 : timeOfDay;    // clamp: seconds past midnight UTC [0, 86399]
        if (capWindow == 1) {
            // Day windows: shift ts back by `off`, floor to N-day blocks (epoch
            // aligned), shift forward again. Boundary at off past midnight UTC.
            if (ts < off) return 0;
            return (((ts - off) / 1 days / n) * n) * 1 days + off;
        }
        if (capWindow == 2) {
            // Monday-anchored week windows, offset by `off` past Monday 00:00.
            // Epoch day 0 (1970-01-01) was a Thursday, so Mondays are instants
            // ≡ 4 days + off (mod 7 days). Floor to an N-week block.
            if (ts < 4 days + off) return 0;
            return (((ts - 4 days - off) / 7 days / n) * n) * 7 days + 4 days + off;
        }
        if (capWindow == 3 || capWindow == 4) {
            // Calendar month/year windows. Shift by `off` first so windows
            // start at `off` past the 1st / Jan 1, then decompose normally.
            if (ts < off) return 0;
            ts -= off;
            // Decompose ts into a civil date, then rebuild the window's first
            // day back to a unix timestamp.
            uint256 z = ts / 1 days + 719_468;
            uint256 era = z / 146_097;
            uint256 doe = z - era * 146_097;                       // [0, 146096]
            uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
            uint256 y = yoe + era * 400;
            uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
            uint256 mp = (5 * doy + 2) / 153;                      // [0, 11]
            uint256 m = mp < 10 ? mp + 3 : mp - 9;                 // [1, 12]
            if (m <= 2) y += 1;                                    // civil year containing ts
            if (capWindow == 3) {
                // N-month blocks since year 0: floor((y*12 + m-1)/N)*N → month index.
                uint256 mi = y * 12 + (m - 1);
                mi = (mi / n) * n;
                return _daysFromCivil(mi / 12, (mi % 12) + 1, 1) * 1 days + off;
            }
            // N-year blocks since year 0.
            uint256 y0 = (y / n) * n;
            return _daysFromCivil(y0, 1, 1) * 1 days + off;
        }
        return 0; // lifetime
    }

    /// @dev Days since 1970-01-01 for a civil date (inverse of the decomposition
    ///      above); Hinnant's days_from_civil in 256-bit Solidity.
    function _daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;                               // [0, 399]
        // Hinnant: doy = (153*(m>2 ? m-3 : m+9)+2)/5 + d - 1 — kept unsigned via
        // a +12 offset that the -3 cancels for the m>2 branch.
        uint256 doy = (153 * (m + (m > 2 ? uint8(0) : uint8(12)) - 3) + 2) / 5 + d - 1; // [0, 365]
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;       // [0, 146096]
        return era * 146_097 + doe - 719_468;
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
