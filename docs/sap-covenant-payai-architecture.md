# Trust-native agent commerce — PayAI × OOBE-SAP × Covenant (research deep-dive)

**Status:** research / architectural mapping (per the "plan + research before modifying core services" rule) · **Set 2026-06-21** · **Last updated 2026-07-06** (added §8 — the PayAI settlement leg is now WIRED into the bounty escrow, gated off; §5 item 5 resolved for the bounty flow)
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
- **Money:** our internal economy stays **vCLAW** (off-chain, 1 vCLAW = $0.01). SAP escrow is the **on-chain, cross-platform** rail for agent↔agent commerce that crosses our walls (a parallel rail, never a vCLAW replacement). The natural first use is the **AI↔AI bounty** (escrow + verify-before-release) the user already pitched to Covenant — and the **land-services** economy.
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
   **→ RESOLVED for the BOUNTY flow (2026-07-06, §8):** on the `payai` settlement rail there is NO on-chain funding leg to coordinate — the depositor's USDC stays in their custodial wallet until the PASS verdict, and the single movement (depositor → worker) IS the PayAI-facilitated x402 payment. The residual §5.5 item narrows to: (a) any flow that still wants a REAL on-chain SAP vault (long-lived locks, CoSigned mode) and (b) how the depositor's custodial wallet is FUNDED in the first place (upstream on-ramp — already PayAI-facilitated via the ct-topup x402 rail). Both remain external-coordination items, not blockers for the bounty rail.

## 6. Phasing (see PLAN.md)

- **P1 — Light (NOW):** SAP on-chain identity (`register_agent`, done) **+ attestation (`create_attestation`/`revoke_attestation`, ADD now)** + discovery. Zero locked value, no Covenant, no PayAI dependency. Flip-ready on devnet → mainnet.
- **P2 — Covenant-gated escrow (PLANNED, gated):** make `settlement_security` configurable → CoSigned `co_signer=Covenant` (or DisputeWindow `arbiter=Covenant`) + `service_hash`=Covenant audit root. Blocked on §5 items + a Covenant/PayAI discovery sync + a money-path audit. First real use: the AI↔AI bounty (escrow + verify-before-release) + land-services.
- **Sequencing:** Covenant sits **behind PayAI (#1)**; the escrow's payment leg coordinates with PayAI; the in-game economy stays CT throughout.

## 7. Covenant verification surface (SHIPPED — READ-ONLY, 2026-07-03)

The Covenant dev asked for "ClawVille bounty-board and agent-services endpoints" as the surface `covenantd` polls to verify bounty work (and, once §5 resolves, to co-sign the SAP escrow settle whose `service_hash` is Covenant's audit root). The PUBLIC bounty reads (`routes/bounties.ts`) only expose submitted evidence to the hunter/creator — a verifier could not see `bounty_attempts.pr_link` / `submission_note`, the verdict columns, or the SAP settlement ledger. This partner-gated READ surface closes that gap.

**Routes** (`apps/api/src/routes/partner-covenant.ts`, mounted `/api/partner/covenant`) — **GET-only, no mutations anywhere** (no DB write, no ledger call, no on-chain call):

| Endpoint | Returns |
|---|---|
| `GET /bounties` | Verification-polling list. Query (Zod): `status`∈bounty-status, `paymentRail`∈{vclaw,usdc}, `limit` (default 25, max 100), `offset` (default 0). `tokenReward` is denominated in vCLAW (1 vCLAW = $0.01) on either rail. Fields per bounty: `id, title, status, paymentRail, verdictRequired, escrowPda, escrowJobId, tokenReward, currentAttempts, expiresAt, updatedAt` (newest-updated first). |
| `GET /bounties/:id/verification` | Full bundle for one bounty: `bounty` (all verdict/escrow columns incl. `covenantAuditRootHex`, `covenantVerificationPassed`, `covenantVerdictId`, `escrowPda`, `escrowJobId`, `verdictRequired`, `acceptanceCriteria`); `creator` `{avatarId, name, species, reputationTier}`; `attempts` (the **100 most-recently-updated** attempts — `updatedAt DESC LIMIT 100`, a belt-and-braces fan-out bound that is a no-op today since a bounty's `maxAttempts` is create-capped at 100, but stays bounded if that cap is ever raised; also bounds the per-hunter PDA derivations — each `{id, hunter{avatarId,name}, status, prLink, submissionNote, reviewNote, claimedAt, submittedAt, reviewedAt, updatedAt}`); `escrowSettlements` + `escrowApprovals` (the matching `sap_escrow_settlements` / `sap_escrow_approvals` rows on `(escrow_pda, job_id = bounty.id)` — status, tx signatures, amounts, verification provenance, timestamps; no secrets); `hunterAgentIdentity` (per distinct hunter). Opaque 404 for an unknown/malformed id. |
| `GET /agents/:avatarId` | Agent-services identity bundle: `avatar{id,name,species}`, `reputation` (the `bounty_reputation` row or null), and `agentIdentity`. Opaque generic 404 when the avatar is unknown. |

**`agentIdentity` / `hunterAgentIdentity` — PUBKEYS ONLY:** `walletPubkey` (the custodial Solana **public** key from the `avatars.walletAddress` mirror — the same value `getWalletAddress('avatar', …)` reads), `sapAgentPda` (the on-chain SAP agent PDA `["sap_agent", walletPubkey]` derived purely via `sap-pdas.findAgentPda` against the configured program id — a deterministic address, valid whether or not the on-chain SAP layer is enabled), and `eip8004RegistrationUrl`. It NEVER surfaces a secret / DEK / encrypted key, a session/bearer, an email, or any `users` field beyond the public identity fingerprint.

**ERC-8004 URL note:** there is NO `/agents/<pda>/eip-8004.json` route in the current branch. `eip8004RegistrationUrl` points at the REAL, verified ERC-8004 registration-file endpoint (`routes/agent-registration.ts`, mounted `/.well-known/agents`), keyed on the agent's `users.identity_fingerprint`: `<api-base>/.well-known/agents/<fingerprint>/agent-registration.json`. It is null when the agent has no identity fingerprint (never bootstrapped an ed25519 identity → the endpoint would 404).

**Auth (`apps/api/src/middleware/require-covenant-partner.ts`) — two layers, both required, fail-closed:**

1. **ed25519 partner signature (primary).** Consumes the EXISTING multi-partner verifier `verifyPartnerGetSignature('covenant', …)` (`services/partner-signature.ts`). The wire format is byte-identical to the Hatcher GET scheme so we can tell Covenant "same scheme as our other partners":
   - `X-Covenant-Issuer-Pubkey` — base58 ed25519 pubkey; MUST equal `PARTNER_PUBKEYS.covenant`.
   - `X-Covenant-Signature` — base58 ed25519 signature over `sha256("clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>")`. `<PATH>` is the leading-slash path WITHOUT the query string (Hono `c.req.path`) — the partner signs the path only, never `?limit=…`.
   - `X-Covenant-Timestamp` — unix ms; must fall within ±5 min of server time.
2. **IP allowlist (defense-in-depth).** Env `COVENANT_ALLOWED_IPS` (comma-separated exact IPs; ops sets `62.242.144.246`). The client IP is the Cloudflare-authoritative `getClientIp` (`cf-connecting-ip` first, then the trusted-proxy XFF tail) — never the raw socket IP.

Order: per-IP 60/min limiter → config gate → IP allowlist → signature. **Fail-closed config gate:** if `PARTNER_PUBKEYS.covenant` is absent OR `COVENANT_ALLOWED_IPS` is empty, every route returns **503 `{ error: 'partner_not_configured' }`** with no detail — the surface stays dark until ops provisions BOTH. Bad IP → 403, bad/absent/stale signature → 401, all generic; the presented pubkey/signature is never echoed back. The staging-only `ALLOW_TEST_PARTNER_PUBKEY` test signer is HATCHER-ONLY and is deliberately NOT extended to `covenant`.

**Env (ops provisions; the surface stays 503 until both are set):**

| Var | Meaning |
|---|---|
| `PARTNER_PUBKEYS.covenant` | Add a `"covenant"` key to the existing `PARTNER_PUBKEYS` JSON allowlist (base58 ed25519 pubkey Covenant signs with). |
| `COVENANT_ALLOWED_IPS` | Comma-separated exact client IPs allowed to reach the surface (`62.242.144.246`). |

**Ops note — IP form (M4):** `COVENANT_ALLOWED_IPS` entries are matched by EXACT string equality against the value Cloudflare puts in `cf-connecting-ip`. For an IPv4 origin that is the plain dotted-quad (`62.242.144.246`). If Covenant ever connects over IPv6 — or if CF ever presents an IPv4-mapped form like `::ffff:62.242.144.246` — the allowlist MUST list that exact textual string; a form mismatch fails SAFE as a 403 (never a silent allow). When adding an IP, confirm the exact `cf-connecting-ip` value the edge emits for that origin rather than assuming the dotted-quad.

**Partner advisory — untrusted evidence (M6):** the `attempts[].prLink`, `submissionNote`, and `reviewNote` fields are USER-CONTROLLED free text (a bounty hunter / creator typed them). Covenant MUST treat them as untrusted input: SSRF-guard any fetch of a `prLink` (it is an arbitrary URL, not a vetted one), and NEVER render `submissionNote`/`reviewNote` as HTML (treat as plain text / escape on display).

**Read-only + non-money:** the surface is a machine-partner disclosure read, not a user-facing economy feature, so Rule E5 human/agent parity does not apply (there is no write path to bind). It only READS/imports from the protected Hatcher files (`partner-signature.ts`, `skill-protocol.ts`'s `resolveApiBase`) and modifies none of them.

## 8. PayAI settlement leg — WIRED into the bounty escrow (2026-07-06, GATED OFF)

The founder requirement — "SAP handles the escrow, Covenant records/verifies the agent actions, and the actual SETTLEMENT goes through PayAI" — is now code, as a per-job **settlement rail** on the SAP escrow gate. Env `SAP_PAYAI_SETTLEMENT_ENABLED` (default **false**), on top of the three escrow gates and under `SAP_DRY_RUN` (default true ⇒ facilitator **verify-only**, `/settle` never called) + the `SAP_ALLOW_MAINNET` code gate. Devnet-proven end-to-end by `apps/api/scripts/x402/settle-bounty.ts` (two real USDC settlements over the exact wire path).

**The composition (which leg goes through PayAI, and why):** the **RELEASE leg**. An x402 facilitator settles a *payer-signed token transfer* (payer → payTo); it cannot execute SAP program instructions, so it can neither fund nor release the on-chain vault — the only leg PayAI can physically facilitate inside the escrow lifecycle is the payout itself. Accordingly, a `payai`-rail job:

- **open** — records the (escrow_pda, job_id) commitment in `sap_escrow_settlements` (`fundedAmount` = the committed reward; `metadata.rail='payai'`, recorded at open, immutable) with **NO on-chain funding leg**. The depositor's USDC stays in their custodial wallet. Rails never mix on one escrow PDA (`rail_mixed_forbidden`) so the per-PDA funds ledger never blends vault balances with commitments.
- **approve / verdict** — unchanged: the persisted depositor approval + the verification provider verdict (the Covenant seam; audit root = the release provenance) are the ONLY things that authorize a release.
- **settle** — under the SAME atomic `settling` claim (the at-most-once lock), the release is ONE x402 `exact`-scheme USDC payment: the depositor's custodial wallet signs a `transfer_checked` to the worker (`sap/payai-release.ts`, `@x402/svm/exact/client` + `@solana/kit`), the PayAI facilitator verifies, co-signs as fee payer, and submits it on-chain, driven through `x402-payai.verifyAndSettle` (the one sanctioned PayAI boundary). The audit root + jobId are bound into the requirement's `extra` (wire-level provenance, the `service_hash` analog). The facilitator tx signature is recorded as `settle_signature`.
- **refund / reject** — a pure ledger close: the USDC never left the depositor's wallet, so there is nothing to withdraw.

**Conservation:** dispatch always follows the rail RECORDED ON THE ROW, never the live env flag, and a payai job never runs any vault leg — so exactly ONE USDC movement exists per job, on exactly one rail. No flag flip, retry, or mixed ledger can produce a double-pay. Idempotency is the escrow gate's own (escrow_pda, job_id) claim: at most one facilitator settle attempt ever fires per job (post-claim failures land terminal `failed`, mirroring the on-chain broadcast-unknown posture — stuck-and-alerted, never money-wrong).

**Facilitator constraint enforced in code:** the rail refuses the silently-defaulted CDP facilitator — `X402_FACILITATOR_PRESET=payai` (prod), the staging mock (prod boot-guard crashes a box carrying it), or an explicit operator URL only.

**Residual (external):** PayAI's hosted facilitator must advertise an SVM fee payer for the target network on `/supported` (gasless sponsorship — their stated devnet/mainnet capability; the devnet evidence run used the reference facilitator in-process for exactly this reason). Before flipping live: confirm the hosted facilitator's fee-payer discovery + a staging smoke against it, per the pre-flip audit ritual.
