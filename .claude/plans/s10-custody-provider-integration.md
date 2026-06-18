# S10 — Privy / Steward custodian (wallet-custody integration) — DECISION PLAN

**Status:** PLAN-ONLY. No code, no DB migration, no provider API calls until the
founder answers the decision checklist below AND authorizes (this is money/custody
= high-stakes per `CLAUDE.md`: "destructive or irreversible actions … set status
to blocked and wait for explicit authorization"). Author: Claude + Codex (Rule E3),
2026-06-18, during the S4–S10 staging-issues batch.

Why plan-only and not implemented like S4–S9: the backlog entry is literally
"Scope TBD." Building a third-party custody integration blind would be scaffolding
theater and touches every signer / the custodial-key path. The reversible,
correct first artifact is this decision doc.

---

## 1. What exists today (verified)

Server-custodial model:
- Unified `wallets` table — `subject_type ∈ {avatar, agent, treasury}`, one row per
  `(subject_type, subject_id)`.
- Envelope encryption: per-row 32-byte DEK, DEK wrapped by a Cloudflare-held KEK
  (treasury rows use `VANITY_ENCRYPTION_KEY`).
- Services: `keypair-vault.ts` (decrypts local `Keypair`s), `wallet-service.ts`,
  `service-issuer.ts`, `identity-service.ts`.
- Phase 5.1: two-keypair split (identity ed25519 + Solana avatar wallet),
  signed-challenge reconnect, `wallet.secretKey` returned **exactly once** on
  first-connect (no recovery path).
- Solana; wager program is **devnet** (mainnet = a code change, not just env).
- `wallets.ts` carries a custodial WARNING: **legal review required before any
  self-custody export**.

Privy / Steward are **not referenced anywhere** in the codebase yet (only a passing
mention in `docs/agent-token-launch-research.md`).

## 2. Provider read (Codex-sourced)

- **Privy** — identifiable + relevant. Embedded/user wallets via email/social (no
  seed phrase), flexible custody (server / user-held / developer-controlled /
  quorum), policy controls (default-deny, transfer/program/network limits), agent
  wallets (developer-owned or user-owned with scoped agent signers), treasury
  controls (quorums, human escalation), full Solana/SVM support, webhooks. Docs:
  `docs.privy.io/wallets/overview/{types,flexible-custody,chains}`,
  `/controls/policies/overview`, `/recipes/agent-integrations/agentic-wallets`,
  `/recipes/wallets/treasury-overview`.
  - **Does NOT automatically make ClawVille non-custodial** — classification depends
    on who can move funds / recover / approve. If we keep server signing authority
    or import server-held keys into Privy, it's still custodial.
- **Steward** — NOT clearly identifiable as a specific Solana custody provider from
  primary sources. **DECISION NEEDED:** founder must supply the exact product +
  URL, or we drop it. Treat as undefined until then.

## 3. Integration model options

- **(A) Augment with optional Privy custody — RECOMMENDED first real phase.**
  Existing `server` wallets stay the default; new wallets can be `privy_user` /
  `privy_agent` / `privy_treasury` per chosen scope. Lowest migration risk.
- **(B) Replace avatar-wallet custody with Privy — NOT a sane phase 1.** Touches
  every signer; migration/legal problems with existing pubkeys, the one-time-secret
  invariant, balances, wager PDAs, recovery.
- **(C) Privy/Steward for treasury/policy custody only.** Sane if the goal is
  operational controls around the settlement authority / merchant wallets / future
  real-money custody. Narrow blast radius (treasury signers + policy approvals); does
  NOT solve user onboarding.

## 4. Code blast radius (when authorized)

- `packages/database/src/schema/wallets.ts` — custody/provider metadata column (NOT
  added yet — see §6).
- `wallet-service.ts` — stop assuming every wallet has an encrypted local secret.
- `keypair-vault.ts` — remains for `server` custody only.
- `identity-service.ts` / agent-connect — decide if the identity keypair stays
  ClawVille-owned.
- `require-auth-or-agent.ts` / `agent-gateway.ts` — branch/remove the `wallet.secretKey`
  once-only invariant for non-server custody.
- `wager-program-client.ts` — abstract signer loading (today it decrypts local
  `Keypair`s directly).
- `treasury_wallets` scripts/services if treasury custody changes.
- Protocol docs + `PROTOCOL_VERSION` if agent wallet semantics change; `ARCHITECTURE.md`
  §7/§13, `GameFeatures.md`, Nori/protocol surfaces if economy behavior changes.

## 5. Founder decision checklist (ALL required before any code)

1. Exact provider — Privy, Steward (with URL/docs), or both.
2. Goal — user onboarding, agent autonomy, treasury controls, legal-risk reduction,
   or a combination.
3. Custody model — server-held, user-held, developer-controlled, 2-of-2, agent
   signer, treasury quorum.
4. Subjects — avatars, agents, treasury, or only new users.
5. Network — devnet only vs mainnet readiness.
6. Migration — keep existing wallets, import keys, or create-new + migrate funds.
7. Legal posture — what value these wallets may hold before counsel signs off.
8. Signing policy — who initiates / approves / cancels / exports / recovers / rotates.
9. Failure mode — what happens if the provider API is down during wagers/settlement.

## 6. Safe first step

**100% plan-only.** Do NOT add a `custody_kind` column yet — even a defaulted schema
column implies an architecture before the model is chosen. A disabled spike branch
(no DB migration, no provider calls in staging/prod) is acceptable for evaluation,
but the reversible first artifact is THIS doc. When authorized, the build is a
backend full-team + `reconciler-manager` (high-stakes custody) per `CLAUDE.md`, with
a Codex adversarial pass on the signing/verification path.
