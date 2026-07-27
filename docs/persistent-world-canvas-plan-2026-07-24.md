# Persistent World Canvas — kill the reload-on-return loading screen

**Last Audited:** 2026-07-26 — P1c implementation and in-scope leak fixes are complete; the named Three r185 WebGPU residual is accepted under the binding v4 calibrated gates, with fresh serial verification in progress.

**v2.1 — 2026-07-24. Round 1 Codex review: REWORK (12 findings, all folded in
below). Round 2 Codex convergence: all 12 ADDRESSED, verdict
APPROVE-WITH-CHANGES — both required text edits applied (P0a isolation clause;
per-phase acceptance loops). Status: PLAN CONVERGED with Codex, awaiting
founder approval to execute. No code written.**

Codex round-1 full output: session scratchpad `codex-review-output.log`
(232k tokens spent; findings 1–12 referenced inline as [C#]).

## Problem (founder's question)

Leaving the Cove, Kelp Forest, or Reef Race back to `/game` replays the full
loading screen — the same cold boot as first visit. The cove-exit 90% freeze
(hotfixed by the `3f0dd4c3` watchdog) was a symptom of this architecture: every
return remounts the whole ready-flag handshake, and remount races are what broke.

## Current architecture — corrected facts [C2]

- `/game` → `World3DCanvas`: async gl factory → `WebGPURenderer` (WebGL2
  fallback; **Iris Xe runs `forceWebGL: true` by default** — WebGPU only via
  `?webgpu=1`).
- `/cove` → `CoveCanvas`: **plain R3F WebGL renderer config, NOT the async
  WebGPU factory** — migrating cove into a shared WebGPU canvas is a renderer
  BACKEND CHANGE for cove content on capable devices → needs a compat spike.
- `/kelp` → `KelpRealmCanvas`: its **own** async `WebGPURenderer` with init
  timeout, uncaptured-error detection, session WebGL fallback, device-loss
  handling, canvas-adoption watchdog — a stronger health/recovery policy than
  the world's, which must be CONSOLIDATED (not dropped) on migration.
- `/arena` → `Arena3DCanvas` is just another `World3DCanvas` mode already.
  **Reef Race lives under `/activity/[activityId]/[roomId]`**, not `/arena`.
- Route crossing = canvas unmount → WebGPU/WebGL context destroyed → return =
  cold reboot (context init + full GPU re-upload + full pipeline recompile
  behind SeaLoadingScreen; only download band is cached).
- `useWorldStream()` belongs to `/game`: route unmount closes SSE, stops the
  5 Hz position upload, leaves the room, clears players. Arena separately opens
  `useNpcStream()`.
- World texture baseline: ~491 MB measured, compression work targeting ~250 MB
  (`docs/perf-p1b-texture-vram-spec-2026-07-14.md`).

## Decision

**One persistent full-viewport Canvas in a Next.js App Router route-group
layout, with per-scene lifecycle slots inside it.** Sibling client navigation
inside the group never destroys the Canvas or the GPU device; scenes activate/
deactivate in slots. Returns become a fade (capable devices) instead of a
loading screen. Codex confirms the mechanism: Next 16 preserves shared layouts
across sibling client navigation; `force-dynamic`/searchParams don't remount a
layout; keep the Canvas directly in the layout, never under a keyed
`template.tsx` subtree [C1].

### Route map — explicit manifest, not whole directories [C1]

Only the INTERACTIVE 3D pages move into `app/(world)/`:

| Route | Scene slot |
|---|---|
| `/game` | `world` |
| `/cove` (page.tsx only) | `cove` |
| `/kelp` (page.tsx only) | `kelp` |
| `/arena` | `world` (presentation mode — already same canvas) |
| `/activity/[activityId]/[roomId]` (Reef/Bumper) | `activity` (Phase 4) |

`/cove/history`, `/cove/verify`, poker sub-pages, arena debug pages stay
OUTSIDE the group (no canvas). The caching purpose of the existing
`game/layout.tsx` is preserved (nested or promoted to the group layout).
Hard reloads, leaving the group, and layout-level error recovery still cold
boot — that is acceptable and expected.

## Core contracts (the load-bearing design, all Codex-required)

### 1. Per-scene lifecycle state machine [C3]

Each slot: `unrequested → loading → warming → ready → resident | evicted |
error`, with **generation-tokened readiness acknowledgements** so abandoned
Suspense work can never mark a stale request ready. One stage-level warmup
scheduler replaces the canvas-global `WorldWarmup` capture of scene/camera/gl.
The `__W3D_*` window flags are retained ONLY as first-world-boot diagnostics.
The loading screen keys off Canvas/scene GENERATION, not route-page mount —
this deletes the entire stranded-ready bug class (SeaLoadingScreen's
mount-time flag re-zero currently recreates it under a persistent canvas).

### 2. Transition state machine owned by the persistent layout [C4]

`SceneTransition`'s fire-and-forget `router.push` + destination-owned fade-in
is insufficient. The layout owns one state machine:

`fade black → navigate/request slot → await (matching route generation AND
scene ready AND camera installed AND first controlled frame) → fade in`

with timeout/error handling and stale-request cancellation (rapid navigation,
browser back/forward).

### 3. Auditable pause discipline — a scene scheduler, not `visible=false` [C5]

`visible={false}` only suppresses rendering; `useFrame`, controls, keyboard
listeners, timers, network effects, mixers, spring bones, DOM projection, and
store writes all continue. Replace scattered boolean checks with
`useSceneFrame(sceneId, callback)` — a scheduler that only runs callbacks for
the active slot. Explicitly gated per slot: camera + controls, keyboard/pointer
+ raycast ownership, mixers/spring bones/particles/NPC interpolation/DOM
labels, timers/observers/subscriptions/store writes.

**Automated hidden-scene probe (CI-able):** across 100 transitions, assert
zero hidden-slot callback work, zero camera/store mutation from hidden slots,
zero listener growth.

### 4. Resource ownership before any eviction [C6]

three r185 WebGPU backend handles `texture.dispose()` correctly (bind groups
invalidated, `needsUpdate` + `initTexture()` recreates) — BUT
`vrm-loader.ts` deliberately shares canonical textures across instances, so
"dispose everything reachable from the world" can dispose a texture the cove
still uses. Therefore:

- **Initial low-end fallback: keep the Canvas/device alive but UNMOUNT AND
  DISPOSE the inactive world subtree** (low-end keeps ~today's return cost
  minus context init; capable devices get instant returns).
- Texture-only eviction ships LATER, after slot ownership/refcounts land and
  backend soak tests pass. Evict only inactive-exclusive textures; preserve
  CPU sources/mipmaps; exclude shared, dynamic, render-target, depth,
  video/canvas, and source-less generated textures.

### 5. Named `worldPresencePolicy` [C7 — product decision for founder]

Moving `useWorldStream` into the persistent layout changes server semantics:
a Cove visitor's avatar would stay present in the world (no idle-despawn), the
downlink keeps parsing snapshots, and the Arena path can double-subscribe via
`useNpcStream`. The policy must define: downlink open or closed while in a
sub-scene; uploads stopped vs a low-rate location heartbeat; how "in
Cove/Kelp/activity" is represented to other players; identical semantics for
human-controlled and autonomous agents. One stream owner, route-aware.
**Default proposal: body stays present, tagged "at the Cove"; uploads drop to
a low-rate heartbeat; despawn timer paused while any group route is active.**
Server-side `AGENT_BODY_IDLE_DESPAWN_MS` review is in-scope for Phase 1.

### 6. Central camera + slot-scoped environment [C8]

`state.set({ camera })` is safe with the async factory. One stage coordinator
owns persistent per-scene camera objects: installs the active camera while the
screen is black, updates aspect/projection, rebinds controls, preserves each
camera's pose. `makeDefault` only if exactly one camera component can ever be
mounted. Background, fog, environment, clear color, shadow policy,
postprocessing, and event ownership are all slot-scoped.

### 7. VRAM: resource ledger + real-device tests, no invented ceilings [C9]

Iris Xe is unified-memory with no reliable browser VRAM allowance, and
`renderer.info.memory.textures` is a count, not bytes. Build a byte-accurate
resource ledger and gate tiers on repeated real-device transition tests on the
Iris Xe floor. World-resident-during-cove is plausible (~250–491 MB world
textures) but must be PROVEN, not assumed.

### 8. Leak audit is a release gate [C10]

Route-level teardown currently masks ownership errors (e.g. cove clones
materials without cloned-material cleanup; R3F doesn't auto-dispose beneath
arbitrary `<primitive>`). Before cove rollout: audit every primitive/clone
dispose path, then require 50–100 game↔cove loops with PLATEAU (no growth) in:
renderer textures/geometries/render-objects/pipelines, canonical VRM refs, JS
heap, listener counts, ancillary canvas contexts (incl. slot-reel modals).

### 9. Device-loss / background / mobile release gates [C11]

Consolidate kelp's stronger recovery policy into the shared stage: WebGPU
device-loss + repeated uncaptured-error recovery; WebGL
`contextlost/contextrestored`; bounded stage recreation or WebGL fallback
without reload loops; `visibilitychange/pageshow` input clearing + delta reset
+ resize/camera resync + one invalidation. Test matrix: iOS Safari WebGL,
Android Chrome, bfcache, 5-minute background tab, memory pressure.

## Phasing + estimates (Codex-revised [C12])

| Phase | Scope | Est. |
|---|---|---|
| **P0a** | Persistent empty stage: route-group layout + manifest, camera coordinator, transition state machine proof (no real scenes yet). **P0a runs behind a development-only feature flag or synthetic route and MUST NOT mount the persistent stage alongside any live route-owned Canvas. The production manifest cutover occurs atomically with the first real scene migration in P1.** | 1–2 days |
| **P0b** | Backend compat spikes (cove-on-WebGPU, kelp health-policy consolidation), byte-accurate resource ledger, hidden-work instrumentation + probe harness | 1–2 days |
| **P1** | Cove in the stage: per-scene lifecycle, presence policy, leak soak (50–100 loops), staging + founder eyes | 5–8 days |
| **P2** | Arena as a world presentation mode (already same canvas) | ~1 day |
| **P3** | Kelp (after renderer-health consolidation) | 2–3 days |
| **P4** | Reef Race / Bumper activities (authoritative networking + postprocessing) | 3–5 days per activity |
| Later | Low-end exclusive-texture eviction, only after measured retention results | — |

Docs (`3dStructure.md` camera/perf sections, `GameFeatures.md` mode flow,
`ARCHITECTURE.md` if routes/streams change) update in EACH phase's diff, not a
final cleanup phase. Every phase runs its applicable migrated-route loop: P0a
synthetic transitions; P0b compatibility and harness gates; P1 game↔cove; P2
game↔arena; P3 game↔kelp; P4 game↔activity. Unmigrated routes receive
no-regression smoke tests, but the <1 s fade target begins only when that route
enters the persistent stage. All loops run via `bun run build && bun run start`
on the Iris Xe desktop in a real browser, FPS floor ≥ current 40–45; staging
deploy + founder sign-off before each promotion.

## Execution model

Per founder model-allocation rule: **Fable plans (this doc) · Codex implements
(per phase, with the spec excerpts as the task brief) · Fable reviews** each
phase diff + drives the browser verification on the Iris Xe floor. 3da is
consulted for stage/camera/scene-graph review points (Rule E3 collaboration).

## Execution ledger (updated per sub-phase — documentation mandate 2026-07-25)

| Slice | State | Evidence |
|---|---|---|
| Plan v2.1 | CONVERGED (Codex R1 REWORK → R2 APPROVE-WITH-CHANGES, edits applied) | this doc; codex-review logs in session scratchpad |
| P0a — persistent stage, synthetic proof | DONE `6e95b9dc` | `docs/world-stage-p0a-{brief,notes}.md`; browser-verified: canvas mounts=1, hidden slot frozen, rapid-click storm clean |
| P0b — cove spike + health policy + ledger + probe | DONE `3e01cac6` | `docs/world-stage-p0b-{brief,notes}.md`; cove VERDICT COMPATIBLE (0 material fixes); probe PASS both backends (100/100, 0 violations, ~1.2% heap); cove ledger 27.1 MiB |
| P1a — world onto the stage behind `(world)` group (parity cutover) | DONE — reviewer-verified locally; staging checkpoint next | `docs/world-stage-p1a-{brief,notes}.md`; build+tsc 0; probes 102/102 both backends (re-run post-review); `/game` no-store header; reviewer browser drive: world+NPCs+HUD live on stage, ~58 FPS dev box, pointer layering correct (HUD clicks + canvas hits), `/game`↔`/perf/stage` round trip clean, `/arena` legacy smoke OK; review fix: stage DPR corrected to live constants [0.55,0.7] (brief carried stale doc value) |
| P1b — cove joins the stage; returns become fades | DONE — reviewer-verified locally; staging next | `docs/world-stage-p1b-{brief,notes}.md`; build+tsc 0; ALL THREE probe lanes PASS on final build (synthetic WebGPU + WebGL 102/102; real-route 30 game↔cove round trips, canvas mounts 1, zero hidden violations, heap +12.5% <15% gate); reviewer drive: cove renders in stage, Back-to-World return = fade with SeaLoadingScreen NEVER mounting, deep-link /cove loads zero world assets, /cove/history canvas-free; 2 blocking review findings fixed in-slice (world-label bleed via scene-scoped label registry; useSceneFrame priority support for -100 controllers); known P1c items: first-navigate cold-boot fallback, dual interior GLB download, route-lane heap watch |
| P1c — streams/presence policy to layout + leak soak + staging promotion | FINAL GATE IN PROGRESS — implementation + in-scope leak fixes complete; named Three r185 WebGPU `bindGroups`/`Backend.data` residual accepted under v4 calibrated gates | `docs/world-stage-p1c-{brief,notes}.md`; exact inventory/count/history/listener/route/network/freeze gates retained; WebGPU bytes capped at +1%; 60-loop forced-GC heap capped at 0.8 MB/loop second-half slope and +20% total; game/Cove dwell capped at 0.05 MB/s |
| P1c tracked follow-up | TRACKED — trigger on the next three.js upgrade to r186+ or P3, whichever comes first | Re-measure the renderer `bindGroups` growth against upstream lifecycle fixes and fold renderer-cache eviction into the planned low-end texture-eviction tier |
| P2 arena / P3 kelp / P4 activities | pending | — |

P1 is deliberately split into P1a/P1b/P1c: the 5–8-day estimate is too large for
one implementation pass; each sub-slice is independently verifiable and
committed. Presence-policy default (founder, 2026-07-25): body stays in world,
tagged "at the Cove"; low-rate heartbeat; despawn paused while in group —
goes live in P1c.

## What this buys

- Cove/kelp/arena returns: loading screen GONE on capable GPUs (fade only);
  low-end initially unchanged on return cost, later improved by eviction tier.
- The 90%-hang bug class structurally impossible on returns (no remount, no
  flag race).
- Presence continuity: the agent's body stays live in the world while its
  human is at the tables (metaverse premise upheld) — pending founder's call
  on the presence policy defaults.
