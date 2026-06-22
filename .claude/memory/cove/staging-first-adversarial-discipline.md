---
name: staging-first-adversarial-discipline
description: "Cove money code: staging-first, full backend team + Codex adversarial pass + LIVE staging smoke of hidden-state invariants — bun test green is not enough"
category: pattern
confidence: high
date: 2026-06-21
---

# Cove money/parity ship discipline

**Staging-first:** all cove money/parity work goes to the `staging` branch first (verify on `staging.clawville.world` / `api-staging.clawville.world`) → PR `staging → master` → merge. NEVER push direct to master unless the user's message contains the literal `direct to master`.

**DB hazard:** `bun run db:push` = `drizzle-kit push --force` (silent destructive — drops tables not in the running checkout's schema). This DROPPED the poker-MTT tables from staging on 2026-06-16 when a stale-schema branch pushed. Staging now has its OWN dedicated Supabase DB (`mtpixvtclsjqjguouxes`), so staging writes no longer mutate prod — but prefer targeted idempotent DDL (`CREATE TABLE IF NOT EXISTS` / `ALTER ... ADD COLUMN IF NOT EXISTS`) for additive deltas over a full `db:push` from a partial-schema branch.

**Adversarial money audit (every settle/idempotency/ownership/agent-session/SSRF/custodial-wallet change):** full backend team (impl-1, impl-2, spec-auditor, regress-auditor, adversary) + a Codex adversarial pass. **`bun test` green is NOT a substitute** — the holdem board-leak passed multi-agent money-adversary audits and was caught ONLY by live staging smoke (memory `live-smoke-catches-audit-misses`).

**LIVE staging smoke (mandatory before prod for any provably-fair/casino engine):** assert hidden-state invariants over the real API — board == street-count, no opponent cards mid-hand, serverSeed null until close, verifier returns verified:true on a fair stored row (not a jsonb-reorder false-negative).

**Protected partner surface** (MTT agent tools) adds: mock-Hatcher harness GREEN + PROTOCOL_VERSION bump + Codex pass. See [[poker-protected-partner-surface]].

Related: [[commit-reveal-no-board-leak]], [[working-tree-staleness-trap]], [[conservation-and-idempotency-patterns]].
