# Trust-native agent commerce — PayAI × OOBE-SAP × Covenant (research deep-dive)

**Status:** research / architectural mapping (per the "plan + research before modifying core services" rule) · **Set 2026-06-21**
**Companion:** `.claude/plans/sap-onchain-agents/PLAN.md` (the phased build) · `Partnerships.md` (OOBE, Covenant, PayAI scoping) · `project_payai_x402_integration` (the off-chain x402/CT rail)

## 1. The three-party model (from the Covenant dev, 2026-06-21)

A clean separation of concerns for verifiable, trustless agent-to-agent commerce:

| Layer | Provider | Role | Mechanism |
|---|---|---|---|
| **Identity** | OOBE **SAP** | who the agent is + its track record | on-chain `agent_pda` (`register_agent`) + `create_attestation` (cross-agent web-of-trust) |
| **Money** | OOBE **SAP escrow_v2** | holds the deposit, releases on settle | on-chain escrow PDA; `create_escrow_v2` → `settle_calls_v2` |
| **Verification** | **Covenant** | authorizes release only when the work is verified | the escrow **coSigner** (or **arbiter**) + its audit root carried in `service_hash` |
| **Payment rail** | **PayAI** | the x402 facilitator (the #1 partner constraint) | all x402 payment facilitation routes through PayAI |

> **TLDR (dev's words):** SAP = identity (the agent_pda we publish + attest against). OOBE escrow = the money (holds the deposit, releases on settle). Covenant = verification (the coSigner/arbiter that authorizes release, plus the audit root carried in `service_hash`).

## 2. The two on-chain hooks (how Covenant binds to SAP escrow)

SAP `escrow_v2` already exposes exactly the two hooks needed — no new program, no fork:

1. **Audit root in `service_hash`.** `settle_calls_v2(escrow_nonce, calls_to_settle, service_hash: [u8;32])`. Covenant's audit root is a 32-byte hash → the agent settles by presenting the **Covenant audit root as `service_hash`**. Every release is then bound on-chain to a Covenant-verified work record (the on-chain settlement points at the off-chain provenance envelope).
2. **Covenant as the release gate.** Create the escrow with `settlement_security = 1` (**CoSigned**) and **`co_signer = Covenant`**. `settle_calls_v2` then cannot release until Covenant co-signs — and Covenant only co-signs once its verification passes. Trustless release, built entirely from OOBE's existing escrow.
   - **Alternative (optimistic):** `settlement_security = 2` (**DisputeWindow**) with **`arbiter = Covenant`** — funds finalize after the window *unless* Covenant files a dispute because the work isn't verified. Same guarantee, reversed default.

This resolves the earlier Covenant "gap" (their provenance disclaims attesting to *remote game outcomes*): Covenant doesn't attest to a ClawVille leaderboard event — it acts as the **signer that gates an on-chain escrow release**, with its own audit root as the binding reference. The verification stays in Covenant's wheelhouse (signing/provenance); the money stays on SAP; the outcome is enforced on-chain.

## 3. How this maps onto what ClawVille already has

- **Identity:** we already `register_agent` (the agent's Phase-5.1 custodial pubkey → `agent_pda`). **`create_attestation` / `revoke_attestation` are now WIRED** (2026-06-21) — agents attest to each other (Light rung complete; the 5-SAP-capabilities "reputation = feedback + cross-agent attestations"). Routes `POST /api/sap/attestation` + `POST /api/sap/attestation/revoke`, builders mirror `give_feedback` (attester = caller's own wallet signs; SUBJECT agent is a non-signer account); gated on `SAP_ENABLED` + `requireLedgerCapable` like feedback (NOT the escrow gate). On-chain account context verified against the deployed 0.18.0 IDL by the dry-run harness. See `docs/sap-integration.md §4`.
- **Money:** our internal economy stays **ClawTokens** (off-chain). SAP escrow is the **on-chain, cross-platform** rail for agent↔agent commerce that crosses our walls (a parallel rail, never a CT replacement). The natural first use is the **AI↔AI bounty** (escrow + verify-before-release) the user already pitched to Covenant — and the **land-services** economy.
- **Verification:** Covenant is the coSigner/arbiter. ClawVille already enforces capability-scoping + action audit *server-side* (the Hatcher `[ACTION:]` whitelist) — Covenant's added value is a **portable, third-party-verifiable signed receipt** an agent carries off-platform, which is the only genuinely additive angle (Partnerships.md). Binding it to the escrow release is what makes it concrete.
- **Payment rail (the #1 constraint):** "all x402 ultimately routes through PayAI." SAP escrow_v2 is an **on-chain Solana program escrow**, a *different layer* from PayAI's **HTTP facilitator** (USDC→CT on-ramp). They are not mutually exclusive — but the **funding of a SAP escrow** (where the depositor's USDC/SOL comes from, and whether that leg is PayAI-facilitated) MUST be coordinated with PayAI before the escrow rung goes live. **Open item — see §5.**

## 4. What Covenant actually is (caveats from diligence)

Local-first, **off-chain** agent operating layer (8 primitives: intent, runtime, memory, identity, permissions, comms, compositor, settlement). Capability tokens = ed25519-signed permission tokens + a local audit/receipt ledger. Provenance envelopes = JSON, **Git-commit-centric** today. **Pre-1.0**; signing/transparency-log/distributed-settlement are roadmap. The on-chain-coSigner architecture above is how it composes with SAP *despite* being off-chain — Covenant signs a Solana tx (the co-sign) using a keypair; its provenance system produces the audit root. **Player local agents** are a natural fit (a player's own locally-run agent can run Covenant on its host).

## 5. OPEN VERIFICATION ITEMS — resolve BEFORE building the Covenant-gated escrow

These gate the escrow (P2) rung, not Light (P1):

1. **Does the DEPLOYED program enforce CoSigned?** Our solana-auditor found the **devnet** program is **0.18.0** (its `settle_calls_v2` account list = `[wallet, agent, agent_stats, escrow, system_program]` — no explicit `co_signer` account; no `settlement_receipt`). The Covenant dev says CoSigned + `service_hash` work and they "run live on devnet AND mainnet." **Reconcile:** (a) re-fetch BOTH cluster IDLs (devnet vs mainnet may be different program versions at the same address) and confirm which enforces CoSigned; (b) determine how the co_signer signs `settle_calls_v2` on the deployed version (named account vs `remaining_accounts`); (c) if only 0.25.0 enforces it and only mainnet runs 0.25.0, the escrow rung is mainnet-gated (real money) — coordinate with the mainnet code gate.
2. **`settlement_security` is currently pinned to SelfReport (0)** in `sap-client.ts` (`SETTLEMENT_SELF_REPORT`, co_signer/arbiter hard-null). The Covenant model requires making this **configurable** (CoSigned + `co_signer=Covenant`, or DisputeWindow + `arbiter=Covenant`) — a money-path core-service change → full audit + Codex.
3. **Covenant's keypair / co-sign API:** what pubkey does Covenant co-sign with, and how does ClawVille hand it the settle tx for co-signing (their CLI/HTTP API)? SSRF-guard any outbound call (same discipline as Hatcher webhooks).
4. **Covenant license + repo** — STILL UNLOCATED (Partnerships.md). Must be confirmed permissive (no AGPL/GPL) before adopting ANY Covenant code. The co-signer path may need no Covenant code (just their pubkey + a call to their verify endpoint) — confirm.
5. **PayAI coordination:** how the SAP-escrow funding leg routes through / coexists with PayAI (the #1 "all x402 through PayAI" constraint). A discovery sync with both.

## 6. Phasing (see PLAN.md)

- **P1 — Light (NOW):** SAP on-chain identity (`register_agent`, done) **+ attestation (`create_attestation`/`revoke_attestation`, ADD now)** + discovery. Zero locked value, no Covenant, no PayAI dependency. Flip-ready on devnet → mainnet.
- **P2 — Covenant-gated escrow (PLANNED, gated):** make `settlement_security` configurable → CoSigned `co_signer=Covenant` (or DisputeWindow `arbiter=Covenant`) + `service_hash`=Covenant audit root. Blocked on §5 items + a Covenant/PayAI discovery sync + a money-path audit. First real use: the AI↔AI bounty (escrow + verify-before-release) + land-services.
- **Sequencing:** Covenant sits **behind PayAI (#1)**; the escrow's payment leg coordinates with PayAI; the in-game economy stays CT throughout.
