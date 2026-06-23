---
name: peer-commerce-paused-503
description: "The sacred 503 write-gate: a use('*') middleware that 503s all write methods on all three peer-commerce routes; ordering + method-set load-bearing; the keystone that keeps the menu honest with the paused backend."
category: pattern
confidence: high
date: 2026-06-22
---

---
name: peer-commerce-paused-503
description: The 503 write-gate that pauses all peer commerce — first use('*'), method-based, on all three routes; the keystone the menu must reflect.
category: pattern
confidence: 0.95
date: 2026-06-22
---

# The 503 write-gate (the sacred pause middleware)

**State: PAUSED/ENFORCED on all three routes (verified in worktree cv-agents-wave23 @ chore/agents-wave23 a4daf0d8). Re-confirm on the target branch + live container before any claim.**

Each peer-commerce route mounts ONE `use('*')` middleware, FIRST after `sessionMiddleware`, that returns `503 {error:'Skill marketplace paused pending rework…', code:503}` for `POST|PUT|PATCH|DELETE` and falls through to `next()` for GET:

- `apps/api/src/routes/bazaar.ts:30-43`
- `apps/api/src/routes/marketplace.ts:20-33`
- `apps/api/src/routes/auctions.ts:241-254`

All three are byte-identical in the gate body (verified). `writeMethods = new Set(['POST','PUT','PATCH','DELETE'])`.

## Why it is load-bearing (menu ↔ backend ↔ economics ↔ knowledge)
This is a BRAND-PRIORITY invariant, not a stub (CLAUDE.md Priority #3 / Brand Identity §3 / improvements.md §7 — the 2026-04-21 pivot to the free leaderboard). The PAUSED backend is authoritative; the UI must reflect it. The pause targets **PEER commerce ONLY** — never `cosmetics-shop` (the allowed first-party carve-out).

## Traps it prevents (FIXED while the gate is intact)
- A refactor that registers a write handler ABOVE the gate, or relaxes the method-set, silently re-opens paid peer commerce. Keep it the FIRST `use('*')` after `sessionMiddleware`.
- Never 503 a GET — browse/detail/stats/my-* reads serve today and the modals render them.
- **The gate is airtight ONLY for HTTP callers** — the ElizaOS agent buy action bypasses it. See `[[agent-action-bypasses-gate]]` (OPEN).
- The auction resolver + SSE are NOT behind this gate. See `[[auction-resolver-ungated]]` (LATENT).

## Verify (staging, not localhost)
`curl -X POST .../api/bazaar/list` → 503; `curl -X POST .../api/auctions/:id/bid` → 503; `curl -X POST .../api/marketplace/publish` → 503; `curl .../api/bazaar` (GET) → 200.

Related: `[[feature-gate-skill-marketplace]]` (the gate's lifecycle), `[[unpause-becomes-money-path]]` (how to lift it correctly), `[[modal-reflects-paused-state]]` (the UI side).
