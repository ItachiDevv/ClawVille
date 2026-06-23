---
name: validate-against-hatcher-ref
description: "Validate our register/PATCH/wire shapes against the partner's REAL .hatcher-ref/CONTRACT.md (HatcherLabs/hatcher-host-frontend) — refresh first if stale/absent. OPEN: .hatcher-ref is ABSENT in this worktree and docs/hatcher-integration-spec.md reads PROTOCOL_VERSION 5 while code is 6."
category: constraint
confidence: high
date: 2026-06-22
---

# Validate against the partner's REAL .hatcher-ref/ contract

**Status: TWO OPEN drift items in this worktree.**

## Rule
When changing register/PATCH/response/error/[ACTION:] shapes, validate OUR side against Hatcher's ACTUAL open-source contract (`.hatcher-ref/CONTRACT.md` + their host-frontend `ClawVilleRegisterBody`/`ClawVillePatchBody`), NOT our assumptions. This is the lesson from the contract-parity session — assumptions drifted from their real frontend. Refresh from `HatcherLabs/hatcher-host-frontend@main` FIRST if stale.

## OPEN #1 — .hatcher-ref/ is ABSENT here
`ls .hatcher-ref/` → no such directory (gitignored / not vendored in this worktree). The EXTERNAL validation source is missing — **refresh it before any contract change.** `contract-probe.ts` already encodes 6 known real-vs-ours divergences (A–F, pulled 2026-06-13): PATCH `{stats}`/`{homeX,homeY}`/`{rotateScopedToken}`-only HARD-FAIL 400 'No mutable fields'; stats SILENTLY dropped on PATCH `{name,stats}`; our stat bounds tighter than their form. Run it on staging.

## OPEN #2 — spec PROTOCOL_VERSION stale
`docs/hatcher-integration-spec.md` 'At a glance' (`:33`) + `:167` read **`PROTOCOL_VERSION 5`** while `skill-protocol.ts:63` is **6** (poker-MTT bump, 2026-06-16). Live code wins — fix the doc SAME-DIFF on the next protected-surface touch. The doc's 'cross-validated against live code' / 'single source of truth' promise is load-bearing for the partner, so a stale number mis-tells Hatcher.

## rotateScopedToken accept-and-ignore (don't silently strip)
Plain `z.object()` SILENTLY STRIPS unknown keys. Hatcher's body declares `rotateScopedToken`, so register+PATCH schemas (`partner-hatcher.ts:387-401`/`:426-429`) declare it explicitly as accept-and-ignore (FIX-8). Rotation today is via re-supplying `cognition.scopedToken` (re-encrypted on register/PATCH); the flag is parsed-but-unused.

→ [[mock-hatcher-harness-gate]] [[whitelist-manual-protocol-parity]]
