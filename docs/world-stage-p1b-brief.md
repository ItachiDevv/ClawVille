# P1b IMPLEMENTATION BRIEF — the Cove joins the stage; returns become fades

Phase P1b of `docs/persistent-world-canvas-plan-2026-07-24.md` (v2.1 +
execution ledger). P1a is DONE and ON STAGING (`cf393d4f` + ledger `7d1f409f`,
container-verified): `/game` renders through the persistent stage, parity
confirmed. THIS slice delivers the founder-visible payoff: **`/cove` joins the
`(world)` route group, and cove↔game crossings become fades — the return
loading screen dies.** Work from your own P0b cove fix list
(`docs/world-stage-p0b-notes.md` §"Exact P1 Cove fix list") — all six items are
in scope here except real-avatar/economy integration testing beyond what the
route needs.

## Scope

### 1. `/cove` page joins the group

- MOVE `app/cove/page.tsx` (+ its co-located client components if any) →
  `app/(world)/cove/page.tsx`. `/cove/history`, `/cove/verify`, `/cove/poker`
  sub-routes STAY OUTSIDE the group (route manifest rule [C1]) — verify they
  still build and render (they must not inherit the stage layout).
- `/cove` today has no force-dynamic guard analog — check; if its page is
  static-cacheable HTML, add the same `layout.tsx` force-dynamic guard pattern
  as `/game` (same Cloudflare stale-chunk-graph hazard applies once it's a
  group member). Record the Cache-Control evidence for BOTH routes.
- Delete the `CoveCanvas` mount from the cove page; cove HUD/DOM (exit button,
  balance, modals, styles from `cove-tokens.css`) stays in the page above the
  stage, following the P1a pointer-events pattern (page shell transparent,
  concrete roots interactive). The cove page's `key={'cove-interior'}` clean-
  teardown pattern is obsolete for the stage path — remove with a note.
  `CoveCanvas.tsx` itself: if nothing else imports it after this, DELETE the
  file (no dead forks); note the deletion.

### 2. Cove scene slot (from your own P0b fix list)

- Register scene `cove` in the production stage manifest: the REAL
  `cove-interior.tsx` subtree (not the spike). Fix list item 1: unify its
  imports to `three/webgpu`. Item 4: cove camera pose, fog, background, and
  lights become slot-scoped (`appearance` per slot — P1a already made
  background/fog/shadows slot state; extend for cove's values and verify
  hidden-slot lights cannot illuminate the active slot — if R3F `visible=false`
  on the slot group does not exclude lights from the render list, gate light
  mounting on slot activity explicitly).
- Item 3: cove slot lifecycle — optimized GLB warming with generation-tokened
  `ackReady` (reuse the KTX2 loader path proven in the P0b spike); the
  fallback interior GLB path must also work (test by forcing the fallback).
  Teardown/eviction must not dispose textures shared through `vrm-loader`'s
  canonical cache (ownership rule [C6] — for P1b, cove slot resources stay
  resident once loaded on capable GPUs; low-end unmount-and-dispose comes
  later; do NOT implement texture eviction).
- Item 5: cove HUD/labels/modals/economy REST stay DOM-side, untouched
  functionally. The cove's game logic (slots/blackjack REST + stores) must
  work identically — zero API changes.

### 3. `useSceneFrame` conversion sweep (fix list item 2 + plan contract 3)

Now that TWO scenes can be resident, hidden-slot work must be zero:

- Convert the WORLD's per-frame owners to `useSceneFrame('world', ...)`:
  every `useFrame` inside the `WorldSceneContents` subtree (NPC controllers,
  interpolation, water/particles, click-path, camera follow, jump ticker,
  labels projection, animator updates — sweep `apps/web/src/lib/three/**` for
  `useFrame` consumers mounted under the world subtree). Mechanical rule:
  subtree-mounted `useFrame(cb)` → `useSceneFrame(sceneId, cb)` with sceneId
  from a new SceneIdContext provided by the slot wrapper — so shared
  components (used by world AND arena's legacy canvas) keep working: the
  context defaults to "always run" when absent (legacy canvas path).
- Convert the COVE subtree's frame owners (`cove-interior.tsx` has several)
  the same way.
- Window/document listeners and RAF timers inside both subtrees: gate on slot
  activity (use the counted stage helper where the stage owns them; for
  scene-component listeners, mount/unmount on activity flag from context).
- The probe's hidden-violation assertions are the acceptance: extend
  `world-stage-probe.mjs` with a THIRD lane that drives the REAL `/game` ↔
  `/cove` navigation loop (not `/perf/stage`): 30 round trips, asserting
  hidden-slot frame counters frozen, canvas mount count 1, listener delta 0,
  heap growth <15% after warmup, zero transition errors. This IS the leak-soak
  release gate for the slice (plan contract 8, scaled to 30 loops here; the
  50-100-loop soak runs in P1c pre-promotion).

### 4. Transitions + loader (plan contracts 1-2)

- Cove entry/exit currently uses `SceneTransition` (`triggerTransition({to})`).
  For in-group crossings, route through the stage's transition machine:
  fade → `router.push` → slot request keyed to the destination route →
  awaiting (ready + camera + first frame) → fade in. Reuse/adapt the P0a
  `StageTransition` overlay as the group-level transition surface; the legacy
  `SceneTransition` component stays for non-group routes (kelp) — do not break
  it.
- Back/forward browser navigation between /game and /cove must drive the same
  machine (pathname is the source of truth for the active slot request).
- `SeaLoadingScreen`: on RETURNS (world slot already resident) it must NOT
  mount/show at all — key its mount to "world slot has never been resident
  this stage generation" (worldHasEverActivated, Codex answer #4). First boot
  keeps the exact current behavior. Cove deep-link cold boot (`/cove` direct):
  stage boots with ONLY the cove slot requested — world assets must NOT load
  (verify by network inspection: no world GLB/KTX2 fetches on a cold /cove
  load) — and the first exit to /game runs the world's first boot (loader
  shows then, once).
- The 45s stage transition timeout stays; its error surface must offer a
  reload action (never an infinite black).

### 5. What P1b explicitly does NOT do

- No stream/presence moves (`useWorldStream` stays page-owned in /game —
  P1c). Consequence to preserve: entering /cove still unmounts the game page →
  streams close exactly as today. State this in the notes.
- No texture eviction, no low-end unmount tier (later, after P1c).
- No /kelp, /arena, /activity changes.
- No PROTOCOL_VERSION / agent-surface / economy changes.

## Constraints

Iris Xe bans; `three/webgpu` only; TS strict; no new deps; live code wins over
docs on any discrepancy (flag it in notes, like the P1a DPR catch).

## Definition of done

1. Root build 0; web tsc 0.
2. Probe: original `/perf/stage` lanes PASS + the NEW real-route lane PASS
   (30 game↔cove loops; fresh JSONs committed).
3. Manual local drive documented in notes: cold /game boot → enter cove (fade,
   NO loading screen) → play one slots spin (demo guest ok) → back to world
   (fade, NO loading screen, world instantly live) → repeat ×3; cove deep-link
   cold boot works with no world fetches; /cove/history + /cove/verify render
   outside the group.
4. `docs/world-stage-p1b-notes.md`: what moved, the sweep inventory (every
   converted useFrame owner listed), transition wiring, loader keying,
   deviations, reviewer checklist.
5. Same-diff docs: `3dStructure.md` (cove render path), `GameFeatures.md`
   (cove entry/exit UX — returns are now fades), `ARCHITECTURE.md` (route
   group membership), plan ledger row P1b.
6. Commit on `feat/world-stage-p0a`:
   `feat(3d): P1b cove joins persistent stage — fade returns, no reload (plan v2.1)`
   — do NOT push. Then write `docs/world-stage-p1b.done` with the sha.

Reviewer (Fable) drives the full loop in a real browser (including FPS + the
cove tables actually playing) before anything moves further.
