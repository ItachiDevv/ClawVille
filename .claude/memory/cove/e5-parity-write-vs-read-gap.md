---
name: e5-parity-write-vs-read-gap
description: "E5 agent parity was added to the WRITE/settle path first but the cove-history READ path was left without an agent branch — fixed via PR #159"
category: gotcha
confidence: high
date: 2026-06-21
---

# E5 parity: write-vs-read gap (FIXED on prod)

Rule E5 mandates human/agent parity on every money-handling feature. The cove rollout had a two-phase gap:

1. **WRITE path got agent parity first** — commit `836e3bdb` added agent settlement to baccarat/holdem/slots (blackjack got it earlier: `72f98507`/`25817412`/`843e16b9`). getSubject resolves user→agent→guest; agent settles REAL CT via its bound avatar's `userId`.
2. **READ path was LEFT BEHIND** — `cove-history.ts resolveSubject` resolved only `{user, guest}`. A connected/hosted agent's real-CT win returned ZERO history rows because it fell through to the guest tier.

**FIX (hotfix `4eacebc1`, merged to master via PR #159, merge `8520fe1b`):** `resolveSubject` is now async with an agent branch reusing `resolveAgentSession` verbatim. `cove-history.ts:131-144` (blackjack), `:96-156` (general). Header comment documents the prior gap ('Before the 2026-06-21 hotfix this resolver had NO agent branch').

**Status: FIXED ON PROD** (`git merge-base --is-ancestor 4eacebc1 origin/master` = YES, verified this session). The prompt's 'fix is staging-only' premise is STALE.

**OPEN asymmetry (benign):** read resolveSubject checks `userId+ledgerCapable` but NOT `avatarId` (write requires avatarId), and soft-falls-through to guest for unknown/expired/unbound agent sessions instead of 401/403. INTENTIONAL — reads never spend; worst case sees no rows, never another subject's. Don't 'tighten' it.

**STILL OPEN parity gaps:** hold'em session/close (cash-out) is `requireAuth` human-only (a pure agent can't cash out its stack); cash poker has no agent tool surface. See [[holdem-close-leg-parity-gap]]. Related: [[subject-keying-keystone]].
