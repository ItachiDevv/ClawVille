# MAJOR-A fix — real hole beat for 3D blackjack naturals (+ balance-spoiler removal)

**Status: v2 FROZEN — v1 REJECTED by Codex peer review (2 BLOCKERs, 3 MAJORs — full
report `scratchpad/reports/critique-majora-report.md`, copied below in §v2). v2 adopts
Codex's prescriptions wholesale. Division confirmed by both sides: Fable implements,
Codex reviews the diff + owns live browser verification.**
Worktree `C:\Users\itachi\Documents\Crypto\cv-cove-3d`, branch `feat/cove-3d-holdem`,
HEAD `cce5ab1a`. NOTHING pushed. Never stage pre-existing untracked/modified files.

## The finding being fixed

Ledger `specs/spec-2d-publisher-round.md` (Opus G0 review, MAJOR A, tracked deferral
per Rule E6.1): the 3D blackjack natural path journals a `hole` revision the DOM never
painted. Deal settles inline → `applySettled(response, 'deal')`
(`use-blackjack-room-controller.ts:723-766`) calls `revealDealer()` synchronously, so
`dealStep` goes `idle → dealer-reveal` with no committed hole frame. The adapter
(`blackjack-room-parity.ts:70-104`) then finds no snapshot for the instance and
**fabricates** a `hole` revision ("seed the entitlement-safe hole state so
beginTransition() can bind") — a journal entry describing a state the visible felt
never showed. b6-3d is certified on top of that fabrication. Honesty constraint:
journal revisions may only describe DOM-committed states.

**Second defect found while diagnosing (same fix, same diff):**
`applySettled` commits `setBalance(response.balance)` immediately (line 733), so the
3D HUD bankroll jumps to the settled value 120–400ms BEFORE the dealer flips — the
exact settlement-concealment class W-G eliminated on 2D ("settlement concealment
includes the visible BANKROLL"). The certified 2D reference holds balance in
`pendingSettlement` until the settled commit.

## The certified 2D reference (mirror it)

`BlackjackModal.tsx` `applySettled`, `source === 'deal' && res.dealtImmediately`:
`revealEpoch.begin` → `setPendingSettlement(res)` → `setLiveHand(buildNaturalHoleHand(res))`
→ `setDisplayStep('hole')` — a REAL hole commit (player natural cards, dealer
`[upcard, hidden]` + `N+?`, no banner, balance untouched), then staged dealer-reveal →
settled where balance/banner commit.

`buildNaturalHoleHand` (`blackjack-2d-publisher.ts:75-97`) shape:
`insuranceOffered: dealerUpcard?.rank === 'A'` · `tookInsurance: outcome.insurance !== null`
· `didSplit: outcome.playerHands.length > 1` · player hands `isResolved: true`.

**Already verified: the 3D view derivation needs NO new code for the hole frame.**
With `hand === null` + `settledResponse` set + `dealStep 'hole'`:
- `playerHands` derive from `settledOutcome` (controller lines 1108-1121);
- `deriveDealerRenderView` (lines 165-185) falls back to
  `settledOutcome.dealer.cards[0]` as upcard → renders `[upcard, hidden]` + `N+?`
  for any non-revealed dealStep;
- `insuranceState` set by `applySettled` lines 729-732 matches `buildNaturalHoleHand`
  exactly (`offered: outcome.dealer.cards[0]?.rank === 'A'`, `took: insurance !== null`);
- `buildBlackjackRoomParity` (`blackjack-room-parity.ts:20-22`) attaches `settled`
  ONLY at dealer-reveal/settled, and `bannerText` only at settled — a published hole
  revision carries `settled: null`, no leak.

## Change 1 — controller staging (`use-blackjack-room-controller.ts` `applySettled`)

a) **Deal-settled hole beat.** Replace the `else { revealDealer(); }` branch
   (line 763-765) with:
   ```ts
   setDealStep('hole');
   setTransition('idle');
   bumpPublish();
   revealTimerRef.current = setTimeout(revealDealer, HOLE_REVEAL_MS);
   ```
   (`HOLE_REVEAL_MS` = 120 — the existing 3D hole cadence, line 47.)
   Resulting natural staging: hole (real paint, 120ms) → dealer-reveal (280ms,
   `SETTLE_REVEAL_MS`) → settled + banner. Journal phases hole → dealer-reveal →
   settled — scenario B6 `['hole','settled']` (scenarios/blackjack.ts:48) needs NO
   change; its hole checkpoint simply becomes honest.

b) **Balance deferral.** Move `setBalance(response.balance)` from line 733 into the
   settled-step commit (inside the `SETTLE_REVEAL_MS` timeout, alongside
   `setDealStep('settled')` / `setBannerVisible(true)` / `setPhase('settled')`).
   This defers the visible bankroll on BOTH deal- and action-settled paths —
   uniform with 2D. The action path's certified rows re-certify anyway (same
   function edited).

## Change 2 — adapter honesty (`blackjack-room-parity.ts`)

Replace both fabricated `'hole'` seeds (lines 77-80 and 100-103) with **truthful
current-state seeds**: the advance coordinator runs from a post-commit effect, so
`view.dealStep` IS the painted state at seed time. Dealer-reveal branch seeds
`buildBlackjackRoomParity(view, 'dealer-reveal', 'idle')`; settled branch seeds
`buildBlackjackRoomParity(view, 'settled', 'idle')`. The seed's only job is creating
the store entry so `beginTransition` can bind the span (`card-parity-mirror.ts:574-587`
no-ops without an entry, and `completeTransition` then can't reset to idle) — keep the
binding, fix the lie. After Change 1 these branches are defensive-only (the controller
always publishes hole/player-turn first from the same instance).

## Change 3 — tests

- Adapter: `advanceBlackjackRoomParity` with empty store + a dealer-reveal view seeds
  a `dealer-reveal` revision, NEVER `'hole'` (place per existing parity test patterns).
- Controller pure pieces already covered; add/extend: a hole-step view with
  `settledResponse` builds parity with `settled: null` + masked dealer + `N+?`.
- If a hook-level test harness exists for the controller staging, cover: deal-settled
  commits `hole` before `dealer-reveal`, and balance does not change until the settled
  commit. If none exists, say so honestly — the live rows are the staging gate.

## Open questions for Codex peer review (verify against real code, don't trust me)

1. **Affordance gating during the new hole beat**: phase is 'player-turn',
   `settledResponse` set, `hand` null, `insuranceState.offered` possibly true (dealer
   Ace natural). Verify NO control (Insure/Hit/Stand/Deal) is clickable in the room
   component during staged beats. (The certified action-settled 120ms beat has the
   same state shape, so gating should already handle it — verify, don't assume.)
2. **Balance deferral blast radius**: anything reading `balance` between settle
   response and settled commit (agent decide loop, bet clamp, shoe UI)? The next deal
   can't start until phase 'settled'→'idle', but verify.
3. **Unmount mid-staging**: reveal timer cleanup drops the balance commit — next
   mount reconciles. Same discipline as 2D (pendingSettlement dropped on close,
   certified). Acceptable? Verify cleanup actually clears `revealTimerRef`.
4. **Adapter seed alternatives**: is truthful-seed right, or should the seeds be
   deleted outright with `beginTransition`/`completeTransition` made entry-creating?
   Counter-propose if you disagree.
5. **Journal noise**: truthful settled-branch seed produces settled@idle →
   settled@revealing → settled@revealing (dup?) → settled@idle on the defensive path.
   Does `acceptRoot` dedupe? Does any walker/teardown expectation break?

## Division of work (founder instruction: collaborative, mutual review)

- Fable authored this design; **Codex reviews it as a peer** (verdict
  APPROVE / APPROVE-WITH-FIXES / REJECT + findings with file:line evidence).
- After convergence: **Fable implements** the diff (commit-first per item);
  **Codex reviews the diff AND owns live browser verification** (its stronger
  tooling): b6-3d TWICE consecutively, full blackjack-3d regression set
  (b2/b3/b4/b5/b7/b8/b-neg on blackjack-3d), one 2D spot row (b6-2d) — via root
  `smoke-row.cmd <row-id>`, 90s spacing after guest rows, max 4 attempts,
  journalTail=[]/nav-timeout = environment (wait 90s, retry).
- Fable re-runs every gate personally before any "certified" claim: parity unit
  suite 0 fail · self-test green · web tsc EXACTLY the 12 baseline · api tsc 0 ·
  rebuild web + restart :3003 (api :4002 NOT restarted).
- Same-diff docs: GameFeatures.md (user-visible: 3D naturals now show a masked-dealer
  beat before the flip; 3D balance moves only at the verdict) + ledger addendum in
  `specs/spec-2d-publisher-round.md` closing MAJOR A.
- Disagreements between Fable and Codex get surfaced to the founder, not silently
  resolved.

## Constraints (binding)

vCLAW never "CT"/"casino" in user-visible strings · NO em dashes in user-visible copy
· no pushes anywhere · no spec edits by the implementer once frozen · never stage
pre-existing untracked/modified files · E4: no "done/fixed" claims — "certified by
the harness, needs founder eyes".

---

# v2 (FROZEN) — revised per Codex REJECT (2026-07-29)

Codex verdict on v1: REJECT (full report: session scratchpad
`reports/critique-majora-report.md`). Two blockers: (B1) the v1 timer is armed inside
`applySettled` BEFORE React commits the hole state — a >120ms main-thread stall makes
React commit dealer-reveal directly and, with the fabricated seed removed, B6 has no
hole revision at all (the exact pre-commit-timer trap the certified 2D round solved
with `scheduleCommittedStep`); (B2) `BlackjackParityPublisher` mounts INSIDE the
Canvas's Suspense subtree (`blackjack-table-room.tsx:380,435-438`) while Deal is
clickable in the HUD outside it — a natural can traverse hole→settled before the
publisher exists; the fabricated seed was hiding exactly this. Plus MAJORs: Walk Away
executable during every staged beat (new bug, found by the review); moving one
setBalance is not a concealment guarantee — reconcile/avatar-refresh/eager-restore
are independent balance writers; v1's "truthful seed" forced transition 'idle',
overriding committed transition truth.

## v2 changes (supersede v1 Changes 1–3)

**C1 — new `apps/web/src/lib/cove/blackjack-room-reveal-epoch.ts`.**
`BlackjackRoomRevealEpoch`: sibling of the certified `BlackjackRevealEpoch` (same
pattern: epoch+correlation captured at schedule, re-proved at fire, committedStepKey
dedupe, BOUND timer defaults, cancel()). 3D settled-staging plan (settledResponse
always present): `hole` –120ms→ `dealer-reveal` · `player-turn` –120ms→
`dealer-reveal` · `dealer-reveal` –280ms→ `settled`. Sibling, NOT a refactor of the
2D class — zero risk to the certified 2D surface; trade-off flagged for diff review.

**C2 — controller settled staging runs post-commit through the epoch.**
- `applySettled`: state only, NO timers, NO balance: markSettled, setSettledResponse,
  insuranceState, hand null, activeSlot 0, shoe dealtCount, phase 'player-turn',
  bannerVisible false, `pendingSettlementRef.current = true`,
  `roomRevealEpoch.begin(handId)`, transition 'idle',
  dealStep = source==='deal' ? 'hole' : 'player-turn', bumpPublish.
- NEW post-commit effect keyed on `[dealStep, settledResponse?.handId]`: when
  settledResponse present, `epoch.scheduleCommittedStep(handId, dealStep, commit)`.
  commit('dealer-reveal'): setDealStep + setTransition('revealing') + bumpPublish.
  commit('settled'): pendingSettlementRef=false, setDealStep('settled'),
  setBannerVisible(true), setPhase('settled'), setBalance(settled.balance),
  bumpPublish, epoch-owned 0ms → setTransition('idle') (no bump — the journal's idle
  stamp comes from completeTransition, unchanged).
  Each step arms only from the COMMITTED previous frame — the chain PROVES the hole
  painted. `revealTimerRef` + `revealDealer` deleted.
- Balance guard: `setBalanceGuarded` used by ALL other writers (avatar effect :663,
  reconcile :655, eager restore :675, ensureShoe :712) — no-op while
  `pendingSettlementRef` true. Settled commit writes settled.balance directly.
- Epoch cancel + pendingSettlementRef=false at: resetHand, restoreHandFromServer
  ('clear' AND live-restore branches), reconcile guest branch, unmount cleanup.
  2D-G3.2 mirror: 'clear' disposition skipped while pendingSettlementRef true.
- Obsolete comment :755-758 rewritten.
- Deliberately UNCHANGED: live-deal hole beat + split beat (`holeTimerRef`) —
  fail-safe (a missed beat = missing revision = visible row failure, not a lie);
  autonomous decide loop (redundant mid-staging fetch is pre-existing; acts are
  phase-gated).

**C3 — publisher hoisted out of Suspense.** New
`apps/web/src/components/cove/blackjack/BlackjackRoomParityPublisher.tsx` (verbatim
the null-render effect component from blackjack-table-room.tsx:334-352), rendered by
`app/cove/blackjack/page.tsx` beside `ParityMirror`; removed from the Canvas subtree.
Matches the baccarat precedent (its controller publishes at page level; baccarat has
NO fabricated seed — this bug class is blackjack-only, verified). Driver needs no
readiness wait: publisher mounting is unconditional.

**C4 — adapter truthful seed.** Both empty-store seeds become
`publishFeltParity(instanceId, buildBlackjackRoomParity(view))` — committed dealStep
AND committed transition, no overrides. Defensive-only after C2/C3. Expected
empty-store settled journal (per Codex): settled/committed-transition →
settled/revealing (forced begin) → [identical publish deduped] → settled/idle
(forced complete).

**C5 — Walk Away staging lock.** Top-of-handler guard in `handleWalkAway` (BEFORE
the guest `requestClose` branch — guests currently NAVIGATE AWAY mid-staging) + HUD
disable, both on the staging window (settledResponse present && dealStep !==
'settled'). Live-hand toast UX kept (narrower than Codex's idle-or-settled phrasing —
closes exactly the found hole without changing live-hand behavior; divergence flagged
for diff review). Any other HUD leave-control found during implementation gets the
same lock.

**C6 — tests.** blackjack-room-reveal-epoch.test.ts (plan, dedupe, re-proof, cancel,
bound defaults) · blackjack-room-parity.test.ts empty-store dealer-reveal AND settled
exact journal sequences (never 'hole') · walk-away lock predicate · honest statement:
no mounted-hook harness exists for the 3D controller — the live rows + Codex's HUD
probes are the staging gate.

**Verification contract (Codex's expanded list, accepted):** b6-3d TWICE
consecutively INCLUDING one cold-Canvas load · observed hole frame with masked dealer
+ `N+?` · HUD balance unchanged at hole and dealer-reveal, equals wire balance at
settled · Walk Away disabled during staged beats, enabled at settled · adapter unit
tests · b2/b3/b4/b5/b7/b8/b-neg blackjack-3d regressions + b6-2d · gates: parity
suite 0 fail, self-test green, web tests 0 fail, web tsc EXACTLY the 12 baseline,
api tsc 0, rebuild web + restart :3003 (api :4002 untouched).
