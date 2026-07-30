# World-stage P3 notes

## Built result

P3 moves page-only `/kelp` into the persistent `(world)` layout and makes the
real Kelp Forest scene a resident stage slot. The four reviewable commits are:

- P3a — shared player-capability controller.
- P3b-1 — renderer/stage plumbing, boundaries, readiness, and slot capability.
- P3b-2 — guarded Kelp walk-in, route handoff, resident scene, controls, health,
  recovery, and probe coverage.
- P3b-3 — `at-kelp` co-presence and connection protocol version 41.

The human path is `/kelp` in-world portal → stage slot. The agent path is
unchanged: Kelp exposes no new `[ACTION:]` verb and no settlement change. The
only agent-visible addition is the `at-kelp` co-presence convention documented
by protocol version 41.

## Frame and listener ownership

The resident scene routes player integration, camera follow/orbit, environment
animation, selected-avatar animation, beacon/discovery animation, readiness,
and active-scene bookkeeping through stage-scoped owners. Hidden-scene callbacks
are frozen by `useSceneFrame`; window listeners and timers remain mount-owned
with symmetric cleanup. Activation state resets once per slot generation, and
stale tokens cannot acknowledge readiness or mutate a newer visit.

## Renderer-health disposition

The former Kelp-local Canvas factory and renderer-status store are removed.
Device loss, uncaptured WebGPU errors, WebGL context loss, one same-canvas
recovery, session-sticky WebGL fallback, visibility wake, stage failure UI, and
resource accounting are owned by the persistent stage. Kelp-specific chunk,
environment, and activation failures retain explicit evidence lanes. A
recovery repaints the maze without remounting the slot or changing its resource
ledger.

## Verification inventory

- Shared controller and ordered frame-contract suites.
- Stage plumbing, boundary, renderer-status, navigation, warmup, and slot tests.
- Kelp walk-in/slot tests plus existing portal, realm, HUD, and world-stream
  suites.
- Production-bundle WebGPU/WebGL synthetic, Kelp/Cove routes, Kelp exit,
  retry-adoption, loader, dwell, soak, recovery, and mobile/touch checks.
- Protocol v41 pins, exact `at-kelp` manual convention, refreshed public Hatcher
  client comparison, contract probe, and staging signed mock-Hatcher harness.

## Deviations and limitations

The production probe bridge gained read-only ledger access and an exact recovery
trigger because the frozen recovery gate cannot be proved from external DOM
state alone. The short-landscape Kelp HUD bound was tightened after the required
844×390 sweep found overlap. Emulation cannot prove physical safe-area insets;
the real-iPad check is tracked for 2026-09-01. Signed-in manual traversal/claim
and subjective maze lighting/occlusion remain founder/reviewer checks; automated
contracts do not claim visual approval.

## Reviewer checklist

- Confirm `/game` ↔ `/kelp` returns are fades with one Canvas and no loader.
- Confirm world facing/position restore and no immediate portal re-entry.
- Confirm keyboard and both touch joysticks move the Kelp body; jump stays off.
- Confirm beacons, three spores, center CTA, and explicit claim UI.
- Confirm peers show `· at the Kelp Forest` while the Kelp visitor remains in
  the room.
- Confirm renderer recovery repaints without remount or ledger drift.
