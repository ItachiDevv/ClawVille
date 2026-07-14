# Money Rails — Canonical Operations Reference

> **Last Audited: 2026-07-14** (finish-money-paths build closed; all four rails LIVE on prod at master `a0b43c1c`).
> Authoritative for agents and operators. Precedence: live code > this doc + ARCHITECTURE.md > memory files.
> Deep architecture detail lives in `ARCHITECTURE.md` entries (20) agent-pay, (21) CLV cashout, (22) reconcile-apply.
> NEVER print, log, or commit private key material. Pubkeys only in docs.

## 1. The four rails (all LIVE on prod, 2026-07-14)

| # | Rail | Entry point | Gate/flag | Proof |
|---|------|-------------|-----------|-------|
| ① | vCLAW on-ramp (USDC → BOUGHT vCLAW) | `POST /api/x402/topup/*` (x402 v2 exact-SVM) | `X402_TOPUP_NETWORK=mainnet` | $0.10 settled prod mainnet 2026-07-13 |
| ② | CLV cashout (settled checkouts → treasury CLV buys) | `clv-swap-live.ts` worker, boots when `CLV_SWAP_EXECUTE=true` | Flag ON prod 2026-07-14; live-worker start failure is boot-FATAL | Full ladder on mainnet-staging: checkout `5pjJ88QT…` → sweep `39xfgu3y…` → clip `5BeCGakJ…` ($0.10 → 1,483.50 CLV) |
| ③ | Reconcile APPLY (chain-evidence resolution of stuck rows) | `apps/api/scripts/x402/reconcile-checkouts.ts` | DOUBLE consent: env `RECONCILE_APPLY=true` (ON prod) **AND** CLI `--apply`. Env alone is inert. | 114 unit tests + clean live scans |
| ④ | Agent↔agent USDC pay + paid routes | `POST /api/agent-pay`; paid `POST /api/v2/agent/expert-consult` ($0.05), `GET /api/v2/agent/analytics/:agentId` ($0.01) | `AGENT_PAY_MAX_USD_CENTS` (default $10) | 13/13 smokes on devnet + mainnet-staging, on-chain conservation proof; PROTOCOL_VERSION 17 |

## 2. Wallet map (pubkeys only)

| Wallet | Pubkey | Purpose | Key custody | Gas notes |
|---|---|---|---|---|
| x402 merchant (BOTH envs — same keypair) | `79sH9jtT7EpWLCemadFZQb7sD1b6rCqkwTtSxDCViLLE` | Receives x402 settles; FEE PAYER for CLV sweeps | `treasury_wallets` purpose=`x402-merchant`, AES-256-GCM via `VANITY_ENCRYPTION_KEY` | **Gasless x402 settles deliver ZERO SOL** — keep ≥0.005 SOL or sweeps preflight-fail |
| Prod swap wallet | `HqpYMh6JE4CgSXh9EX9dzVfo7PUiwoxHaReoeZaJ1aPu` | Holds swept USDC; FEE PAYER for Jupiter clips | `treasury_wallets` purpose=`clv-swap` (prod DB) | Clip peak ≈0.0063 SOL (3 ATA rents in-flight @0.00204 each; CLV-ATA rent is one-time). Founder funded 0.05 on 2026-07-14 |
| Staging swap wallet | `9UsQV8814Z7PgDZfRK5YBBemfd3McDx9VrgW1uH6dj89` | Same, staging DB | `treasury_wallets` purpose=`clv-swap` (staging DB) | Holds ~0.003 SOL + 1,483.50 CLV + closable EURC ATA (~0.002 reclaimable) |
| Rescue / ops | `CQMkzDuaftQ1mW6ZkdEd3uGWdMaqio39VsY2TmyugRmz` | Founder's mainnet smoke/gas funds; signs LOCALLY only, never in containers | Plaintext offline `Desktop/clawville-agent-keys-backup-2026-07-01/.rotated-rescue-2026-07-04.json` + `.enc` in brain | Cannot send below its own 890,880-lamport rent-exempt floor |
| Prod SAP house | `ESpnsVdj2HkxPQgS3UVUvs2d5egUCDBwvMbpwPEhsm3m` | Live bounty house; **0.1 SOL staked PERPETUAL** (`2uiZBWyx…`) + ~0.06 register/pricing PDA rents | `.enc` in brain (`.house-coralia-PROD-mainnet-2026-07-12`) | **NEVER close/deregister the prod house** |
| Staging SAP house | (key: `.house-coralia-mainnet-2026-07-11.json.enc`) | Staging test house; 0.1 SOL mainnet stake + ~0.055 rents | `.enc` in brain | **FOUNDER DECISION 2026-07-14: stake STAYS for staging testing.** Exit requires a `close_agent` helper (unstake alone hits 6107 `StakeBelowMinimum`) — backlog |

## 3. Settle-machine invariants (bind every rail — do not regress)

1. **Atomic claim before custody**: CAS `planned→executing` with a fresh `claim_id` BEFORE any decrypt/sign/send.
2. **Capture-before-send**: signature durable in DB before the wire call.
3. **Ambiguous ⇒ reconcile, NEVER auto-retry**: any send whose money-state is unknown strands the row for evidence-based resolution.
4. **Chain evidence before mutating a captured fill**: `getSignatureStatuses`/parseTransactions NOT-FOUND **after blockhash expiry**, evidence stamped into the reset. Never guess claim ids — read them from the row.
5. **Zero-clip pre-SIGN stops self-release** (since `296651f0`): claim released to `planned` only when nothing signed, nothing sent, zero captured fills — enforced BOTH in-memory and by the DB CAS (`jsonb_array_length(tx_signatures)=0`).
6. **Gate algebra** (since `296651f0`): quote passes iff `outAmount ≥ oracleMid × (1 − CLV_SWAP_ORACLE_TOLERANCE_BPS)` (default 300); untrusted wire threshold must clear `mid × (1−t) × (1−slippage)`. NEVER compare Jupiter's threshold to an oracle floor built with the same slippage — the (1−s) cancels and the gate becomes unsatisfiable.
7. **Exactly-once by schema**: UNIQUE `source_ref`, partial-UNIQUE `tx_signature`, EARNED mints inside the settled-flip transaction.
8. **Money test ladder**: devnet-staging → mainnet-staging → mainnet-prod. Prod IS mainnet. No rung claimed without on-chain signatures.

## 4. Runbooks

### Gas funding (the #1 recurring ops failure)
Custodial fee payers start at 0 SOL by construction (gasless settles). Before enabling any flow where a wallet fee-pays:
- merchant ≥ 0.005 SOL; swap wallets ≥ 0.009 SOL first-clip / ≥ 0.004 after the CLV ATA exists.
- Fund from rescue via a one-off local script (pattern: `scratchpad fund-swap-sol.ts` — rescue key stays local, `PAYER_KEYPAIR_PATH` + `RPC_URL` env, prints only pubkeys+sig).
- Symptoms of missing gas: preflight `Attempt to debit an account but found no record of a prior credit` (0 SOL) or `Transfer: insufficient lamports N, need 2039280` (can't cover an ATA rent mid-tx).

### Stranded `clv_buy_queue` row (status=executing)
1. Read the row — get the ACTUAL `claim_id` and captured signature(s).
2. If zero fills: CAS back to planned (same shape as `releaseQueueClaim`).
3. If a fill is captured: prove the signature is chain-absent post-expiry (Helius parseTransactions), then evidence-gated reset that pins queue id + exact claim + exact dead signature and refuses on ANY drift. Run in-container (module resolution is script-location-relative; staging scripts can't run from scratchpad).

### Reconcile CLI
Read-only scan: `bun scripts/x402/reconcile-checkouts.ts` (in-container). Apply: env `RECONCILE_APPLY=true` + `--apply` (+ `--row <table>:<id>` to scope). Verdicts: capture+fulfill / refund-required (durable evidence, no auto-refund) / no-money (only after 24h grace + complete probe).

### Deploy + flip verification (prod)
Envs via Coolify tinker MODEL SETTER only (never raw DB writes). Deploy verify = `cv-wait-deploy.sh <app> <container-filter> <sha>` on the box; then confirm IN the container: `docker exec <c> env | grep <FLAG>` + boot log (`[clv-swap-live] LIVE worker started`) + `/health`. Queue rows lie; containers don't.

## 5. Backup / recovery chain (verified 2026-07-14)

- **Custodial wallets** (merchant, swap wallets, vanity): encrypted rows in `treasury_wallets` (prod + staging Supabase, paid tier). Master key `VANITY_ENCRYPTION_KEY` — identical both envs (sha256 `8366502e…`) — lives in Coolify env **and** (since 2026-07-14) escrowed: plaintext in the offline Desktop backup dir + AES-256-GCM `.enc` in the private brain repo (`agent-squad` `keys/agent-economy/`, commit `7782361`).
- **Standalone keypairs** (rescue, houses, mpl assets, facilitator feepayer, smoke set): 14/14 encrypted `.enc` in the brain (round-trip verified) + plaintext offline on Desktop. Decrypt key: `Desktop/clawville-backup-decryption-key.txt` (founder: keep a password-manager copy).
- Recovery: brain repo + decrypt key restores every standalone keypair; Supabase backup + `VANITY_ENCRYPTION_KEY` restores every custodial wallet.

## 6. Open follow-ups

- Gas-floor alerts: Telegram alert when a treasury fee payer drops below floor (hardening; today it fails safe but strands rows).
- Preflight-rejection classification: a `SendTransactionError` simulation failure is provably never-broadcast — executor could release instead of stranding (currently conservative-ambiguous).
- `close_agent` sap-client helper (backlog; staging stake intentionally kept).
- EARNED-cycling policy (founder decision pending): per-avatar EARNED cap before cash-out ships.
- Global cross-table signature-claim registry for normal settle writers (future hardening).
- MoonPay rail: blocked on keys.
