# Wizard

**Confidential cross-brand campaign factory** — B2B loyalty/cross-brand campaigns where two enterprises run "spend at Brand A → earn rewards redeemable at Brand B" without sharing raw customer data or building bilateral integrations.

> Scaffolded from the `hello-confidential-workflows` starter kit ([smartcontractkit/cre-templates](https://github.com/smartcontractkit/cre-templates/tree/main/starter-templates/hello-confidential-workflows), MIT). The CRE confidential workflow provides the confidential eligibility verification; settlement lives on Base Sepolia.

## Stack

| Layer | Tech |
|---|---|
| Smart contracts | Solidity 0.8.28, Foundry, OpenZeppelin v5.1 (EIP-1167 clones, ERC-1155) |
| Confidential workflow | Chainlink CRE (`handlerInTee`), TypeScript, `@chainlink/cre-sdk` 1.18 |
| Backend | bun + Hono + postgres.js + zod |
| Local state | Postgres 16 in Docker (`docker compose`), port 5433 |
| Settlement | Base Sepolia (`CampaignFactory` → `CampaignEscrow` clones → `CampaignReward`) |
| Identity | Privy embedded wallets (identity anchor = wallet address) |

## Layout

```
contracts/            Foundry project (CampaignFactory, CampaignEscrow, CampaignReward, tests)
wizard/               CRE workflow (workflow.ts, tests, configs, test-payloads/)
backend/              Local-state API (Hono + postgres.js). Campaign CRUD + launch (fee split, salt)
backend/db/           Schema (auto-applied to Postgres on first `docker compose up`)
app/                  Vite + React frontend (Campaign Wizard, Campaigns list)
docs/                 Technical spec + demo outline
docker-compose.yml    Local Postgres 16 (port 5433) — one command for a fresh clone
project.yaml          CRE project settings (Base Sepolia RPCs)
secrets.yaml          CRE secret mapping
Makefile              Common dev tasks (db-up, backend, app, test)
```

## Prerequisites

- [Foundry](https://book.getfoundry.sh/) — `forge` (e.g. `~/.foundry/bin/forge.exe`)
- [bun](https://bun.sh/) — used by the CRE workflow toolchain
- The `cre` CLI (Chainlink Runtime Environment, e.g. `C:\Users\<you>\AppData\Local\Programs\cre\cre`)

## Installation

```bash
# Workflow dependencies
git clone https://github.com/Logiqode/ETHOnline2026-Wizard.git
bun install --cwd ./wizard
bun install --cwd ./backend
bun install --cwd ./app

# Environment (required for CRE simulate)
cp .env.example .env    # fill SECRET_API_TOKEN, or export it

# Environment (backend local dev)
cp backend/.env.example backend/.env   # optional — defaults match compose

# Start the local Postgres (one command, no local install)
docker compose up -d
```

Contracts use vendored dependencies in `contracts/lib/` (via `git clone`; gitignored).

## Local dev

```bash
make db-up       # start Postgres (port 5433)
make backend     # run the API on http://localhost:4000  (bun --watch)
make app         # run the Vite app (http://localhost:5173)
```

Or without make:

```bash
docker compose up -d
cd backend && bun run dev
cd app && bun run dev
```

The wizard's **Launch Campaign** now saves a campaign draft in Postgres, validates
launch (fee split 0–10000 bps, non-zero fee accounts, ≥ 0.01 ETH operating deposit
— mirrors `CampaignFactory.createCampaign`), and stores the generated CREATE2 salt.
Launch calls `createCampaign()` on-chain, stores the escrow/reward addresses, and
records the factory-assigned on-chain id in `terms.onchainCampaignId` — note the
**two id namespaces**: the Postgres row id (used by the UI/URLs) differs from the
factory's sequential campaign id (what the workflow reads via `campaigns(id)`), so
the payload route forwards the on-chain id, never the DB id. The
**Campaigns** page lists only campaigns the live factory registry actually knows
about (each DB row must prove factory membership — via
`terms.onchainCampaignId` → factory escrow match) — stale DB rows from superseded
factory generations are hidden. Each campaign's detail page shows live
**Participants** (per-wallet ledger from scanned `Claim` events: lifetime
earned / spendable / totalSaved, cap usage, claim count, spend volume) and
**Operating fees** (per-claim gas from real receipts, CRE fees at the demo
free tier, platform-fee accrual, and the per-company operating-fee balance with
a usage bar — balances may go negative when one company's share runs dry, in
which case the other fronts the difference and the UI flags the debt as owed
at settlement/campaign end).

---

## Testing

### Backend (local state API)

```bash
cd backend
bun run typecheck
bun test          # launch validation: fee split, fee accounts, deposit, salt
```

Requires the Postgres container (`docker compose up -d`).

### Smart contracts (Foundry)

```bash
cd contracts

# Build
~/.foundry/bin/forge build          # or: forge build (if on PATH)

# Run the test suite (67 tests: claim, lifetime cap, per-tx cap clamp, nullifier, window,
# cap-reset windows (day/week/month/year incl. multi-week anchors + day-of-week gate),
# campaign-wide cap (clamp ordering, discount path, window-reset interaction, exhaustion),
# redeem/redeemFor, redeemer whitelist, decimal guard, factory wiring,
# per-rule deployment shapes, and parallel campaigns with different rule mixes)
~/.foundry/bin/forge test           # or: forge test

# Run a single test (verbose trace)
~/.foundry/bin/forge test --match-test test_ClaimMintsPoints -vvv

# Run tests matching a substring
~/.foundry/bin/forge test --match-path test/CampaignWorkflow.t.sol

# Gas report
~/.foundry/bin/forge test --gas-report
```

> Note: `forge` may not be on PATH on Windows — use the full path `~/.foundry/bin/forge.exe`, or add it to PATH.

### CRE confidential workflow (TypeScript / bun)

The workflow is **HTTP-triggered** and serves multiple campaigns from one binary. The config holds a `campaigns` map keyed by `campaignId`; each HTTP request body selects a campaign via `campaignId` and carries the POS purchase.

```bash
cd wizard

# Typecheck
bun run typecheck                      # or: ./node_modules/.bin/tsc --noEmit

# Unit tests (27 tests: 3 demo campaigns x 5 payloads — eligibility, window,
# min-spend, day-of-week, per-user cap, reset rollover, discount, campaign-wide
# cap ordering, digital)
bun run test                           # or: bun test
```

### End-to-end simulation (HTTP-triggered, per-campaign payloads)

```bash
cd ..   # repo root

# Run one payload against a campaign
cre workflow simulate ./wizard --target=staging-settings -e .env --http-payload ./wizard/test-payloads/onchain-1-pass.json
```

- `--target=staging-settings` selects the config from `workflow.yaml` (`config.staging.json`).
- `-e .env` loads the environment (including `CAMPAIGN_NULLIFIER_MASTER`, read by the enclave at runtime — no shell export needed).
- `--http-payload <path>` is the HTTP request body. Payload files live in `wizard/test-payloads/`.

> **Before demoing: rotate the `userAnchor`.** All payloads share one test anchor (`0xAAaA…0001`). Simulate itself never writes on-chain (the cap it shows comes from the payload's `earnedInWindow`, not the ledger), but any *live* claims you fire during testing accumulate against that anchor's on-chain ledger — against a $100 lifetime cap. Swap in a fresh address (e.g. `0xAAaA000000000000000000000000000000000002`) across the payloads before a demo so every claim has full headroom and a clean participants entry. One `sed` does it: `sed -i 's/AAaA000000000000000000000000000000000001/<new-anchor-hex>/g' wizard/test-payloads/*.json`.

The simulation reads campaign terms **live from the deployed contracts on Base Sepolia** (factory → escrow), so the verdicts below reflect real on-chain state.

The three live demo campaigns (seeded on the deployed factory — see `contracts/script/SeedCampaigns.s.sol`):

| id | Mechanic | Rules (on-chain) |
|----|----------|------------------|
| 1 | 10% percent cashback | min spend $10, $100/user cap, redeemable |
| 2 | Flat $2 cashback per purchase | min spend $10, no cap, redeemable |
| 3 | Flat $5 discount (proof-of-savings) | min spend $10, totalSaved counter only — nothing redeemable |

Run all the bundled payloads (pass + fail per campaign) and check the verdict:

```bash
for p in wizard/test-payloads/onchain-*.json wizard/test-payloads/flat-*.json wizard/test-payloads/discount-*.json; do
  echo "===== $(basename $p) ====="
  cre workflow simulate ./wizard --target=staging-settings -e .env \
    --http-payload "$p" 2>&1 | grep -E "Workflow Simulation Result|APPROVE|REJECT"
done
```

Expected results (live on-chain terms, campaign window Sep 2026 → Sep 2027):

```
onchain-1-pass.json              → APPROVE points=3 reason=ok           (10% of $30)
onchain-1-below-min.json         → REJECT points=0 reason=below-min-spend
onchain-1-cap-clamp.json         → APPROVE points=5 reason=ok           ($100 spend, 95 earned — clamped to cap)
onchain-1-cap-exhausted.json     → REJECT points=0 reason=cap-exhausted
onchain-1-after-end.json         → REJECT points=0 reason=after-campaign-end
onchain-2-pass.json              → APPROVE points=2 reason=ok           (campaign 2 is flat $2 — file predates the mechanic switch)
onchain-2-below-min.json         → REJECT points=0 reason=below-min-spend
flat-2-pass.json                 → APPROVE points=2 reason=ok           (flat $2, $30 spend)
flat-2-big-spend-same-earn.json  → APPROVE points=2 reason=ok           ($90 spend — same flat $2)
flat-2-below-min.json            → REJECT points=0 reason=below-min-spend
discount-3-pass.json             → APPROVE points=5 reason=ok           ($5 saved, $30 spend)
discount-3-small-spend.json      → APPROVE points=5 reason=ok           ($12 spend — same $5 saving)
discount-3-below-min.json        → REJECT points=0 reason=below-min-spend
campaign-a-pass.json             → APPROVE points=3 reason=ok           (same as onchain-1-pass, alt anchor)
campaign-a-fail-below-min.json   → REJECT points=0 reason=below-min-spend
campaign-c-pass.json             → APPROVE points=5 reason=ok           ($5 saved, $20 spend)
campaign-c-fail-below-min.json   → REJECT points=0 reason=below-min-spend
campaign-2-min-spend-boundary.json → APPROVE points=2 reason=ok         (exactly $10.00 = min spend → passes)
campaign-1-cap-exhausted.json    → REJECT points=0 reason=cap-exhausted (earned 100 = at cap)
```

All 19 payload files currently pass with these verdicts (verified against the gen-3 factory on 2026-09-08).

Simulation output shows the handler's `runtime.log` lines (debug only — removed for production) and ends with the verdict, e.g.:

```
[USER LOG] payload: campaign=1 user=0xAAaA...0001 merchant=burgera amount=30 earnedInWindow=0
[USER LOG] on-chain terms: escrow=0x2888...B02b rateBps=1000 window=[1788683360,1820305760] minSpend=10 cap=100
[USER LOG] eligibility: ok eligible=true points=3
[USER LOG] report written to escrow 0x2888...B02b (txStatus=2)
✓ Workflow Simulation Result: "APPROVE points=3 reason=ok"
```

### Mock payloads

Per-campaign POS payloads live in `wizard/test-payloads/` (one file per campaign × scenario). Campaign terms are **read on-chain at request time** from the deployed factory (`0xB770252B23066d0f0cf4006F740F5CAd6b83f5df` on Base Sepolia, recorded in `contracts/deployments/base-sepolia.json`) — new campaigns are picked up with zero workflow redeploys.

## Deployed contracts (Base Sepolia, chain 84532)

Recorded in `contracts/deployments/base-sepolia.json` (rewritten by the deploy script). The demo is verified **end-to-end on-chain**: HTTP trigger → gateway ACCEPTED → DON consensus → forwarder delivers the report → escrow settles the claim (block [46501290](https://sepolia.basescan.org/tx/0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2)).

**Core contracts**

| Contract | Address |
|---|---|
| `CampaignFactory` (gen-6: `setCampaignRedeemer` passthrough) | [`0xB770252B23066d0f0cf4006F740F5CAd6b83f5df`](https://sepolia.basescan.org/address/0xB770252B23066d0f0cf4006F740F5CAd6b83f5df) |
| `CampaignEscrow` (implementation; campaigns are EIP-1167 clones of it) | [`0xdEbB0c6c1eb693C1147d298478d0D63733F31a45`](https://sepolia.basescan.org/address/0xdEbB0c6c1eb693C1147d298478d0D63733F31a45) |
| CRE Forwarder (Chainlink's production forwarder, not ours) | [`0xF8344CFd5c43616a4366C34E3EEE75af79a74482`](https://sepolia.basescan.org/address/0xF8344CFd5c43616a4366C34E3EEE75af79a74482) |

**Demo campaigns (seeded via `contracts/script/SeedCampaigns.s.sol` on the current factory)**

| # | Escrow clone | Reward (ERC-1155) |
|---|---|---|
| 1 | [`0x6D6eB14b3ADeA837080C4588026C3CbeA60F35cF`](https://sepolia.basescan.org/address/0x6D6eB14b3ADeA837080C4588026C3CbeA60F35cF) | [`0x72EDEca29435F008Db3d9b31BecBF3718832BdcA`](https://sepolia.basescan.org/address/0x72EDEca29435F008Db3d9b31BecBF3718832BdcA) |
| 2 | [`0xaa173E7E9B9f8B3C9405D844Ed74300A0DFa924F`](https://sepolia.basescan.org/address/0xaa173E7E9B9f8B3C9405D844Ed74300A0DFa924F) | [`0xfA6B5D7BC8fC2B2276600a0c011068E3e9C8B20a`](https://sepolia.basescan.org/address/0xfA6B5D7BC8fC2B2276600a0c011068E3e9C8B20a) |
| 3 | [`0x71a2f110461c7A5659936a26c7f6E6FfE2d122aA`](https://sepolia.basescan.org/address/0x71a2f110461c7A5659936a26c7f6E6FfE2d122aA) | [`0x90b1294E9c3D6a722AcB3C720B4f5AF5162fae93`](https://sepolia.basescan.org/address/0x90b1294E9c3D6a722AcB3C720B4f5AF5162fae93) |

**Key transactions**

| What | Tx |
|---|---|
| Deploy `CampaignEscrow` implementation (gen-6) | [`0xa6f6de514d49450cc8904af69f75de76b9bc83ce378a200e5d7229b7bab53c8b`](https://sepolia.basescan.org/tx/0xa6f6de514d49450cc8904af69f75de76b9bc83ce378a200e5d7229b7bab53c8b) |
| Deploy `CampaignFactory` (gen-6) | [`0x93db79c5ce3f969d8ce8cd484d8594d951e39e59c5aaf22e6f7ac4de259bb329`](https://sepolia.basescan.org/tx/0x93db79c5ce3f969d8ce8cd484d8594d951e39e59c5aaf22e6f7ac4de259bb329) |
| Seed campaign 1 (gen-6, percent 10%) | [`0x4b80635f887bd6afed59c843d1a3f9745d5601f4f06a6cc7239983e9f576412a`](https://sepolia.basescan.org/tx/0x4b80635f887bd6afed59c843d1a3f9745d5601f4f06a6cc7239983e9f576412a) |
| Seed campaign 2 (gen-6, flat $2) | [`0x0ae1eee5d307a2cce2f662c5de3959575c1b023717818e35aed61c3ebcc22c8b`](https://sepolia.basescan.org/tx/0x0ae1eee5d307a2cce2f662c5de3959575c1b023717818e35aed61c3ebcc22c8b) |
| Seed campaign 3 (gen-6, discount $5) | [`0xaf1788f95e50af502f88b2ba1405a97801c67128665aaa7af6fb85507f5ca157`](https://sepolia.basescan.org/tx/0xaf1788f95e50af502f88b2ba1405a97801c67128665aaa7af6fb85507f5ca157) |
| `setCampaignRedeemer` — relay authorized on campaigns 1 & 2 (gen-6 passthrough) | [`0x1222d898317c56696618dd8c69a6a94c3f5cc4579ca2d107da3d52ab9b9871b0`](https://sepolia.basescan.org/tx/0x1222d898317c56696618dd8c69a6a94c3f5cc4579ca2d107da3d52ab9b9871b0), [`0x20aa156d6f0d8bab855828e602cc92e8e791b08b4d142601cf16550593778194`](https://sepolia.basescan.org/tx/0x20aa156d6f0d8bab855828e602cc92e8e791b08b4d142601cf16550593778194) |
| **End-to-end earn+redeem on gen-6** (DON report → claim + mint 2.0; then relay `redeemFor` 1.0) | mint `0x3644aae0`… — see [Earn/redeem verification](#earnredeem-verification-gen-6) below |
| (gen-4, superseded) End-to-end claim | [`0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2`](https://sepolia.basescan.org/tx/0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2) |

**CRE workflow**: `wizard-staging`, workflow ID `00d9e14331b22726f39936f0bd5178bdc86db9cfa6f72d2361381c9261859c67` (gen-6: reads the gen-6 factory `0xB770…f5df`; on-chain per-tx cap; private registry, zone-a DON family, owner `0x8996097709d886abD468511BfB5A7279110e15d8`; nullifier includes the payload timestamp — see the privacy notes below). Fired via the signed-relay path (see `backend/scripts/trigger.ts`).

### Earn/redeem verification (gen-6)

The redeem path is now **live on-chain**, not roadmap: the gen-6 factory exposes `setCampaignRedeemer(campaignId, wallet, allowed)` — a passthrough to each escrow's owner-gated `setRedeemer` (the escrow's owner IS the factory; without the passthrough the whitelist was dead code and every redeem reverted `OnlyRedeemer`). The platform relay (`0x9587BD3e8195D597BF4e82B18724178e52B55c4F`) is authorized on the two redeemable seeded campaigns, verified end-to-end on 2026-09-08: HTTP payload → DON verdict (`eligible=true, points=2`) → escrow `Claim` + ERC-1155 mint of 2.0 on escrow 2 ([block 46553514](https://sepolia.basescan.org/tx/0x3644aae0d39c9c1a3ef7f6e12b1776234832eeec007112c079695f27af44d149)) → relay `redeemFor(user, 1.0e18)` → `Redeemed` event + `TransferSingle` burn, balance 1.0 remaining ([tx 0x3644aae0…](https://sepolia.basescan.org/tx/0x3644aae0d39c9c1a3ef7f6e12b1776234832eeec007112c079695f27af44d149)). Escrow `_onlyRedeemer` also lets the `workflowOwner` redeem without explicit authorization; older-generation escrows (gen-5 and earlier) keep the previous factory as owner and cannot be repaired — redeploy any campaign that needs redemption.

### Deploying from scratch

Full teardown-to-live sequence. Copy `.env.example` → `.env` and fill in the secrets first (`CRE_ETH_PRIVATE_KEY`, `CAMPAIGN_NULLIFIER_MASTER`); every address variable below is explained there.

**1. Deploy the core contracts** (escrow implementation + factory — this is the "master factory"):

```bash
cd contracts
export PATH="$HOME/.foundry/bin:$PATH"
forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast --private-key $CRE_ETH_PRIVATE_KEY --sender 0x<your-deployer-eoa>
```

This rewrites `contracts/deployments/base-sepolia.json` with the new `factory` / `escrowImplementation` / `deployer` — every other component reads that file, so nothing needs hand-editing yet.

**2. Seed the demo campaigns.** `WORKFLOW_OWNER` is **mandatory** (the script reverts without it):

```bash
FACTORY=0x<new-factory> WORKFLOW_OWNER=0x<registry-owner> \
  forge script script/SeedCampaigns.s.sol --rpc-url https://sepolia.base.org --broadcast --private-key $CRE_ETH_PRIVATE_KEY --sender 0x<your-deployer-eoa>
```

> **`WORKFLOW_OWNER` vs `REPORT_OWNER` — the pitfall that cost us a morning.** The DON stamps every report with the *registry* owner (the account that deployed the workflow, printed by `cre workflow deploy` in step 3), while `workflowOwner` is the EOA allowed to submit claims. If the escrow's `reportOwner` doesn't match the registry owner, the forwarder delivers with `success=00` / state `NotAttempted` and every claim silently fails while the DON verdict looks green. Both default to the same EOA in a solo setup — pass `WORKFLOW_OWNER` explicitly and they stay in sync. (A mismatch on already-deployed escrows is repairable with `setReportOwner()` — no redeploy needed.)

**3. Point the workflow at the new factory and deploy it** (PowerShell — the CRE CLI is a Windows app):

```powershell
# wizard/config.staging.json → set "factoryAddress" to the new factory
cre workflow build ./wizard
cre workflow deploy ./wizard --target=staging-settings
```

The deploy output prints the registry owner (use it as `WORKFLOW_OWNER` in step 2 if you haven't seeded yet) and the new **workflow ID**. Wait ~90s for gateway propagation before firing payloads.

**4. Wire the backend**: put the new workflow ID in `.env` as `WORKFLOW_ID=0x…`, and set `WORKFLOW_OWNER_ADDRESS` (the claim-submitting EOA) so wizard-launched campaigns get the right `workflowOwner`. The launch route passes the **same** value as `reportOwner` too — wizard-created escrows therefore match the DON-stamped registry owner automatically (the step-2 pitfall can't recur through the wizard path). Per-transaction caps configured in the wizard (cashback/discount per-tx cap) are also encoded into the escrow's on-chain rules at launch and clamped in `computePoints` — the DON's points math and the escrow's re-verification stay identical.

**5. Register the seeded campaigns in the DB** (their on-chain state exists but Postgres has no rows yet):

```bash
curl -X POST localhost:4000/api/campaigns/seed
```

This reads escrow/reward addresses **live from the factory** by on-chain id and stores the mapping (`terms.onchainCampaignId`) — the payload route needs it, because the workflow addresses campaigns by the factory's sequential id, not the Postgres row id.

**6. Verify**: fire a test payload on a seeded campaign (`POST /api/campaigns/<id>/payload?await=1`) and check the escrow's `Claim` event on Basescan — a green DON verdict alone doesn't prove the escrow accepted the report.

Each payload is a request body `{ campaignId, userAnchor, merchantId, amountSpent, timestamp, earnedInWindow, items }`. `earnedInWindow` is how much the user already earned in the current reset window (0 after a rollover). Edit the JSON to test different scenarios (below/above min-spend, window edges, cap clamp/exhaustion). Repeat purchases by the SAME anchor are fine — the nullifier includes the payload `timestamp`, so each distinct purchase mints afresh (same wallet + same timestamp = same nullifier → on-chain duplicate-claim/replay rejection). `userAnchor` casing is free-form — the workflow normalizes it via viem's `getAddress()` before encoding (callers are not required to pre-checksum; this bug cost us a morning of "phantom" campaign-2 failures, see the EIP-55 note below).

> **Timestamp precision (POS integration requirement).** Payload timestamps must be Unix **seconds**. Two purchases by the same wallet within the same second derive the *same* nullifier and the second is rejected as a replay — correct anti-double-claim behavior, but a real POS that can emit sub-second purchases (tap-and-go bursts) should send a unique transaction ID as the freshness element instead of the wall-clock second.

---

## Useful commands

```bash
# CRE: list chains + mock forwarders for your tenant
cre workflow supported-chains

# CRE: compile a workflow to WASM
cre workflow build ./wizard

# CRE: deploy a workflow to the Workflow Registry (real, requires staging/prod target)
cre workflow deploy ./wizard --target=staging-settings
```

## Notes

- **Product feedback for protocol teams (Privy + Chainlink).** Two concrete DX observations gathered while building the demo, offered as feedback rather than bug reports:
  - **Privy — the transaction approval modal does not disclose the transfer amount.** When an embedded wallet sends ETH via `eth_sendTransaction`, the "Approve transaction" modal shows the destination, network, and an estimated fee, but **not the amount being transferred** — on a testnet it displays "US$0.00" (no fiat oracle for testnet ETH) with no amount row at all, so the user approves a transfer whose value is only visible after the fact in the explorer. The security-critical facts the modal *does* surface are the destination address (correct and copyable) and the network; the amount is enforced by our backend's independent on-chain verification (a wrong amount simply fails to verify), so this is a UX disclosure gap, not a trust gap. Request: show the transaction `value` explicitly in the approval modal, even when a fiat quote is unavailable.
  - **Chainlink CRE — no native replay protection; processed reports fail silently on-chain.** The workflow is a stateless, trust-minimized evaluator: it reaches DON consensus on payload eligibility against the campaign's on-chain terms, but it has no memory of previously approved payloads. Every builder must therefore implement deduplication in the receiving contract (this demo: a nullifier `H(HMAC(master, campaignId) || userAnchor || timestamp)` checked against `ReportProcessed` in `onReport`). Two friction points: (1) **reimplementing the dedup layer** for every receiver is repeated security-sensitive work — a workflow-tracked nonce or processed-report identifier bound into the report metadata would let contracts enforce replay protection natively; (2) **duplicate reports drop silently** — the forwarder delivers the report, `onReport` recognizes the already-processed nullifier and returns without reverting (forwarder logs success), so from the builder's observability a replayed claim and a total delivery failure are indistinguishable: no event, no revert reason, nothing surfaced back to the workflow either. An emitted event or structured revert on already-processed reports would make claim debugging vastly easier.

- **N-participant campaign support (production).** This demo UI and local backend hardcode a **2-participant** model: Company A (POS) and Company B (reward), with a single `feeSplitBps` for Company A and Company B receiving the remainder. The underlying contracts (`CampaignFactory` / `CampaignEscrow`) and the CRE workflow are **already N-party** (see the `campaigns` map keyed by `campaignId`, the `participants` array in the frontend, and the spec's N-party design), but the demo's fee-split input, the wizard's two-brand `description.participants`, and the launch validation only exercise the 2-party case. In production this would generalize to a per-participant fee-share array and an arbitrary number of participating brands.
- **Reward-token reuse across campaigns (production).** In the demo each campaign deploys a **fresh** `CampaignReward` pair (the factory mints a new ERC-1155 per campaign, `tokenId = campaignId × REWARD_TOKEN_RANGE`) — clean isolation, but it means a company's points from two campaigns are different tokens on different contracts. Production would let two companies **reuse the same reward token** across campaigns: the wizard's launch path takes an optional *existing* reward contract + tokenId instead of deploying a new one, so a brand's "GlobexPoints" stay one fungible balance in a customer's wallet no matter how many campaigns they earn from — one token, many concurrent campaigns, each escrow authorized as a minter on the shared reward (the `CampaignReward` minter role is already per-escrow-address, so multi-minter support is an authorization change, not an architecture change). This is what makes a brand's loyalty program feel like a program rather than a pile of campaign-scoped coupons; the demo's fresh-token-per-campaign model is the deliberate simplification.
- `runtime.log` calls are for simulation/testing only and **must be removed** before production (enclave logs are hidden in real execution anyway).
- **HTTP-trigger authentication & key-reuse vulnerability (current infrastructure, deliberately accepted for the demo).** The workflow's HTTP trigger requires every incoming request to carry an **ECDSA signature from an authorized key** (`authorizedKeys` in the trigger config; the DON verifies it before firing the enclave). The authorized signer is the **platform relay backend**: merchants authenticate to the platform with API keys only (no-web3-for-partners holds), and the relay signs each workflow request before submitting it. The demo vulnerability: the relay signs with the **same burner EOA that deploys contracts and owns the workflows** (`CRE_ETH_PRIVATE_KEY`). Consequences, honestly stated — (1) **capability conflation**: a compromise of that one key lets an attacker deploy malicious contracts, register workflows, AND forge eligibility payloads (minting arbitrary cashback/points to any wallet, since the enclave trusts payload facts like `amountSpent`/`earnedInWindow` from the authorized signer); (2) **no key rotation boundary**: rotating after an incident means re-deploying contracts + workflows, not just swapping an env var; (3) single-key blast radius across every campaign the shared workflow serves. Production roadmap: a **dedicated relay keypair** whose only privilege is firing workflow triggers (public key in `authorizedKeys`, private key in the backend's secret store, never used on-chain); longer term, **one workflow per campaign** with per-campaign authorized keys so a leaked trigger key's blast radius is a single campaign. Forged on-chain claims are still bounded by the DON-consensus report path (`onReport` forwarder + workflow-identity checks) — the key compromise mints *workflow-mediated* fraud, not arbitrary contract calls.
- The workflow is **HTTP-triggered** and serves multiple campaigns from one binary: the config holds a `campaigns` map keyed by `campaignId`, and each request body selects the campaign. Production per-campaign isolation (one workflow per campaign for billing/blast-radius) is a *deployment* choice, not a code limitation — the same binary can be deployed once per campaign, each with its own config, or once for all. Per-campaign isolation also buys **operational independence**: each campaign can be paused, upgraded, or have its workflow logic amended (new eligibility rules, reward mechanics) by redeploying just its own workflow — without touching, or risking, any other campaign's live pipeline; with the shared binary, a logic amendment is an all-campaign redeploy.
- **New campaigns after a workflow is live**: no redeploy needed — the enclave reads campaign terms on-chain from the factory at request time (`campaigns(id)` via `evmClient.callContract` — the factory is the single stable "workflow master" address), so new campaigns register on-chain and are picked up with zero redeploys. Only the factory address (and the trigger's authorized keys) live in the workflow config.
- All on-chain writes via the CRE workflow (`EVMClient.writeReport`) are **live**: the deployed `CampaignEscrow` implements `IReceiver.onReport` (forwarder + workflow-identity checks) on Base Sepolia, and the workflow writes verdicts through the CRE Forwarder. The forwarder runs an **ERC-165 handshake before delivering** — the receiver must advertise `IReceiver` (`0x805f2132`, the bare `onReport(bytes,bytes)` selector, since inherited IERC165 functions are excluded from `type(IReceiver).interfaceId`) and `IERC165` (`0x01ffc9a7`). The escrow also distinguishes `workflowOwner` (the EOA claim path) from `reportOwner` (the CRE registry owner the forwarder stamps into report metadata; handover-able via `setReportOwner`).
- **EIP-55 checksum pitfall (fixed in workflow `004310b2…`)**: viem enforces address checksums at `encodeAbiParameters` time, so a non-checksummed `userAnchor` used to crash the workflow *after* eligibility — all 10 DON nodes agreed on APPROVE, then every node threw "Address must match its checksum counterpart" during report encoding → execution FAILURE with 3 of 5 events and no error surfaced on-chain (the forwarder never got a report to deliver). Nastier still, it was anchor-dependent, not campaign- or amount-dependent: `0xAAaA…001` passed only because its mixed-case prefix happened to be the *correct* checksum casing — pure luck, which is why the morning E2E worked while identical payloads with `…002/3/4/5` failed and masqueraded as a campaign-2 "flat-branch bug". Fix: `onHTTPTrigger` normalizes via `getAddress(request.userAnchor)` once after parsing, so any caller casing works and the nullifier (derived from address bytes, case-insensitive) is unchanged. Debug tip: `cre execution status <id>` prints a **Top-Level Errors** block that `grep Status` alone hides — that's where the viem error was.
- **Caps — what's enforced where (gen-5).** The Rules struct carries per-user cap fields (`capEnabled`/`cap` + the gen-5 window fields `capWindow`/`capWindowCount`/`capWindowTime`/`capWindowDow`) and **campaign-wide** fields (`campaignCapEnabled`/`campaignCap` — "Total redeem cap" in the wizard: total rewards issued across ALL users, lifetime, never resets). `CampaignRulesLib.computePoints` clamps in a fixed order — **per-tx cap → per-user cap (window ledger) → campaign cap (escrow `campaignTotalEarned` accumulator)** — claiming as much as each remaining budget allows (partial clamp; reverts only when nothing remains). The DON's workflow mirrors this order byte-for-byte (it reads `campaignTotalEarned()` from the escrow rather than trusting the payload), and the escrow re-verifies at `onReport` — divergence in either direction reverts the report. Window resets refill the per-user budget; the campaign pool only drains.
- **Known cosmetic bug — large USD values render with float error in the UI (display-only).** Entering a "Total redeem cap" of `200000` (or any USD figure above ~9,000, where wei values exceed `2^53`) shows a mangled number in the campaign summary / workflow views, e.g. `campaignCap = 199999.99999999997`. Cause: some render paths convert the wei `BigInt` to a JS `Number` to format it (`Number(wei)/1e18`), and IEEE-754 doubles cannot represent `2e23` exactly — at that magnitude representable doubles are spaced 33,554,432 wei (2^25) apart, so the nearest double to 200,000×10^18 is `199999.999999999970896…`. **Enforcement is unaffected**: the contract stores the exact integer (`terms().rules.campaignCap` reads back precisely `200000000000000000000000`; verified on-chain on campaign 28 / escrow `0x9541…47Ee`), the `usdToWei` conversion rounds to integer wei before the contract ever sees a value, and every clamp/comparison (`computePoints`, the workflow's `evaluate()` mirror, the `onReport` re-verification) runs in uint256/BigInt where fractional points cannot exist — a campaign cap of 200000 with 199998 earned pays out exactly 2 points on a 5-point raw earn, never 1.999…. The report path is additionally defended in depth: `onReport` re-computes the earn on-chain and reverts `InvalidReport` unless the delivered `pointsWei` matches bitwise, so even a hypothetically float-corrupted workflow value would be rejected, not clamped. Fix when bothered: a BigInt-aware USD formatter (scale by 10^18 in BigInt, insert the decimal point as a string) instead of the `Number()` cast at the display sites.
- **Gas & the operating deposit (production roadmap).** In this demo the platform wallet (an EOA) pays all gas directly and the `OperatingDeposit` is each company's **prepaid operating-fee balance** — split per `feeSplitBps` at creation and drawn down by that company's share of campaign gas (the detail page's Operating-fees card tracks this live, including a signed balance: if one company's share runs dry mid-campaign, the other's deposit fronts the difference and the UI flags the covered amount as a **debt the drained company owes at settlement/campaign end** — keeping the campaign running never silently transfers cost). In production the roadmap is: companies deposit **USDC** (via Stripe/Coinbase fiat rails) into platform custody, and an **ERC-4337 paymaster — e.g. Coinbase Developer Platform's, billed in USDC — sponsors all campaign gas**, so neither the platform nor the companies hold ETH and deposits are USDC-denominated (no bear-market exposure on held deposits). Trade-off, honestly stated: the DIY alternative (platform holds a small ETH float, tops up from USDC periodically) avoids paymaster fees and smart-account (4337) constraints but reintroduces an ETH treasury to manage; the paymaster buys zero-ETH friction at a per-tx fee. Either way, deposits are **custody, not revenue** — unspent (net-positive) balances refund to the company at campaign end, after netting any covered-debt.
- **Pricing follow-through (business model).** The demo contract's `platformFeeBps` (10% uplift in the demo terms) exists as a *cost-plus buffer*: gas + an ETH-volatility premium so the platform doesn't bleed out while holding a float. Once gas is USDC-denominated (paymaster or periodic swap), that buffer's reason disappears and the platform fee drops to a thin value-based margin (e.g. ~1.5%, or 0% as a deliberate growth subsidy) — the fee is just a per-campaign parameter in `CampaignTerms`, so infrastructure savings flow straight through to customer pricing without code changes.

## Revenue model (production business concept)

*Representative figures for the business concept only — not backed by market research or a compute-unit valuation. The numbers illustrate the shape of the model; real pricing would be set from measured unit costs (gas, CRE execution, paymaster markup) plus margin.*

### Where the money comes from

The platform operates the workflow + contracts and charges merchants (Company A, the POS side) for settled redemptions; the reward side (Company B) funds the rewards themselves. Two revenue lines:

1. **Per-redemption platform fee (primary).** Charged per redemption settled through the workflow, on **volume tiers** — the more a merchant settles, the less each redemption costs. Representative US tiers:

   | Monthly redeemed volume | Price per redemption |
   |---|---|
   | up to 5,000 | $0.02 |
   | 5,000 – 25,000 | $0.018 |
   | 25,000 – 125,000 | $0.016 |
   | 125,000 – 625,000 | $0.014 |
   | 625,000+ | $0.012 |

   Tiering mirrors the underlying cost structure: the per-claim cost (DON consensus + gas + paymaster markup) is nearly fixed, so higher amortized volume genuinely costs less to serve — the discount is real margin management, not just a pricing lever. Billed monthly in USDC against the merchant's platform account; volume counts **settled redemptions** (minted claims), not submitted payloads (ineligible submissions are the merchant's own pre-filtering problem — see the batch-at-ingress note above).

2. **Operating-deposit float economics (secondary, modest).** Companies pre-fund operating deposits (USDC in production). Deposits are **custody, not revenue** — unspent balances refund at campaign end — but the platform earns on settlement mechanics (below) and, depending on custody structure, on float placement. Deliberately not counted as core revenue in this model.

3. **Dedicated-workflow premium (execution-tier fee).** The shared workflow (one binary serving many campaigns, billed at the tiers above) is the default; a merchant can instead run a **dedicated workflow** — their own deployment with their own config, authorized keys, and execution lane. It mirrors the shared-vs-dedicated split of cloud compute: shared amortizes the DON's cost across all tenants (cheap, noisy-neighbor latency during bursts), dedicated isolates execution (predictable latency, independent upgrade/pause control, blast-radius isolation for their trigger keys) at a flat monthly premium. A dedicated lane is also the prerequisite for the per-campaign pause controls described below — `cre workflow pause` on a shared binary would halt every tenant's settlement, so the circuit-breaker is only available to dedicated deployments (or per-campaign workflows).

4. **Settlement-speed tiers (batching).** Batching is the **default** settlement mode — payloads buffer at the merchant ingress and flush as a single consensus round (see the batch-at-ingress note above), which is what makes the per-redemption pricing viable at all. The merchant picks a **batch tier**: whichever of a transaction count or a time window comes first triggers settlement. Representative tiers, faster = more expensive (each flush is its own DON round, so more rounds per hour = more consensus cost, passed through with margin):

   | Tier | Flush when either hits | Character |
   |---|---|---|
   | Standard | 2,000 tx or 30 min | cheapest; settlement latency ≤ 30 min |
   | Express | 1,000 tx or 15 min | faster credit visibility |
   | Priority | 250 tx or 5 min | near-real-time settlement |
   | Real-time | per-transaction (no batching) | every purchase settles on its own consensus round |

   Priced as a multiplier on the per-redemption fee (Standard 1.0×, Express ~1.15×, Priority ~1.4×, Real-time ~2.5× — representative). Tier is per-merchant and switchable between billing cycles; the demo's per-payload submission is effectively the Real-time tier end-to-end.

5. **Campaign migration fee (flat).** A merchant can extend or amend a live campaign — raising a nearly-exhausted total redeem cap, pushing out an end date, widening eligibility — by **migrating to a new escrow + reward deployment**: the platform pauses the campaign's workflow, deploys the updated `CampaignEscrow`/`CampaignReward` pair (factory `createCampaign` with the amended terms), migrates the ledger state (participants' earned/unspent balances re-credited on the new escrow, nullifier registry carried over or superseded by the new deployment's fresh registry), re-points the workflow's campaign entry to the new escrow address, and resumes. The workflow pause → migrate → resume sequence is what keeps in-flight payloads from settling against the old terms mid-migration. Charged as a **flat per-migration fee** (representatively $50–250 depending on ledger size), since the work is one deploy + one state migration regardless of volume. This is a production capability the demo deliberately does not implement: the demo's escrows are immutable after launch (terms fixed at `initialize`), and extension is the roadmap item — the honest workaround today is launching a successor campaign.

### What a production platform looks like

- **Onboarding:** a brand signs up, gets a Privy org wallet (policies: spend limits, scoped signers — the reward company's wallet is the only redeemer on its escrows), and wires/pre-funds a USDC operating account.
- **Campaign creation:** the wizard stays as-is; launch moves the required operating deposit from each company's USDC account into the campaign's prepaid balance (off-chain custody, on-chain escrow for rewards).
- **Operations:** purchase payloads flow merchant→enclave (batched at ingress), the DON settles claims, the paymaster sponsors gas, the platform meters everything per-campaign.
- **Billing:** monthly USDC invoice = platform fee (tiered per-redemption) + net gas/paymaster usage — itemized per campaign on the detail page's meter, which in production reads real receipts (below).

### Reliability: payload delivery guarantees (production)

In the demo a payload that fails between the POS and the workflow (connection drop, gateway timeout, DON hiccup) is simply lost — the clerk sees an error and moves on. That's unacceptable at retail volume: an unrecorded claim is a customer standing at the register who earned points they never receive. Production therefore treats payload delivery as a **reliability contract**, not a best-effort HTTP call:

- **Company-side message broker (expected):** the POS company's backend already runs a message queue (Kafka, RabbitMQ, SQS — every serious retail stack does). Purchase payloads are published to a queue with an **outbox pattern**: the POS writes the sale locally, a relay publishes to the broker, and a consumer submits to the CRE trigger with **at-least-once delivery + retries with backoff + dead-letter queue**. Nothing is silently dropped: a payload that can't settle stays visible in the DLQ until a human or a replay job resolves it. The platform's responsibility starts at the trigger boundary; the nullifier's per-receipt dedup means a redelivered duplicate is safely rejected, so at-least-once is the correct contract (not exactly-once).
- **Platform-managed outbox (optional add-on service):** for companies whose backend has no broker, the platform offers a managed ingestion endpoint: POST payloads to the platform, which persists them (own outbox table), submits to the workflow with the same retry/DLQ discipline, and exposes delivery status per payload (pending → accepted → settled / rejected / dead-lettered). This is the "we hold your hand" tier — a metered add-on (per-payload ingestion fee on top of the per-redemption fee, representative pennies) rather than a subscription, consistent with the usage-based pricing posture. It also gives the platform a clean place to batch-flush on the merchant's settlement tier.

### Campaign success metrics (with company consent)

The platform observes every payload's full lifecycle — submitted, accepted, DON verdict (eligible/rejected + reason: below-min-spend, cap-exhausted, not-allowed-day, replay), settled on-chain, or dropped — for its own billing. With the partner company's **explicit consent**, that same data becomes a **campaign analytics product**: a metrics page per campaign showing settle rate, rejection breakdown by reason, cap-utilization over time (per-user vs campaign-wide), effective payout per dollar of spend, redemption velocity after mint, and the funnel from purchases → eligible → settled → redeemed. The value proposition for the merchant is campaign evaluation: *why did 40% of payloads fail, and is that a config problem (min-spend too high), a targeting problem (customers not enrolled), or a healthy cost-control signal (caps doing their job)?* The demo already surfaces the raw ingredients — the DON verdict log (reason strings) and the escrow's live ledger — so this is presentation and consent-gating, not new data collection.

**Pricing posture:** an **opt-in add-on priced per campaign per month as a flat analytics fee** (representatively $20–50/month/campaign), deliberately *not* a platform-wide subscription — it stacks on the usage-based core (per-redemption + gas) as an optional line item, so a merchant who doesn't want analytics pays nothing extra. Consent is per-company and revocable; without it, the platform uses lifecycle data for billing only and the metrics page stays empty. Honesty note: the platform is the only party positioned to offer this (it sees the ingress), and the data is the company's own — the consent model treats it as theirs, licensed back, not the platform's to monetize silently.

### Merchant SDK: pre-submission eligibility filtering (with an unresolved metrics tension)

The billing model charges per **submitted** payload only when it reaches the workflow — so every obviously-ineligible transaction a POS pushes straight to the DON is money the company burns for a guaranteed rejection. If 50% of transactions fail eligibility (customers not enrolled, below min-spend, campaign not started), half the company's settlement spend buys nothing. The production answer is an **SDK** the platform ships for the company's POS/backend integration:

- **Connection + auth:** the SDK wraps platform connectivity end-to-end — API key or per-company secret key for signing payloads (the trigger's `authorizedKeys` story), campaign discovery, and submission through the batching/outbox machinery above. A POS integration is a few lines of config, not a protocol implementation.
- **Local pre-flight eligibility check:** the SDK mirrors the campaign's rule gates client-side — campaign window, min-spend, day-of-week, enrollment status — all knowable *before* submission. A transaction that fails locally is never forwarded: the company pays only for payloads that are **intended to go through**. The SDK verdict is **advisory** (the enclave remains the authoritative evaluator — callers can't be trusted, and cap checks against the live escrow ledger can only be approximated client-side), but the combination of SDK pre-filter + batch ingress means consensus cost scales with *likely-eligible* volume, not raw POS traffic. The existing per-claim economics note carries the same conclusion; the SDK is its product form.

**The unresolved tension — pre-filtering vs analytics:** every rejection the SDK filters locally is a rejection the platform never sees, so the rejection-reason breakdown that powers the metrics product goes dark exactly where the SDK is doing its job. "Below-min-spend: 40% of your transactions" becomes invisible — the company saves the settlement fee and loses the insight. Possible shapes, none settled:

- **Meter the filter anyway:** the SDK reports locally-rejected payloads (reason + count) to the platform out-of-band for analytics — a telemetry stream that costs the platform nothing to store but requires the same consent gate, and re-introduces a (much thinner) data path for a company that chose the SDK precisely to thin the pipeline.
- **Sampled submission:** the SDK forwards a configurable percentage of *locally-rejected* payloads anyway (e.g. 5%) as probe traffic, keeping the DON-side rejection distribution measurable at ~5% of the pre-filter savings given up.
- **Tiered honesty:** accept the gap — merchants who buy the SDK get cheaper settlement and explicitly trade away DON-grade rejection analytics; local rejection reasons are still logged client-side by the SDK and exportable, but they're the company's own numbers, not consensus-backed.

This is genuinely unresolved product design: the cost-optimal configuration (filter everything) and the analytics-optimal configuration (submit everything) are opposite ends of the same dial, and where a merchant sits should probably be their choice, priced accordingly — but the pricing for that dial isn't designed yet.

### Gas tracking & settlement in production (CDP Paymaster, USDC-settled)

In this demo the fee meter is a **model**: calibrated from real receipts (claims ≈ 268k gas, redeems ≈ 59k gas, measured on this escrow) multiplied by observed event counts, split by `feeSplitBps`. It is honest arithmetic, not per-transaction accounting — the app does not read `gasUsed` from individual receipts or track which wallet broadcast each tx.

In production, with an **ERC-4337 paymaster (e.g. Coinbase Developer Platform's)** sponsoring gas and settling in **USDC**, the tracking changes shape:

- The paymaster, not a platform EOA, sponsors every claim/redeem `UserOperation`. Gas is no longer an ETH transfer from a known wallet — it's a paymaster deposit drawdown, batched and priced in USDC.
- Tracking therefore reads the **paymaster's accounting** rather than tx senders: for each `UserOperation` the `userOpHash`, the actual `gasUsed`, the paymaster's per-op charge (which includes the **CDP paymaster's markup** — on the order of 10%, a per-op overhead over raw L2 gas), and the sponsoring smart-account (the campaign's escrow-side account) that the charge is attributed to. These accumulate into the per-campaign ledger that the Operating-fees card already models.
- The **10% paymaster markup is part of the fees the platform passes through** — it's inside the per-redemption price and the prepaid operating-deposit drawdown, not a separate line the platform absorbs. The tiered pricing above must clear raw gas + CRE execution + this markup at the *lowest* tier; the representative numbers are chosen so it plausibly does on an L2.
- Companies never hold ETH; their prepaid USDC balance is debited by settled, itemized usage (claims + redeems + batch overhead), with the itemization serving as the invoice.

### Deposit exhaustion, covered debt, and circuit-breaking

The demo's signed-balance model extends to production with explicit credit limits:

- **Coverage:** while a company's prepaid balance is positive, its share of usage draws it down. When it hits zero, the **platform covers further usage as a debt** — but only up to a cap: the platform's maximum exposure per company is bounded (representatively, its **initial operating deposit**, or half of it, as credit risk policy — the smaller the line, the less unsecured the platform is lending). Debt accrues **interest** (representatively, a monthly rate on outstanding covered balance) — covering a drained company is a credit line, not a charity.
- **Joint depletion:** if **both** companies' balances (plus debt headroom) are exhausted, the campaign has no funding — in production the platform **pauses the campaign's workflow** (`cre workflow pause` per-campaign; requires the one-workflow-per-campaign isolation model — a shared workflow serving N campaigns cannot be paused for one of them, which is the strongest argument for per-campaign deployments despite the operational overhead). Neither company deposits → claims stop at the ingress; rewards already minted remain spendable/redeemable only while gas is funded, which the pause halts — an explicit, surfaced state, never a silent failure.
- **Asymmetric top-up:** if only **one** company tops up, the campaign continues — the topping-up company's balance covers the flow, and the **other company's negative balance keeps tracking** (same mechanics as the demo's covered-debt: usage attributed by fee-split draws the non-paying company negative; interest accrues; settlement/campaign-end nets it out against rewards owed or refunds). The platform's debt cap still bounds the non-paying side's exposure — past it, the same pause applies.
- **Settlement:** at campaign end (or periodic), balances net out: refunds go to positive balances, debts (plus interest) are invoiced in USDC or offset against the company's other campaigns' balances on the platform.

## Notes (continued)

- **Nullifier privacy model — trust & security implications (read before pitching).** Each claim carries a nullifier `H(HMAC(CAMPAIGN_NULLIFIER_MASTER, campaignId) || userAnchor || timestamp)` — the payload timestamp (POS purchase time) is the per-receipt freshness element; its on-chain job is **anti-double-claim (one claim per purchase, not per user), not anonymity** — the claim event writes the recipient wallet address next to the nullifier, so recipient identity is public at claim time. The system is honestly **pseudonymous-but-linkable, never zero-knowledge**. What the single Vault-held master secret protects: no one outside the enclave (node operators, observers, even the platform itself in normal operation) can test whether a given wallet produced a given nullifier — the hash is one-way, so a nullifier cannot be *inverted* to a wallet; holding the secret would only enable *candidate testing* ("did wallet X produce nullifier N?"), turning the registry into a linkage oracle. Concretely, the parties who could ever run such brute-force identity-linking are the campaign participants (who already know their own customers) and whoever operates the payload ingress — third parties and observers cannot, which is the privacy claim we make and no more. Integrity is a separate mechanism entirely: forged claims are impossible even with the master leaked, because claims execute only through the DON-consensus report path (forwarder + workflow identity checks in `onReport`). Production hardening (deferred): derive with an epoch — `HMAC(master, epoch || campaignId)` — so rotating the master invalidates future linkage tests without touching campaign terms.
- **Redemption privacy — the earn-side is public, so we hide the spend-side (open problem + roadmap).** The privacy model above has an asymmetry: **earning is chain-visible by design** (`Claim(user, nullifier)` links wallet → campaign → amount), while **redemption is where real-world value gets exchanged** — and that's where linkage becomes dangerous. Concretely: a user redeeming points for a promo item ("500 Bpoints → entry in a Japan holiday draw") today emits `Redeem(user, amount)`, so anyone correlating the chain with the public promo can build a targeted picture (who holds loyalty wealth, who entered which draw) — a **spear-phishing / social-engineering surface**, not a hypothetical. Identity source doesn't change this: even with both companies on Privy DIDs, the *wallet* remains the on-chain actor and the DID↔wallet join happens in whichever company's backend holds it. Mitigations, honest about cost:
  - **Company-side redemption sweep (deployable today, no contract change).** Company B sweeps users' points to its own org wallet via `redeemFor` in batches and runs the *actual* reward fulfillment (draw entries, catalog, anything) entirely off-chain in its local database, keyed by its own identity source. The chain then shows only "B's wallet redeemed N points" — **what** each user got is invisible; only **that** value left the system. Trade-offs accepted: per-user trust moves off-chain (B's DB becomes the ledger of record for redemptions; the escrow still bounds total supply, so B can't over-burn, but can't prove per-user fairness on-chain), and `platformFeeBps` would accrue per sweep rather than per redemption. Note what this does **not** fix: the earn-side `Claim` events remain public, and each sweep still touches user wallets (batching amortizes timing but the wallet-level footprint stays).
  - **`batchRedeem(bytes32[] commitments)` (contract roadmap).** Replace per-user redemption with a batch call over **commitments** — e.g. `commit = H(user || salt)` where the user derives and keeps the salt — so the escrow enforces *supply conservation* (sum of committed amounts ≤ minted, double-spend via used-commitment flags) while the chain learns **nothing about who redeemed what**: no user address, no per-user event, just an aggregate burn against the campaign's total. Identity becomes exactly what the nullifier design already is: the enclave/company holds the keyed mapping, the chain holds a fresh-ness-checked commitment. "ZK-shaped but not ZK" — same one-way-hash discipline as the claim nullifiers, without a prover. Combined with the sweep, this closes the loop: earn-side linkage stays (inherent to crediting a wallet), but the redemption graph — the part attackers can weaponize against users — disappears from the chain entirely.
- **Earn-side economics: per-purchase DON consensus is the dominant cost (production roadmap — batch at the ingress).** Every submitted purchase currently costs a full workflow execution: HTTP trigger fires the enclave, the enclave reads campaign terms on-chain, all 10 nodes reach consensus, and a report is written through the forwarder — regardless of the verdict. In a real retail volume that's the money-leaker: if only half of POS transactions even *can* be eligible (customers who never enrolled; customers who know the campaign but opt out), the platform pays consensus-grade cost for a guaranteed `eligible=false` report, and campaign economics bleed on the ~50% that will never earn anything. **Mitigation shape — batch at the merchant/relay ingress, not in the enclave:** buffer incoming purchase payloads and flush a batch to the workflow on whichever comes first — **N transactions (e.g. 100) or T seconds (e.g. 30s)** — so the DON pays one consensus round per batch instead of per receipt. The enclave evaluates the whole batch in one execution (cheap: eligibility is pure stateless math against on-chain terms) and the forwarder delivers one aggregated report that the escrow's `onReport` applies as N credits. Honest costs that remain: batch payloads must be authenticated as a unit (one signature over the batch, same authorizedKeys path), the nullifier stays per-receipt so dedup is unchanged, and the escrow needs a multi-claim report format (batch ABI in `onReport`) — contract-side work, not just a relay change. **Throughput, not just cost:** batching also eases the workflow's latency floor — in the current staging registry a single execution takes ~10 seconds to finalize (trigger → terms read → 10-node consensus → forwarder write), so per-receipt submission caps sustainable throughput at ~6 tx/min *per workflow* and any burst queues serially behind that. A 200-tx / 60-second flush turns that same ~10s round into 200 verdicts per round — ~200x the effective throughput per consensus — with worst-case claim latency bounded by the flush window (60s), which is acceptable when the customer's receipt is already in hand and the credit lands in the background. The trade is honest from Chainlink's side too: fewer executions = fewer per-execution fees, but batch-flush pricing (per payload inside a consensus round, not per round) is exactly the model that makes high-volume retail workloads viable on CRE at all — without it, the economics cap the addressable market. **Why rule-testing belongs in the merchant SDK, not the enclave (longer term):** most ineligibility is knowable *before* submission (not enrolled, below min-spend, campaign not started — all local facts), so a thin merchant-side SDK that pre-filters obviously-ineligible receipts would cut submission volume at the source; the enclave remains the *authoritative* evaluator (the SDK verdict is advisory — callers can't be trusted), but the batch + SDK pre-filter combination means consensus cost scales with *likely-eligible* volume, not raw POS traffic.
- **Deposit handshake & redemption authority — Privy B2B model (demo implemented for deposits; platform retains redemption rights).** Launching a campaign is now a **two-party deposit handshake** (the wizard's "Launch Campaign" saves the draft and flips it to `PENDING_DEPOSIT`): each company connects a **Privy wallet** on the campaign page and sends its own share — `feeSplitBps% × MIN_OPERATING_DEPOSIT` for A, the complement for B (40:60 → A sends 0.004 ETH, B 0.006 ETH) — to the platform wallet. The backend **verifies each deposit on-chain** (exact tx: right `from`, right `to`, exact wei, confirmed receipt) before recording it, and the on-chain `createCampaign` fires automatically when **both** shares land — the escrow does not exist until the handshake completes. The **deposit deadline** = the campaign's start date (backend-enforced; a past or missing start sets it to now + 4h); if it lapses with a share missing, the campaign flips to `CANCELLED` (lazy check on read — nothing deployed, nothing to unwind on-chain; in production the deposited share would refund off-chain). **Demo honesty — no authentication:** the demo backend has no identity system, so wallet↔company attribution is claimed client-side; what makes the handshake real is the on-chain deposit verification (a claimed wallet that didn't send the exact tx is rejected). Production would bind Privy wallets to authenticated company identities (Privy access tokens verified server-side) and invite the counterparty by email + single-use code, with Privy's email OTP as the login. Privy's deeper production roles — **policies** as enforced spend limits (B's wallet capped at its computed share; the redemption wallet scoped to `redeemFor` on that escrow) and B's wallet becoming the **authorized redeemer** (factory `setRedeemer` passthrough) — remain roadmap; the demo retains the "Bypass deposit (DEMO ONLY)" button (no transfers, manual fee addresses, platform relay keeps redemption rights — a deliberate demo simplification, *not* a production trust model). **Multisig (open design decision, honestly deferred):** whether the org wallet becomes a **Privy quorum wallet** (e.g. 2-of-3 team approval for redemptions) is undecided; likewise undecided is whether B may grant **other trusted addresses** redemption rights on its behalf (the escrow's `authorizedRedeemers` whitelist exists on-chain, but a delegated redeemer can burn *any* user's spendable balance — a custody/product ruling, not just a contract function). Both are roadmap items; the demo neither claims nor fakes them. **Launch-side quorum is part of the same open decision:** the handshake records whichever wallet sends each share, so extending quorum to the deposit itself (a 2-of-3 org approval before a company's share leaves, vs. a single connected wallet) is an open product question, not a contract constraint.
- **Deposit hijack / first-mover spoofing (open security concern — platform auth solves it).** Because the demo backend has no authentication, campaign records (including deposit details) are readable and writable by anyone with API access, and a side's deposit slot is claimed by **whoever pays first**: an attacker who learns a pending campaign's id/deposit details can front-run the legitimate company by sending the exact share from their own wallet first. The on-chain verification happily accepts it — the tx is real, the amount exact — so the platform records the attacker's wallet as that side's fee account, the legitimate company's deposit is refused ("already deposited"), and the campaign launches with an attacker-controlled counterparty. Worse, the legit company's funds sit in a pending-deadline state (refundable only by the demo's manual unwind). Production closes this with the **platform's own authentication system, which doubles as the whitelist**: the company that *creates* the campaign is authenticated (Privy access token verified server-side), and the creator's identity implicitly pins its side — the first authenticated deposit for a side comes from a wallet bound to a known company account, and the backend enforces **side ↔ company binding** (the deposit must come from a wallet registered to the *expected* company for that side, established at campaign creation, not from whoever pays first). Concretely: at creation, the platform records "A = Acme's org, B = Globex's org"; an authenticated wallet belonging to neither org is rejected for either side regardless of paying the exact amount — the interception above becomes impossible because payment alone confers nothing without identity. For the counterparty (who may not have an account yet), the email + single-use invite code flow (mentioned above) binds them to their side before the deadline; unclaimed sides past the deadline cancel and refund. The demo cannot implement this without the identity layer it deliberately lacks — hence the concern is *documented*, not solved: anyone replaying the demo against real funds should treat deposit attribution as entirely untrusted.
- **PRODUCTION-LIMITED register (honest deferrals — blocked, not just labeled).** Each of these is *actually* non-functional (greyed-out/disabled UI + backend refusal), not a UI-only label:
  - **Rolling cap windows**: the wizard's Reset-basis selector disables "Rolling"; launches map it to a **lifetime** cap (on-chain window math is calendar-anchored only).
  - **Timezones**: only UTC is selectable; all other zones are disabled `<option>`s (on-chain windows anchor at UTC; translating HH:MM + weekday per zone — including DST — is future work).
  - **Digital / Physical merchandise**: the reward-type buttons are clickable and the badge fields view-only, but the **Launch button disables** ("Launch unavailable") and the backend `/launch` route **rejects** any non-`monetary` reward type with a 400 — a badge campaign cannot silently launch with zero-value terms. The on-chain caps already support badge mechanics (flat value 1 + per-tx cap 1 = one badge per purchase, whole-number clamps); only the launch-path wiring is missing.
  - Custom day-of-month (Month windows) and custom month/day (Year windows): fixed anchors (1st / Jan-1) only.
- **Payload flow: demo vs production.** In this demo the POS payload is submitted by the platform's own backend (the same service that hosts the wizard UI and Postgres) — a deliberate simplification so the whole stack runs locally. In **production the payload ingress is the POS company's backend calling the CRE workflow's HTTP trigger directly** (authenticated per-merchant); the platform operates the workflow + contracts, not the request path. This matters for the trust story: raw purchase data flows from the merchant to the enclave without transiting platform-operated infrastructure, and the enclave's verdict is the only thing the platform can observe. Per-campaign facts the enclave needs (min-spend, rate, caps, window) are read **on-chain from the factory at request time**; the per-user `earnedInWindow` is supplied by the caller in the demo and would be read from the escrow's on-chain ledger (or a merchant-signed accumulator) in production.