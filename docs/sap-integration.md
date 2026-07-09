# SAP (Synapse Agent Protocol) — on-chain integration + flip-to-live runbook

**Status:** FULLY built, gated OFF + devnet-first + dry-run by default. **Set 2026-06-20. Last audited 2026-07-09 (rev 4) — workers can now publish the required caller-named Escrow-mode USDC pricing tier through the authenticated, avatar-bound `POST /api/sap/agent/pricing` route; `update_agent(pricing=[tier])` replaces the worker's entire pricing menu, and the tier price must exactly match a later V2 escrow price. Prior rev 3: SAP V2 DisputeWindow release was routed through the escrow-gate ledger as an OFF-by-default, two-phase `settle → pending → finalize` lifecycle; prior rev 2: adopted the official SDK `@oobe-protocol-labs/synapse-sap-sdk@1.0.0`; prior rev 1: 0.18→0.25 migration.**
**Plan:** `.claude/plans/sap-onchain-agents/PLAN.md` · **Owner:** orchestrator (Claude)
**FEATURE_GATE:** `sap_onchain_agents` (review deadline 2026-09-20 — see `routes/sap.ts`).

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
| `apps/api/src/services/sap/synapse_agent_sap.idl.future-0.25.json` | The **0.25.0 IDL** (MIT, `IDL-LICENSE-MIT.txt`) — the client LOADS THIS for the Anchor-driven identity/stake/pricing instructions (register / init_stake / deposit_stake / request_unstake / complete_unstake / update_agent), whose account contexts (incl. `pricing_menu`) match the deployed 0.25-family binary. ⚠️ Its `settle_calls_v2` (6-acct) + `create_pending_settlement` are WRONG for the deployed program — the escrow-V2 money family is hand-rolled instead (see below). |
| `apps/api/src/services/sap/synapse_agent_sap.onchain.idl.json` | The **0.18.0 IDL** fetched from the OLD devnet deployment — now STALE (4-acct create, no `pricing_menu`). Kept FOR REFERENCE / diffing only. NOT loaded. |
| `apps/api/scripts/sap/fetch-onchain-idl.ts` | Throwaway: re-fetch the deployed IDL from devnet → re-vendor. Run after any OOBE redeploy (⚠️ the fetched IDL is NOT authoritative for the escrow-V2 money family — see the warning block above). |
| `sap-config.ts` | Gate + cluster + program-id + RPC + dry-run + USDC-mints + min-stake loader. `loadSapConfig()` + the mainnet code-gate throw + the mainnet-RPC-hostname guard (FIX-D) + `isHonoredEscrowMint()` (SOL-only, FIX-E) + the mainnet genesis-hash constant. `SAP_MIN_STAKE_LAMPORTS` mirrors the on-chain floor (StakeBelowMinimum 6107). |
| `sap-pdas.ts` | Pure PDA derivation for every account + `u64LE`, `toolNameHash` (sha256), `serviceHash`. `findReceiptPda` is NOT wired into settle (deployed settle takes no `settlement_receipt`; the pending PDA rides in SPL remaining). |
| `sap-escrow-v2.ts` | The HAND-ROLLED escrow-V2 money builders (create/settle/finalize/withdraw/dispute + close) built to the devnet-verified 0.25-family shapes, PLUS `assembleV2SplRemaining()` — the SINGLE source of truth for the SPL `remaining_accounts` wire order. Pure; byte-tested in `__tests__/sap-escrow-v2.test.ts`. |
| `sap-client.ts` | Loads the **future-0.25 IDL** + `Program` (Anchor identity/stake/pricing) + calls the hand-rolled escrow-V2 builders; custodial in-memory signing via `keypair-vault` (FIX-F); honest dry-run program-reached classification (FIX-B); live-send mainnet genesis-hash guard (FIX-D); structured errors; worker-owned `updateAgentPricingUsdc` provisioning; the `deposit>obligation` money pre-flight + `sap_agent_stake_provisioning` FEATURE_GATE. |
| `routes/sap.ts` | `requireAuthOrAgentSession`-gated Hono routes; `requireLedgerCapable` on agent-session writes (FIX-C); Zod on every body; gate → 503 before chain work; FEATURE_GATE block. |
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
- **R3 [MED] — deposit idempotency (before ANY real-funds flip).** `deposit_escrow_v2` is additive, so a client double-submit (double-click / 5xx retry) double-funds the depositor's OWN escrow. `executeTx`'s confirm-split stops an SDK auto-resend but NOT a duplicate client POST. Add a route-level idempotency key `(subject, escrowNonce, requestId)` on `/escrow/v2/deposit`. (create is nonce-keyed → a re-create dedups to 6097; deposit is not.)
- **Decode-parity [INFO] — prove escrow + pending decode vs a REAL devnet escrow.** `simulate-shapes.ts` proved `EscrowAccountV2` decode + `AgentStake` decode against real accounts, but `PendingSettlement` decode is unproven — and the settle→finalize guards read `pending.amount/isFinalized/isDisputed`. Make a real-pending decode a REQUIRED gate in the release-path plan.
- **Stake coverage [MED, upgraded from LOW — OBSERVED LIVE 2026-07-09] — obligation-based floor.** Route smoke observed the rule in the wild: with a 0.11 SOL worker stake, `create_escrow_v2` at 150,000 USDC base units PASSED but a `deposit_escrow_v2` raising total to 200,000 FAILED `EscrowCoverageExceeded (6153)` — the deployed program DOES bind token-escrow deposits to the SOL-denominated stake via a conversion the SDK does not model (`computeRequiredStakeLamports` takes lamports only — second upstream SDK gap). Derive the exact on-chain formula (read the program's coverage check against live account states) and mirror it in the create/deposit preflight before flip.
- **Stake coverage [LOW, superseded by the line above] — original note.** The create preflight currently passes `computeRequiredStakeLamports(0n)` = the 0.1-SOL FLOOR only; for a large USDC obligation the on-chain requirement is higher → fail-LATE at simulate (no fund risk). Once the coverage DENOMINATION is devnet-confirmed (does `computeRequiredStakeLamports` take the raw `price_per_call*max_calls` in the escrow's token base units?), compute the real obligation-based floor.
- **R1 [DONE] — withdraw routed.** `/escrow/v2/withdraw` ships in the funding bucket (self-custody, free balance only), so there is NO "can fund, can't defund" trap. `close_escrow_v2` route still pending its executor (self-custody rent reclaim) — route with the funding bucket when added.
- **V2-withdraw ledger bypass [MED, review finding 2026-07-09 gate-retrofit d6bd9410] — reconcile before flip.** `/escrow/v2/withdraw` moves vault→depositor ON-CHAIN without booking `refundedAmount` into the gate's settlements ledger (V1 refunds go through `refundJob`, which books; the V2 withdraw route predates the gate). Consequence: the ledger's `remaining` can OVERSTATE the vault after an out-of-band withdraw. Fail-closed on-chain — a stale-ceiling settle fails at the program (6062-family) and lands terminal `failed`/reservation-restored, never over-releases — but a depositor withdraw can brick a live job's row. Before flip: either route V2 withdraws through a gate leg that books against the escrow's jobs, or (minimum) re-read the on-chain vault balance inside the settle claim and clamp the ceiling to it.
- **Replay-reconcile books request, not chain [MED, review finding 2026-07-09 — folds into the Decode-parity gate above].** `settleJobV2`'s pending-PDA-already-exists reconcile books the CALLER's requested `callsToSettle`/principal/fee rather than decoding the on-chain `PendingSettlement`'s actual amount. Unreachable divergence today (our own claim commits before broadcast, so an open|submitted row with an on-chain pending implies an out-of-band writer), but the staging e2e MUST land PendingSettlement decode-parity and switch this reconcile to the decoded amount.

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
   bucket when its executor is added; and give the additive `deposit_escrow_v2` route an
   idempotency key (subject, escrowNonce, requestId) so a client retry can't double-fund
   (create is nonce-keyed → a re-create dedups to 6097; deposit is not).
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
