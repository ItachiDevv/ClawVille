# SAP (Synapse Agent Protocol) — on-chain integration + flip-to-live runbook

**Status:** Existing SAP rail live posture unchanged; automatic identity pipeline implemented locally and awaiting staging smoke + founder sign-off. **Set 2026-06-20. Last audited 2026-07-21 — additive `sap_agent_identities` durable registry, first-economic-action self-funded registrar, SDK Core CreateV2 plus 1DREG RegisterIdentityV1 CPI attach/verify stage, genesis-first DB-backed public EIP-8004 documents, and the default-on rollback-only `SAP_IDENTITY_AUTOREG_ENABLED` gate. Registration/attach reuse the avatar's own custodial wallet; no escrow/settle/withdraw wire changed. Prior audit 2026-07-09 (rev 5): deployed-program V2 stake/max-obligation preflights and SDK 1.0.0 adoption.**
**Plan:** `.claude/plans/sap-onchain-agents/PLAN.md` · **Owner:** orchestrator (Claude)
**FEATURE_GATE:** `sap_onchain_agents` (review deadline 2026-09-20 — see `routes/sap.ts`).

## MAINNET-ON-STAGING ENABLEMENT (2026-07-10)

The validation ladder: devnet-on-staging (✅ two live e2es 2026-07-10) → **MAINNET-on-staging (this rung)** → prod fully ON. "Flags off" is the DEFAULT-SAFE posture, NOT a resting state — the target is prod ON with real value flowing.

**The two-lock mainnet gate (BOTH required to touch mainnet):**
- **LOCK 1 — code constant `SAP_ALLOW_MAINNET`** (`sap-config.ts`): flipped `false → true` 2026-07-10 as the reviewed config event this gate was designed to require. Flipping it ALONE moves no cluster. Revert to `false` = one-line return to crash-loud devnet-only.
- **LOCK 2 — `SAP_CLUSTER=mainnet` PER BOX** (env): a box stays fully devnet unless it sets this. With LOCK 1 true, `SAP_CLUSTER=mainnet` no longer throws. Real funds move only when the box ALSO sets `SAP_DRY_RUN=false` + the enable flags (`SAP_ENABLED`, `SAP_ESCROW_ENABLED`, `SAP_USDC_ESCROW_ENABLED`, `SAP_PAYAI_SETTLEMENT_ENABLED`).

**Env changes for a mainnet box:**
- `SAP_CLUSTER=mainnet` — selects the mainnet USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) + mainnet RPC default.
- `SAP_RPC_URL=<Helius mainnet>` — **REQUIRED**; the public mainnet RPC is rate-limited + unsuitable for real traffic.
- `USDC_BOUNTY_REWARD_MIN=1` — lets the funded smoke post a 1-vCLAW ($0.01) bounty against a small real balance (default 5 vCLAW / $0.05; the in-game `vclaw` rail has the same 5-vCLAW floor).

**Funding facts (what a mainnet run actually costs):**
- House provisioning: 0.1 SOL stake (program hard floor; 0.11 SOL default) held as a standing, REUSABLE coverage bond, plus ~0.055 SOL account rent (AgentAccount + pricing_menu + stake PDAs). BOTH recoverable (unstake + `close_agent`). Raise the stake before any single bounty > ~$200.
- A bounty's USDC CIRCULATES between OUR custodial wallets (creator → house V2 vault → hunter), so the reward itself is not "spent" — it moves. The TRUE burn per bounty ≈ the SAP 0.5% protocol fee (to the SAP treasury) + tx fees (~0.00001 SOL/tx). The ~0.5% deposit headroom is reclaimed to the creator (leg 1d).

**Fixed as part of this review (CRITICAL, pre-existing):** the live-send mainnet-broadcast guard (`assertNotMainnetGenesis`) compared `getGenesisHash()` (44-char) against a constant that held only the 32-char CAIP-2 truncation, so it NEVER matched — a devnet-configured box pointed at a mainnet RPC would NOT have been refused (silent fail-OPEN). Corrected to the full genesis hash `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, pinned by `sap-config.test.ts`. The guard is SKIPPED on an intended mainnet box (mainnetGateOn) and now correctly RUNS on every devnet box — protecting exactly the misconfig case.

**SMOKE RUNBOOK — money containment (adversary nits, mainnet-enablement review):**
- **The auth gate is NOT the containment.** On a mainnet box the bounty routes are reachable by ANY logged-in non-guest; real containment is that `create_escrow_v2` is atomic create+deposit, so an UNFUNDED custodial wallet's USDC bounty fails clean. Safety of the smoke therefore rests on funding discipline: **before setting `SAP_DRY_RUN=false`, confirm NO staging custodial wallet other than the smoke creator + house holds real mainnet USDC/SOL.**
- **Don't linger money-live:** immediately after the smoke passes, flip the box back to `SAP_CLUSTER=devnet` + `SAP_DRY_RUN=true` until the next deliberate rung (prod-ON promotes the mainnet env as its own reviewed step).
- If ops mis-points a mainnet box at a devnet RPC, the mainnet mint makes every escrow tx fail wrong-mint — a wasted (but fund-safe) run; the dangerous reverse direction is what the genesis fix refuses.
- **Pre-smoke config parity:** carry the proven devnet-staging SAP config (arbiter pubkey, DisputeWindow mode) over unchanged; verify the SDK treasury matches the mainnet program's expectation and the x402 facilitator is PayAI's MAINNET facilitator (payai-release derives `network` from the cluster) — each mismatch fails closed but burns a funded attempt.
- **Follow-up (separate rail, pre-existing):** `wallet-withdraw-executor.ts` hardcodes the mainnet USDC mint on the custodial wallet-withdraw path — likely intentional (user withdrawals are real-money-only) but confirm independently; not part of the SAP escrow rail.

> ## ⚠️ DEPLOYED PROGRAM IS 0.25-FAMILY — and BOTH vendored IDLs are WRONG (2026-07-09)
> The devnet program (`SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ`) now runs the
> **0.25-family** binary. A full DisputeWindow USDC lifecycle was driven END-TO-END
> live on devnet (register → init_stake → update_agent(pricing) → create_escrow_v2 →
> settle_calls_v2 → finalize_settlement → withdraw_escrow_v2; funds moved; zero
> PrivilegeEscalation). The escrow-V2 client is built to those EMPIRICAL shapes.
>
> **RESOLVED 2026-07-09 (rev 2) — the OFFICIAL SDK 1.0.0 IDL is now authoritative.** OOBE
> published `@oobe-protocol-labs/synapse-sap-sdk@1.0.0` with a refreshed IDL whose account/
> arg layouts MATCH the deployed 0.25-family program (and match what we devnet-verified). We
> now load THAT IDL and let Anchor build every escrow-V2 instruction. The two old vendored
> IDLs (`synapse_agent_sap.onchain.idl.json` 0.18, `synapse_agent_sap.idl.future-0.25.json`)
> are superseded — the SDK IDL is correct where each was wrong: `settle_calls_v2` = 5 accts
> (NO `settlement_receipt`), `create_escrow_v2` = 7 accts (stake+stats+pricing_menu), and it
> drops the deprecated `create_pending_settlement`.
>
> **What the client actually does (2026-07-09 rev 2):**
> - **Loads the SDK 1.0.0 IDL** (`sap-client.ts`, imported from
>   `@oobe-protocol-labs/synapse-sap-sdk/idl/synapse_agent_sap.json`) for BOTH the Anchor-driven
>   identity/stake/pricing instructions (register / init_stake / deposit_stake / request_unstake /
>   complete_unstake / update_agent / feedback / attestation — contexts verified byte-identical to
>   the prior vendored IDL) AND the escrow-V2 money family.
> - **Anchor BUILDS the escrow-V2 money family** in `sap-escrow-v2.ts` via
>   `program.methods.X().accountsStrict().remainingAccounts().instruction()` — no hand-rolled
>   discriminators/borsh/account lists. A wire-parity test (`__tests__/sap-escrow-v2.test.ts`)
>   asserts the Anchor-built `data`+`keys` are byte-identical to the devnet-verified shapes below:
>
> | Instruction | DEPLOYED 0.25-family shape (empirical) | devnet tx |
> |---|---|---|
> | `create_escrow_v2` | 7 named `[depositor(S,W), agent, agent_stake, agent_stats(W), pricing_menu, escrow(W), system]` + SPL `[depositorAta, vaultAta, tokenProgram]` (NO mint) | `2J6kxma…N7nkv` |
> | `settle_calls_v2` | 5 named (NOT 6 — no `settlement_receipt`) + SPL `[vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda]` (order LOAD-BEARING) | `512iPTG…CqUnz` |
> | `create_pending_settlement` | **DEPRECATED 6161** — settle inits the pending itself; NOT called | — |
> | `finalize_settlement` | 5 named (unchanged) + SPL `[vaultAta, workerAta, tokenProgram]` (NO mint) | `21QKsYj…Sc7iy` |
> | `withdraw_escrow_v2` | `[depositor(S,W), escrow(W)]` + SPL `[vaultAta, depositorAta, tokenProgram]` (NO mint) | `3TXwu7c…q69Frg` |
> | `update_agent(pricing)` | 4 named `[wallet(S), agent(W), pricing_menu(W), system]` — tier REQUIRED before create (else PricingTierNotFound 6148) | `5SWRTNh…z6Y6y` |
> | `init_stake` | ≥ 0.1 SOL HARD-ENFORCED on-chain (StakeBelowMinimum 6107) | `4rDjvfh…Zpr5rC` |
> | `resolve_dispute` / CoSigned | NOT live-confirmed — `assembleV2SplRemaining('resolve')` keeps its `TODO(devnet-confirm)` | — |
>
> **Two on-chain behaviors the 0.25-family DEPLOYED program NOW has (that 0.18 lacked):**
> 1. **On-chain stake gate at create.** `create_escrow_v2` takes `agent_stake` + `agent_stats`
>    and enforces the ≥ 0.1 SOL self-stake + a provisioned pricing tier before an escrow opens.
> 2. **Fee charged + pending INIT at settle.** `settle_calls_v2` charges the ~0.44% protocol
>    fee from the vault → treasury AND inits the pending settlement itself; `finalize_settlement`
>    releases the principal after the dispute window.
>
> **MONEY RULE (client pre-flight, `createEscrowV2Usdc`):** `initial_deposit` MUST EXCEED
> `price_per_call × max_calls` — the fee is charged FROM the vault at settle, so a
> bare-obligation deposit fails `InsufficientEscrowBalance 6062`. The client requires
> `initial_deposit ≥ obligation + max(1, ceil(obligation × 50bps))` (0.5% headroom, above
> the observed ~0.44% fee; `FEE_HEADROOM_BPS` is a client guard, not the on-chain fee).
>
> **Consequence:** the escrow rail stays HARD-GATED (`SAP_ESCROW_ENABLED=false`, dry-run
> default) until the funded worker-provisioning flow passes staging. The prior missing-pricing-
> route / 6148 application gap is **RESOLVED** by `POST /api/sap/agent/pricing`: the worker signs
> through its own avatar-bound custodial wallet and publishes one caller-named Escrow-mode USDC tier.
> Registration + ≥0.1 SOL stake remain separate prerequisites. Pricing is not auto-provisioned;
> see the `sap_agent_stake_provisioning` FEATURE_GATE in `sap-client.ts` + §9.
>
> **NOTE — the 0.18 dry-run harness (`scripts/sap/dry-run-e2e.ts`) + its `0.18.0` version
> pin are now STALE** and out of scope for this diff; they must be re-vendored/re-pinned to
> the 0.25-family shapes before they can gate again. The legacy SOL-only escrow rail
> (`createEscrow`/`settleCalls`/`closeEscrow` Anchor calls) was 0.18-shaped and is NOT
> migrated — under the future-0.25 IDL those `accountsStrict` calls fail-closed (gated OFF).

---

## 0. What this is (and is NOT)

SAP wires the OOBE-Protocol **Synapse Agent Protocol** (Solana on-chain program
`SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ`, MIT) into ClawVille so our agents
get **on-chain identity + reputation + discoverability** (Phase 1 / "Light") plus an
**on-chain x402 escrow commerce rail** (Phase 2). The **Light "identity +
attestation" rung** is complete: `register_agent` (identity) + `give_feedback`
(0..1000 scores) + **`create_attestation` / `revoke_attestation`** (cross-agent
web-of-trust — "reputation = feedback + cross-agent attestations") + discovery.
It is an **additive, gated, flip-to-live layer**:

- **The in-game economy stays ClawTokens.** SAP changes NOTHING about CT, the
  cove, the leaderboard, or any existing money path. CT is still the only LIVE
  in-game settlement.
- **Everything is gated OFF by default.** With the default env the whole layer is
  dark; the routes return `503 sap_disabled`.
- **Devnet-first + dry-run.** Even when enabled, `SAP_DRY_RUN=true` (the default)
  means the client BUILDS + `simulateTransaction`s every instruction and NEVER
  broadcasts. Flip-to-live is a config change, not a code change — except mainnet,
  which is a deliberate **code** gate.

It is NOT: a CT replacement, a new in-game currency, a peer skill marketplace, or
anything that moves real funds without two explicit gates flipped by a human.

---

**Last audited 2026-07-21 (Slice D):** verified composed-bounty PAID commits now enqueue a durable, house-signed SAP reputation write. Coralia creates/adopts one standing `clawville-verified` attestation and gives/updates one standing `bounty` feedback pair per hunter. Additive `sap_reputation_jobs` DDL, exact feedback probes, per-hunter serialization, bounded retries, and the default-on rollback lever `SAP_REPUTATION_WRITES_ENABLED` are local and awaiting staging/founder sign-off. No escrow/settle/withdraw wire changed.

## 1. The three gates (all default-safe)

| Gate | Env | Default | Controls |
|---|---|---|---|
| Master | `SAP_ENABLED` | `false` | The WHOLE layer (identity / feedback / tool / discovery). Off ⇒ every route 503 `sap_disabled`. |
| Escrow/stake | `SAP_ESCROW_ENABLED` | `false` | The MONEY/STAKE rail (stake + escrow). Off ⇒ escrow routes 503 `sap_escrow_disabled`, even if the master gate is on. |
| Dry-run | `SAP_DRY_RUN` | `true` | `true` ⇒ build + `simulateTransaction` ONLY, NEVER broadcast. `false` ⇒ sign + send + confirm. |

Other env:

| Env | Default | Notes |
|---|---|---|
| `SAP_CLUSTER` | `devnet` | `devnet` or `mainnet`. Same program id both. `mainnet` THROWS at config-load unless the `SAP_ALLOW_MAINNET` code constant is flipped. |
| `SAP_PROGRAM_ID` | `SAPpU…FETZ` | Override only to point at a fork. |
| `SAP_RPC_URL` | public devnet/mainnet RPC | Override with a paid endpoint (Helius/Triton) before any real traffic. NEVER surfaced in API responses (may carry an API key). |
| `SAP_IDENTITY_AUTOREG_ENABLED` | `true` | Emergency rollback lever for first-economic-action identity registration. Effective only while master `SAP_ENABLED=true`; this is not a dark-launch flag. |
| `SAP_IDENTITY_REGISTRAR_POLL_MS` | `300000` (5 min) | Durable identity worker cadence. Rows, not the timer, are the source of truth across restarts. |
| `SAP_REPUTATION_WRITES_ENABLED` | `true` | Emergency rollback lever for verified-bounty SAP reputation writes beneath `SAP_ENABLED`; dry-run consumes no jobs. |
| `SAP_REPUTATION_WRITER_POLL_MS` | `300000` (5 min) | Durable reputation writer cadence (minimum 1 minute). |

### Automatic identity pipeline (local implementation; staging smoke + founder sign-off pending)

Policy is **first real economic action, self-funded**. Agent creation alone spends
nothing, and ClawVille never drips treasury SOL into a user wallet. A ledger-capable
human-driven or connected/hosted agent reaches the same economic route; a best-effort
`ensureSapIdentityQueued(avatarId, triggerSource)` call inserts one durable row with
`ON CONFLICT (avatar_id) DO NOTHING`. It is fire-and-forget and can never fail the
economic response. SAP-disabled, autoreg-disabled, wallet-less, non-ledger-capable,
guest, and demo subjects do not enqueue.

The idempotent migration `packages/database/migrations/0042_sap_agent_identities.sql`
creates `sap_agent_identities` (also modeled by `schema/sap-identity.ts`). It stores the
avatar's public owner wallet, deterministic SAP PDA, cluster, non-empty registration
name/description, JSONB capabilities, trigger provenance, attempts/error, real register
signature, and optional Metaplex asset/registration/attach signature. One avatar and one
PDA each have a UNIQUE row. Lifecycle:

`pending_funding → registering → registered → attaching_identity → identity_attached`

`failed` is the terminal retry-budget outcome. A transient registration failure returns
to `pending_funding`; insufficient SOL is normal parked state (no attempts increment).
Per-avatar in-process serialization plus a Postgres advisory lock prevents concurrent
workers from signing twice. Registration is idempotent-adoptable: every retry probes the
on-chain profile first, and a broadcast-unknown send is re-probed before any retry. An
adoption is not allowed to invent a tx-signature sentinel: the public document stays 404
until a real historical registration signature is resolved.

`SAP_REGISTER_BALANCE_FLOOR_LAMPORTS = 60_000_000` (0.06 SOL) is a conservative
preflight covering today's register rent (~0.056 SOL) and the much smaller Core
mint/attach cost (~0.004 SOL). It gates only a **new register or mint/attach send**;
once an asset is persisted, read-only existence reconciliation and `verifyLink` run
even below the floor so a wallet whose successful writes consumed its SOL cannot be
stranded. It is **not a quoted fee** and never overrules the chain.
OOBE's source carries a future, currently undeployed 0.1 SOL protocol fee; an upgrade
could therefore park identities back at `pending_funding` until wallets are funded above
the real new requirement. Never hardcode today's rent as a permanent protocol cost.

After a confirmed registration, the same worker uses SDK 1.0.0
`MetaplexBridge.buildMintAndAttachIxs` for its ix0 Core `CreateV2`, with the avatar's own
custodial wallet plus the ephemeral Core asset signer. It deliberately replaces the SDK's
ix1 direct `addExternalPluginAdapterV1` with a hand-built mpl-agent-014
`RegisterIdentityV1` instruction to `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p`.
The deployed MPL Core accepts this AgentIdentity adapter only through the registry's CPI;
the SDK direct-adapter builder is ahead of that deployment. The AgentIdentity URI is asserted to be exactly
`https://api.clawville.world/agents/<agentPda>/eip-8004.json`; the sibling
`metadata.json` URL is immutable too. The derived `["agent_identity", asset]` 1DREG PDA is
persisted in `identity_registration` before broadcast and retained with the prepared asset
for exact reconciliation. The row becomes
`identity_attached` only after read-only `verifyLink` succeeds; verification failure
stays retryable at `attaching_identity`. If the RPC outcome becomes ambiguous after
the transaction is signed, the worker retains the deterministic signed transaction
signature and prepared asset, then reconciles that exact asset; it never blindly
remints. A crash-before-send asset is cleared for a fresh mint only after the stale
blockhash window and a read-only account-absence proof.

The public route checks the hand-audited genesis entry first, then the database. It
serves only `registered|attaching_identity|identity_attached` rows with a real 64-byte
Solana `register_tx_sig`, includes real proof fields in `extra`, derives the wallet
CAIP-2 entry from the row's cluster, and imports no SAP write gate—public identity
documents remain readable while writes are disabled.

**Staging verification constraint:** the immutable asset URI deliberately names
`api.clawville.world`, never `api-staging`. Staging now has an isolated database, so a
devnet identity created only in staging will make SDK `verifyLink` fetch the production
registry and receive 404. A staging attach e2e therefore requires deliberate
production-registry coordination for that test row (or a read-only equivalent proxy);
do not change the minted URI to staging to make the smoke pass.

### Verified bounty reputation writes

The shared `bookComposedBountyPaid` compare-and-swap is the single admission seam
for both instant approval and deferred resume. Only `booked:true` enqueues, after
the money transaction commits, using `ON CONFLICT (bounty_id) DO NOTHING`.
Migration `0043_sap_reputation_jobs.sql` and `schema/sap-reputation.ts` store
`waiting_identity → writing → written` with terminal `skipped|failed`, partial
transaction signatures, attempts, errors, and timestamps.

The worker accepts only a cluster-matching hunter identity with a real registration
signature. A failed/absent identity waits up to 14 days; Coralia resolves through
`resolveHouseAvatarId` and her pre-registrar live SAP profile. Self-attestation is
refused by avatar and wallet. Oldest-per-hunter ordering plus an in-process mutex
and Postgres advisory lock span probe/write/reprobe so unique pair writes cannot
interleave.

The standing attestation uses type `clawville-verified`, metadata = the canonical
production EIP-8004 URL, and expiry zero; an existing pair PDA is success. Feedback
score is `min(1000, 600 + 25 × distinct PAID composed bounties)`. The first write
uses `give_feedback`; later writes use `update_feedback` with SDK-IDL accounts
exactly `[reviewer, feedback, agent]`, tag `bounty`, and sha256(raw bounty UUID).
Decoded pair/non-revoked/intended state is probed before every feedback send, so an
ambiguous landed write is adopted without blind resend. Ten transient failures end
in `failed` + `alertError`; `SAP_DRY_RUN=true` leaves queued work untouched.

### The mainnet CODE gate (not an env flip)

`SAP_ALLOW_MAINNET` is a **constant in `apps/api/src/services/sap/sap-config.ts`**,
not read from env. To run SAP against mainnet a human must:

1. Edit `sap-config.ts` and flip `SAP_ALLOW_MAINNET` to `true` (a reviewed code
   change), AND
2. set `SAP_CLUSTER=mainnet` on the box.

Setting `SAP_CLUSTER=mainnet` while the constant is `false` makes `loadSapConfig()`
**throw at call time** (crash-loud, like `FINGERPRINT_SECRET`). This deliberately
mirrors the wager-program devnet-only doctrine — mainnet, where real funds move,
is a code-review event, not an ops toggle.

---

## 2. Files

| File | Role |
|---|---|
| `sap-reputation-writer.ts` | Post-PAID durable worker for Coralia-signed standing attestation/feedback, exact PDA probes, give-vs-update score ramp, oldest-per-hunter serialization, bounded retry/alerting, and broadcast-unknown adoption. |
| `packages/database/src/schema/sap-reputation.ts` + migration `0043_sap_reputation_jobs.sql` | One `bounty_id UNIQUE` job with hunter, lifecycle, partial tx signatures, attempts/errors, and timestamps. Additive/idempotent; never `db:push`. |
| `apps/api/src/services/sap/synapse_agent_sap.idl.future-0.25.json` | The **0.25.0 IDL** (MIT, `IDL-LICENSE-MIT.txt`) — the client LOADS THIS for the Anchor-driven identity/stake/pricing instructions (register / init_stake / deposit_stake / request_unstake / complete_unstake / update_agent), whose account contexts (incl. `pricing_menu`) match the deployed 0.25-family binary. ⚠️ Its `settle_calls_v2` (6-acct) + `create_pending_settlement` are WRONG for the deployed program — the escrow-V2 money family is hand-rolled instead (see below). |
| `apps/api/src/services/sap/synapse_agent_sap.onchain.idl.json` | The **0.18.0 IDL** fetched from the OLD devnet deployment — now STALE (4-acct create, no `pricing_menu`). Kept FOR REFERENCE / diffing only. NOT loaded. |
| `apps/api/scripts/sap/fetch-onchain-idl.ts` | Throwaway: re-fetch the deployed IDL from devnet → re-vendor. Run after any OOBE redeploy (⚠️ the fetched IDL is NOT authoritative for the escrow-V2 money family — see the warning block above). |
| `sap-config.ts` | Gate + cluster + program-id + RPC + dry-run + USDC-mints + min-stake loader. `loadSapConfig()` + the mainnet code-gate throw + the mainnet-RPC-hostname guard (FIX-D) + `isHonoredEscrowMint()` (SOL-only, FIX-E) + the mainnet genesis-hash constant. `SAP_MIN_STAKE_LAMPORTS` mirrors the on-chain floor (StakeBelowMinimum 6107). |
| `sap-pdas.ts` | Pure PDA derivation for every account + `u64LE`, `toolNameHash` (sha256), `serviceHash`. `findReceiptPda` is NOT wired into settle (deployed settle takes no `settlement_receipt`; the pending PDA rides in SPL remaining). |
| `sap-escrow-v2.ts` | The HAND-ROLLED escrow-V2 money builders (create/settle/finalize/withdraw/dispute + close) built to the devnet-verified 0.25-family shapes, PLUS `assembleV2SplRemaining()` — the SINGLE source of truth for the SPL `remaining_accounts` wire order. Pure; byte-tested in `__tests__/sap-escrow-v2.test.ts`. |
| `sap-client.ts` | Loads the **future-0.25 IDL** + `Program` (Anchor identity/stake/pricing) + calls the hand-rolled escrow-V2 builders; custodial in-memory signing via `keypair-vault` (FIX-F); honest dry-run program-reached classification (FIX-B); live-send mainnet genesis-hash guard (FIX-D); structured errors; worker-owned `updateAgentPricingUsdc` provisioning; the `deposit>obligation` money pre-flight + `sap_agent_stake_provisioning` FEATURE_GATE. |
| `sap-dreg-identity.ts` | Pure, empirically pinned mpl-agent-014 `RegisterIdentityV1` builder: 1DREG identity PDA, 8-zero + Borsh-URL data, and the exact seven-account CPI shape accepted by deployed MPL Core. |
| `sap-identity-registrar.ts` | Durable first-economic-action identity queue + poll worker: resolve a ledger-capable avatar/wallet/name, register idempotently after the 0.06 SOL preflight, then mint with the SDK Core `CreateV2`, attach through 1DREG, and verify the Metaplex AgentIdentity. Per-avatar mutex + advisory lock, bounded retries, alerting, and broadcast-unknown re-probe discipline. |
| `packages/database/src/schema/sap-identity.ts` + migration `0042_sap_agent_identities.sql` | One durable `sap_agent_identities` row per avatar; registration/attachment state, proof signatures/pubkeys, trigger provenance, and retry diagnostics. Additive idempotent CI migration; never `db:push`. |
| `routes/sap.ts` | `requireAuthOrAgentSession`-gated Hono routes; `requireLedgerCapable` on agent-session writes (FIX-C); Zod on every body; gate → 503 before chain work; FEATURE_GATE block. |
| `routes/agent-eip8004.ts` | Public genesis-first, DB-backed EIP-8004 + Core metadata documents at the immutable `/agents/:sapAgentPda/{eip-8004,metadata}.json` paths. Opaque 404 unless DB registration proof is honest; no SAP write-gate import. |
| `apps/api/scripts/sap/dry-run-e2e.ts` | The 0.18 conformance harness — now STALE (version-pins `0.18.0` + asserts the OLD account sets). Must be re-pinned/re-vendored to the 0.25-family shapes before it can gate again; out of scope for the 2026-07-09 migration diff. |

---

## 3. PDAs (all from the vendored IDL)

ASCII string seeds; `u64` args little-endian 8 bytes; 32-byte hashes raw.

| Account | Seeds |
|---|---|
| agent | `["sap_agent", walletPubkey]` |
| stats | `["sap_stats", agentPda]` |
| pricing | `["sap_pricing", agentPda]` |
| global | `["sap_global"]` |
| tool | `["sap_tool", agentPda, sha256(toolName)(32)]` |
| feedback | `["sap_feedback", agentPda, reviewerWallet]` |
| attestation | `["sap_attest", subjectAgentPda, attesterWallet]` |
| stake | `["sap_stake", agentPda]` |
| escrow | `["sap_escrow_v2", agentPda, depositorWallet, nonce(u64 LE 8B)]` |
| receipt | `["sap_recv", escrowPda, service_hash(32)]` |
| pending | `["sap_pending", escrowPda, settlementIndex(u64 LE 8B)]` |

> **SDK trap (caught during build):** the cloned MIT SDK's `pdas/index.ts` is
> STALE — it uses `["sap_stake", wallet]` (should be `agentPda`) and a **4-byte
> u32** escrow nonce (the program defines a `u64` → **8-byte LE**), and a tool
> seed of the raw tool-name string (the program uses the 32-byte hash). We derive
> from the IDL, NOT the SDK. The dry-run harness confirms our seeds against the
> deployed program. The escrow/agent/stats/feedback/tool seeds resolve identically
> on 0.18.0 and 0.25.0 (the version delta is ACCOUNT LISTS, not seeds). The
> `receipt` + `pending` PDAs are retained as exports but **NOT used by the 0.18.0
> client** (0.18.0 settle has no receipt account) — see `sap-pdas.ts` notes.

---

## 4. Routes (`/api/sap/*`)

All gated via `sessionMiddleware` + (writes) `requireAuthOrAgentSession`; the
acting agent binds to `identity.avatarId` → its Phase-5.1 custodial Solana wallet.
Zod on every body. Gate-off → 503 BEFORE any chain work. **Agent-session writes
additionally require `ledgerCapable===true` (FIX-C) — a non-ledger / unproven
agent session is 403'd before any custodial decrypt; the human (Lucia) path is
implicitly ledger-capable.**

| Method + path | Auth | Gate | Purpose |
|---|---|---|---|
| `GET /api/sap/status` | none | — | Gate snapshot (no RPC URL leak). |
| `POST /api/sap/register` | human/agent | `SAP_ENABLED` | Map agent wallet → SAP `AgentAccount`. Pricing empty (identity only), treasury omitted → fee 0. |
| `POST /api/sap/tools/publish` | human/agent | `SAP_ENABLED` | Publish a capability as a `ToolDescriptor` (content-addressed sha256 hashes). |
| `POST /api/sap/feedback` | human/agent | `SAP_ENABLED` | Agent↔Agent reputation score 0..1000. |
| `POST /api/sap/attestation` | human/agent | `SAP_ENABLED` | `create_attestation` — cross-agent web-of-trust. Subject = body `subjectAgentPda` (NON-signer); `attestationType` ≤32 chars; optional `metadata` → sha256 → 32-byte `metadata_hash`; `expiresAt` i64 (0=never). REPUTATION, not money (gated on `SAP_ENABLED` only). |
| `POST /api/sap/attestation/revoke` | human/agent | `SAP_ENABLED` | `revoke_attestation` — the ORIGINAL attester revokes its attestation of `subjectAgentPda`. No args on-chain. (POST, not DELETE-with-body — matches the codebase's param-only DELETE convention.) |
| `GET /api/sap/agents?limit=` | none | `SAP_ENABLED` | Discovery — `AgentAccount.all()` (discriminator memcmp), reputation-sorted. |
| `GET /api/sap/agent/:pubkey` | none | `SAP_ENABLED` | One agent profile by wallet (404 `not_registered` if none). |
| `POST /api/sap/agent/pricing` | human/agent | `SAP_ESCROW_ENABLED` + `SAP_USDC_ESCROW_ENABLED` | Worker publishes one caller-named Escrow-mode USDC pricing tier as itself; custody binds to `identity.avatarId`. `update_agent(pricing=[tier])` replaces the complete pricing menu (last write wins), and `pricePerCall` must exactly match a later V2 escrow price or create fails `PricingTierNotFound 6148`. |
| `POST /api/sap/escrow/stake` | human/agent | `SAP_ESCROW_ENABLED` | `init_stake` ≥0.1 SOL — REAL, timelocked, explicit separate step. |
| `POST /api/sap/escrow/deposit-stake` | human/agent | `SAP_ESCROW_ENABLED` | `deposit_stake` top-up. |
| `POST /api/sap/escrow/create` | human/agent | `SAP_ESCROW_ENABLED` | `create_escrow_v2` — prepaid per-call escrow; **SOL ONLY** for now (USDC ⇒ 400 `sol_only_for_now` until the SPL remaining-accounts path is wired, FIX-E). SelfReport. |
| `POST /api/sap/escrow/deposit` | human/agent | `SAP_ESCROW_ENABLED` | `deposit_escrow_v2` top-up. |
| `POST /api/sap/escrow/settle` | human/agent | `SAP_ESCROW_ENABLED` | `settle_calls_v2` — service agent settles N calls; receipt PDA anti-replay. |
| `POST /api/sap/escrow/withdraw` | human/agent | `SAP_ESCROW_ENABLED` | `withdraw_escrow_v2` — depositor reclaims unspent. |
| `POST /api/sap/escrow/close` | human/agent | `SAP_ESCROW_ENABLED` | `close_escrow_v2` — depositor closes, reclaims rent. |

**Dry-run response shape** (write routes, `SAP_DRY_RUN=true`):
`{ ok:true, dryRun:true, accepted:boolean, accounts:{…}, simulation:{ err, unitsConsumed, logs } }`.
**Live response shape** (`SAP_DRY_RUN=false`): `{ ok:true, dryRun:false, signature, accounts }`.
**Failure:** `{ error:<code>, code:<code>, message }` with HTTP 400/404/502/503 per `failureStatus`.

---

## 5. Security invariants

- **Custodial key:** the agent keypair is decrypted IN-MEMORY ONLY (`decryptWalletRow`),
  used to sign, then dropped. NEVER logged, echoed, returned, or persisted. The
  AnchorProvider runs on a throwaway no-op placeholder wallet so it can never
  auto-sign with a real key.
- **Agent acts as ITSELF only.** Every builder takes an `avatarId` (resolved
  upstream from `requireAuthOrAgentSession`) and loads THAT avatar's wallet. No
  body-supplied pubkey ever becomes a signer.
- **Gates fail closed.** Disabled ⇒ structured refusal BEFORE any wallet decrypt /
  RPC call. The service layer re-checks the gate (defense-in-depth) so a future
  direct caller can't bypass the route gate.
- **Dry-run never broadcasts.** `SAP_DRY_RUN=true` runs `simulateTransaction` only,
  and reports `programReached` honestly (`'inconclusive'` ≠ success).
- **Mainnet TRIPLE-gated (FIX-D).** `SAP_ALLOW_MAINNET` code constant +
  `SAP_CLUSTER=mainnet` + a live **genesis-hash** check on every broadcast that
  fail-closed refuses the Solana mainnet genesis unless the code gate is on; plus a
  config-load throw on a known mainnet RPC hostname.
- **Escrow is SOL-ONLY for now (FIX-E).** Any non-null mint (incl. USDC) is refused
  client-side (`sol_only_for_now`) until the SPL remaining-accounts path is wired.
- **Ledger-capability gate (FIX-C).** Agent-session writes require a proven
  (ledger-capable) session before any custodial decrypt/sign.
- **No 5xx leak / no secret echo (FIX-F).** Every chain/RPC error is caught and
  returned as a structured 4xx/5xx; a wallet-decrypt failure returns a fixed
  `internal` / `'wallet decrypt failed'` message that never echoes the underlying
  KEK/secret-pipeline error.

---

## 6. Ship gate — the on-chain-IDL conformance harness

```bash
cd apps/api && bun run scripts/sap/dry-run-e2e.ts
```

The harness (rewritten in audit FIX-B — the old one was FALSELY GREEN because it
simulated with an unfunded payer, which aborts at `AccountNotFound` with empty logs
BEFORE the program runs, so it could not tell a correct account set from a wrong
one yet scored that as PASS). It now asserts, for every instruction the client
issues:

1. **Version pin (hard):** fetches the live on-chain IDL via `Program.fetchIdl` and
   FAILS if `metadata.version` ≠ the vendored `0.18.0`. An OOBE redeploy ⇒ loud fail.
2. **Structural account conformance (hard, no funding):** the produced
   `TransactionInstruction.keys` must EXACTLY match the on-chain IDL account list —
   count, order, and signer/writable flags per position. (Anchor's coder silently
   drops accounts not in the IDL, so this positional comparison — not the build
   merely not throwing — is what catches a wrong account context. Verified to catch
   both count and flag mismatches.)
3. **Program-invoke proof (opportunistic):** if a payer can be funded (devnet
   airdrop, or `SAP_HARNESS_PAYER_SECRET=[..]` pre-funded keypair), it runs a real
   `simulateTransaction` and asserts a `Program SAPpU… invoke` log with no malformed
   signature. `AccountNotFound` / empty logs = **INCONCLUSIVE → not a pass** (the
   program never ran). No funding ⇒ degrades to the structural gate (clearly labeled).
4. **Gate behavior (hard):** gates-off ⇒ helpers refuse; dry-run ⇒ no signature.

**Last run: 13/13 cases structurally conformant + version pin 0.18.0 matched on
devnet (2026-06-21, after adding create_attestation + revoke_attestation);
program-invoke proof skipped (public-RPC airdrop 429).** To
exercise the program-invoke path, set `SAP_HARNESS_PAYER_SECRET` to a JSON byte
array of a pre-funded devnet keypair.

The same honest classification is in the runtime client: a dry-run write returns
`programReached: 'yes' | 'no' | 'inconclusive'` and `accepted` is `true` ONLY when
the program was actually invoked — an under-funded avatar wallet returns
`'inconclusive'` (read as "fund the wallet + retry"), never a false success.

---

## 7. FLIP-TO-LIVE runbook (devnet → mainnet)

### A. Devnet dry-run → devnet LIVE

1. **Confirm the vendored on-chain IDL still matches the deployed program**
   (one-time / after any OOBE redeploy): `cd apps/api && bun run
   scripts/sap/fetch-onchain-idl.ts` (re-fetches via `Program.fetchIdl`), then run
   the harness — it version-pins to `0.18.0` and FAILS LOUDLY on drift. If the
   deployed version changed, re-vendor + re-diff EVERY account list before shipping.
2. **Enable the layer (still dry-run):** set `SAP_ENABLED=true` on staging.
   `GET /api/sap/status` should report `enabled:true, dryRun:true`. Hit
   `POST /api/sap/register` → expect `{ ok:true, dryRun:true, accepted:true }`.
3. **Fund a test agent wallet** on devnet (airdrop SOL to the avatar's
   `wallets.public_key`).
4. **Go LIVE on devnet:** set `SAP_DRY_RUN=false` (keep `SAP_CLUSTER=devnet`).
   Real `register_agent` smoke → expect `{ ok:true, dryRun:false, signature }`.
   Verify the AgentAccount on a devnet explorer + `GET /api/sap/agents`.
5. **Escrow smoke (devnet):** set `SAP_ESCROW_ENABLED=true`. Stake ≥0.1 SOL
   (`/escrow/stake`), create an escrow (`/escrow/create`, SOL), settle one call
   (`/escrow/settle`), withdraw + close. Confirm lamport flow on-chain.

### B. Mainnet (deliberate code change — NOT an env flip)

1. **Code review** the full money/custody path: a `solana-auditor` Anchor pass +
   a **Codex adversarial** pass on the escrow + custodial-key path (the escrow
   rail moves real SOL on mainnet).
2. Flip the **`SAP_ALLOW_MAINNET`** constant in `sap-config.ts` to `true`
   (reviewed code change, committed).
3. Set `SAP_CLUSTER=mainnet` + a paid `SAP_RPC_URL` on the box. Without step 2,
   the API refuses to load this config (crash-loud).
4. Fund a mainnet agent wallet, run a single register smoke, then a single
   funded escrow smoke before exposing it broadly.

> **Never** flip `SAP_ESCROW_ENABLED` and `SAP_DRY_RUN=false` and
> `SAP_CLUSTER=mainnet` together in one step without the smoke ladder above.

---

## 8. Agent parity (Rule E5)

Identity / feedback / tool / escrow acts are the agent acting AS ITSELF on-chain
(its custodial wallet). Human path (a Trainer opting their agent in via a Lucia
cookie) and agent path (`X-Clawville-Agent-Session`) both resolve via
`requireAuthOrAgentSession` → the same avatar → its Solana wallet. **PARITY note —
human path: `POST /api/sap/*` via Lucia cookie; agent path: same endpoints via
`X-Clawville-Agent-Session` → bound avatar; signing binds to `identity.avatarId`.**
Exposing register/discovery on the agent `tools.json` + `[ACTION:]` whitelist is a
later phase (post-merge); the MVP wires the routes + the dry-run harness.

---

## 9. Follow-up scrutiny + the escrow-rail PREREQUISITES before real money

### Audit hardening already applied (2026-06-20)

- **FIX-A — build against the DEPLOYED 0.18.0 program** (not the 0.25.0 repo IDL).
  Client loads `…onchain.idl.json`; account lists for register / createEscrow /
  settle / close corrected; harness version-pins + per-instruction account
  conformance.
- **FIX-C — `ledgerCapable` enforced on agent-session writes.** A non-ledger /
  unproven agent session is 403'd (`agent_session_not_ledger_authorized`) BEFORE
  any custodial decrypt/sign — mirrors the cove real-money routes. Human (Lucia)
  path is implicitly ledger-capable. `ledgerCapable` is surfaced from
  `resolveAgentSession` onto `identity` (fail-closed default false).
- **FIX-D — mainnet broadcast double-guarded.** (1) `loadSapConfig` THROWS if
  `SAP_RPC_URL` matches a known mainnet hostname while the mainnet code gate is
  off. (2) the live-send path fetches the connection's **genesis hash** and
  REFUSES (`mainnet_broadcast_refused`, fail-closed on probe error) if it is the
  Solana mainnet genesis unless `SAP_CLUSTER=mainnet && SAP_ALLOW_MAINNET`. The
  program id is identical on every cluster, so the genesis hash is the only ground
  truth for which chain a tx would actually hit.
- **FIX-E — escrow is SOL-ONLY for now.** `isHonoredEscrowMint` refuses any
  non-null mint (incl. USDC); the route rejects USDC with `sol_only_for_now`. The
  SPL path needs `remaining_accounts` (token program + escrow/depositor ATAs)
  wired into create/deposit/settle/withdraw/close before USDC can be honored
  (TODO `escrow-usdc` in `sap-config.ts`).
- **FIX-F — wallet decrypt wrapped.** `loadAvatarWallet` wraps the DB lookup +
  `decryptWalletRow` in try/catch and returns `{code:'internal', message:'wallet
  decrypt failed'}` — never echoing the underlying error (which can carry
  KEK/secret-pipeline detail). Routes map `internal` → 500.

### Escrow-rail PREREQUISITES (the rail stays dark until these are met)

> **FIX-G — body-driven settlement is unsafe on 0.18.0.** `settle_calls_v2` accepts
> a caller-supplied `callsToSettle` + arbitrary `serviceHashParts`, and the 0.18.0
> program has NO `settlement_receipt` anti-replay (see the top-of-doc box). So a
> compromised/buggy SERVICE agent could settle fresh distinct hashes up to the
> escrow's `max_calls`, draining the escrow. The rail is gated OFF, so there is no
> behavior change today — but BEFORE `SAP_ESCROW_ENABLED` is ever flipped on for
> real money, ALL of:
> 1. **Backend-derived `service_hash`** — derive it server-side from PERSISTED
>    invocation records (one row per real call), NOT from arbitrary request-body
>    parts. The route must NOT accept caller-supplied hash parts for live money.
> 2. **Backend `(escrow, service_hash)` idempotency** — a settle ledger keyed on
>    `(escrow, service_hash)` that refuses a repeat, replacing the receipt PDA the
>    0.18.0 program lacks.
> 3. **Backend stake precondition** — re-add the ≥0.1 SOL self-stake check the
>    0.18.0 program does not enforce at escrow creation (or wait for a 0.25.0
>    redeploy that does).
> These are tracked as the FEATURE_GATE prerequisite in `routes/sap.ts`.

- **Stake lock** — 0.1 SOL is real + timelocked; confirm the unstake cooldown +
  coverage math (`StakeBelowCoverage` / `EscrowCoverageExceeded`) before mainnet.
- **Custodial key handling** — verify no path logs/echoes the decrypted secret and
  the keypair is never persisted beyond the signing call (FIX-F closes the one
  unwrapped decrypt; re-audit on every new builder).

## 10. Option C — OOBE USDC SelfReport escrow GATE (verify-before-release) — BUILT, gated

> **Set 2026-06-22.** A backend-enforced verify-before-release USDC commerce gate
> on the PROVEN OOBE SelfReport settle. Built FULLY, **gated OFF + dry-run + devnet-
> first** — no money moves until a deliberate flip-to-live. In-game economy stays CT.

### What it is

The deployed program has NO on-chain CoSigned/receipt anti-replay (see the top
box + §9), so the on-chain CoSigned/Covenant path is unexercised. **Option C**
enforces the coupling in ClawVille's backend: depositor funds an escrow → worker
does the work → backend runs a pluggable verifier → **only on a passing verdict**
does the backend call the SelfReport `settle_calls` to release the vault to the
worker, binding the verifier's 32-byte audit root into the on-chain `service_hash`.
The at-most-once-settle invariant lives in a DB table (the on-chain receipt the
0.18.0 program lacks).

### The USDC path is V1 (non-versioned), NOT `_v2`

Per `oobe-usdc-selfreport-spec.md` (reverse-engineered from real mainnet txs — the
IDL is inconsistent), the entire USDC lifecycle uses the **V1** instructions
`create_escrow` / `deposit_escrow` / `settle_calls` / `withdraw_escrow` with
HAND-ASSEMBLED account lists + raw Borsh args (`sap-escrow-usdc.ts`), NOT the
`_v2` family (`_v2` = native-SOL only). The V1 USDC escrow PDA is
`["sap_escrow", agentPda, depositor]` (NO nonce → one escrow per (agent,
depositor) pair; a 2nd job for the pair TOPS UP, tracked by a distinct `job_id`).
`settle_calls` releases the vault ATA → the worker's own USDC ATA, no fee/treasury;
the worker's registered wallet is the ONLY settle signer (= the backend gate key).
`service_hash`[32] carries the verifier's `auditRoot`.

### Three gates (Option C sits on top of the SOL escrow gate)

`SAP_ENABLED` (master) → `SAP_ESCROW_ENABLED` (escrow rail) → `SAP_USDC_ESCROW_ENABLED`
(Option C USDC sub-rail). ALL must be true; `SAP_DRY_RUN=true` (default) builds +
`simulateTransaction` only. Mainnet still needs the `SAP_ALLOW_MAINNET` code gate +
the live-send genesis-hash refusal (unchanged).

**+ a fourth, rail-selector gate (2026-07-06):** `SAP_PAYAI_SETTLEMENT_ENABLED`
(default false) — with all three gates above ALSO true, NEW escrow jobs open on
the `payai` settlement rail (no on-chain vault; the PASS-verdict release is an
x402 exact-scheme USDC payment settled by the PayAI facilitator — see
`docs/sap-covenant-payai-architecture.md §8` + `sap/payai-release.ts`). The rail
is recorded per-row at open (`metadata.rail`); dispatch follows the ROW, never
the live flag. On this rail `SAP_DRY_RUN=true` means facilitator VERIFY-only
(`/settle` never called — no money can move).

### Pluggable verification provider

`VerificationProvider` (`sap-verification.ts`) is a single-method abstraction:
`verify(jobCtx) → { passed, auditRoot:Uint8Array(32), detail? }`. **v1 provider =
`RequesterApprovalProvider`** — the escrow depositor (requester) must explicitly
approve the job; `auditRoot = sha256(escrowId ‖ jobId ‖ approver ‖ approvedAt)`,
approver must equal the depositor. The verification signal is built **server-side
from the PERSISTED depositor approval** (`sap_escrow_approvals`), NEVER from a
request body (see BLOCKING #1 fix below). Shaped so a future
`CovenantVerificationProvider` (co-located `covenantd`, `POST /escrow/prove`, map
`audit_root_hex` → `auditRoot`, ed25519-verify the proof) DROPS IN with no
interface change.

### HARD idempotency (the money invariant)

`sap_escrow_settlements (escrow_pda, job_id)` is UNIQUE. The settle path runs a
conditional `UPDATE … SET status='settling' WHERE id=? AND status IN ('open',
'submitted')` — the row-lock + WHERE state-guard make check-then-claim atomic, so a
concurrent OR retried second settle updates ZERO rows and bails WITHOUT touching
the chain. The chain `settle_calls` runs ONLY after the claim commits; a success
→ `settled` (terminal, records `settle_signature`/`dry_run`), a chain failure
AFTER the claim → `failed` (terminal, NOT auto-retried — a send whose confirmation
we never saw may have landed; re-releasing would double-pay). A replay of an
already-`settled` job returns the cached row with `replay:true` and `chain:null`
(no fabricated simulation). **Settle fires ONLY when the verifier `passed===true`
AND the audit root is non-zero** (a zero root = the verification-failed sentinel,
refused at both the gate and the chain builder).

**Refund vs settle TOCTOU (BLOCKING #4):** `refund` now makes the SAME atomic claim
(`status='refunding' WHERE status IN ('open','submitted')`) BEFORE any chain send,
so exactly one of {settle, refund} ever reaches the chain for a given escrow, and a
`settled` row can never be relabelled `refunded` (settle provenance preserved).

**Two new lifecycle states:** `refunding` (the atomic refund claim, BLOCKING #4) and
`funding_unknown` (an OPEN tx that was BROADCAST but never confirmed — BLOCKING #5:
the row is held for reconciliation with its `funding_signature`, NOT deleted, so a
retry can't double-fund and any landed USDC isn't orphaned; the funds ledger
excludes it from the spendable balance).

### Routes (`/api/sap/escrow/usdc/*` — all triple-gated 503, Zod, requireAuthOrAgentSession + requireLedgerCapable)

| Route | Role / acting avatar | What |
|---|---|---|
| `POST /escrow/usdc/open` | DEPOSITOR (requester) as itself | fund (create or top-up) a USDC escrow against a worker for a `jobId`; records `max_calls` + `funded_amount`. Rejects depositor==worker (self-dealing) |
| `POST /escrow/usdc/submit` | either party | record the worker's deliverable submission (open → submitted) |
| `POST /escrow/usdc/approve` | DEPOSITOR as itself | persist the authenticated approval (`sap_escrow_approvals`) that gates the settle; optional `approvedCalls` cap. **The ONLY thing that authorizes a release** (BLOCKING #1) |
| `POST /escrow/usdc/settle` | WORKER as itself | read the PERSISTED approval → clamp `callsToSettle` to maxCalls/approved/funded → atomic claim → release vault → worker ATA (≤ once per (escrow, job)) |
| `POST /escrow/usdc/refund` | DEPOSITOR as itself | atomic `refunding` claim → reclaim unspent USDC (cancel / expiry / verify-fail); books `refunded_amount` |

### V2 release routes (`/api/sap/escrow/v2/*` — all triple-gated 503, Zod, requireAuthOrAgentSession + non-guest ledger identity)

| Route | Role / acting avatar | What |
|---|---|---|
| `POST /escrow/v2/open` | DEPOSITOR as itself | claim the nonce-bound `(escrowPda, jobId)` ledger row before funding through the existing V2 create/deposit executors; persists `escrowVersion='v2'` + `escrowNonce`; broadcast-unknown funding becomes reconcile-only `funding_unknown` |
| `POST /escrow/v2/settle` | WORKER as itself | enforce persisted depositor approval + ceiling + verification, atomically claim the job, then charge the protocol-fee leg and initialize the per-index PendingSettlement PDA; success records `settlementIndex`, `settleSignature`, fee, and `callsSettled`, then enters `pending` |
| `POST /escrow/v2/finalize` | any authenticated non-guest avatar | permissionless crank using the caller's avatar wallet only as payer; finalize the persisted settlement index after the dispute window, release principal to the worker, book `releasedAmount`, and enter terminal `settled` |

V2 release is on-chain-only: a row recorded with `metadata.rail='payai'` is refused before either V2 executor. A settle replay in `pending` returns finalize guidance without another chain send; a replay in `settled` returns the terminal row. Clean pre-broadcast finalize failures leave `pending` retryable. Broadcast-but-unconfirmed settle/finalize outcomes become `settle_unknown` / `finalize_unknown` with the observed signature and are never automatically retried. Fee and principal are deliberately separate ledger legs: settle may charge only the fee; finalize releases principal.

### Rule E5 parity

BOTH a human (Lucia cookie) AND a connected/hosted agent (`X-Clawville-Agent-Session`)
drive their role AS THEMSELVES, bound to their avatar's own Phase-5.1 custodial
wallet with REAL settlement (never a guest fallback). Depositor signs create/
deposit/withdraw; worker signs settle (the gate asserts `callerAvatarId ===
row.workerAvatarId`). No body-supplied pubkey is ever a signer.

### FEATURE_GATE prerequisites before flip-to-live

`escrow-gate.ts` carries the `sap_usdc_escrow_gate` FEATURE_GATE. The five money-path
BLOCKING fixes below were applied 2026-06-22 (still gated OFF + dry-run — build-only,
no money moved). Items 1-5 are RESOLVED in code; items 6-7 remain devnet/audit gates
before `SAP_USDC_ESCROW_ENABLED` is EVER flipped on for real money:

1. **(RESOLVED — BLOCKING #1) Persisted approval, not a body claim.** The settle
   route NO LONGER accepts a request-body `approval`. The depositor (and only the
   depositor) records an authenticated approval via `POST /escrow/usdc/approve`
   (`sap_escrow_approvals`, keyed `(escrow_pda, job_id)`); `settleJob` reads THAT
   row and builds the verification signal server-side. A worker can no longer forge
   an approval to self-release. `depositor == worker` is rejected at open + approve +
   settle (no self-dealing).
2. **(RESOLVED — BLOCKING #2) `callsToSettle` bounding.** `callsToSettle` is an
   upper REQUEST; `settleJob` clamps/rejects it to `min(maxCalls − callsSettled,
   approvedCalls, floor(escrowRemaining/price), floor(jobRemainingFunded/price))`
   (`computeSettleCeiling`). An over-request is a 400 `over_release`, never a silent
   truncation. `max_calls` is recorded at open.
3. **(RESOLVED — BLOCKING #3) Cross-job fund accounting.** The nonce-less shared
   `(agent,depositor)` vault now carries a per-job + escrow-wide funds ledger
   (`funded_amount`/`released_amount`/`refunded_amount`): each settle enforces
   `sum(released)+sum(refunded) ≤ sum(funded)` escrow-wide AND
   `job.released ≤ job.funded` per-job, so a worker controlling one job cannot drain
   USDC the depositor funded for a sibling job.
4. **(RESOLVED — BLOCKING #4) Refund-vs-settle TOCTOU.** `refund` makes an atomic
   `refunding` claim before any chain send and operates only from `open|submitted`,
   so a refund and a settle can never both broadcast against one escrow, and a
   `settled` row is never relabelled `refunded` (provenance preserved).
5. **(RESOLVED — BLOCKING #5) Orphaned/double-funded deposit.** A broadcast-but-
   unconfirmed open is held in `funding_unknown` with its `funding_signature` for
   reconciliation — NEVER auto-deleted (which would free the slot → double-fund, and
   orphan landed USDC). `executeTx` now distinguishes pre-broadcast failure (clean
   delete) from broadcast-then-unconfirmed (`SapFailure.broadcast` + `signature`).
6. **(GATE) Expiry/refund reconciliation** — confirm the OOBE `close_escrow`-for-USDC
   rent reclaim (UNVERIFIED on-chain per the spec — 1 devnet test) and the
   withdraw-amount math against the on-chain vault balance. Also wire the
   `funding_unknown` reconciler (poll the broadcast signature / on-chain escrow
   account before reusing the slot).
7. **(GATE) Money-path audit** — full team + Codex adversarial on the USDC custody +
   approve + settle + refund + idempotency path before the flip (per ARCHITECTURE /
   CLAUDE.md), driven end-to-end on devnet with a funded depositor.

---

## Empirical verification + upstream SDK notes (2026-07-09 rev 2, SDK adoption)

Run `bun run apps/api/scripts/sap/simulate-shapes.ts` (READ-ONLY devnet — no sends, no funds, no signer) to reproduce. It reads the four LANDED devnet txs our builders were verified against and reports the DEPLOYED program's ACCEPTED account shape (a landed tx = what the program took), then decodes the on-chain escrow via the new SDK IDL.

- **SPL shape (trap-list T2) — RESOLVED: the deployed program DROPS the token mint.** All four landed txs (create/settle/finalize/withdraw) carry NO mint in `remaining_accounts` — exactly what our `assembleV2SplRemaining` sends. settle = `[vaultAta, workerAta, tokenProgram, treasuryAta, pendingPda]` (treasury idx3, pending idx4), create/deposit = `[depositorAta, vaultAta, tokenProgram]`, finalize/withdraw = `[vault, otherAta, tokenProgram]`.
- **DECODE parity — RESOLVED.** The on-chain `EscrowAccountV2` decodes cleanly via the SDK 1.0.0 IDL: `settlementIndex=1, balance=95500, pendingAmount=0, tokenMint=<devnet USDC>, settlementSecurity=DisputeWindow` — the 95,500 residual matches the documented conservation (1,000,000 deposit − 900,000 principal − 4,500 fee). The settle→finalize state-machine reads (settlementIndex/pendingAmount/balance/amount/isFinalized/isDisputed) therefore operate on a layout the swapped IDL decodes correctly (encode-parity ≠ decode-parity — both now proven).

**UPSTREAM SDK notes (report to the OOBE dev):**
- The SDK's `EscrowV2Module.deposit()` (send-module) validates `splAccounts.length >= 4` expecting `[depositorAta, escrowAta, tokenMint, tokenProgram]` (WITH mint) — but the deployed devnet program accepts the 3-account NO-mint shape (proven above). The SDK's mint expectation is AHEAD of / mismatched with this deployment. We build our own remaining-accounts (no mint) and do NOT use the SDK send-module.
- The SDK's `MetaplexBridge.buildMintAndAttachIxs` emits direct Core `addExternalPluginAdapterV1` as ix1, but deployed MPL Core rejects that AgentIdentity path for a wallet signer. The landed genesis transaction proves it must be `1DREG` `RegisterIdentityV1` → Core CPI. We retain SDK ix0 `CreateV2` and hand-build only the registry ix1. This is the third documented SDK/deployed divergence, alongside `/pdas` derivation and deposit remaining-account shape.
- The SDK ships TWO PDA modules; `/pdas` (plural) is BROKEN (drops the escrow depositor seed, 4-byte nonce, stake-from-wallet, mis-seeded dispute → un-fundable addresses). We import `/pda` (singular) semantics only and keep our own `sap-pdas.ts`; a `sap-pda-parity.test.ts` asserts ours === the SDK `/pda` for every escrow-V2 account.

## FLIP-TO-LIVE CHECKLIST — SAP Escrow V2 (0.25-family) — added 2026-07-09

The 0.18→0.25 client migration (branch `feat/sap-v2-settlement`) landed the DEVNET-VERIFIED
builder/executor shapes. The V2 funding and release executors are now routed, with counterparty
release reachable only through the escrow-gate ledger; the whole surface remains **gated OFF**.
The items
below MUST be resolved before ANY enablement (SAP_ENABLED / SAP_ESCROW_ENABLED /
SAP_USDC_ESCROW_ENABLED = true, SAP_DRY_RUN=false) — this is the Codex flip pass scope.

**Reviewed 2026-07-09 by solana-auditor (shapes vs live devnet txs — byte-exact, conservation
on-chain: 1,000,000 = 900,000 principal + 4,500 fee(0.5%) + 95,500 residual) + an adversarial
money-path pass. Verdict: safe to push gated; the following gate the flip.**

1. **B1 — Escrow-gate integration for the RELEASE path (approval/ceiling/job-hygiene) — ROUTED, GATED OFF.**
   *(Premise CORRECTED 2026-07-09 rev 2: the earlier "no on-chain anti-replay" claim is WRONG for
   1.0.0.)* The deployed 1.0.0 program DOES enforce at-most-once settlement on-chain — each escrow
   keeps a monotonic `settlement_index`, `settle_calls_v2` INITs a per-index `PendingSettlement`
   PDA atomically, and a duplicate settle for a finalized/reused index FAILS LOUD
   (`SettlementReplay 6138` / `EscrowNonceReused 6097` / `SettlementAlreadyFinalized 6099`). So the
   chain is the authoritative replay guard; a naive settle retry can no longer silently double-
   charge. The V2 RELEASE path now enters the same ledger gate through nonce-bound V2 open and
   retains the V1 authorization layer: worker-only settle, persisted depositor approval, ceiling
   rejection (never truncation), self-dealing re-check, server-built verification signal, and the
   keyed-mutex + PostgreSQL advisory-lock conditional claim before chain dispatch. DisputeWindow
   release is explicitly two-phase: `open|submitted → settling → pending → settled`. Settle books
   only the protocol fee and consumes `callsSettled`; finalize books principal in `releasedAmount`.
   `settle_unknown` and `finalize_unknown` are reconcile-only states for broadcast-but-unconfirmed
   outcomes. A clean pre-broadcast early-finalize refusal leaves `pending` retryable. Replay-family
   errors (6097/6099/6138) reconcile toward `pending` and direct the caller to finalize; settle is
   never blindly resent. This retrofit remains behind the three existing OFF-by-default SAP/USDC
   gates and `SAP_DRY_RUN=true`; the staging end-to-end deadline remains open before any live flip.
   FUNDING-side V2 (create/deposit — the depositor spending its OWN escrow) is safe to route now.
**Release-path (B1) flip-gate follow-ups — from the 2026-07-09 money-lens review (APPROVED, non-blocking while the rail is OFF + DRY_RUN):**
- **Pre-flip empirical gate [REQUIRED, Codex 2026-07-09] — re-run `simulate-shapes.ts` GREEN immediately before ANY flag flip.** The byte-parity tests pin the wire against the SDK's BUNDLED IDL offline; only this read-only devnet script proves the DEPLOYED binary still accepts our shapes (OOBE redeploys without notice — it has happened twice). A flip with a stale shape table is a fund-lock risk.
- **R3 [MED] — deposit idempotency (before ANY real-funds flip).** `deposit_escrow_v2` is additive, so a client double-submit (double-click / 5xx retry) double-funds the depositor's OWN escrow. `executeTx`'s confirm-split stops an SDK auto-resend but NOT a duplicate client POST. Add a route-level idempotency key `(subject, escrowNonce, requestId)` on `/escrow/v2/deposit`. (create is nonce-keyed → a re-create dedups to 6097; deposit is not.) **RESOLVED 2026-07-09** — shipped standard STRICT idempotency, deliberately keyed UNIQUE `(subject avatarId, requestId)` with `(escrowPda, amount)` as the request FINGERPRINT (NOT `escrowNonce` — a nonce alone does not identify an escrow; the V2 PDA is agent+depositor+nonce, so one nonce can address two workers). New `sap_deposit_requests` table (migration 0023a): the claim is INSERTed atomically BEFORE any wire build (the unique index is the lock); same key + same fingerprint replays the recorded outcome (`replayed:true`, NO re-send); same key + different fingerprint → 409 `deposit_request_mismatch`; an in-flight duplicate → 409 `deposit_in_flight`; a broadcast-unknown is held terminal (reconcile-only, never auto-retried); a pre-broadcast failure DELETES the claim so the same `requestId` retries cleanly. DRY-RUN skips persistence entirely (a dry-run sends nothing, so it must never block a later real request). `requestId` is now REQUIRED on `POST /escrow/v2/deposit`; the logic lives in `depositEscrowV2Idempotent` (escrow-gate.ts). **Hardened (review MED M2):** the executor call + outcome-persist are wrapped so a THROWN error (unknown broadcast timing) holds the claim `broadcast_unknown` + `failureCode:'internal'` (R3-4 canonicalized the code into the SapFailure union) + the captured signature (R3-3) (NEVER deletes — that could re-open the key for a tx that may have landed → double-fund) and returns a typed `internal` "held for reconcile", so a throw can never strand the claim `in_flight` and 409-brick every retry.
- **Decode-parity [PROVEN 2026-07-09 — live staging e2e].** `PendingSettlement` decode verified against the REAL pending created by the route-driven e2e (escrow `85G3oP5zNysqdo9FV9QBfYUccwPGKgn4RD1M6oox1Qv` nonce 1, pending `476Ht3LNDVcug434NMZXsnfuxTAJ7j6192pqWKh63S4Q` index 0): on-chain `amount=100000 / callsToSettle=10 / settlementIndex=0 / serviceHash=6028dfe2…` matched the gate ledger byte-for-byte; post-finalize `isFinalized=true, outcome=autoReleased`. Escrow decode also live-verified (`balance` tracked 110000→109500→9500 through settle/finalize; `disputeWindowSlots=2160`; `maxObligation` field present, confirming the deposit-cap rule's on-chain source). Decode script: `apps/api/scripts/sap/_decode-pending-e2e.ts` (untracked, re-runnable). REMAINING from this line: switch settleJobV2's replay-reconcile to book the DECODED pending amount (see the replay-reconcile MED below) — the decode itself is now proven safe to rely on.
- **Stake coverage [RESOLVED 2026-07-09 — source-derived + live-decoded].** The earlier premise that
  `EscrowCoverageExceeded (6153)` dynamically converts a token deposit into SOL stake was wrong.
  Upstream commit `55d29edeafebf5fd11ee6c7a63935625cfe98b1b` defines two separate checks in
  [`escrow_v2.rs` lines 98–124](https://github.com/OOBE-PROTOCOL/synapse-sap/blob/55d29edeafebf5fd11ee6c7a63935625cfe98b1b/programs/synapse-agent-sap/src/instructions/escrow_v2.rs#L98-L124)
  and [`escrow_v2.rs` lines 325–337](https://github.com/OOBE-PROTOCOL/synapse-sap/blob/55d29edeafebf5fd11ee6c7a63935625cfe98b1b/programs/synapse-agent-sap/src/instructions/escrow_v2.rs#L325-L337):
  at CREATE, `maxPotential = maxCalls == 0 ? initialDeposit : pricePerCall × maxCalls` and
  `requiredStakeLamports = max(100_000_000, floor(maxPotential × 5_000 / 10_000))`; the program
  compares the raw token-base-unit `maxPotential` directly with lamports (there is NO mint-decimal
  or oracle conversion). This is a per-escrow create check, not an aggregate over all of the
  worker's active escrows; a shortfall is `StakeBelowCoverage (6145)`. It then persists
  `max_obligation = maxPotential`. At DEPOSIT, 6153 means
  only `escrow.balance + depositAmount > escrow.max_obligation`; stake is not re-read and the check
  is skipped only for legacy rows whose `max_obligation == 0`. Constants are pinned in
  [`state.rs` lines 1246–1257](https://github.com/OOBE-PROTOCOL/synapse-sap/blob/55d29edeafebf5fd11ee6c7a63935625cfe98b1b/programs/synapse-agent-sap/src/state.rs#L1246-L1257).
  Live decode validates the apparently surprising result: escrow
  `3CdFnNya9q2GEi9U61rmLARK9boJtNJFsS8X37fX8dry` stores `pricePerCall=10_000`, `maxCalls=10`,
  `maxObligation=100_000`, `totalDeposited=150_000`, and current `balance=100_000` USDC base
  units. Its actual agent is `6gCTFRsubnfaoWomt1965Nrc5BnvT24i7eP6nLwY8Q1C`; the correctly
  derived stake PDA `7GtzMamSwb28VkA5CFSCAi7EBE7czvx7wXFH77yoPxnS` stores
  `stakedAmount=110_000_000`, `slashedAmount=0` (the agent/stake addresses originally supplied for
  the investigation were stale/mismatched). Thus create required
  `max(100_000_000, 100_000×50%) = 100_000_000` lamports and accepted the 110M stake; create also
  permits its 150,000 initial deposit even though that exceeds stored `max_obligation`, while a
  later deposit projecting the balance to 200,000 fails because `200_000 > 100_000`.
  The client now mirrors both checks before wire construction and returns the required/additional
  stake or deposit-cap details. Read/decode/RPC failure deliberately SKIPS this UX preflight and
  falls through to the authoritative chain; the mirror must never reject an operation on uncertain
  state. `openEscrowV2` runs the same create preflight before its ledger claim so a definite
  under-stake request remains pre-claim and retryable. All flags remain OFF and dry-run remains ON.
- **R1 [DONE] — withdraw routed.** `/escrow/v2/withdraw` ships in the funding bucket (self-custody, free balance only), so there is NO "can fund, can't defund" trap. `close_escrow_v2` route still pending its executor (self-custody rent reclaim) — route with the funding bucket when added.
- **V2-withdraw ledger bypass [MED, review finding 2026-07-09 gate-retrofit d6bd9410] — reconcile before flip.** `/escrow/v2/withdraw` moves vault→depositor ON-CHAIN without booking `refundedAmount` into the gate's settlements ledger (V1 refunds go through `refundJob`, which books; the V2 withdraw route predates the gate). Consequence: the ledger's `remaining` can OVERSTATE the vault after an out-of-band withdraw. Fail-closed on-chain — a stale-ceiling settle fails at the program (6062-family) and lands terminal `failed`/reservation-restored, never over-releases — but a depositor withdraw can brick a live job's row. Before flip: either route V2 withdraws through a gate leg that books against the escrow's jobs, or (minimum) re-read the on-chain vault balance inside the settle claim and clamp the ceiling to it. **RESOLVED 2026-07-09** — shipped BOTH halves. (a) `settleJobV2`'s claim now reads the LIVE on-chain vault token balance UNDER the advisory lock (`readV2VaultBalanceBaseUnits`, an injected reader seam mirroring the coverage preflights) and clamps the ceiling to `min(ledgerRemaining, vaultBalance)` — catching ANY out-of-band drain, not just our own route; a read failure returns null and falls back to the ledger ceiling (never rejects on uncertain state — the program stays the fail-closed 6062 guard). (b) `/escrow/v2/withdraw` now routes through `withdrawEscrowV2Booked`, recording each drain (escrow-scoped, not job-scoped) into the new `sap_escrow_withdrawals` table (migration 0023b) that `escrowFundsLedger` subtracts from `remaining` — `succeeded` + `broadcast_unknown` are both subtracted (pessimistic/fail-closed), a pre-broadcast failure books nothing, and dry-run books nothing. This leaves the `settle_unknown` quarantine + every V1 path untouched (a V1 escrow has no rows in the new table). **Hardened (review MED M1):** the settle claim's IN-LOCK ledger re-read now also `tx.select`s + subtracts `sap_escrow_withdrawals` under the advisory lock (not just the pre-claim `escrowFundsLedger`), so a withdraw booked between the pre-claim read and the claim is caught even when the vault RPC read falls back to null.
- **Replay-reconcile books request, not chain [MED, review finding 2026-07-09 — folds into the Decode-parity gate above].** `settleJobV2`'s pending-PDA-already-exists reconcile books the CALLER's requested `callsToSettle`/principal/fee rather than decoding the on-chain `PendingSettlement`'s actual amount. Unreachable divergence today (our own claim commits before broadcast, so an open|submitted row with an on-chain pending implies an out-of-band writer), but the staging e2e MUST land PendingSettlement decode-parity and switch this reconcile to the decoded amount. **RESOLVED 2026-07-09** — `inspectV2SettlementState` now Anchor-DECODES the on-chain `PendingSettlement` (`amount` = the gross reserved principal = calls×price, devnet-proven `amount=100000` for 10×10000; `callsToSettle`) whenever the PDA exists, and BOTH reconcile branches in `settleJobV2` (the pre-claim pending-exists path AND the post-broadcast replay-signal path) now book the DECODED principal + `computeV2ProtocolFee(decoded principal)` + decoded calls — NEVER the caller's requested numbers. A decode/RPC failure returns a typed retryable failure and books NOTHING (the row stays retryable). **Hardened (review MEDs M3 + M4):** (M3, refined by R3-1) when the settle-replay signal fires but the re-probe fails/undecoded, the outcome is GATED ON `broadcast`: `isV2ReplaySignal` substring-matches the STRINGIFIED failure (incl. the base58 signature), so a genuine confirm-timeout `broadcast:true` failure can FALSE-MATCH the replay regex. A `broadcast:true` unresolved-probe therefore QUARANTINES as `settle_unknown` (reservation KEPT, reconcile-only) — restoring + releasing would let a retry settle at the NEXT index → two pendings → double release; this is safe for both a false match AND a genuine replay we couldn't read. ONLY a provably-pre-broadcast (`broadcast` falsy, e.g. a dry-run sim) failure RESTORES to pre-claim (reservation released, `replaySignalUnresolved`, retryable) instead of terminal `failed`, so the next call reconciles-with-decode once RPC recovers. `isV2ReplaySignal` is deliberately UNCHANGED (narrowing it risks missing genuine signals; the broadcast gate makes a false match land in the same safe quarantine as a no-match). **Hardened again (round 4 — Codex BLOCK fixes):** (R4-A) the physical-free clamp now uses the escrow's ON-CHAIN aggregate `pending_amount` (`physicalFree = vault − pending_amount`), not the DB reserved-sum — the DB sum MISSES out-of-band settles and settle_unknown-landed pendings; PLUS a fail-CLOSED UNOWNED-PENDING GUARD (opposite polarity to the fail-open clamp): if `pending_amount` is unreadable → refuse `pending_state_unverifiable`, if `pending_amount` > the gate-tracked pending → refuse `unreconciled_onchain_pending` (the program PERMITS sequential settles, so an unowned pending is a chain-legal double-pay this guard is the ONLY thing preventing). This AGGREGATE guard deliberately SUPERSEDES per-pending `service_hash` ownership adoption — an out-of-band pending is ops-reconciled, NEVER auto-adopted. The pre-claim current-index reconcile is REMOVED as dead code (settle-increment ⇒ the current index is always the next-free slot). (R4-C) `escrowFundsLedger` + the in-lock re-read now count SUCCEEDED direct deposits (`sap_deposit_requests`) as funding, so a valid settle after a direct deposit + withdraw isn't wrongly rejected. (R4-D) a STALE `settling`/`finalizing` claim self-heals from the on-chain truth (probe the PERSISTED index → adopt `pending` / terminal `settled` / restore `submitted` / ops-refuse) instead of refusing forever. **Hardened again 2026-07-10 (round 5 — adversary BLOCKING):** the R4-D absent-arm "PDA absent ⇒ our settle never landed" premise was WRONG — a finalized PendingSettlement is CLOSABLE for rent (`buildClosePendingSettlementIx`, sap-escrow-v2.ts:410), so `crash-at-settling → permissionless finalize (worker PAID) → close (PDA gone) → absent-arm restores 'submitted' → retry → DOUBLE-PAY` (the `pending_amount` guard is blind — finalize already decremented it). FIX (R5-1): the absent-arm restore is now gated on the MONOTONIC escrow `settlement_index` (surfaced always as `currentSettlementIndex`; incremented ONLY inside settle, UNTOUCHED by finalize/close) — restore ONLY when `currentSettlementIndex === persistedIndex` (slot provably never consumed); `current > persisted` ⇒ the slot was consumed (finalized+closed, or superseded) ⇒ refuse fail-closed `settle_slot_consumed` (reservation KEPT), regardless of wasStatus. Also: (R5-2) an ABSENT escrow account (`fetchNullable` null, distinct from a read failure) refuses TERMINAL `job_not_open` instead of the retryable `pending_state_unverifiable` retry-loop; (R5-3) the stale-recovery probe is 4s-bounded (hung RPC can't stall the per-escrow mutex); (R5-4) the single-settle invariant the recovery's absolute-SET rests on is pinned by test (a `pending`/`settled` row re-entering settle replays with amounts UNCHANGED). **MED-2 accepted tradeoff:** the unowned-pending guard's `gateLivePending` deliberately EXCLUDES `settling` rows (including a mid-flight settle's still-provisional reservation would MASK a real unowned pending) — the cost is a cross-process availability window (a concurrent settle's landed pending can trip a false `unreconciled_onchain_pending`) bounded by `SAP_STALE_CLAIM_MS`; a genuine out-of-band pending needs MANUAL ops reconcile. **An automated reconcile endpoint (resolving `unreconciled_onchain_pending` / `settle_slot_consumed` / stale `in_flight` idempotency claims / stale `pending` rows whose on-chain pending was FINALIZED OUT-OF-BAND — see the out-of-band-FINALIZE phantom residual below) is a REQUIRED-pre-real-funds-flip item.** That endpoint's `settle_slot_consumed` handler MUST disambiguate — from the escrow's on-chain settle/finalize tx history, which the DB row alone CANNOT — the TWO cases it folds: (1) our settle LANDED → was finalized → its pending was closed for rent (the worker was PAID; resolve: mark the row `settled`, sourcing amounts from chain history) vs (2) our settle NEVER landed and a sibling settle superseded the slot (resolve: safe to reset the row to `submitted` for a clean retry); read the tx history before acting. (M4) both reconcile branches now honor the decoded `isDisputed`/`isFinalized`: a DISPUTED pending books NOTHING (ops resolution); an already-FINALIZED pending (the account survives finalize) reconciles TERMINAL `settled` with the principal booked as RELEASED (never reserved), so `finalizeJobV2` never runs against an already-finalized settlement. **Hardened again (adversary A1 + A2):** (A1) the settle-claim vault clamp now compares the debit against the LIVE **physical-free** balance (`vault − reserved principal`), not the raw vault — `min(remaining, vault)` was inert for any drain ≤ reserved (reserved principal physically sits in the vault until finalize; only the fee leaves at settle), the exact crash-window drain FIX 2b's best-effort booking can miss; never false-rejects (a consistent state always has `vault − reserved ≥ remaining`). (A2) BOTH reconcile branches now run the decode-then-book UNDER the per-escrow `pg_advisory_xact_lock` with a **sibling guard** (a DIFFERENT row of the same escrow already owning the pending at this `settlement_index` ⇒ book nothing, `settle_in_progress`), so no cross-process / cross-row double-book. VERIFIED against OOBE `escrow_v2.rs` @55d29ed: `settlement_index` increments INSIDE `settle_calls_v2` (a unique index per settle) and the PendingSettlement account is KEPT (marked `is_finalized`, not closed) at finalize — so the guard is defensive under settle-increment but correct under either semantics.
- **Stale-claim recovery [SETTLE/FINALIZE claims: NOW IN CODE — R4-D; DEPOSIT/WITHDRAW `in_flight`: Codex #6, REQUIRED-pre-flip].** R4-D self-heals a stale `settling`/`finalizing` settlement claim (a crashed process) from the on-chain truth at settle/finalize entry (`SAP_STALE_CLAIM_MS` = 10 min; probe the persisted index → adopt `pending` / terminal `settled` / `settle_slot_consumed` (slot consumed) / escrow-closed quarantine / disputed ops-refuse / R10-1 QUARANTINE-not-restore — never guess), so a settlement claim can no longer strand. **R10-1 (Codex V3-1):** the never-landed arm (`current === persisted`) now QUARANTINES to `settle_unknown` (reservation KEPT), it does NOT auto-restore to a retryable `submitted` — the old restore→retry lifecycle dropped the R7-1 slot pin (the retry fresh-inspects the current index), re-opening a zombie-lands-after-restore double-pay; no auto-retry ⇒ no lifecycle ⇒ that class is dead. Ops resets a provably-never-landed row via the reconcile endpoint. The DEPOSIT (and now WITHDRAW) `sap_deposit_requests` / `sap_escrow_withdrawals` `in_flight` claims are NOT yet self-healing: a hard CRASH mid-send (after the claim INSERT, before the outcome persists) leaves the claim `in_flight` forever — a same-key replay 409s SAFELY (never re-sends), but a NEW-key retry double-funds/-withdraws the depositor's OWN (recoverable) escrow — out-of-contract but unrecoverable without ops. **REQUIRED pre-real-funds-flip:** a chain-checking reconciler / TTL sweep that flips a stale `in_flight` to a terminal state. NOTE (Codex #6): a real fix wants executor-level PRE-BROADCAST signature capture (so a crashed `in_flight` row always carries a chain-poll anchor) — `executeTx` is out of tonight's scope by the byte-parity constraint, so R3-3 captures the signature only for the post-return throw, not a hard crash before the executor returns.
- **Withdraw idempotency [RESOLVED 2026-07-09 — R4-B].** `/escrow/v2/withdraw` now mirrors the deposit idempotency EXACTLY: `requestId` REQUIRED in the zod; migration 0023c adds `request_id` + a partial UNIQUE `(subject_avatar_id, request_id)` to `sap_escrow_withdrawals` + widens the status CHECK to include `in_flight`; the flow is CLAIM-FIRST (INSERT `in_flight` before the send — the funds ledger subtracts ALL rows including `in_flight`, an intentional pessimistic hold); succeeded/broadcast_unknown/pre-broadcast-delete/throw-park outcomes + fingerprint (escrowPda, amount) replay identical to deposit (in-flight → 409 `withdraw_in_flight`, key reuse → 409 `withdraw_request_mismatch`, terminal replay → recorded outcome `replayed:true`, NO re-send). `withdrawEscrowV2Idempotent` (escrow-gate.ts). Dry-run is a full passthrough with zero persistence.
- **Round 7 hardening 2026-07-10 (Codex re-BLOCK — 3 BLOCKING resolved).** **(R7-1 — Codex #1 TOCTOU + #2 wall-clock fallacy) the settle send is PINNED to the CLAIM-CAPTURED index.** `settleCallsV2Usdc` no longer re-reads the escrow's current index at build time — it takes a REQUIRED `expectedSettlementIndex`, and `settleJobV2` passes the index it inspected AND persisted on the row at claim. An out-of-band settle (or a stale zombie broadcast landing late under stalled block production) that advanced the counter between our claim and our send now makes the program's pending-PDA seeds constraint REVERT this tx (fail-closed) instead of silently creating a SECOND pending at N+1 → **exactly-once per slot is enforced ON-CHAIN, not by wall-clock**. The finalize executor was ALREADY index-pinned (`finalizeSettlementUsdc({ settlementIndex: row.settlementIndex })`) — confirmed, unchanged. The R6-1 blockhash-window assertion STAYS as defense-in-depth but is now correctly documented as PROBABILISTIC (Solana blockhash validity is ~151 BLOCKS via `lastValidBlockHeight`, NOT a wall-clock ceiling), no longer the safety property. **(R7-2 — Codex #1 phantom-mask) the unowned-pending guard now counts CONFIRMED ownership only:** `gateLivePending` sums `pending | finalizing | finalize_unknown` and DROPS `settle_unknown` (R8-1 below ALSO drops `finalize_unknown` — the same phantom-mask; the current membership is `{pending, finalizing}` only). An UNCONFIRMED settle_unknown is not proof of ownership — counting it let a phantom never-landed settle_unknown of X MASK a genuinely-unowned on-chain pending of X (guard read gate==on-chain and passed → double-pay). Fail-closed cost, by design: an escrow carrying a truly-landed `settle_unknown` now refuses ALL settles (`unreconciled_onchain_pending`) until ops reconciles — exactly the reconcile-only quarantine `settle_unknown` already means. **(R7-3 — Codex #3 closed-escrow brick) a stale claim whose ESCROW was CLOSED on-chain no longer bricks in an infinite retry.** `inspectV2SettlementState` now surfaces escrow ABSENCE distinctly (`escrowAbsent:true`, distinct from a read FAILURE which stays a retryable `SapFailure`), and `recoverStaleV2Claim` flips the row to its reconcile-only quarantine for its phase (`settling` → `settle_unknown` / `finalizing` → `finalize_unknown`, reservation KEPT, metadata `escrowClosedDuringClaim`), returning the existing `settle_unconfirmed`/`finalize_unconfirmed` refusals — ops disambiguates from tx history (same method as the `settle_slot_consumed` runbook above; NEVER guesses settled vs never-landed). **(R7-4)** the dead `finalize_unresolvable` code (unreferenced since R5-1's monotonic-index gate replaced it with `settle_slot_consumed`) is removed from the error union + route mapping, and the `recoverStaleV2Claim` contract comment is corrected (a pending does NOT "provably survive finalize" — it is closable for rent). Gates: 128/0 SAP tests, tsc 33/0-SAP, `sap-escrow-v2.ts` diff EMPTY, `executeTx` + V1 executors byte-untouched, no schema/dep change, flags OFF + dry-run.
- **Round 8 hardening 2026-07-10 (adversary re-BLOCKED round 7 on ONE finding — the mirror of R7-2).** `finalize_unknown` in `gateLivePending` was the SAME phantom-mask R7-2 fixed for `settle_unknown`: an UNCONFIRMED finalize may have LANDED (releasing the principal → the escrow's on-chain `pending_amount` decremented/gone) while the DB row RETAINS its `reservedPrincipalAmount`, so the gate OVERSTATES and an unowned on-chain pending of ≤ the phantom passes the guard → double-pay on a multi-job escrow (it also breaks the post-restore-retry safety argument). **R8-1: `gateLivePending = Σ reservedPrincipalAmount over {pending, finalizing} ONLY`** — `finalize_unknown` is DROPPED from the gate. Mental model: `pending`|`finalizing` are the ACTIVE rows whose on-chain pending provably exists (`pending` = settle confirmed; `finalizing` = the transient, mutex-serialized in-flight window, deliberately kept to avoid false-firing during EVERY normal finalize — the same accepted narrow window that excluding `settling` opens on the settle side); BOTH broadcast-unknown quarantines (`settle_unknown` AND `finalize_unknown`) are AMBIGUOUS and fail-CLOSED. Consequence (intended): an escrow carrying a `finalize_unknown` row now refuses ALL settles (`unreconciled_onchain_pending`) until ops reconciles — the quarantine that status already implies. (`finalize_unknown` STAYS in the `remaining` ledger — its settle DID confirm, so its reserved principal correctly leaves the free balance; only the GATE membership changed. R7-3 also mints `finalize_unknown` for a CLOSED escrow, where the guard's terminal `job_not_open`/escrowAbsent fires before this comparison anyway.) Tests: the adversary's exact double-pay sequence (finalize_unknown reserved P + unowned pending ≤ P → REFUSE `unreconciled_onchain_pending`) + a positive `{finalizing}`-still-counts test. Gates: 130/0 SAP tests, tsc 33/0-SAP, `sap-escrow-v2.ts` diff EMPTY, `executeTx` + V1 executors byte-untouched, no schema/dep change, flags OFF + dry-run.
- **Out-of-band-FINALIZE phantom [MED, pre-real-funds-flip — logged 2026-07-10, adversary residual on `5aff049d` (verdict SHIP)].** The aggregate unowned-pending guard detects `on-chain > gate` (unowned settles) but is BLIND to `gate > on-chain`: a tracked `pending` row whose pending was finalized OUT-OF-BAND (a permissionless crank post dispute-window — worker paid, on-chain `pending_amount` decremented, but OUR row still `pending`) becomes a PHANTOM in `gateLivePending` that can mask an unowned pending of ≤ its amount → the SAME double-pay class, via a THIRD phantom source the aggregate cannot see. R7-2/R8-1 closed the two phantom sources UNDER OUR CONTROL (our own unconfirmed settle/finalize broadcasts = `settle_unknown`/`finalize_unknown`); this third source is NOT under our control, and `pending` itself CANNOT simply be dropped from the gate like the unknowns were — it is the NORMAL healthy state, so dropping it would false-fire the guard on every multi-job escrow (the positive `{pending}`/`{finalizing}` tests exist to prevent exactly that). **Exploitability VERIFIED REAL 2026-07-10 (Codex, against the DEPLOYED IDL):** `settle_calls_v2`'s account list carries ONLY the worker wallet as signer — NO co-signer / arbiter for `settlement_security` — so out-of-band settles CAN exist and this residual is REAL, not conditional (the earlier co-signer-→-moot branch is closed). The COMPLETE pre-real-funds-flip fix is per-pending PDA EXISTENCE verification: decode EACH tracked `pending`/`finalizing` PDA (not the aggregate `pending_amount` sum) and count ONLY the pendings that still EXIST AND are NOT finalized, so a pending finalized out-of-band stops counting toward the gate. Until the per-pending fix ships: flip-gated — real-funds settlement stays OFF.

2. **Wiring + E5 parity (ROUTED, GATED OFF).** The V2
   FUNDING-side ops are now routed in `routes/sap.ts` behind `requireAuthOrAgentSession` +
   `requireNonGuestIdentity` + `requireLedgerCapable` + `gate503` + `SAP_DRY_RUN`, E5 parity
   (both human + connected agent act AS THEMSELVES, custody bound to `identity.avatarId`, never
   a body pubkey): `POST /api/sap/agent/pricing` and `POST /api/sap/escrow/v2/{provision-stake, create, deposit, withdraw, open, settle, finalize}`. These are
   SELF-CUSTODY (owner stakes own SOL; depositor funds/withdraws its OWN escrow — free balance
   only, on-chain enforces free=balance−pendingAmount) so no gate approval is needed. The
   RELEASE ops move money to a counterparty only through the escrow-gate's approval/ceiling/self-
   dealing/at-most-once layer. `/settle` binds the caller to the recorded worker; `/finalize` is a
   permissionless crank for any authenticated non-guest avatar and uses that avatar only as payer.
   Custody always comes from `identity.avatarId`; body pubkeys remain counterparty/PDA seeds.
   Gated as `FEATURE_GATE sap_v2_release_path` (see the block on `settleCallsV2Usdc`). ⚠️ **The
   release path is routed but is not live: all feature flags remain OFF and dry-run remains ON.**
   Also: route `close_escrow_v2` (self-custody rent reclaim on an empty escrow) with the funding
   bucket when its executor is added. (The `deposit_escrow_v2` idempotency-key TODO that used to
   live here is DONE — see the R3 RESOLVED item above; withdraw idempotency is also DONE per R4-B.)
3. **Agent stake + pricing provisioning (economic prerequisite; pricing-route gap RESOLVED).**
   Every agent still needs ≥0.1 SOL staked (`init_stake`, MIN hard-enforced 6107) + ~0.055 SOL
   register rent before it can accept an escrow. The previously missing application route for the
   other prerequisite now exists: worker-owned `POST /api/sap/agent/pricing` calls
   `update_agent(pricing=[tier])` through the worker's own custodial wallet. On-chain this operation
   **replaces the complete pricing menu** (last write wins), so ClawVille intentionally supports one
   caller-named Escrow-mode USDC tier per worker for now. Its `pricePerCall` MUST equal
   `createEscrowV2Usdc.pricePerCall` (depositor-signed), or create fails `PricingTierNotFound 6148`.
   The pricing route resolves the fail-late 6148 provisioning gap; funded SOL stake provisioning
   and a read-only price-match precheck remain flip-gate work. Nothing is auto-provisioned and all
   flags remain OFF with dry-run ON by default.
4. **Deposit sizing.** `createEscrowV2Usdc` enforces `initialDeposit ≥ obligation + ceil(obligation
   × 1%)` (FEE_HEADROOM_BPS=100, 2× the measured 0.5% fee) so a single-settle escrow can pay the
   fee. For MULTI-settle escrows confirm the per-batch fee rounding stays within the headroom on
   the deployed program (only a single full settle was devnet-proven).
5. **Confirmed handled in this diff (bank-grade):** N1 — `executeTx` now inspects
   `confirmTransaction().value.err` so a landed-but-REVERTED tx returns a structured failure
   (`broadcast:true`+signature), not `ok:true`. N2 — the deployed custom errors 6062/6107/6148/6161
   map to distinct `SapErrorCode`s (`insufficient_escrow_balance` / `stake_below_minimum` /
   `pricing_tier_not_found` / `pending_settlement_deprecated`).
6. **Dispute RESOLUTION model changed in 1.0.0.** `resolve_dispute` (the arbiter-signed
   DepositorWins/AgentWins path) DOES NOT EXIST in the deployed program — it was a phantom
   instruction and has been REMOVED from the client (`buildResolveDisputeIx` + `resolveDisputeUsdc`
   deleted). 1.0.0 resolves a filed dispute via `auto_resolve_dispute` (permissionless, merkle-proof
   + stake-slash) + `submit_agent_evidence`. `file_dispute` (the depositor's dispute FILING, now with
   a `dispute_type` arg) stays wired; wiring the auto-resolve/slash model is a deliberate follow-up
   (it moves real stake). CoSigned settle remains unimplemented (DisputeWindow is the wired flow).
   `deposit_escrow_v2` top-up SPL was inferred from create (now Anchor-built off the SDK IDL, wire-
   parity tested). The SDK adoption makes `scripts/sap/v2-dispute-window-smoke.ts` current
   (rewritten to the SDK path: no `create_pending_settlement`, settle inits the pending itself).

---

## 11. Bounty COMPOSITION rail — SAP V2 vault (LEG 1) → PayAI x402 (LEG 2)

> **Set 2026-07-10 (B1 slices 2a/2b/3).** Founder spec (LOCKED): *"bounties are done via
> escrow through SAP and then settled via x402 with PayAI."* A `payment_rail='usdc'` bounty
> selected onto the **composed** rail custodies the creator's USDC in an on-chain SAP V2 vault
> **at post**, then pays the winning hunter one x402 USDC payment from the house. Gated OFF +
> dry-run by default (all four SAP gates); no money moves until a deliberate flip.

### Rail selection (recorded on the row, never re-read from the flag)

`bountySettlementRail()` (`services/bounty-escrow-link.ts`) → `sap-payai-composed` when BOTH
`SAP_USDC_ESCROW_ENABLED` **and** `SAP_PAYAI_SETTLEMENT_ENABLED` are on. The decision (`isComposedRail`)
is made ONCE at create and stamped IN the insert as `bounties.composition_state='vault_pending'`
(a FAIL-CLOSED custody sentinel — see the state machine), then flipped to the immutable `'vault_held'`
marker on a successful vault open. Every later transition branches on that column (not the live flag),
so a mid-lifecycle flag flip can never re-route or double-move an existing bounty. A non-composed USDC
bounty keeps `composition_state` NULL and uses the legacy single-leg path (`runBountyUsdcSettle`), unchanged.

### The two legs + the fixed HOUSE worker

The deployed program seeds every escrow with the WORKER key at open, and a bounty's hunter is
unknown at post, so the composition uses the **ClawVille house** (Coralia, `resolveHouseAvatarId`)
as the FIXED escrow worker:

- **LEG 1 (on-chain V2 vault)** — at CREATE, `openComposedBountyEscrow`:
  - **LEG 1 tier-publish (the 6148 fix)** — FIRST (re)publishes the house pricing tier at THIS
    bounty's exact price (`updateAgentPricingUsdc` with `tierId='bounty-usdc'`, `pricePerCall =
    usdcRewardBaseUnits(reward)`), because `create_escrow_v2` rejects `PricingTierNotFound 6148`
    unless the escrow's `price_per_call` matches a tier in the WORKER's on-chain pricing_menu, and the
    house provisioner only publishes a fixed NOMINAL 1-USDC tier that arbitrary rewards can never
    match. `update_agent(pricing)` replaces the whole menu (last-write-wins), so the constant tier id
    at the new price is correct. The tier-publish AND the create below are held together under a
    per-house keyed mutex (`sap-house-pricing:<houseAvatarId>`, `services/keyed-mutex.ts`): a
    concurrent bounty's tier-set must not land between this bounty's tier-set and its create (that
    would make the create read the wrong price ⇒ 6148). Single API container ⇒ the in-process mutex is
    sufficient (mirrors escrow-gate's per-escrow serialization). `settle_calls_v2` captures price at
    CREATE and does NOT re-read the menu, so a LATER bounty overwriting the menu can never break an
    already-created escrow's settle/finalize. If the tier-publish fails, `openComposedBountyEscrow`
    returns a typed `internal` failure WITHOUT opening the vault (provably no custody ⇒ the create
    route deletes the phantom bounty) — never fund a vault the create would 6148-reject.
    **Ops caveats (adversary LOW nits, money-safe):** (1) `scripts/sap/provision-house-sap.ts` is a
    SECOND, cross-process, un-mutexed writer to the same menu (it resets the nominal 1-USDC tier) —
    do NOT run a house re-provision while the composed rail is live-creating; a collision is a
    transient, atomically-reverted, retryable 6148, never stranded custody. (2) ALL composed creates
    platform-wide serialize through the one house mutex (held across the on-chain create+confirm), so
    a slow create head-of-line-blocks the rail for seconds — inherent to the single-tier
    whole-menu-replace design. (3) A bounty over the house STAKE coverage (~$200 at 0.11 SOL) burns
    one pricing tx before the coverage preflight rejects it — wasted fee only, menu self-heals on the
    next create.
  - then opens a V2 USDC escrow `depositor=creator, worker=house, jobId=bountyId`, funded to
    `bountyVaultDeposit(reward)` with a deterministic `bountyEscrowNonce(bountyId)`. At APPROVE:
    `approveJob`(creator) → `settleJobV2`(house, reserves principal in a PendingSettlement) →
    `finalizeJobV2`(permissionless, releases principal to the house after the dispute window).
    **LEG 1d (auto-reclaim)** fires right after finalize.
- **LEG 2 (payai)** — one x402 exact USDC payment house→hunter through the existing PayAI rail
  (a V1 `rail:'payai'` escrow `depositor=house, worker=hunter, jobId=${bountyId}:payout`).

### Reward denomination + FEE / DEPOSIT / CONSERVATION ($100 bounty; base units)

`bounties.token_reward` is always an integer vCLAW count: **1 vCLAW = $0.01**.
`usdcRewardBaseUnits(tokenReward)` converts without floating point as
`BigInt(tokenReward) × 10_000n`, so the 5-vCLAW floor funds exactly `50_000`
USDC base units ($0.05). In the $100 example below, `token_reward=10_000` vCLAW
and the exact on-chain principal is `100_000_000` base units.

```
deposit       = bountyVaultDeposit = principal + MAX(0.5% fee, 1% create-floor) = 101_000_000
settle debit  = principal 100_000_000 + fee 500_000                              = 100_500_000
  → house receives 100_000_000 (principal at finalize); treasury 500_000 (fee)
  → LEG 2 pays hunter EXACTLY 100_000_000 (one x402 payment)
  → 500_000 headroom spread = creator's RECLAIMABLE dust (leg 1d) — NOT a loss
ledger: creator(101) = hunter(100) + treasury(0.5) + creator-reclaimable(0.5)   [no mint/burn]
```

### State machine (`bounties.composition_state`)

| state | meaning | set by | next |
|---|---|---|---|
| `vault_pending` | stamped IN the create insert BEFORE the vault opens (FAIL-CLOSED sentinel); a crash between the insert and the `vault_held` flip leaves this — the vault MAY or MAY NOT have opened, `escrow_pda` unrecorded, binding INDETERMINATE | create insert | open ok → `vault_held`; approve + admin-refund 409 (reconcile via the deterministic nonce); cancel refunds via the nonce |
| `vault_held` | LEG 1 vault opened + recorded at post; creator's USDC custodied, not settled | create (open ok) | approve / cancel |
| `awaiting_finalize` | LEG 1b settled (principal reserved); LEG 1c finalize pending the dispute window | approve/crank | crank → `paid` |
| `reconcile_payout_failed` | LEG 1 FINALIZED (reward at house) but LEG 2 payout failed | approve/crank | crank retries LEG 2 → `paid` |
| `paid` | both legs done: house finalized + hunter paid the reward | approve/crank (via `bookComposedBountyPaid`) | terminal |
| `failed` (transient) | LEG 1a/1b failed before any settle; funds still in the vault, `composition_state` STAYS `vault_held`. A pre-broadcast V2 settle failure (L-2, 2026-07-10) now restores the gate row to a RETRYABLE status (not terminal `failed`), so the row is re-drivable | — | auto-retried by the `vault_held`+approved crank sweep (L-1) |

**No `refunded` state** (by design): a refund (cancel / admin-fail-refund, `vault_held` ONLY) leaves
`composition_state='vault_held'` and marks the terminal via `status='cancelled'` (cancel) or
`covenant_verification_passed=false` (admin-fail-refund); the idempotent `${bountyId}:refund` withdraw
makes a re-refund a safe no-op, so no distinct marker is needed.

Every leg is idempotent (deterministic V2 nonce + `(escrowPda, jobId)` at-most-once ledger +
`${bountyId}:{payout,refund,reclaim}` request ids), so approve and the crank re-drive safely and book
the hunter's completion + the dust reclaim EXACTLY ONCE. The →paid booking (the one seam with two
authors) rides `bookComposedBountyPaid`'s atomic per-path CAS (`WHERE composition_state = <observed
prior> AND != 'paid' RETURNING`): approve passes `'vault_held'`, the crank passes its loaded
`'awaiting_finalize'`/`'reconcile_payout_failed'` — disjoint priors, so each books at most once.

### The two team-lead rulings

1. **Dispute window = MINIMUM (1 slot).** `SAP_BOUNTY_DISPUTE_WINDOW_SLOTS` (default 1, floor 1) is
   threaded `openComposedBountyEscrow` → `openEscrowV2` → `createEscrowV2Usdc` (per-escrow override
   of the global `SAP_DISPUTE_WINDOW_SLOTS` default 2160 ≈ 15 min, which stays large for agent↔agent
   escrows). A bounty's "verdict" is the creator's own approve (RequesterApproval), so no arbiter
   window is needed and the winning hunter is paid promptly. **Raising it DELAYS the payout** — the
   settle returns `awaiting_finalize` at approve and the resume worker completes it once the window
   elapses.
2. **Auto-reclaim (LEG 1d).** After LEG 1 finalizes, the creator's ~0.5% headroom dust is FREE vault
   balance; `settleComposedBounty` idempotently withdraws it back to the creator
   (`withdrawEscrowV2Idempotent`, `${bountyId}:reclaim`). **Non-fatal** — a reclaim failure never
   changes the settle outcome; the dust stays reclaimable (manually or on the next pass).

### The resume worker (finalize/payout crank)

`resumeComposedBounty(bountyId)` + `startComposedBountyResumeWorker()` (`services/bounty-composition-worker.ts`),
boot-wired in `index.ts` **DARK-gated** (starts ONLY when `bountySettlementRail()==='sap-payai-composed'`;
cadence `SAP_BOUNTY_RESUME_POLL_MS`, default 5 min, floor 1 min). Each pass advances every bounty stuck in
`awaiting_finalize` / `reconcile_payout_failed` — AND (L-1, 2026-07-10) every `vault_held` bounty that carries
an **APPROVED attempt** — by re-driving `settleComposedBounty` (idempotent). The `vault_held` sweep is the
wedge self-heal: an approve whose settle failed pre-settle leaves `vault_held` WITH an approved winner (before
the L-2 gate fix a transient sim failure parked the V2 row terminal `failed`), and the route's 'failed'-phase
note long promised "retryable via an ops crank" — this IS that crank.

**Two-tier priority (no starvation):** the sweep runs TIER 1 (`awaiting_finalize` / `reconcile_payout_failed`
— money mid-flight, delayed REAL payouts) first, taking up to the whole `RESUME_BATCH`; TIER 2 (`vault_held` +
approved) runs only on the slots tier 1 leaves free, both ordered `updated_at` ASC. So the L-1 `vault_held`
class can NEVER starve a money-mid-flight row. **Persistent-wedge alert (L-3c):** a `vault_held`-origin resume
that ends phase `failed` now pages ops (`alertError`, `source:bounty-composition`, severity critical) with
`{bountyId, escrowPda, code}`, throttled per bounty to one page per hour (an in-memory Map — resets on restart;
alert-error.ts's own limiter is only 60s, shorter than the ~5-min crank, so the worker owns the window). So ops
sees a stuck approved bounty long before batch-size accumulates. Residual (still deferred): within tier 2 a
permanently-wedged row keeps a slot each pass (a no-op `failed` resume doesn't bump `updated_at`), so ≥
batch-size permanent wedges delay NEWER vault_held payouts — money-safe (USDC stays custodied). The remaining
real fix (a terminal quarantine / backoff needing a NEW `composition_state`) is bigger than warranted until ops
noise proves real.

**Provenance guard (money invariant):** a `vault_held` bounty is swept ONLY with a genuinely approved attempt —
the winning hunter is resolved FROM that approved attempt row, NEVER from input; the sweep query's
`EXISTS(approved attempt)` filter + `resumeComposedBounty`'s `no_winner` backstop exclude an unapproved
(refund-path) `vault_held` bounty. **No double-book / double-pay under a concurrent approve retry:** both the
approve route and the sweep feed `bookComposedBountyPaid` the SAME observed prior `'vault_held'`, so the atomic
`WHERE composition_state='vault_held' AND != 'paid'` CAS flips exactly once; every settle leg is at-most-once
(the V2 'settling' claim + pg advisory lock; the leg-2 payout `(payoutPda, ${id}:payout)` key). The crank still
NEVER touches the terminal `paid`, or the indeterminate `vault_pending` (operator-reconcile only).

**Settle-failure disposition — pre-broadcast restores, may-have-landed quarantines (L-2 / L-3a / L-3b):** every
post-claim settle failure now splits by whether the money leg MAY have reached the wire, so a transient failure
no longer wedges an approved bounty terminal `failed` (which the settle claim refuses `job_not_open`):
- **V2 vault settle** (`settleJobV2`, L-2): a `broadcast` falsy (pre-broadcast sim/RPC) failure RESTORES the row
  to its pre-claim status (retryable); `broadcast:true` KEEPS `settle_unknown` (reconcile-only).
- **payai LEG-2 payout** (`settleJob` payai branch, L-3a — the composed hunter payout): a `broadcastUnknown:false`
  VERIFY-stage failure (the facilitator provably never called `/settle`) RESTORES retryable; `broadcastUnknown:true`
  (verify passed → `/settle` attempted → may have executed on-chain) STAYS terminal `failed`, never auto-retried.
  `broadcastUnknown` is a FULL equivalent of the on-chain `broadcast` flag (set in `payai-release.ts`), so there is
  NO honesty asymmetry — both rails cleanly discriminate provable-no-move from may-have-moved.
- **V1 vault settle** (`settleJob` chain branch, L-3b — latent, off the composed path): the same `broadcast` split.
Money-neutral in every case (the restored arm moved nothing + the payai/V1 claim reserves no columns, so only the
status label flips terminal→retryable); the may-have-landed arm is UNCHANGED (a payment that may have executed must
never auto-retry — double-pay). Together these let the composed bounty SELF-HEAL to `paid`: a LEG-1 settle transient
→ L-2 restore → next sweep; a LEG-2 payout transient → L-3a restore → next sweep.

### OPS RUNBOOK — `reconcile_payout_failed`

Meaning: LEG 1 finalized, so the **reward is safe in the house wallet**; LEG 2 (the x402 hunter
payout) failed. A CRITICAL `bounty-composition` / `bounty-composed-payout` alert pages ops. **No
double-pay is constructible** (LEG 2 replays idempotently on `${bountyId}:payout`). Resolution:
- Automatic: the resume worker retries LEG 2 each pass; a transient PayAI/RPC blip self-heals to `paid`.
- Manual: re-run `resumeComposedBounty(<bountyId>)` (or wait a poll cycle). If it persists, check the
  PayAI facilitator + the house wallet's USDC balance; the reward is in the house vault-out, not lost.
- NEVER refund a `reconcile_payout_failed` bounty (the hunter earned it) — the money owed is the
  house→hunter payout, not a creator refund. `admin-fail-refund` refuses any state other than `vault_held`.
