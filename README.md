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
On-chain `createCampaign()` wiring is still pending deployment, so escrow/reward
addresses stay null (honest boundary). See `backend/src/lib/launch.ts`. The
**Campaigns** page lists everything persisted.

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

Expected results (live on-chain terms, campaign window ≈ Sep 2026 → 2100):

```
onchain-1-pass.json              → APPROVE points=3 reason=ok           (10% of $30)
onchain-1-below-min.json         → REJECT points=0 reason=below-min-spend
onchain-1-cap-clamp.json         → APPROVE points=5 reason=ok           ($100 spend, 95 earned — clamped to cap)
onchain-1-cap-exhausted.json     → REJECT points=0 reason=cap-exhausted
onchain-1-after-end.json         → REJECT points=0 reason=after-campaign-end
onchain-2-pass.json              → APPROVE points=2 reason=ok           (10% of $40 spend — legacy payload predating the flat mechanic; campaign 2 is now flat $2, so re-running it today earns the $2 flat)
onchain-2-below-min.json         → REJECT points=0 reason=below-min-spend
flat-2-pass.json                 → APPROVE points=2 reason=ok           (flat $2, $30 spend)
flat-2-big-spend-same-earn.json  → APPROVE points=2 reason=ok           ($90 spend — same flat $2)
flat-2-below-min.json            → REJECT points=0 reason=below-min-spend
discount-3-pass.json             → APPROVE points=5 reason=ok           ($5 saved, $30 spend)
discount-3-small-spend.json      → APPROVE points=5 reason=ok           ($12 spend — same $5 saving)
discount-3-below-min.json        → REJECT points=0 reason=below-min-spend
```

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
| `CampaignFactory` | [`0xf60c0882605E3A43e4983f79D775ba333be69acC`](https://sepolia.basescan.org/address/0xf60c0882605E3A43e4983f79D775ba333be69acC) |
| `CampaignEscrow` (implementation; campaigns are EIP-1167 clones of it) | [`0xA64B521DdCF9C9A27B8E382c03BCa6b5646FfdF8`](https://sepolia.basescan.org/address/0xA64B521DdCF9C9A27B8E382c03BCa6b5646FfdF8) |
| CRE Forwarder (Chainlink's production forwarder, not ours) | [`0xF8344CFd5c43616a4366C34E3EEE75af79a74482`](https://sepolia.basescan.org/address/0xF8344CFd5c43616a4366C34E3EEE75af79a74482) |

**Demo campaigns (seeded via `contracts/script/SeedCampaigns.s.sol`)**

| # | Escrow clone | Reward (ERC-1155) |
|---|---|---|
| 1 | [`0x2888C3E4929ACC07Db30c24351e76abF342eB02b`](https://sepolia.basescan.org/address/0x2888C3E4929ACC07Db30c24351e76abF342eB02b) | [`0x1B2327Db86AD5508a0a40Dd64bdE00B9E88F4F44`](https://sepolia.basescan.org/address/0x1B2327Db86AD5508a0a40Dd64bdE00B9E88F4F44) |
| 2 | [`0x5fce7344bDEf336afffd16162238365B88C99da9`](https://sepolia.basescan.org/address/0x5fce7344bDEf336afffd16162238365B88C99da9) | [`0x7dd2133D85CF68fAB983B5D19E375cb3d44d3D86`](https://sepolia.basescan.org/address/0x7dd2133D85CF68fAB983B5D19E375cb3d44d3D86) |
| 3 | [`0xe741d92DEdFa3bC88B6765b7ceAe90F400F90a31`](https://sepolia.basescan.org/address/0xe741d92DEdFa3bC88B6765b7ceAe90F400F90a31) | [`0x362Ac52fc453d4a8DD76e3FA038C0C3c2A707d50`](https://sepolia.basescan.org/address/0x362Ac52fc453d4a8DD76e3FA038C0C3c2A707d50) |

**Key transactions**

| What | Tx |
|---|---|
| Deploy `CampaignEscrow` implementation | [`0xab892c2b6e7dd5ad85b13f0fec5f9bffe96e6b13fbf1d589c54d00dc7e958174`](https://sepolia.basescan.org/tx/0xab892c2b6e7dd5ad85b13f0fec5f9bffe96e6b13fbf1d589c54d00dc7e958174) |
| Deploy `CampaignFactory` | [`0xf3e5aa38a9dec9fcab8916519c9d02226854c6659b7e50106d8d4a45daf3d691`](https://sepolia.basescan.org/tx/0xf3e5aa38a9dec9fcab8916519c9d02226854c6659b7e50106d8d4a45daf3d691) |
| Seed campaign 1 | [`0x35f7648847c76c3ab26578547e1cf40d556707fa2add5adb9278cc0a80b1e0cc`](https://sepolia.basescan.org/tx/0x35f7648847c76c3ab26578547e1cf40d556707fa2add5adb9278cc0a80b1e0cc) |
| Seed campaign 2 | [`0x7edbf6ff8a190db43721cdb70ce925a174115cbb781216acbaaf0dda10383163`](https://sepolia.basescan.org/tx/0x7edbf6ff8a190db43721cdb70ce925a174115cbb781216acbaaf0dda10383163) |
| Seed campaign 3 | [`0xdcb3053feb95c8f09f6377e14dde72bd897a3f666ba77322f73283a3d10a5b87`](https://sepolia.basescan.org/tx/0xdcb3053feb95c8f09f6377e14dde72bd897a3f666ba77322f73283a3d10a5b87) |
| **End-to-end claim** (DON report → escrow `Claim` + ERC-1155 mint, `ReportProcessed success=true`) | [`0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2`](https://sepolia.basescan.org/tx/0x7903f511099c7c182dd017195dd35a45a0986b809c972d224c208e83ce65f9c2) |

**CRE workflow**: `wizard-staging`, workflow ID `004310b2e30e24106613ed62cd1dd2f75512e4ca0a3e9210be5932a397b1f162` (private registry, zone-a DON family, owner `0x8996097709d886abD468511BfB5A7279110e15d8`). Fired via the signed-relay path (see `backend/scripts/trigger.ts`).

Each payload is a request body `{ campaignId, userAnchor, merchantId, amountSpent, timestamp, earnedInWindow, items }`. `earnedInWindow` is how much the user already earned in the current reset window (0 after a rollover). Edit the JSON to test different scenarios (below/above min-spend, window edges, cap clamp/exhaustion). Use **distinct `userAnchor`s for approve cases** (duplicate anchors mint the same nullifier → on-chain duplicate-claim collision). `userAnchor` casing is free-form — the workflow normalizes it via viem's `getAddress()` before encoding (callers are not required to pre-checksum; this bug cost us a morning of "phantom" campaign-2 failures, see the EIP-55 note below).

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
- The workflow is **HTTP-triggered** and serves multiple campaigns from one binary: the config holds a `campaigns` map keyed by `campaignId`, and each request body selects the campaign. Production per-campaign isolation (one workflow per campaign for billing/blast-radius) is a *deployment* choice, not a code limitation — the same binary can be deployed once per campaign, each with its own config, or once for all.
- **New campaigns after a workflow is live**: no redeploy needed — the enclave reads campaign terms on-chain from the factory at request time (`campaigns(id)` via `evmClient.callContract` — the factory is the single stable "workflow master" address), so new campaigns register on-chain and are picked up with zero redeploys. Only the factory address (and the trigger's authorized keys) live in the workflow config.
- All on-chain writes via the CRE workflow (`EVMClient.writeReport`) are **live**: the deployed `CampaignEscrow` implements `IReceiver.onReport` (forwarder + workflow-identity checks) on Base Sepolia, and the workflow writes verdicts through the CRE Forwarder. The forwarder runs an **ERC-165 handshake before delivering** — the receiver must advertise `IReceiver` (`0x805f2132`, the bare `onReport(bytes,bytes)` selector, since inherited IERC165 functions are excluded from `type(IReceiver).interfaceId`) and `IERC165` (`0x01ffc9a7`). The escrow also distinguishes `workflowOwner` (the EOA claim path) from `reportOwner` (the CRE registry owner the forwarder stamps into report metadata; handover-able via `setReportOwner`).
- **EIP-55 checksum pitfall (fixed in workflow `004310b2…`)**: viem enforces address checksums at `encodeAbiParameters` time, so a non-checksummed `userAnchor` used to crash the workflow *after* eligibility — all 10 DON nodes agreed on APPROVE, then every node threw "Address must match its checksum counterpart" during report encoding → execution FAILURE with 3 of 5 events and no error surfaced on-chain (the forwarder never got a report to deliver). Nastier still, it was anchor-dependent, not campaign- or amount-dependent: `0xAAaA…001` passed only because its mixed-case prefix happened to be the *correct* checksum casing — pure luck, which is why the morning E2E worked while identical payloads with `…002/3/4/5` failed and masqueraded as a campaign-2 "flat-branch bug". Fix: `onHTTPTrigger` normalizes via `getAddress(request.userAnchor)` once after parsing, so any caller casing works and the nullifier (derived from address bytes, case-insensitive) is unchanged. Debug tip: `cre execution status <id>` prints a **Top-Level Errors** block that `grep Status` alone hides — that's where the viem error was.
- The `totalRedeemCap` and the reset-window *boundary* are carried in config and enforced by the caller/escrow; the workflow clamps the per-user cap against the caller-supplied `earnedInWindow`.
- **Gas & the operating deposit (production roadmap).** In this demo the platform wallet (an EOA) pays all gas directly and the `OperatingDeposit` is a *recorded* amount owed by each company to the platform reserves (settled off-chain — no ETH moves on-chain; the companies never touch wallets). In production the roadmap is: companies deposit **USDC** (via Stripe/Coinbase fiat rails) into platform custody, and an **ERC-4337 paymaster — e.g. Coinbase Developer Platform's, billed in USDC — sponsors all campaign gas**, so neither the platform nor the companies hold ETH and deposits are USDC-denominated (no bear-market exposure on held deposits). Trade-off, honestly stated: the DIY alternative (platform holds a small ETH float, tops up from USDC periodically) avoids paymaster fees and smart-account (4337) constraints but reintroduces an ETH treasury to manage; the paymaster buys zero-ETH friction at a per-tx fee. Either way, deposits are **custody, not revenue** — unspent deposits refund to the company at campaign end.
- **Pricing follow-through (business model).** The demo contract's `platformFeeBps` (10% uplift in the demo terms) exists as a *cost-plus buffer*: gas + an ETH-volatility premium so the platform doesn't bleed out while holding a float. Once gas is USDC-denominated (paymaster or periodic swap), that buffer's reason disappears and the platform fee drops to a thin value-based margin (e.g. ~1.5%, or 0% as a deliberate growth subsidy) — the fee is just a per-campaign parameter in `CampaignTerms`, so infrastructure savings flow straight through to customer pricing without code changes.
- **Nullifier privacy model — trust & security implications (read before pitching).** Each claim carries a nullifier `H(HMAC(CAMPAIGN_NULLIFIER_MASTER, campaignId) || userAnchor)`; its on-chain job is **anti-double-claim, not anonymity** — the claim event writes the recipient wallet address next to the nullifier, so recipient identity is public at claim time. The system is honestly **pseudonymous-but-linkable, never zero-knowledge**. What the single Vault-held master secret protects: no one outside the enclave (node operators, observers, even the platform itself in normal operation) can test whether a given wallet produced a given nullifier — the hash is one-way, so a nullifier cannot be *inverted* to a wallet; holding the secret would only enable *candidate testing* ("did wallet X produce nullifier N?"), turning the registry into a linkage oracle. Concretely: the parties who could ever run such brute-force identity-linking are the campaign participants (who already know their own customers) and whoever operates the payload ingress — third parties and observers cannot, which is the privacy claim we make and no more. Integrity is a separate mechanism entirely: forged claims are impossible even with the master leaked, because claims execute only through the DON-consensus report path (forwarder + workflow identity checks in `onReport`). Production hardening (deferred): derive with an epoch — `HMAC(master, epoch || campaignId)` — so rotating the master invalidates future linkage tests without touching campaign terms.
- **Payload flow: demo vs production.** In this demo the POS payload is submitted by the platform's own backend (the same service that hosts the wizard UI and Postgres) — a deliberate simplification so the whole stack runs locally. In **production the payload ingress is the POS company's backend calling the CRE workflow's HTTP trigger directly** (authenticated per-merchant); the platform operates the workflow + contracts, not the request path. This matters for the trust story: raw purchase data flows from the merchant to the enclave without transiting platform-operated infrastructure, and the enclave's verdict is the only thing the platform can observe. Per-campaign facts the enclave needs (min-spend, rate, caps, window) are read **on-chain from the factory at request time**; the per-user `earnedInWindow` is supplied by the caller in the demo and would be read from the escrow's on-chain ledger (or a merchant-signed accumulator) in production.