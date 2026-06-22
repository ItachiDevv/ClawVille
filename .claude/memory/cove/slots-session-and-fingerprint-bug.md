---
name: slots-session-and-fingerprint-bug
description: "Slots 'won 20 CT, no history' + session_not_found dead-end — root-caused to fp keyed on raw full IP + no client fp header; fixed by 5 coordinated changes"
category: solution
confidence: high
date: 2026-06-21
---

# Slots money-history bug + fix (FIXED on prod via PR #159)

**Symptom 1 — 'won 20 CT, no history':** a guest spin wrote `fpHash` off the RAW FULL client IP (tier-2 fallback). On DHCP/CGNAT/VPN churn, the later history read computed a DIFFERENT `fpHash` → orphaned the win AND the open session (subsequent /spin 404).

**Symptom 2 — session_not_found dead-end:** a stale/closed in-memory `sessionId` made /spin 404; the modal showed a scary toast (twice on fast double-press/autoplay), leaving the player stuck.

**Fix (commit `4eacebc1`, 5 coordinated changes):**
1. `middleware/fingerprint.ts:86-107` — tier-2 fallback now keys on **UA + IP /24 PREFIX** (was raw full IP), so a dynamic-IP guest keeps ONE fpHash. (Crash-loud if `FINGERPRINT_SECRET` unset/<32 chars.)
2. `lib/cove/slot-api-client.ts:67-77` — `coveFetch` injects `X-CV-Fingerprint` on EVERY cove request → stable server tier-1 fpHash.
3. `lib/cove/history-client.ts` — `coveHistoryHeaders()` injects the same header on all 3 history reads.
4. `components/cove/SlotScreenModal.tsx:210-220,319-410` — `spinRecoveringRef` single-shot self-heal: on /spin 404/`session_not_found`/`session_not_open`, clear the pointer, mint a FRESH idempotency key, force-open a new session, retry ONCE.
5. `app/login/page.tsx:39-90` — `claimGuestCoveHistory()` now runs on BOTH signup AND plain login.

**GOTCHAS:** (a) the auto-recovery is CLIENT-side (modal + api-client), NOT in `cove-slots.ts` — the route is byte-identical master↔staging. (b) `CoveApiError.code` is the first token of the server message split on `/[\s:]/`, so `session_not_open` is a **409** not 404 — the self-heal must branch on `err.code` too. (c) the fp /24 widening doesn't weaken farm detection (cap key is `(fp_hash, ip_prefix_hash)`, already prefix-collapsed; guest play is demo-only).

**Status: FIXED ON PROD.** Self-labeled 'Safety checkpoint commit — audit pending' in its own body. The `feat/poker-mtt-tournament` working tree still has the OLD buggy files. Related: [[subject-keying-keystone]], [[working-tree-staleness-trap]].
