# Money Rails — Canonical Operations Reference

> **Last Audited: 2026-07-15** (x402 reconcile pass: checkout receipt ownership now commits with durable signature capture before fulfillment; independent verification binds the exact signed transaction message. The generic metered `/api/v2/agent/*` paywall stays ENABLED when `X402_ENABLED=true` (prod + staging) — it does NOT yet claim its settled signature into the global receipt registry; that capture-first wiring is a tracked Wave-2 follow-up, NOT a reason to gate or disable the paywall. Migrations `0032`–`0039` applied to staging + deployed at `2281d1bf`; live DB-guard smoke passed.)
> **Last Audited: 2026-07-14** (CLV swap simulation now includes every writable v0/ALT account in its snapshots, credits rent only when an account parses as an initialized wallet-authority SPL/Token-2022 account, and accepts the mandatory one-time Pump.fun `user_volume_accumulator` creation rent only for the swap wallet's exact derivable PDA when newly created, Pump-program-owned, and no larger than 2.5M lamports. The `priorityFeeLamports + 10,000` fee bound is unchanged. The broader CLV cashout mechanism correction remains local and awaiting Fable review; the E3 captured-delivery reconcile sweep also remains local. Uncommitted/un-deployed, no migration/sign-off. E1/E2 + E3 remain built locally and GATED DARK. The prior four rails remain live at master `a0b43c1c`).
> Authoritative for agents and operators. Precedence: live code > this doc + ARCHITECTURE.md > memory files.
> Deep architecture detail lives in `ARCHITECTURE.md` entries (20) agent-pay, (21)/(26) CLV cashout, (22) reconcile-apply, and (25) E1/E2/E3.
> NEVER print, log, or commit private key material. Pubkeys only in docs.

## 1. Money rails

| # | Rail | Entry point | Gate/flag | Proof |
|---|------|-------------|-----------|-------|
| ① | vCLAW on-ramp (USDC → BOUGHT vCLAW) | `POST /api/x402/topup/*` (x402 v2 exact-SVM) | `X402_TOPUP_NETWORK=mainnet` | $0.10 settled prod mainnet 2026-07-13 |
| ② | CLV cashout (settled checkouts → treasury CLV buys) | `clv-swap-live.ts` worker, boots when `CLV_SWAP_EXECUTE=true`; one Jupiter USDC→CLV tx per ≤$100 clip | Flag ON prod 2026-07-14; live-worker start failure is boot-FATAL. Mechanism correction is local/un-deployed | Historical full ladder on mainnet-staging: checkout `5pjJ88QT…` → sweep `39xfgu3y…` → clip `5BeCGakJ…` ($0.10 → 1,483.50 CLV); this is not sign-off on the local correction |
| ③ | Reconcile APPLY (chain-evidence resolution of stuck rows) | `apps/api/scripts/x402/reconcile-checkouts.ts` | DOUBLE consent: env `RECONCILE_APPLY=true` (ON prod) **AND** CLI `--apply`. Env alone is inert. | 114 unit tests + clean live scans |
| ④ | Agent↔agent USDC pay; metered routes quarantined | `POST /api/agent-pay`; `/api/v2/agent/*` paywall is FEATURE-GATED | `AGENT_PAY_MAX_USD_CENTS` (default $10); `X402_ENABLED=true` is crash-loud refused until metered settlements have a durable capture-first receipt machine | Agent-pay: 13/13 smokes on devnet + mainnet-staging, on-chain conservation proof; metered routes: no paid traffic may be enabled |
| E3 | EARNED vCLAW exit → market-bought CLV → earner custody | `POST /api/tokenomics/redeem`; `GET /api/tokenomics/redeem/:id`; gated worker | **BUILT-GATED**: route + service require literal `TOKENOMICS_REDEEM_ENABLED=true`; default OFF. G2 funded adversarial smoke + G3 founder legal/MSB/MT/KYC/sanctions clearance required | Verification, staging/mainnet evidence, and founder sign-off pending |

## 2. Wallet map (pubkeys only)

| Wallet | Pubkey | Purpose | Key custody | Gas notes |
|---|---|---|---|---|
| x402 merchant (BOTH envs — same keypair) | `79sH9jtT7EpWLCemadFZQb7sD1b6rCqkwTtSxDCViLLE` | Receives x402 settles; FEE PAYER for CLV sweeps | `treasury_wallets` purpose=`x402-merchant`, AES-256-GCM via `VANITY_ENCRYPTION_KEY` | **Gasless x402 settles deliver ZERO SOL** — keep ≥0.005 SOL or sweeps preflight-fail |
| Prod swap wallet | `HqpYMh6JE4CgSXh9EX9dzVfo7PUiwoxHaReoeZaJ1aPu` | Holds swept USDC; FEE PAYER for Jupiter clips | `treasury_wallets` purpose=`clv-swap` (prod DB) | Clip peak ≈0.0063 SOL (3 ATA rents in-flight @0.00204 each; CLV-ATA rent is one-time). Founder funded 0.05 on 2026-07-14 |
| Staging swap wallet | `9UsQV8814Z7PgDZfRK5YBBemfd3McDx9VrgW1uH6dj89` | Same, staging DB | `treasury_wallets` purpose=`clv-swap` (staging DB) | Holds ~0.003 SOL + 1,483.50 CLV + closable EURC ATA (~0.002 reclaimable) |
| Rescue / ops | `CQMkzDuaftQ1mW6ZkdEd3uGWdMaqio39VsY2TmyugRmz` | Founder's mainnet smoke/gas funds; signs LOCALLY only, never in containers | Plaintext offline `Desktop/clawville-agent-keys-backup-2026-07-01/.rotated-rescue-2026-07-04.json` + `.enc` in brain | Cannot send below its own 890,880-lamport rent-exempt floor |
| Prod SAP house | `ESpnsVdj2HkxPQgS3UVUvs2d5egUCDBwvMbpwPEhsm3m` | Live bounty house; **0.1 SOL staked PERPETUAL** (`2uiZBWyx…`) + ~0.06 register/pricing PDA rents | `.enc` in brain (`.house-coralia-PROD-mainnet-2026-07-12`) | **NEVER close/deregister the prod house** |
| Staging SAP house | (key: `.house-coralia-mainnet-2026-07-11.json.enc`) | Staging test house; 0.1 SOL mainnet stake + ~0.055 rents | `.enc` in brain | **FOUNDER DECISION 2026-07-14: stake STAYS for staging testing.** Exit requires a `close_agent` helper (unstake alone hits 6107 `StakeBelowMinimum`) — backlog |
| EARNED backing custody | **Provision-time unknown; exactly one row per DB** | `treasury_wallets` purpose=`earned-backing`; holds outside USDC backing + retained 4.44% exit fees; funds E3 buy principal | AES-256-GCM custody pattern; partial-UNIQUE singleton forbids silent rotation | Keep ≥0.005 SOL **plus tx fee + destination USDC ATA rent**. Rotation forbidden until on-chain drain/migrate proof and atomic custody-reference update |

## 3. Settle-machine invariants (bind every rail — do not regress)

1. **Atomic claim before custody**: CAS `planned→executing` with a fresh `claim_id` BEFORE any decrypt/sign/send.
2. **Capture-before-send**: signature durable in DB before the wire call.
3. **Ambiguous ⇒ reconcile, NEVER auto-retry**: any send whose money-state is unknown strands the row for evidence-based resolution.
4. **Chain evidence before mutating a captured fill**: `getSignatureStatuses`/parseTransactions NOT-FOUND **after blockhash expiry**, evidence stamped into the reset. Never guess claim ids — read them from the row.
5. **Zero-clip pre-SIGN stops self-release** (since `296651f0`): claim released to `planned` only when nothing signed, nothing sent, zero captured fills — enforced BOTH in-memory and by the DB CAS (`jsonb_array_length(tx_signatures)=0`).
6. **Single Jupiter clip contract**: each clip is `min(remaining, $100 USDC)` and uses ONE ExactIn USDC→CLV `/quote` + `/swap`. Jupiter may use SOL internally and owns wrapping/unwrapping in that same transaction; ClawVille never constructs wSOL or split legs. DexScreener is `/dash` telemetry only, never a buy gate or sizing input. Refuse a quote whose `priceImpactPct` exceeds `CLV_SWAP_MAX_IMPACT_BPS`; bind the decoded Jupiter instruction's exact input, quoted output, slippage, and zero platform fee so its minimum output is enforced on-chain. The decoder reads those arguments from the trailing 19 Anchor bytes of `route`/`sharedAccountsRoute`, route-agnostically and without an AMM-variant allowlist.
7. **Pre-sign transaction proof**: v0 payer/single-signer/no-pre-signature remain mandatory; every idempotent ATA setup must create a canonical ATA owned by the swap wallet; priority cost is bounded by `cuLimit × cuPrice / 1e6 ≤ 1,000,000 lamports` with `cuLimit ≤ 1.4M`; no foreign writable token account controlled by the wallet is allowed. Before signing, the authoritative economic simulation must prove CLV ATA increase ≥ decoded minimum-out, USDC ATA decrease ≤ the clip, and no other wallet-owned token account decreases. Its owned-lamport aggregate snapshots every writable v0/ALT account and credits rent parked in any initialized token account whose authority is the swap wallet, including CPI-created multi-hop intermediates. It also accepts the mandatory one-time Pump.fun `user_volume_accumulator` creation rent only when the writable account is the exact PDA derived from the swap wallet, was absent pre-transaction, is Pump-AMM-program-owned after simulation, and holds at most 2,500,000 lamports. Foreign-authority, other non-token, mint/multisig, and program accounts receive no credit, and the fee bound remains `priorityFeeLamports + 10,000`. A closed transient wallet ATA (for example wrap/unwrap wSOL) is treated as gone post-simulation, while canonical USDC/CLV closure and any token or lamport drain remain rejected. Any failure is pre-sign and releases only an empty claim.
8. **Exactly-once by schema**: UNIQUE `source_ref`, partial-UNIQUE `tx_signature`, EARNED mints inside the settled-flip transaction.
9. **Money test ladder**: devnet-staging → mainnet-staging → mainnet-prod. Prod IS mainnet. No rung claimed without on-chain signatures.
10. **EARNED dollar conservation**: 1 vCLAW = 10,000 micro-USDC. Redeemable means EARNED ∧ house-backed ∧ payer-verified ∧ vested ∧ not clawed. Current on-chain custody must cover network-partitioned outstanding backing + retained fees + unswept buy principal; captured-ambiguous funding makes solvency indeterminate. Admission and funding share one custody mutex + Postgres advisory lock.
11. **No dead economics**: no entry rake, treasury split, dividend pool, pro-rata P/E rate, 20% reserve, or fixed CLV anchor. The sole loop fee is 444 bps at exit; CLV floats.
12. **Global signature ownership at capture**: a signature receipt commits with the rail's durable capture, before rollback-prone fulfillment. The generic `@x402/hono` metered middleware cannot currently satisfy this invariant and is fail-boot gated when `X402_ENABLED=true`.

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

### Provision and audit EARNED backing (before either gate can move)

1. Provision exactly one encrypted `treasury_wallets(purpose='earned-backing')` row in each environment; record only its pubkey here after provisioning. Never reuse merchant/swap custody.
2. Fund the matching network with exact external USDC backing and the SOL gas floor above. Production imports are mainnet-only. Staging devnet E1 is for sybil/wash/state-machine smoke only and is never E3-redeemable; a full delivery smoke is a controlled mainnet-staging operation after legal/ops approval.
3. Run the gated solvency audit. Require on-chain USDC ≥ remaining `earned_backing` + retained exit fees + unswept buy principal. A swept row without signature/confirmed slot, or captured ambiguous funding, is `solvent=false`; resolve by chain evidence only.
4. Keep both gates OFF if the singleton is missing, mixed, short, RPC context predates the latest confirmed sweep slot, or any conservation query disagrees.

Run the read-only one-shot audit from the repository root in an **isolated child
process**. The literal flag is required only because the audit service itself is
double-gated; these commands do not change Coolify/server configuration, open
routes, start workers, sign, send, or mutate the database.

PowerShell:

```powershell
powershell.exe -NoProfile -Command '$env:TOKENOMICS_REDEEM_ENABLED="true"; bun apps/api/scripts/tokenomics/audit-earned-backing.ts'
```

POSIX shell:

```sh
TOKENOMICS_REDEEM_ENABLED=true bun apps/api/scripts/tokenomics/audit-earned-backing.ts
```

Exit `0` means solvent with zero structural/funding indeterminacy; exit `1`
means insolvent or indeterminate; exit `2` means the isolated gate was absent or
the audit could not complete. Output is restricted to the custody pubkey,
integer-atomic amount totals, and status/reason fields. Keep the server's
`TOKENOMICS_REDEEM_ENABLED` OFF until G2 + G3 are independently cleared.

### E3 redemption and reconcile

`requested → debited → buy_queued → bought → delivering → delivered`; pre-money refusal is `refused`, ambiguity is `reconcile`. Debit + exact 444-bps fee (`amountVclaw × 444`) + buy principal (`× 9556`) + backing consumption are one transaction. `enqueueClvBuy(reason='earned_redemption', source_ref=redemptionId)` is exactly-once. Funding is classic USDC `TransferChecked` from backing custody to swap; delivery is Token-2022 CLV `TransferChecked` from swap to the server-resolved earner ATA. Capture signature before send; any ambiguous send/confirm is reconcile and never auto-retried. Delivery uses the conservative floor/SUM of confirmed queue `outAmountAtomic` values—house-favorable rounding, never an optimistic quote. Swap must retain ≥0.004 SOL plus tx fee + destination CLV ATA rent.

#### Captured-delivery reconcile sweep

The gated worker re-checks a bounded oldest-first batch of `reconcile` rows marked `delivery_confirm_ambiguous` (the captured send could not be conclusively confirmed/recorded) or `stale_captured_delivery` (a captured delivery outlived its worker claim). It promotes a row to `delivered` only when the captured mainnet transaction proves an exact $CLAWVILLE credit to the captured delivery wallet and, when the swap-wallet balance appears in transaction metadata, the matching exact debit. This is strictly promote-only: it never re-sends, resets to `bought`, or clears the captured signature. Failed, missing, pruned, malformed, or economically mismatched evidence remains `reconcile` for manual review.

### E1/E2 verification and claw-back

Imports require a named `ADMIN_USER_IDS` Lucia admin, exact confirmed USDC transfer into backing custody, current same-network solvency, and zero entry rake. Mints start pending and spendable; the async verifier resolves same-network payer history/first funder, merges payer siblings into one per-(cluster,earner,epoch) cap, and transitions to verified or rejected. Rejected backing is released while the units remain spendable/unbacked. Admin claw-back is idempotent: debit available EARNED, durably record any deficit, mark the event clawed, and release only unconsumed backing.

### Rail ④ future re-plumb

Today ④ pays USDC directly to the recipient wallet, so its EARNED lot is explicitly `backing='none'`: spendable, never redeemable. To make future ④ earnings cashable, route payer USDC to `earned-backing` custody and give the recipient only a backed EARNED mint after settlement. Do not mark current direct-recipient payments backed.

## 5. Backup / recovery chain (verified 2026-07-14)

- **Custodial wallets** (merchant, swap wallets, vanity): encrypted rows in `treasury_wallets` (prod + staging Supabase, paid tier). Master key `VANITY_ENCRYPTION_KEY` — identical both envs (sha256 `8366502e…`) — lives in Coolify env **and** (since 2026-07-14) escrowed: plaintext in the offline Desktop backup dir + AES-256-GCM `.enc` in the private brain repo (`agent-squad` `keys/agent-economy/`, commit `7782361`).
- **Standalone keypairs** (rescue, houses, mpl assets, facilitator feepayer, smoke set): 14/14 encrypted `.enc` in the brain (round-trip verified) + plaintext offline on Desktop. Decrypt key: `Desktop/clawville-backup-decryption-key.txt` (founder: keep a password-manager copy).
- Recovery: brain repo + decrypt key restores every standalone keypair; Supabase backup + `VANITY_ENCRYPTION_KEY` restores every custodial wallet.

## 6. Open follow-ups

- Gas-floor alerts: Telegram alert when a treasury fee payer drops below floor (hardening; today it fails safe but strands rows).
- Preflight-rejection classification: a `SendTransactionError` simulation failure is provably never-broadcast — executor could release instead of stranding (currently conservative-ambiguous).
- `close_agent` sap-client helper (backlog; staging stake intentionally kept).
- Global cross-table signature-claim registry for normal settle writers (future hardening).
- MoonPay rail: blocked on keys.
