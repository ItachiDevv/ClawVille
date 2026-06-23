---
name: working-tree-staleness-trap
description: "On feat/poker-mtt-tournament the working-tree cove files are OLD/pre-fix — read deployed truth via git show origin/master:, never cat/Read the checkout"
category: gotcha
confidence: high
date: 2026-06-21
---

# Working-tree staleness trap (audit hygiene)

The session cwd is branch `feat/poker-mtt-tournament` (HEAD `2259353e`), whose newest cove commit is `801e8fa8` — it PREDATES the deployed cove fixes. Reading cove files from the checkout silently gives you BUGGY pre-fix code:
- `cove-slots.ts` / `cove-history.ts` — OLD (no fp injection, no agent read-branch, raw-IP fp).
- `cove-verify-compat.ts` — LACKS `canonicalize`/`canonicalJsonEq` (the jsonb fix).
- `cove-baccarat.ts` (-226 lines) / `cove-holdem.ts` (-250 lines) — STALE pre-E5 user-XOR-guest, NO agent branch.
- `cove-blackjack.ts` — refactored `subHandResolved()` OUT (divergent from prod).

**ALWAYS read deployed truth via `git show origin/master:<file>`** (== `origin/staging` on all cove files; `git diff origin/master origin/staging` on the cove set = 0 lines). Engines (`slot/blackjack/baccarat/holdem-engine.ts`) ARE byte-identical WT↔master, so engine logic in the WT is trustworthy — only ROUTE/client/verifier files diverge.

**MERGE HAZARD (HIGH):** merging this branch to master WITHOUT rebasing on current master REGRESSES the slots/history money fix + verifier canonicalize + E5 read parity back onto prod, and re-locks agents out of baccarat/holdem (E5 violation). Rebase onto `origin/staging` before any cove file ships.

**Deploy-state corrections to the standing prompt premise (verified this session):** `origin/master` = `8520fe1b` (not 2ef36e14); `4eacebc1` IS on master via PR #159; MTT IS live on prod (`/api/cove/poker/mtt` mounted master index.ts:311); only CASH poker is genuinely unshipped (not on master, verified). Always re-verify with `git merge-base` + live curl. Related: [[slots-session-and-fingerprint-bug]], [[jsonb-verifier-false-negative]], [[e5-parity-write-vs-read-gap]].
