# SAP (Synapse Agent Protocol) — on-chain integration + flip-to-live runbook

**Status:** FULLY built, gated OFF + devnet-first + dry-run by default. **Set 2026-06-20. Last audited 2026-06-21 (added cross-agent attestation — the Light "identity + attestation" rung: `create_attestation` / `revoke_attestation`).**
**Plan:** `.claude/plans/sap-onchain-agents/PLAN.md` · **Owner:** orchestrator (Claude)
**FEATURE_GATE:** `sap_onchain_agents` (review deadline 2026-09-20 — see `routes/sap.ts`).

> ## ⚠️ DEPLOYED PROGRAM IS 0.18.0 — NOT the 0.25.0 repo IDL (audit FIX-A, 2026-06-20)
> The OOBE-Protocol repo IDL is **0.25.0**, but the program ACTUALLY DEPLOYED on
> devnet (`SAPpUhsWLJG1FfkGRcXagEDMrMsWGjbky7AyhGpFETZ`) is **0.18.0**, fetched via
> `Program.fetchIdl` and vendored as `synapse_agent_sap.onchain.idl.json` — the
> **AUTHORITATIVE** IDL the client loads. The 0.25.0 file is kept for reference as
> `synapse_agent_sap.idl.future-0.25.json`. **Re-vendor + re-diff if OOBE redeploys**
> (the dry-run harness version-pins to 0.18.0 and FAILS LOUDLY on drift).
>
> **0.18.0 account-context deltas vs 0.25.0 (the only differences — args are identical):**
> | Instruction | 0.18.0 accounts (DEPLOYED) | 0.25.0 added (NOT deployed) |
> |---|---|---|
> | `register_agent` | `[wallet, agent, agent_stats, global_registry, system_program]` | `pricing_menu` |
> | `create_escrow_v2` | `[depositor, agent, escrow, system_program]` | `agent_stake`, `agent_stats`, `pricing_menu` |
> | `settle_calls_v2` | `[wallet, agent, agent_stats, escrow, system_program]` | `settlement_receipt` |
> | `close_escrow_v2` | `[depositor, escrow]` | `agent_stats` |
> (publish_tool / give_feedback / init_stake / deposit_stake / deposit_escrow_v2 /
> withdraw_escrow_v2 match across versions — all re-verified against the fetched
> on-chain IDL by the harness.)
>
> **TWO on-chain protections the 0.25.0 IDL has but the DEPLOYED 0.18.0 program does NOT:**
> 1. **NO on-chain stake gate at escrow creation.** 0.18.0 `create_escrow_v2` does
>    not take `agent_stake`/`agent_stats`, so the program does NOT enforce the
>    ≥0.1 SOL self-stake precondition. The stake routes (`init_stake`/`deposit_stake`)
>    still exist, but creating an escrow does not require a stake on-chain today.
> 2. **NO per-call replay receipt at settlement.** 0.18.0 `settle_calls_v2` has no
>    `settlement_receipt` PDA, so there is NO on-chain anti-replay keyed on
>    `(escrow, service_hash)`. The `service_hash` arg is still passed but is not a
>    unique receipt key on-chain.
>
> **Consequence:** the escrow rail stays HARD-GATED (`SAP_ESCROW_ENABLED=false`)
> until EITHER OOBE deploys 0.25.0 (re-vendor + restore the dropped accounts) OR we
> add backend equivalents (a backend stake precondition check + backend
> `(escrow, service_hash)` idempotency before settling). See §9.

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
| `apps/api/src/services/sap/synapse_agent_sap.onchain.idl.json` | The **AUTHORITATIVE on-chain IDL — 0.18.0** (what is DEPLOYED on devnet, fetched via `Program.fetchIdl`). The single source of truth for instruction/account/arg shapes. The client loads THIS. |
| `apps/api/src/services/sap/synapse_agent_sap.idl.future-0.25.json` | The **0.25.0 repo IDL** (MIT, `IDL-LICENSE-MIT.txt`) — ahead of deployment, kept FOR REFERENCE ONLY. Do NOT load it; it has account contexts the deployed program lacks. |
| `apps/api/scripts/sap/fetch-onchain-idl.ts` | Throwaway: re-fetch the deployed IDL from devnet → re-vendor `…onchain.idl.json`. Run after any OOBE redeploy. |
| `sap-config.ts` | Gate + cluster + program-id + RPC + dry-run + USDC-mints + min-stake loader. `loadSapConfig()` + the mainnet code-gate throw + the mainnet-RPC-hostname guard (FIX-D) + `isHonoredEscrowMint()` (SOL-only, FIX-E) + the mainnet genesis-hash constant. |
| `sap-pdas.ts` | Pure PDA derivation for every account + `u64LE`, `toolNameHash` (sha256), `serviceHash`. |
| `sap-client.ts` | Loads the **on-chain IDL** + `Program`; custodial in-memory signing via `keypair-vault` (decrypt wrapped, FIX-F); all instruction builders (account lists match 0.18.0); honest dry-run program-reached classification (FIX-B); live-send mainnet genesis-hash guard (FIX-D); structured errors. |
| `routes/sap.ts` | `requireAuthOrAgentSession`-gated Hono routes; `requireLedgerCapable` on agent-session writes (FIX-C); Zod on every body; gate → 503 before chain work; FEATURE_GATE block. |
| `apps/api/scripts/sap/dry-run-e2e.ts` | The on-chain-IDL conformance harness — the SHIP GATE. Version-pins 0.18.0 + asserts per-instruction account-set conformance + opportunistic program-invoke proof. |

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
