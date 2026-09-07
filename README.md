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

# Run the test suite (26 tests: claim, cap, nullifier, window,
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

# Unit tests (15 tests: 3 demo campaigns x 5 payloads — eligibility, window,
# min-spend, day-of-week, per-user cap, reset rollover, discount, digital)
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

Per-campaign POS payloads live in `wizard/test-payloads/` (one file per campaign × scenario). Campaign terms are **read on-chain at request time** from the deployed factory (`0xf60c0882605E3A43e4983f79D775ba333be69acC` on Base Sepolia, recorded in `contracts/deployments/base-sepolia.json`) — new campaigns are picked up with zero workflow redeploys.

## Deployed contracts (Base Sepolia, chain 84532)

Recorded in `contracts/deployments/base-sepolia.json` (rewritten by the deploy script). The demo is verified **end-to-end on-chain**: HTTP trigger → gateway ACCEPTED → DON consensus → forwarder delivers the report → escrow settles the claim (block [46501290](https://sepolia.basescan.org/tx/0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2)).

**Core contracts**

| Contract | Address |
|---|---|
| `CampaignFactory` | [`0xA563808fEb15469D67d671b60b437edD850A6196`](https://sepolia.basescan.org/address/0xA563808fEb15469D67d671b60b437edD850A6196) |
| `CampaignEscrow` (implementation; campaigns are EIP-1167 clones of it) | [`0xD42ae67201181c642Ca15854E136Ec9c2b1ECDf2`](https://sepolia.basescan.org/address/0xD42ae67201181c642Ca15854E136Ec9c2b1ECDf2) |
| CRE Forwarder (Chainlink's production forwarder, not ours) | [`0xF8344CFd5c43616a4366C34E3EEE75af79a74482`](https://sepolia.basescan.org/address/0xF8344CFd5c43616a4366C34E3EEE75af79a74482) |

**Demo campaigns (1–3 seeded via `contracts/script/SeedCampaigns.s.sol`; 4 = the first wizard-launched campaign)**

| # | Escrow clone | Reward (ERC-1155) |
|---|---|---|
| 1 | [`0x8f6aDcBf3a492a448e06eD2249146350b7535D33`](https://sepolia.basescan.org/address/0x8f6aDcBf3a492a448e06eD2249146350b7535D33) | [`0x5Ecc1B878032cb8185FCBd0079E9eCE34e32F92a`](https://sepolia.basescan.org/address/0x5Ecc1B878032cb8185FCBd0079E9eCE34e32F92a) |
| 2 | [`0x089b4D0d09884dF07332E3eA68009B304ac13FAc`](https://sepolia.basescan.org/address/0x089b4D0d09884dF07332E3eA68009B304ac13FAc) | [`0x4080376ab2Ae3BCd19387ac2Fcf10db4c7F66108`](https://sepolia.basescan.org/address/0x4080376ab2Ae3BCd19387ac2Fcf10db4c7F66108) |
| 3 | [`0xb4b3eEd3AD298aBDFB56A299839d6B7422F92273`](https://sepolia.basescan.org/address/0xb4b3eEd3AD298aBDFB56A299839d6B7422F92273) | [`0x537346037296fAc0Af2ed39eBd073f8946384aD3`](https://sepolia.basescan.org/address/0x537346037296fAc0Af2ed39eBd073f8946384aD3) |
| 4 | [`0xE63DC2d8f267C387B22f2ADa949D1B5486aA5c2B`](https://sepolia.basescan.org/address/0xE63DC2d8f267C387B22f2ADa949D1B5486aA5c2B) | [`0x9C83d9a60b7bbA0FB8838E62de14199AE513CB84`](https://sepolia.basescan.org/address/0x9C83d9a60b7bbA0FB8838E62de14199AE513CB84) |

**Key transactions**

| What | Tx |
|---|---|
| Deploy `CampaignEscrow` implementation | [`0xf7682d530f674c2244ecd57e1b4382b609fbf810f6438ae7b5e4405ae9429fa4`](https://sepolia.basescan.org/tx/0xf7682d530f674c2244ecd57e1b4382b609fbf810f6438ae7b5e4405ae9429fa4) |
| Deploy `CampaignFactory` | [`0x8d93a6636484fc79ecd5e39a4de28c74fbd0b423ff2184939e1d73f542e3c2f2`](https://sepolia.basescan.org/tx/0x8d93a6636484fc79ecd5e39a4de28c74fbd0b423ff2184939e1d73f542e3c2f2) |
| Seed campaign 1 | [`0x1b9ecd72145ea7cc4d652a251bf829c22636de6b61e1e19417c94368d0e9da76`](https://sepolia.basescan.org/tx/0x1b9ecd72145ea7cc4d652a251bf829c22636de6b61e1e19417c94368d0e9da76) |
| Seed campaign 2 | [`0x3f70d9aa3c2277cc08acdd6afd77eef28707d0f973d12dd04732d81408ff1114`](https://sepolia.basescan.org/tx/0x3f70d9aa3c2277cc08acdd6afd77eef28707d0f973d12dd04732d81408ff1114) |
| Seed campaign 3 | [`0xb752647ef503d804c40d3e9c3b5ac76de74be05c21c7e5786a72642e6e42a75a`](https://sepolia.basescan.org/tx/0xb752647ef503d804c40d3e9c3b5ac76de74be05c21c7e5786a72642e6e42a75a) |
| **End-to-end claim** (DON report → escrow `Claim` + ERC-1155 mint, `ReportProcessed success=true`) | [`0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2`](https://sepolia.basescan.org/tx/0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2) |

**CRE workflow**: `wizard-staging`, workflow ID `00e8a289eeef0a8f5d13b00b6d6a617853de65e2750309321d57e7b149c98f05` (gen-3: reads the gen-3 factory `0xA563…6196`; private registry, zone-a DON family, owner `0x8996097709d886abD468511BfB5A7279110e15d8`; nullifier includes the payload timestamp — see the privacy notes below). Fired via the signed-relay path (see `backend/scripts/trigger.ts`).

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

**4. Wire the backend**: put the new workflow ID in `.env` as `WORKFLOW_ID=0x…`, and set `WORKFLOW_OWNER_ADDRESS` (the claim-submitting EOA) so wizard-launched campaigns get the right `workflowOwner`.

**5. Register the seeded campaigns in the DB** (their on-chain state exists but Postgres has no rows yet):

```bash
curl -X POST localhost:4000/api/campaigns/seed
```

This reads escrow/reward addresses **live from the factory** by on-chain id and stores the mapping (`terms.onchainCampaignId`) — the payload route needs it, because the workflow addresses campaigns by the factory's sequential id, not the Postgres row id.

**6. Verify**: fire a test payload on a seeded campaign (`POST /api/campaigns/<id>/payload?await=1`) and check the escrow's `Claim` event on Basescan — a green DON verdict alone doesn't prove the escrow accepted the report.

Each payload is a request body `{ campaignId, userAnchor, merchantId, amountSpent, timestamp, earnedInWindow, items }`. `earnedInWindow` is how much the user already earned in the current reset window (0 after a rollover). Edit the JSON to test different scenarios (below/above min-spend, window edges, cap clamp/exhaustion). Repeat purchases by the SAME anchor are fine — the nullifier includes the payload `timestamp`, so each distinct purchase mints afresh (same wallet + same timestamp = same nullifier → on-chain duplicate-claim/replay rejection). `userAnchor` casing is free-form — the workflow normalizes it via viem's `getAddress()` before encoding (callers are not required to pre-checksum; this bug cost us a morning of "phantom" campaign-2 failures, see the EIP-55 note below).

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

- **N-participant campaign support (production).** This demo UI and local backend hardcode a **2-participant** model: Company A (POS) and Company B (reward), with a single `feeSplitBps` for Company A and Company B receiving the remainder. The underlying contracts (`CampaignFactory` / `CampaignEscrow`) and the CRE workflow are **already N-party** (see the `campaigns` map keyed by `campaignId`, the `participants` array in the frontend, and the spec's N-party design), but the demo's fee-split input, the wizard's two-brand `description.participants`, and the launch validation only exercise the 2-party case. In production this would generalize to a per-participant fee-share array and an arbitrary number of participating brands.
- `runtime.log` calls are for simulation/testing only and **must be removed** before production (enclave logs are hidden in real execution anyway).
- **HTTP-trigger authentication & key-reuse vulnerability (current infrastructure, deliberately accepted for the demo).** The workflow's HTTP trigger requires every incoming request to carry an **ECDSA signature from an authorized key** (`authorizedKeys` in the trigger config; the DON verifies it before firing the enclave). The authorized signer is the **platform relay backend**: merchants authenticate to the platform with API keys only (no-web3-for-partners holds), and the relay signs each workflow request before submitting it. The demo vulnerability: the relay signs with the **same burner EOA that deploys contracts and owns the workflows** (`CRE_ETH_PRIVATE_KEY`). Consequences, honestly stated — (1) **capability conflation**: a compromise of that one key lets an attacker deploy malicious contracts, register workflows, AND forge eligibility payloads (minting arbitrary cashback/points to any wallet, since the enclave trusts payload facts like `amountSpent`/`earnedInWindow` from the authorized signer); (2) **no key rotation boundary**: rotating after an incident means re-deploying contracts + workflows, not just swapping an env var; (3) single-key blast radius across every campaign the shared workflow serves. Production roadmap: a **dedicated relay keypair** whose only privilege is firing workflow triggers (public key in `authorizedKeys`, private key in the backend's secret store, never used on-chain); longer term, **one workflow per campaign** with per-campaign authorized keys so a leaked trigger key's blast radius is a single campaign. Forged on-chain claims are still bounded by the DON-consensus report path (`onReport` forwarder + workflow-identity checks) — the key compromise mints *workflow-mediated* fraud, not arbitrary contract calls.
- The workflow is **HTTP-triggered** and serves multiple campaigns from one binary: the config holds a `campaigns` map keyed by `campaignId`, and each request body selects the campaign. Production per-campaign isolation (one workflow per campaign for billing/blast-radius) is a *deployment* choice, not a code limitation — the same binary can be deployed once per campaign, each with its own config, or once for all. Per-campaign isolation also buys **operational independence**: each campaign can be paused, upgraded, or have its workflow logic amended (new eligibility rules, reward mechanics) by redeploying just its own workflow — without touching, or risking, any other campaign's live pipeline; with the shared binary, a logic amendment is an all-campaign redeploy.
- **New campaigns after a workflow is live**: no redeploy needed — the enclave reads campaign terms on-chain from the factory at request time (`campaigns(id)` via `evmClient.callContract` — the factory is the single stable "workflow master" address), so new campaigns register on-chain and are picked up with zero redeploys. Only the factory address (and the trigger's authorized keys) live in the workflow config.
- All on-chain writes via the CRE workflow (`EVMClient.writeReport`) are **live**: the deployed `CampaignEscrow` implements `IReceiver.onReport` (forwarder + workflow-identity checks) on Base Sepolia, and the workflow writes verdicts through the CRE Forwarder. The forwarder runs an **ERC-165 handshake before delivering** — the receiver must advertise `IReceiver` (`0x805f2132`, the bare `onReport(bytes,bytes)` selector, since inherited IERC165 functions are excluded from `type(IReceiver).interfaceId`) and `IERC165` (`0x01ffc9a7`). The escrow also distinguishes `workflowOwner` (the EOA claim path) from `reportOwner` (the CRE registry owner the forwarder stamps into report metadata; handover-able via `setReportOwner`).
- **EIP-55 checksum pitfall (fixed in workflow `004310b2…`)**: viem enforces address checksums at `encodeAbiParameters` time, so a non-checksummed `userAnchor` used to crash the workflow *after* eligibility — all 10 DON nodes agreed on APPROVE, then every node threw "Address must match its checksum counterpart" during report encoding → execution FAILURE with 3 of 5 events and no error surfaced on-chain (the forwarder never got a report to deliver). Nastier still, it was anchor-dependent, not campaign- or amount-dependent: `0xAAaA…001` passed only because its mixed-case prefix happened to be the *correct* checksum casing — pure luck, which is why the morning E2E worked while identical payloads with `…002/3/4/5` failed and masqueraded as a campaign-2 "flat-branch bug". Fix: `onHTTPTrigger` normalizes via `getAddress(request.userAnchor)` once after parsing, so any caller casing works and the nullifier (derived from address bytes, case-insensitive) is unchanged. Debug tip: `cre execution status <id>` prints a **Top-Level Errors** block that `grep Status` alone hides — that's where the viem error was.
- The `totalRedeemCap` and the reset-window *boundary* are carried in config and enforced by the caller/escrow; the workflow clamps the per-user cap against the caller-supplied `earnedInWindow`.
- **Gas & the operating deposit (production roadmap).** In this demo the platform wallet (an EOA) pays all gas directly and the `OperatingDeposit` is each company's **prepaid operating-fee balance** — split per `feeSplitBps` at creation and drawn down by that company's share of campaign gas (the detail page's Operating-fees card tracks this live, including a signed balance: if one company's share runs dry mid-campaign, the other's deposit fronts the difference and the UI flags the covered amount as a **debt the drained company owes at settlement/campaign end** — keeping the campaign running never silently transfers cost). In production the roadmap is: companies deposit **USDC** (via Stripe/Coinbase fiat rails) into platform custody, and an **ERC-4337 paymaster — e.g. Coinbase Developer Platform's, billed in USDC — sponsors all campaign gas**, so neither the platform nor the companies hold ETH and deposits are USDC-denominated (no bear-market exposure on held deposits). Trade-off, honestly stated: the DIY alternative (platform holds a small ETH float, tops up from USDC periodically) avoids paymaster fees and smart-account (4337) constraints but reintroduces an ETH treasury to manage; the paymaster buys zero-ETH friction at a per-tx fee. Either way, deposits are **custody, not revenue** — unspent (net-positive) balances refund to the company at campaign end, after netting any covered-debt.
- **Pricing follow-through (business model).** The demo contract's `platformFeeBps` (10% uplift in the demo terms) exists as a *cost-plus buffer*: gas + an ETH-volatility premium so the platform doesn't bleed out while holding a float. Once gas is USDC-denominated (paymaster or periodic swap), that buffer's reason disappears and the platform fee drops to a thin value-based margin (e.g. ~1.5%, or 0% as a deliberate growth subsidy) — the fee is just a per-campaign parameter in `CampaignTerms`, so infrastructure savings flow straight through to customer pricing without code changes.
- **Nullifier privacy model — trust & security implications (read before pitching).** Each claim carries a nullifier `H(HMAC(CAMPAIGN_NULLIFIER_MASTER, campaignId) || userAnchor || timestamp)` — the payload timestamp (POS purchase time) is the per-receipt freshness element; its on-chain job is **anti-double-claim (one claim per purchase, not per user), not anonymity** — the claim event writes the recipient wallet address next to the nullifier, so recipient identity is public at claim time. The system is honestly **pseudonymous-but-linkable, never zero-knowledge**. What the single Vault-held master secret protects: no one outside the enclave (node operators, observers, even the platform itself in normal operation) can test whether a given wallet produced a given nullifier — the hash is one-way, so a nullifier cannot be *inverted* to a wallet; holding the secret would only enable *candidate testing* ("did wallet X produce nullifier N?"), turning the registry into a linkage oracle. Concretely, the parties who could ever run such brute-force identity-linking are the campaign participants (who already know their own customers) and whoever operates the payload ingress — third parties and observers cannot, which is the privacy claim we make and no more. Integrity is a separate mechanism entirely: forged claims are impossible even with the master leaked, because claims execute only through the DON-consensus report path (forwarder + workflow identity checks in `onReport`). Production hardening (deferred): derive with an epoch — `HMAC(master, epoch || campaignId)` — so rotating the master invalidates future linkage tests without touching campaign terms.
- **Redemption privacy — the earn-side is public, so we hide the spend-side (open problem + roadmap).** The privacy model above has an asymmetry: **earning is chain-visible by design** (`Claim(user, nullifier)` links wallet → campaign → amount), while **redemption is where real-world value gets exchanged** — and that's where linkage becomes dangerous. Concretely: a user redeeming points for a promo item ("500 Bpoints → entry in a Japan holiday draw") today emits `Redeem(user, amount)`, so anyone correlating the chain with the public promo can build a targeted picture (who holds loyalty wealth, who entered which draw) — a **spear-phishing / social-engineering surface**, not a hypothetical. Identity source doesn't change this: even with both companies on Privy DIDs, the *wallet* remains the on-chain actor and the DID↔wallet join happens in whichever company's backend holds it. Mitigations, honest about cost:
  - **Company-side redemption sweep (deployable today, no contract change).** Company B sweeps users' points to its own org wallet via `redeemFor` in batches and runs the *actual* reward fulfillment (draw entries, catalog, anything) entirely off-chain in its local database, keyed by its own identity source. The chain then shows only "B's wallet redeemed N points" — **what** each user got is invisible; only **that** value left the system. Trade-offs accepted: per-user trust moves off-chain (B's DB becomes the ledger of record for redemptions; the escrow still bounds total supply, so B can't over-burn, but can't prove per-user fairness on-chain), and `platformFeeBps` would accrue per sweep rather than per redemption. Note what this does **not** fix: the earn-side `Claim` events remain public, and each sweep still touches user wallets (batching amortizes timing but the wallet-level footprint stays).
  - **`batchRedeem(bytes32[] commitments)` (contract roadmap).** Replace per-user redemption with a batch call over **commitments** — e.g. `commit = H(user || salt)` where the user derives and keeps the salt — so the escrow enforces *supply conservation* (sum of committed amounts ≤ minted, double-spend via used-commitment flags) while the chain learns **nothing about who redeemed what**: no user address, no per-user event, just an aggregate burn against the campaign's total. Identity becomes exactly what the nullifier design already is: the enclave/company holds the keyed mapping, the chain holds a fresh-ness-checked commitment. "ZK-shaped but not ZK" — same one-way-hash discipline as the claim nullifiers, without a prover. Combined with the sweep, this closes the loop: earn-side linkage stays (inherent to crediting a wallet), but the redemption graph — the part attackers can weaponize against users — disappears from the chain entirely.
- **Payload flow: demo vs production.** In this demo the POS payload is submitted by the platform's own backend (the same service that hosts the wizard UI and Postgres) — a deliberate simplification so the whole stack runs locally. In **production the payload ingress is the POS company's backend calling the CRE workflow's HTTP trigger directly** (authenticated per-merchant); the platform operates the workflow + contracts, not the request path. This matters for the trust story: raw purchase data flows from the merchant to the enclave without transiting platform-operated infrastructure, and the enclave's verdict is the only thing the platform can observe. Per-campaign facts the enclave needs (min-spend, rate, caps, window) are read **on-chain from the factory at request time**; the per-user `earnedInWindow` is supplied by the caller in the demo and would be read from the escrow's on-chain ledger (or a merchant-signed accumulator) in production.