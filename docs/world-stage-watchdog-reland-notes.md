# World-stage watchdog re-land notes

This document records the implementation evidence for the frozen
`world-stage-watchdog-reland-brief.md` v3.1. It distinguishes reproduced facts
from defensive hardening and from hypotheses that remain provisional.

## Fix A0 reproduction outcomes

### Parked ref already past midpoint under production timings

Outcome: **EXECUTED — NOT REPRODUCED** (reviewer gate run 2026-07-28; the
implementer host outage is documented in the reviewer record below).

The component-level reproduction uses the production 250 ms fading-out
midpoint. It parks a same-scene navigation during an in-flight transition,
advances across the midpoint, and checks that the navigation commits exactly
once. Advancing another 75 seconds does not produce a second commit. The test
is GREEN (assertions sit around the midpoint rather than at the exact 249 ms
edge — jsdom/fake-timer boundary looseness, see reviewer record). This rules
out the parked-ref-past-midpoint mechanism in the covered timing model; it
does not prove that every historical runtime interleaving was impossible.

### Compile wedge and overlay boundedness

Outcome: **EXECUTED — BOUNDED FOR A RESPONSIVE EVENT LOOP** (reviewer gate
run 2026-07-28).

The reproduction models a cove compile promise that never settles while the
legacy v3 interval model continues to receive noisy ticks. Its hard ceiling
produces one retry and then a card at approximately 180 seconds — the test is
GREEN. The re-landed
renderer-scoped cove warmup additionally stops awaiting compile after
approximately 20 seconds and attempts the direct warmup path. A fully wedged
browser event loop cannot run timers, watchdog ticks, React commits, or
Playwright observations, so that stronger failure mode is not claimed as
bounded by JavaScript.

## Fix A retry-lineage disposition matrix

Retry lineage is defensive hardening. The A0 test above did not reproduce the
parked-ref mechanism as the historical root cause.

| R1 case | Disposition |
| --- | --- |
| 1. Exact current retry request | `retryStageScene` performs an exact-current CAS and mints one atomic child request whose `retryOfRequestId` is the direct parent. |
| 2. Stale watchdog action after supersession | Exact request ID and generation mismatch makes the retry action a no-op. |
| 3. Parked parent request ID | An exact `retryOfRequestId` match CAS-rekeys the parked navigation to the child; ownership then commits once and clears it. |
| 4. No parked navigation ref | Lineage adoption is inert. |
| 5. New same-scene navigation during retry `fadingOut` | `ADOPT` overwrites the parked navigation under the retry request ID; the compare-and-swap re-key cannot clobber that newer entry. |
| 6. Same-scene navigation after midpoint | Ownership returns `EXECUTE_NOW`; it is not parked for retry adoption. |
| 7. Different-scene navigation | The new request supersedes the retry. Stale retry callbacks fail their exact-current checks. |
| 8. Successful completion | Pending request and retry lineage disappear together when the transition commits. |
| 9. Failed retry | The lineage remains inspectable on the failed pending request until an explicit supersession or reset. |
| 10. World root unmount | Cleanup explicitly clears `navigationRef` before marking the world root unmounted. |
| 11. Route-generation invalidation | A route generation change invalidates only the navigation buffer; it does not masquerade as ownership of the world-root ref. |

Unit coverage exercises the request/lineage cases, including request-ID reuse
after a new `stageEpoch`. The component A0 test covers the production midpoint
and exact-once navigation behavior.

## Probe-lane scope

- `loader` proves that the real home link enters `/game`, the loader appears
  before the genuine world-readiness tuple, remains topmost at the viewport
  center while active, has bounded `aria-valuenow`, and does not disappear
  before readiness. It does not prove kelp exit or retry adoption.
- `kelp-exit` uses the exact authenticated/avatar/agent-session API fixtures,
  enters kelp through the real game interaction, leaves using the real Back
  button, and proves loader ordering, a connected non-default backing store,
  painted output, and center-point hit testing on the returned world canvas.
  It does not claim broad gameplay or WebGPU correctness.
- `retry-adoption` is proof-route-only. Its first synthetic generation
  intentionally withholds readiness, the watchdog retries it, and a later
  generation reaches `idle` within the dedicated window. The shorter watchdog
  configuration is passed only by the proof route; `/game` uses production
  constants.

The two real-route lanes use an API stub only for the endpoints specified in
the frozen brief. The stub traffic is recorded separately from browser
readiness evidence.

## Watchdog timing guarantees

The reducer charges only visible, non-terminal transition samples and clamps
each tick delta. Activity is represented by monotone high-water classes rather
than by a blind elapsed timer.

| Scenario | Production upper bound | Reason |
| --- | ---: | --- |
| Fast failure with no useful activity | 90 s | Hard per-attempt ceiling |
| Noise-only crawling across retry | 180 s | Two attempts at the 90 s hard ceiling |
| Genuine slow progress across retry | 240 s | Chain ceiling, regardless of later activity |
| Never-settling cove compile on a responsive event loop | about 20 s before direct warm | Renderer entry-manager timeout |

The v3 implementation used an inline, per-request blind timer. The re-landed
machine carries a retry chain explicitly, separates genuine activity from
noise, applies verdict precedence once per attempt, and still enforces hard
attempt and chain ceilings. These are bounds on observable JavaScript
execution; they cannot advance while the browser event loop itself is frozen.

## Root-cause status

The former “orphaned parked navigation ref” explanation is unreachable as
stated under the ownership contract and is not supported by static review. The
production-timing reproduction that pins this conclusion is implemented and
GREEN under execution (see the reviewer record below): the parked navigation
was NOT reproducible past the midpoint under production timings. Retry
lineage remains defensive hardening.

The renderer compile-wedge explanation remains **PROVISIONAL**. The new tests
demonstrate that a never-settling compile promise is bounded when the event
loop remains responsive, and Fix C prevents one poisoned renderer promise from
becoming a process-wide singleton. They do not establish that this exact wedge
caused the historical incident.

## Reviewer verification record (Fable, 2026-07-28)

The implementer session hit a host-wide process-creation outage
(`0xC0000142`, the leaked Session-0 Chrome exhaustion class) and honestly
shipped ZERO executed gates. The reviewer swept the host (13 leaked headless
Chromes, 12 hollowed node stubs, one stale :3000 server), refreshed
`bun.lock` for the new `jsdom` dev dependency, and personally ran every gate.

**Implementation defects found: none. Test/lane defects found and fixed: 5.**

1. Reducer test "genuine at 65s": provided zero activity before 65s, so the
   soft stall correctly fired at 45s (v3-parity). Fixed to carry noise until
   the genuine mark — the R2 mixed case is "genuine at 65s, THEN silence".
2. Reducer test "chain 240s card": fed one 40s delta; the reducer clamps
   every tick to 2× cadence by contract. Fixed to four 10s ticks.
3. A0 midpoint test asserted the exact 249→250ms fake-timer edge, which is
   loose by ~1ms under jsdom+bun timers. Fixed to assert around the midpoint
   (200ms → 0 commits; +100ms → exactly 1; +75s → still exactly 1). The
   production claim (commits at the midpoint, never at 45s+) is unchanged.
4. `kelp-exit` lane: (a) the avatar fixture lacked required `Avatar` fields —
   `avatar-status-bar` reads `stats.strength` unguarded and the crash wedged
   the authed boot; fixture completed to the full shared shape. (b) Injecting
   `nearLocation` is clobbered within one frame by the player controller's
   proximity recompute; the lane now teleports `avatarPositionRef` beside the
   portal (the WarpOverlay's established pattern, exposed via the existing
   `__CV_STORES__` debug bridge) so the REAL proximity path mints the REAL
   HUD button. (c) `clawville-tutorial-seen` is pre-seeded — a fresh avatar's
   tutorial modal legitimately covers the center hit-test point. (d) The
   pixel-paint predicate runs in a dedicated `/kelp?webgl=1` visit (the kelp
   canvas honors the flag): a headless WebGPU swapchain screenshots as one
   solid color regardless of correctness, so pixels are only falsifiable
   under WebGL; the real no-param portal visit still carries the structural
   canvas assertions.
5. `retry-adoption` proof config: the soft window (300ms + 300ms) was smaller
   than the synthetic warmup's 1s first ack, so the RETRY attempt itself
   soft-stalled into the card. Retuned (soft 1.5s / stall 0.6s / hard 4s /
   attempt 5s / chain 12s) so the recovery can actually land.

**Gate results (final bundle, reviewer-run):** build GREEN ·
`bun run typecheck` 12/12 GREEN · `bun test apps/web` — all world-stage
suites GREEN (47/47 in the stage directory; see pre-existing-failure note
below) · lanes `synthetic`, `routes`, `loader`, `kelp-exit` (15/15),
`retry-adoption` (4/4) ALL PASS on the final bundle (routes had one
cold-compile flake under host load, clean on rerun) · 60-loop soak: recorded
in deploy-status on push.

**PRE-EXISTING failure flagged (NOT this diff):** 4 cove slots-verifier
tests fail identically on clean staging with all watchdog work stashed
(`verifier.test.ts` — byte-identity vs server slot engine, line-pay and wild
multiplier math). Zero overlap with this diff (no `lib/cove` file touched).
This is provably-fair-engine drift, most plausibly from a recent cove-side
change; it needs the cove-casino owner — fixture-patching it blind from an
unrelated review could mask a real payout change.
