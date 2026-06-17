---
title: Game-Dev Skill Suite — ClawVille applicability and overrides
category: reference
tags: [skill-suite, overrides, clawville, game-dev, 3d-generator, image-generator, audio-generator, aaa-graphics, debug-profiler, game-ui, gameplay-systems, qa-release, game-director]
date: 2026-06-17
confidence: high
threejs_version: r182
---

## Summary
Catalog of 8 new game-dev skills, when to reach for each in ClawVille, and which ClawVille invariants hard-override each skill's generic advice.

## Precedence Header

**These are GENERIC game skills aimed at vanilla Vite/TypeScript/Three.js projects. In ClawVille, the authority stack is:**

1. **Current source code** (compiler sees it; code wins over everything)
2. **Four canonical docs** — `WorldContent.md`, `3dStructure.md`, `GameFeatures.md`, `ARCHITECTURE.md` — same-diff update contract
3. **`CLAUDE.md` invariants** (kill-the-build rules, staging-first push, Iris Xe bans)
4. **This threejs memory** (advisory, session-to-session learning)
5. **These generic skill files** (lowest authority — adapt, never blindly apply)

If a skill's generic advice conflicts with any higher layer, the higher layer wins. Update the memory entry if you find the conflict so the next session doesn't re-learn it.

---

## Skills

### threejs-3d-generator (Tripo text/image→3D)

**Purpose:** Generate textured, rigged, animated 3D assets (GLB/FBX) via Tripo API. Supports text-to-3D, image-to-3D, auto-rigging, retargeting, stylization, conversion.

**When to use in ClawVille:** Generating NEW PROPS, environment BUILDINGS, or decorative objects only. Never for characters.

**ClawVille HARD OVERRIDES:**
- **Characters/VRM are FORBIDDEN via Tripo.** ClawVille characters are VRM 1.0 via `@pixiv/three-vrm` 3.5.x. The character pipeline is `fal Meshy v6 HQ` + Blender (`blend007`) + `scripts/hermes-pipeline/` scripts — NOT Tripo. Tripo's humanoid rig outputs an incompatible skeleton; retargeting to VRM humanoid is a dead end that has already been attempted and failed.
- **Show Gemini turnarounds for user approval BEFORE running any paid Tripo mesh gen** — `feedback_pause_for_turnaround_approval` memory rule. Meshy/Tripo is paid; bad mesh wastes credits and wrecks Mixamo auto-rig.
- **Generated GLBs must pass the Iris-Xe draw-call/tri budget**: target ≤ 100 draw calls total (world scene); single prop should add ≤ 2 draw calls. Check `3dStructure.md §5` for current GPU budget.
- **Any downloaded GLB must go through the ClawVille GLB normalization pipeline**: `max(X,Y,Z)` bbox normalization (`targetMaxDim` in `BUILDING_MODELS`), `stripGroundPlanes`, `stripDecorativeMeshes`, pivot offset correction, `frustumCulled=false` on all SkinnedMesh descendants — see `patterns/building-maxdim-normalization.md` + `gotchas/building-glb-pivot-offset-far-from-scene-origin.md`.
- **Cache-bust rule:** any new GLB placed at a stable URL must carry a `?v=N` query in every reference (Cloudflare edge cache TTL 7 days; deploy token has no `cache_purge` scope). See `3dStructure.md §6f rule 9`.
- **Do NOT call the Tripo API from client-side game code.** Generation is a tooling step; outputs are committed as static assets in `apps/web/public/models/`.
- **Same-diff doc update**: adding/swapping a building or prop GLB triggers `WorldContent.md` (§2 buildings or §5 decorations) + `3dStructure.md` (§2 building scale/pivot or §9 asset compression) update in the same commit.

---

### threejs-image-generator (Gemini concept/texture/decal/GUI art)

**Purpose:** Generate 2D images (concept art, textures, decals, logos, GUI panels, sky/background plates) via Gemini image API. Also supports image editing (style variants, palette cleanup).

**When to use in ClawVille:** Pre-generation concept references, texture/material references for terrain or building surfaces, UI decals, in-world signage textures, sky/atmosphere references. Fine for ClawVille's GUI art (React/Tailwind land).

**ClawVille HARD OVERRIDES:**
- **GEMINI_API_KEY is now FULLY UNUSED in the ClawVille runtime** (decommissioned 2026-06-05; moved to OpenAI for both text and embeddings). The API key referenced by this skill (`GEMINI_API_KEY`) is NOT the same as the runtime LLM key. However, if the image generator still uses `GEMINI_API_KEY` for image gen specifically, it may still be set — verify before reporting "unavailable."
- **Never call the Gemini image API from browser/game code.** Generated images are tooling outputs committed as static assets.
- **Show generated concept images to the user for explicit approval BEFORE handing them to threejs-3d-generator for image-to-3D** — `feedback_pause_for_turnaround_approval` memory rule.
- **Texture files for ClawVille go to `apps/web/public/`** (model textures embedded in GLB) or referenced by material code in `apps/web/src/lib/three/`. Do not drop raw PNGs as loose runtime-fetched assets without compression planning.
- **Cache-bust**: mutating a texture at a stable URL without a `?v=N` bump is a 7-day regression. Same rule as GLBs.
- No same-diff doc update required for texture/concept PNGs that aren't mounted as world objects. If a texture changes a visible surface listed in `WorldContent.md`, update it.

---

### threejs-audio-generator (ElevenLabs SFX/ambience/voice)

**Purpose:** Generate game-ready audio (SFX, ambience loops, TTS announcer lines, voice conversion/cleanup) via ElevenLabs. Includes Web Audio runtime integration guidance.

**When to use in ClawVille:** Generating new SFX, ambient sea/world atmosphere, building-specific ambience, UI confirmation sounds, character voice lines for Nori the Town Guide or building residents.

**ClawVille HARD OVERRIDES:**
- **Never put `ELEVENLABS_API_KEY` in browser code.** Audio generation is a local tooling step; outputs are committed as static files under `apps/web/public/audio/` (create this dir if absent).
- **Web Audio `AudioContext` requires a user gesture to unlock** — this is a browser rule, not optional. ClawVille's world already has a click-to-start surface; audio context must be created/resumed from that gesture handler, never on module load.
- **Iris Xe has no audio impact** — Web Audio is CPU-side and does not touch the GPU pipeline. Safe to add without GPU budget concern.
- **Audio files ARE subject to the same asset cache-bust rule**: if you update an audio file at a stable URL path, bump `?v=N` in every `<audio src>` or `fetch()`/`AudioContext.decodeAudioData` reference.
- **No same-diff doc update required for purely cosmetic SFX additions.** If audio introduces a new gameplay mechanic or changes how a feature works (e.g. audio cue gating a quest step), update `GameFeatures.md` same-diff.

---

### threejs-aaa-graphics-builder (art-direction upgrade + asset sourcing)

**Purpose:** Upgrade visuals from prototype to premium. Owns art direction critique, model/material/VFX/render polish, external asset sourcing decisions, visual scorecard gating.

**When to use in ClawVille:** Visual polish passes, addressing "looks basic" feedback, upgrading a specific scene (Cove interior, activity rooms, world terrain). Not for structural rendering architecture changes (those are code + `3dStructure.md` changes).

**ClawVille HARD OVERRIDES — these DIRECTLY CONFLICT with the skill's AAA ambitions:**
- **Iris Xe is the performance floor. AAA post-stacks and many-light setups are BANNED:**
  - NO drei `<Text>` / `<Billboard>` in any game/world scene — hard GPU crash.
  - NO `InstancedMesh + ShaderMaterial` anywhere — silent WebGPU crash.
  - NO per-frame `new Vector3()` / `new Matrix4()` etc. in `useFrame` — GC thrash at 60Hz.
  - NO more than hemisphere + 1 directional no-shadow light in the world scene — 7+ point lights crashed Iris Xe context (see `gotchas/point-lights-iris-xe-gpu-saturation.md`).
  - Vegetation MUST use `MeshBasicMaterial`, never `ShaderMaterial` — see `gotchas/seaweed-meshbasic-webgpu.md`.
- **Performance is ClawVille's #1 priority** (set 2026-06-02): desktop browser load-time + sustained FPS (target 80, floor 60 on Iris Xe) come BEFORE new visual scope. Any "AAA" upgrade that drops FPS below 60 on Iris Xe is rejected.
- **The skill's "build authored forms before adding glow" core rule is CORRECT and compatible** — follow it. Primitives with glow are explicitly banned.
- **The skill's visual scorecard categories** are useful reference but must be adapted: no post-processing stack beyond what `3dStructure.md §4/§5` already documents as safe. Check current GPU budget there before adding effects.
- **VFX must use MeshBasicMaterial or TSL NodeMaterial** on the WebGPU path. Plain `ShaderMaterial` on vegetation or instanced objects is the Iris Xe crash pattern.
- **Same-diff doc update**: any visual change that affects a listed scene object, lighting config, fog, or atmosphere triggers `3dStructure.md` update; any new visible world object triggers `WorldContent.md`.

---

### threejs-debug-profiler (draw calls/tris/memory/shader cost/mobile DPR)

**Purpose:** Debug blank canvas, runtime crashes, loading failures, animation bugs, resize issues, mobile input problems. Profile FPS, draw calls, triangles, texture memory, shader cost, bundle size.

**When to use in ClawVille:** Any time the scene is wrong (blank/blue, GPU crash, NPC T-pose, building missing), FPS drops below target on Iris Xe, or a mobile layout regression is suspected.

**ClawVille HARD OVERRIDES — the profiling methodology is project-specific:**
- **For FPS/freeze/jank profiling, drive the chrome-devtools MCP `performance_*_trace` against the user's REAL Iris Xe profile.** `claude-in-chrome` CANNOT profile the RAF game (hidden tabs throttle to 0Hz). If chrome-devtools MCP is disconnected, say so and ask to reconnect — do NOT silently fall back. Memory entry: `feedback_use_chrome_devtools_mcp_for_profiling`.
- **MCP screenshots CANNOT capture the WebGPU swapchain.** Verify rendering via `gl.render` count, `scene.traverse`, NPC DOM labels, `__W3D_READY` flags. Hand actual pixels to the user. Memory entry: `feedback_mcp_cannot_capture_webgpu_swapchain`.
- **Blue `/game` screen has THREE known causes** (see `feedback_webgpu_blue_screen_double_render_and_first_paint.md`): (1) second `gl.render` clobbers swapchain; (2) WebGPU async factory pre-configures swapchain; (3) `camera.aspect=0` NaN projection on WebGL2 (the Iris Xe path, reproduced via CDP 6× CPU throttle). Diagnose before applying any generic "blank canvas" fix.
- **A fresh isolated guest tab is the correct repro baseline** for `/game` blue-screen investigations — a stuck persistent guest with an off-map saved position shows "water" (blue), not a render regression. See `feedback_blue_game_test_fresh_guest_first`.
- **`bun run dev` is BANNED for local testing.** Use `bun run build && bun run start` on `:3000`. `bun run dev` with HMR crashes the WebGPU scene on Iris Xe → PC restart.
- **Coolify deploy ≠ live.** Verify deploys by reading the container (`docker exec <app> env | grep SOURCE_COMMIT`), not the queue. Queue rows can read "finished" while the container flip silently failed.
- The skill's generic "reproduce locally → baseline → one optimization at a time → re-measure" workflow is fully correct and compatible.

---

### threejs-game-ui-designer (HUD/menus/touch UI/safe-areas)

**Purpose:** Design premium game UI: HUDs, menus, overlays, pause/win/lose screens, touch controls, safe areas, responsive layout, typography, UI/world cohesion.

**When to use in ClawVille:** Adding or modifying any HUD element, building-entry prompt, chat modal, leaderboard overlay, mobile joystick, tutorial overlay, or in-world label.

**ClawVille HARD OVERRIDES — mobile/iPad detection is project-specific and has bitten us repeatedly:**
- **ALWAYS use `useIsMobile()` hook** (`maxTouchPoints > 1` + coarse-pointer) for mobile/desktop gating. NEVER a bare Tailwind `md:` / `max-width` media query — those miss iPad Air/Pro/landscape, which is the exact bug that shipped covered joysticks (see `feedback_ipad_detection_maxtouchpoints`). Memory entry: `[[feedback_ipad_detection_maxtouchpoints]]`.
- **MANDATORY mobile + iPad viewport sweep before "done"**: 390×844 phone, 744×1133 iPad mini, 820×1180 iPad Air, 1024×1366 iPad Pro — portrait AND landscape (swap w/h). Per size: (a) both joystick zones visible + NOT covered; (b) no two fixed/absolute elements overlapping; (c) tap targets ≥44px; (d) any modal fits + is dismissable.
- **NO dark text on dark panel**: inside `.claw-panel` (rgba(10,22,40,0.92) navy) or any dark-bg modal/toast/HUD, NEVER use Tailwind `text-gray/slate/zinc/neutral/stone-700/800/900` — they are < 2:1 contrast and invisible. Light tokens only (cyan-50, slate-100/200, white). Memory entry: `feedback_no_dark_text_on_dark_panel`.
- **drei `<Text>` / `<Billboard>` are BANNED in any game/world scene** for in-world labels (Iris Xe hard crash). Use `drei <Html>` for NPC labels and speech bubbles, OR the `WorldLabelsOverlay` module-scope DOM overlay (see `patterns/world-labels-overlay.md`) — both are Iris Xe safe.
- **ClawVille UI is React/Tailwind**, not a canvas-drawn overlay framework. The skill's generic guidance about Three.js canvas text overlays does NOT apply here; use React components.
- **Safe-area caveat**: devtools has NO `env(safe-area-inset-*)`, so bottom-anchored elements using safe-area math CANNOT be fully verified in emulation. State this to the user; do not claim verified from devtools alone.
- **Same-diff doc update**: if the UI change has a player-facing flow effect, update `GameFeatures.md`.

---

### threejs-gameplay-systems (Vite scaffold + game loop/entity/input/collision)

**Purpose:** Build and iterate a playable game loop. Includes first-playable scaffold creation, architecture, mechanics, entity systems, input, collision/physics, scoring, camera, game feel.

**When to use in ClawVille:** Architecture/design patterns for game-feel tuning, entity system design, input handling, camera controllers, collision trigger logic, scoring and objective systems. Take the PATTERNS and PRINCIPLES; discard the Vite scaffold.

**ClawVille HARD OVERRIDES:**
- **The scaffold command (`create_threejs_game.py ./my-game`) is INAPPLICABLE in ClawVille.** ClawVille is a Next.js 16 App Router + React-Three-Fiber + Zustand + TanStack Query monorepo deployed on Hetzner+Coolify. It is NOT a Vite/standalone game. NEVER run the scaffold creator inside the ClawVille repo.
- **Game loop = R3F `useFrame` + `THREE.Clock.getDelta()`**, not a standalone `requestAnimationFrame` loop. Entity state lives in Zustand stores, not module-scope classes.
- **Input system**: the ClawVille world uses a module-scope `keyState` map + event listeners attached in `useEffect` cleanup. New input paths must follow this pattern (see `gotchas/keyup-not-fired-on-window-blur.md` for the required `window.blur` + `visibilitychange` reset).
- **Physics**: Rapier and cannon-es are NOT used in ClawVille. Collision is custom arcade-style (terrain raycasting via `IntersectObject`, NPC waypoint pathfinding, building proximity detection). Do not add a physics engine without explicit user approval and a performance audit.
- **Camera controllers** follow documented patterns in `3dStructure.md §3`. New controller types must not introduce per-frame allocations — use module-scope scratch `Vector3` / `Matrix4` refs. See `performance/perf-sweep-2026-04-21.md`.
- **Zustand over local state for game entities.** `useState` in component hot-paths causes re-render storms. See `performance/zustand-re-render-storm-fixes.md`.
- **`lil-gui`** is fine for dev-only tuning but must be gated behind a dev flag and never committed to production.
- The skill's core architecture principles (clear ownership, deterministic update order, allocation-free hot paths, incremental playable slices) are CORRECT and directly applicable.
- **Same-diff doc update**: any new game mechanic, camera mode, or control system update goes in `GameFeatures.md` (if player-facing) + `3dStructure.md §3/§6` (if it changes rendering/camera behavior).

---

### threejs-qa-release (playtest QA, prod build, base paths, screenshots)

**Purpose:** Verify game works as a player encounters it and prepare a shippable browser build. Includes playtest QA, mobile/responsive checks, production builds, canvas-pixel verification, console checks, release risk reports.

**When to use in ClawVille:** Before merging any feature branch to staging, after visual changes, after deploy to verify Coolify build landed correctly.

**ClawVille HARD OVERRIDES — the deployment and QA flow is fully project-specific:**
- **Staging-first push flow (MANDATORY):** `git push origin staging` → verify on `staging.clawville.world` + `api-staging.clawville.world` → open PR `staging → master` via `gh pr create --base master --head staging` → merge → Coolify auto-deploys prod. NEVER push directly to `master` unless the message contains literal `direct to master`. Memory entry: `feedback_staging_first_push_flow`.
- **"Vite preview / static hosting base path"** advice from the skill is INAPPLICABLE. ClawVille deploys via Coolify on Hetzner — Next.js production build + Bun runtime. The local test command is `bun run build && bun run start` (prod bundle on :3000). NEVER `bun run dev` (Iris Xe crash → PC restart). Memory entry: `feedback_local_testing_bun_run_start`.
- **MANDATORY browser verification after every deploy:** wait for Coolify (~3–5 min) or `curl -sS --ssl-no-revoke https://api.clawville.world/health`, then open `https://clawville.world/game`. Check: buildings visible, camera zoom, player spawns at center, FPS > 50, no console errors.
- **MANDATORY mobile + iPad sweep after every UI/UX change** (see threejs-game-ui-designer overrides above). Desktop-only checking is the #1 source of repeat regressions.
- **Curl on Git Bash uses schannel** — always pass `--ssl-no-revoke`.
- **"Finished" in the Coolify queue ≠ live.** Verify by reading the CONTAINER: `docker exec <app-container> env | grep SOURCE_COMMIT` must equal the pushed sha. See `feedback_coolify_deploy_flakiness`.
- **Double-queued builds:** every push may create duplicate `ApplicationDeploymentQueue` rows. Cancel the duplicate same-commit row to avoid wasted server cost. See CLAUDE.md deploy section for the full rule.
- The skill's canvas-pixel verification workflow (checking for non-blank canvas, console errors, main input path) maps directly to ClawVille's `__W3D_READY` flag check pattern. Use it.
- **Push-auth fallback chain before escalating to user:** `gh auth status` → `unset GITHUB_TOKEN && gh auth setup-git` → SSH remote → `gh` CLI. Only escalate with all errors quoted.

---

### threejs-game-director (orchestrator for building/iterating a whole game from scratch)

**Purpose:** Primary entrypoint for COMPLETE game creation (new Vite game from scratch), premium iteration, and automatic phase orchestration across all sibling skills (gameplay, AAA graphics, UI, debug, QA, asset generation).

**Decision: DO NOT add to 3da.md frontmatter skills list.**

**Reasoning:** `threejs-game-director` is designed to build a complete game from scratch or run as the top-level orchestrator for a standalone game project. ClawVille is already a fully-architected, live, multi-subsystem Next.js+R3F game with 10+ players/agents online. Running the game-director's "full build" orchestration loop in ClawVille would:
1. Attempt to scaffold a new Vite project inside an existing Next.js monorepo (category error).
2. Re-run the "external asset sourcing ledger / credential probe / visual scorecard from scratch" gates that are irrelevant for incremental 3D changes in an existing product.
3. Load all sibling skills unconditionally on every 3D work task, burning context on irrelevant reference files.

**Limited legitimate use:** The game-director can be consulted as an INDEX to identify which sibling skill to reach for for a given concern (gameplay feel → threejs-gameplay-systems patterns; visual polish → threejs-aaa-graphics-builder patterns; etc.). It is documented here but NOT listed in the 3da.md `skills:` frontmatter so it does not auto-load on every session.

**If you need an orchestration layer in ClawVille**, use the ClawVille-specific CLAUDE.md teams section (which specifies 3da manager-of-managers, not game-director), and the `.claude/workflows/` runbooks.

---

## Quick-Lookup Override Table

| Skill | Applies to ClawVille as-is? | Primary Override |
|---|---|---|
| threejs-3d-generator | Partially (props/buildings only) | Characters = VRM via blend007+Meshy, NOT Tripo |
| threejs-image-generator | Yes | Gemini runtime key unused; show turnarounds before paid gen |
| threejs-audio-generator | Yes | Web Audio gesture unlock; no API key in browser code |
| threejs-aaa-graphics-builder | Partially (principles only) | Iris Xe bans block most AAA post-stacks; perf > visual scope |
| threejs-debug-profiler | Partially | Use chrome-devtools MCP for real Iris Xe profiling |
| threejs-game-ui-designer | Partially | useIsMobile() hook mandatory; viewport sweep mandatory; no dark-on-dark |
| threejs-gameplay-systems | Patterns only | No Vite scaffold; R3F+Zustand not standalone loop; no Rapier |
| threejs-qa-release | Partially | Coolify deploy flow; bun run start not vite preview |
| threejs-game-director | Index only (not in frontmatter) | Full orchestration inapplicable to live Next.js game |

## Context
Written 2026-06-17 when the game-dev skill suite was installed into ~/.claude/skills/. These 8 skills are generic Vite/standalone Three.js game skills; ClawVille deviates significantly in stack (Next.js+R3F+Zustand), GPU target (Iris Xe), deploy (Hetzner+Coolify), character pipeline (VRM+blend007), and profiling methodology (chrome-devtools MCP + real Iris Xe). Every override in this file is backed by a memory entry or CLAUDE.md invariant.
