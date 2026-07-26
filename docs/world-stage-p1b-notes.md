# Persistent world stage P1b notes

Date: 2026-07-25  
Scope: `/cove` joins the persistent `(world)` stage; `/game` returns become
stage-owned fades  
Branch: `feat/world-stage-p0a`  
Verification status: implementation review in progress; build, TypeScript, and
all Puppeteer lanes must be recorded below by the root reviewer after serial
execution.

## Route and render-path change

- `/cove` page ownership moves from `apps/web/src/app/cove/page.tsx` to
  `apps/web/src/app/(world)/cove/page.tsx`. The URL remains `/cove`.
- `/cove/history`, `/cove/verify`, and `/cove/poker/**` stay under the ordinary
  `app/cove` tree. They do not inherit `app/(world)/layout.tsx` and must not
  mount the stage Canvas.
- `/cove` receives the same `dynamic = 'force-dynamic'` route guard as
  `/game`. The serial route probe records status and `Cache-Control` for both
  HTML routes.
- The page retains the Cove DOM surface: Back to World, History, Verify,
  Support, the four game modals, mobile controls, branding, and the existing
  stores/REST clients. Its full-screen shell is transparent to the shared
  Canvas except at concrete interactive roots.
- The route-owned `CoveCanvas` mount and `key="cove-interior"` teardown model
  are obsolete. `CoveCanvas.tsx` is deleted once its last import is removed;
  the production `CoveInteriorScene` renders as the `cove` slot beneath the
  page DOM.
- The optimized interior remains
  `/models/cove/cove-interior-cleaned-v1-ktx.glb?v=6`; `?fallback=1` and the
  measured low-FPS path still select
  `/models/cove/cove-interior-fallback.glb`. Cove slot readiness is
  generation-matched, and its loaded resources remain resident in P1b. No
  texture eviction, shared-VRM-cache disposal, or low-end unmount tier is
  introduced.

## Stage and transition wiring

`WorldStageRoot` maps the live pathname to one requested slot:

| Pathname | Requested slot |
|---|---|
| `/game` | `world` |
| `/cove` | `cove` |

A cold `/cove` request imports/warms only Cove. It must not execute the world
scene/preload path or fetch world-only GLB/KTX2 assets. The first later visit to
`/game` is still a real first-world boot and may show `SeaLoadingScreen`.
After the world slot has activated once in the current stage generation,
`SeaLoadingScreen` does not mount on returns.

In-group entry/exit calls the group-owned navigation bridge. The persistent
transition owns fade-out, Next client navigation, matching slot request,
generation-matched readiness, camera installation, first controlled frame,
and fade-in. `usePathname()` remains the authority, so browser history changes
request the same slot. The 45-second failure path remains black with an
explicit Reload action. The legacy `SceneTransition` remains available for
routes outside `(world)` and is not the `/game`↔`/cove` owner.

Cove appearance is slot-scoped:

- camera: `fov=65`, `near=1`, `far=2000`, initial position `[0,55,400]`;
- background/clear color: `0x0a0015`;
- fog: Cove interior values owned by the slot rather than a child
  `<fog attach="fog">`;
- shadows: disabled;
- Cove lights mount only while Cove is active, so resident hidden lights
  cannot illuminate the world.

The Cove exit midpoint still resets the avatar to the outside-door game-pixel
position before `/game` becomes visible. Cove game rules, wagers, API routes,
ClawToken settlement, guest behavior, agent settlement, and leaderboard
credit are unchanged.

## Frame and listener conversion inventory

`SceneIdContext` is supplied by each stage slot. `useSceneFrame(callback)`
reads that context and registers with the stage scheduler; outside the stage
the context is absent and the hook delegates to ordinary R3F `useFrame`, which
preserves legacy `/arena`, `/perf`, and other Canvas consumers.

The P1b sweep covers these world-subtree frame owners:

| Owner | Converted work |
|---|---|
| `World3DCanvas.tsx` | arrow-orbit camera; explore WASD camera; follow camera; minimap/store projection; Cove entrance camera push |
| `jump-ticker.tsx` | jump integration |
| `arena-buildings.tsx` | building animation/interaction tickers |
| `meshlet/meshlet-buildings-r3f.tsx` | debug meshlet frame submission while that optional path is mounted |
| `arena-npcs.tsx` | streamed/free-roamer interpolation, animation, labels |
| `arena-location-npcs.tsx` | resident animation/interpolation and label projection |
| `player-avatar.tsx` | both VRM and GLB player movement/animation/camera-facing branches |
| `npc-controller.tsx` | possessed-NPC movement and store writes |
| `kelp-forest.tsx` | ambient animation |
| `kelp-forest-portal.tsx` | portal animation |
| `quest-npc.tsx` | quest marker/NPC animation branches |
| `town-guide.tsx` | guide animation |
| `cove-beacon.tsx` | beacon animation |
| `cove-entrance.tsx` | entrance animation and tunnel auto-entry check |
| `activity-indicators.tsx` | pulse and typing indicators |
| `floating-text-3d.tsx` | reward-float animation |
| `npc-speech-bubbles.tsx` | label projection |
| `click-to-move.tsx` | path dots and target marker |
| `land-structures.tsx` | distance visibility |
| `land-showroom.tsx` | distance visibility |
| `world-labels-overlay.tsx` | shared DOM projection |
| `particle-system.tsx` | particle animation when mounted transitively |
| `cosmetic-loader.tsx` | equipped cosmetic animation/update branches used by staged avatars |

The Cove subtree owns five frame callbacks, all converted:

1. VRM avatar movement, collision, camera, animation, and E interaction.
2. GLB avatar movement, collision, camera, animation, and E interaction.
3. one-shot interior/camera debug sample.
4. FPS sampling, empty-scene detection, and optimized-to-fallback selection.
5. Classic/Bonus bank-label proximity-state projection.

Non-`useFrame` work audited in the same sweep:

- the world adaptive-quality `requestAnimationFrame` sampler pauses while its
  slot is hidden;
- world Arrow/WASD/custom Cove-walk-in listeners mount only while `world` is
  active and clear held state when deactivated;
- player-avatar, NPC-controller, and jump-input keyboard owners are active
  scoped and reset on deactivation;
- Cove WASD, arrow, blur, and visibility listeners are removable and active
  scoped instead of module-global one-shot listeners;
- NPC speech-bubble polling and any scene-local interval/RAF owner are
  activity-gated;
- stage renderer/device/context/visibility listeners remain stage-owned for
  the lifetime of the one Canvas and stay in the counted diagnostics;
- `input-reset.ts` remains its existing process-level reset bus rather than
  being duplicated per slot.

The acceptance invariant is stricter than `group.visible=false`: hidden frame
counts, camera poses, and sampled slot state must remain frozen, and listener
accounting must return to the same baseline after 30 round trips.

## Probe contract

`apps/web/scripts/world-stage-probe.mjs` retains the original synthetic lane
and adds a separate real-route lane:

```text
--lane=synthetic  /perf/stage, at least 100 transitions
--lane=routes     cold /cove, exactly 30 /game↔/cove round trips
```

The route lane writes
`apps/web/scripts/world-stage-route-summary.json`. It uses the production
stage bridge's Next-router navigation rather than hard reloads for the first
29 round trips, then performs the 30th with real browser Back and Forward
history traversal. Assertions:

- exactly 30 complete round trips / 60 route transitions;
- physical Canvas mount count remains one;
- hidden frame, camera, and slot-store windows remain frozen;
- active callbacks advance;
- stage listener delta is zero and accounting never underflows;
- transition error and recovery counts remain zero;
- Back/Forward reaches the matching pathname/slot through the same stage
  transition;
- world returns do not mount `SeaLoadingScreen`;
- cold `/cove` records no world-only GLB/KTX2 fetch;
- both `/game` and `/cove` return non-cacheable HTML headers;
- post-warmup JS heap growth is below 15% when
  `performance.memory` is available.

The synthetic WebGPU, synthetic forced-WebGL, and real-route lanes must run
one at a time after the production build and TypeScript check. The harness
does not use Playwright or Chrome DevTools MCP.

## Scope boundaries and deviations

- `useWorldStream()` remains owned by the `/game` page. Navigating to Cove
  still unmounts the page, closes the world streams, stops uploads, and clears
  page-owned presence exactly as before. Presence continuity moves in P1c.
- No API, database, economy, wager, agent protocol, Hatcher partner surface,
  `PROTOCOL_VERSION`, activity, Kelp, Arena, stream, presence, texture
  eviction, or low-end residency-tier behavior changes in P1b.
- Live code confirms the stage/legacy low-end DPR is `[0.55,0.7]`. The P1a
  prose that said `[0.5,0.65]` was stale brief drift and is corrected in the
  same documentation diff.
- Cove preserves the prior live camera `far=2000` and fog `[4000,10000]`
  exactly while moving ownership into the slot. The inherited
  `fog.far > camera.far` mismatch is recorded rather than silently retuned in
  a lifecycle migration; visual/fog retuning requires a separate reviewed
  change.
- Definition-of-done item 3, the manual local drive (including playing a
  slots spin, three visual loops, deep-link isolation, and history/verify
  visual checks), is reassigned to reviewer/Fable by the run amendment. It is
  deliberately not performed or claimed by this implementation session.

## Serial verification record (filled by reviewer/Fable 2026-07-26 — Codex was host-blocked at this step, 0xC0000142)

| Step | Result | Evidence |
|---|---|---|
| root `bun run build` | PASS (exit 0) | run post-review-fixes |
| `apps/web` `bunx tsc --noEmit` | PASS (exit 0) | run post-review-fixes |
| synthetic WebGPU probe | PASS | `world-stage-probe-summary.json` |
| synthetic forced-WebGL probe | PASS | `world-stage-probe-webgl-summary.json` |
| real-route probe (30 game↔cove round trips) | PASS — canvas mounts 1, zero hidden violations, listener delta 0, heap +12.5% (<15% gate; higher than synthetic ~1.2% — WATCH ITEM for the P1c 50–100-loop soak) | `world-stage-route-summary.json` |
| `/cove/history` outside-group smoke | PASS — renders, 0 canvases | reviewer browser |
| `/cove/verify` outside-group smoke | not separately driven (same layout tree as history) | — |
| manual drive: /game boot → cove (fade) → Back to World (fade) | PASS — `SeaLoadingScreen` NEVER mounted on return (MutationObserver armed through the crossing), world instantly live, canvas count 1 throughout | reviewer screenshots `p1b-cove-final2.png`, `p1b-world-returned.png` |
| deep-link cold `/cove` | PASS — cove active; 3D fetches were ONLY cove interior GLBs + lobster prop + player VRM/locomotion clips; zero world environment assets | reviewer network capture |
| demo slots spin through the modal | NOT exercised headless (3D raycast click flow); REST/store path is untouched by this diff — covered by founder staging playtest | honest gap |

## Review findings fixed in-slice (Fable, 2026-07-26)

1. **World-label bleed onto /cove (BLOCKING, fixed).** The labels overlay was a
   module singleton while the stage mounts TWO hosts (world + cove-interior's
   own bank-label host) against one global registry: the world host's frozen
   DOM stayed painted over the cove AND the cove host rendered every
   registered label (world's included). Fix: entries carry `sceneId` (captured
   from SceneIdContext at registration); each host renders + projects ONLY its
   own scene's entries; the projection pass and visibility gate target the
   instance's own overlay element (never the module singleton); module
   singleton cleanup is equality-guarded; the occluder `_sceneRef` self-heals
   at the top of the active host's projection pass. Verified live: on /cove the
   world host is `display:none` holding 40 labels, the cove host shows exactly
   its 2.
2. **`useSceneFrame` lacked render-priority support (BLOCKING, fixed).** Three
   swept owners (player-avatar ×2, npc-controller) were `useFrame(cb, -100)` —
   controllers must run before the follow camera. The hook now accepts
   `(cb, priority?)` / `(sceneId, cb, priority?)`; the stage scheduler
   dispatches in ascending priority; the legacy path passes priority through
   to R3F's subscriber list. The three call sites keep `-100`.
3. **First `requestWorldStageNavigation` after a cold boot can return false**
   (once per page load; not fully root-caused). Both UI call sites carry the
   `router.push` fallback and the pathname authority drives the same stage
   transition, so the crossing still works — the only degradation is that the
   first crossing of a session may skip `onMidway` (cove-exit avatar
   reposition to the door). P1c task: root-cause + retry-once hardening.
4. **Minor:** cold /cove downloads BOTH interior GLBs (optimized + fallback).
   Possibly deliberate fast-switch preload; P1c to confirm or lazy-load the
   fallback.

## Reviewer checklist

- [ ] Cold `/cove` paints the Cove directly and loads no world environment
      assets.
- [ ] Cove optimized GLB path works.
- [ ] `?fallback=1` renders the fallback interior.
- [ ] Cove camera, fog, background, and light balance match the prior route.
- [ ] Hidden Cove lights do not affect the world.
- [ ] Cove WASD/arrows/touch/E controls work only while Cove is active.
- [ ] Slot, blackjack, Hold'em, and baccarat modal entry still works.
- [ ] One demo-guest slots spin completes through the unchanged REST/store path.
- [ ] `/game`→`/cove` and warmed `/cove`→`/game` are fades with no return
      loading screen; repeat three times.
- [ ] Browser Back/Forward uses the same stage transition.
- [ ] Transition timeout error offers Reload.
- [ ] `/cove/history`, `/cove/verify`, and poker routes render outside the
      group without a stage Canvas.
- [ ] FPS remains at or above the current Iris Xe floor.
