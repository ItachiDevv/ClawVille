---
name: usdc-ct-boundary-x402-not-payai
description: "x402 (Apache @x402/* only, NEVER @payai/*) is the USDC payment boundary; CT is the internal non-withdrawable play-currency. x402 scaffold-only, flag OFF, no USDC→CT settlement path exists"
category: constraint
confidence: high
date: 2026-06-22
---

# USDC/CT boundary — @x402 (Apache), NEVER @payai

**Rule:** x402 is the USDC payment boundary; CT is the internal play-currency. They NEVER mix in one write — x402 settles USDC to the merchant treasury wallet; CT moves stay on the ledger.

**Package discipline:** keep ONLY the Apache `@x402/*` packages (`@x402/core`, `@x402/hono`, `@x402/svm` v2.9.0 — verified in `apps/api/package.json`). NEVER `@payai/*` — it is an AGPL license-contamination risk that would force ClawVille (wallet/custody/API) open. Verified ZERO `@payai` anywhere in the worktree 2026-06-22.

**Scaffold state:** `x402-config.ts` is behind `FEATURE_GATE x402_payment_middleware` (1-12, review deadline 2026-07-21). `X402_ENABLED` defaults OFF (65); `buildX402ResourceServer` returns null when disabled (86). The ONLY route is `GET /api/v2/agent/ping` $0.001 (111-121) to prove the wire — **there is NO USDC→CT settlement path.** SOL/USDC settlement stays 501/gated until a real-money tier with legal/custodial sign-off.

**Building a real USDC→CT bridge:** (a) a NEW settlement route, (b) credit CT via `creditClawTokens` with an idempotency anchor keyed on the on-chain tx signature (`[[on-ramp-double-credit-guard]]`), (c) keep SOL/USDC legs 501-gated until sign-off. If no metered feature graduates by the gate deadline, `@x402/*` gets ripped.

**Don't conflate:** `token_launches`/`vanity_keypairs` (`schema/token-launch.ts`) are on-chain SPL mint infra — UNRELATED to internal CT. `token_launches` rows are NOT CT balances.

Related: `[[on-ramp-double-credit-guard]]`, `[[ct-not-withdrawable]]`.
