# Phase 1 — /create-agent 3D swap + connect-modal rename

**Status:** PLANNING — orchestrator scope doc. 3da extends this with 3D
implementation specifics (render strategy, GLB preload plan, Iris Xe
compile-spike mitigation) before writing code.
**Date:** 2026-04-16
**Orchestrator:** Claude (opus 4.6 max effort)
**Implementer:** 3da subagent (required — component sits under
`apps/web/src/components/three/`)

---

## 1. Goal

Ship a `/create-agent` page that:

1. **Uses 3D GLB avatars** instead of emoji text, by wiring the existing
   `SelectAgentCanvas` into the page and removing the emoji grid and
   emoji-preview placeholder.
2. **Exposes four agent-framework categories** as tabs: `OpenClaw`,
   `Hermes`, `Milady`, `Other`. Each category lists the models from
   `MODEL_REGISTRY` that belong to it.
3. **Defaults the unconnected visitor to the `lobster` model** under the
   `OpenClaw` category. This matches the existing "lobsters as default
   crustacean" rule in memory (`feedback_lobster_faces_negative_z.md`).
4. **Defaults the agent harness selector to Milady + Eliza** — the user
   lands with a working autonomous-capable agent that will deploy cleanly
   in Phase 4a.
5. **Renames `openclaw-connect-modal` to `agent-connect-modal`** across
   the codebase. This is a user-visible naming correction: the modal
   supports every agent type today, not just OpenClaw.

Nothing in this phase writes to the database schema — Phase 2 handles
persistence. Phase 1 is a pure UI swap + rename, with sessionStorage
still bridging step 1 → step 2.

---

## 2. Non-goals

- **No new GLB asset sourcing.** We use only the 11 models already in
  `apps/web/public/models/` (and `models/characters/`). If the Milady
  category ends up visually thin, that is Phase 5+ work, not Phase 1.
- **No DB migrations.** Phase 2.
- **No character-export endpoint changes.** Phase 3.
- **No Milady install UX.** Phase 4a.
- **No hosted runtime scaffolding.** Phase 4b (deferred — see
  `AgentHosting.md`).
- **No removal of legacy OpenClaw-only code paths** beyond the rename.
  `identityType: 'openclaw'` in agent-gateway stays as-is. We are renaming
  the UI modal, not the API protocol.

---

## 3. Inventory — files in scope

| File | Change |
|---|---|
| `apps/web/src/app/create-agent/page.tsx` | Major rewrite — emoji grid out, 3D picker in. sessionStorage key grows from `{species, color, name, gender}` to `{modelKey, category, color, name, gender}`. |
| `apps/web/src/app/create-agent/personality/page.tsx` | Update preview block to render a small `SelectAgentCanvas` (or a pre-baked thumbnail) instead of the 120px emoji. Consume `modelKey`+`category` from sessionStorage. |
| `apps/web/src/components/three/SelectAgentCanvas.tsx` | Additive only. Expose a `category` prop for filtering the picker, add a `modelKey` → `category` lookup helper, confirm no scene contents change. 3da validates GPU budget unchanged. |
| `apps/web/src/components/game/openclaw-connect-modal.tsx` | Rename file → `agent-connect-modal.tsx`, rename component → `AgentConnectModal`, update header copy ("Connect Agent" stays; remove any "OpenClaw"-specific strings that still refer to the modal itself). |
| `apps/web/src/stores/game.ts` | Rename UI-scoped store fields: `openclawModalOpen` → `agentConnectModalOpen`, with setter renamed. **Keep** `openclawSessionId` / `openclawConnected` **only if** they currently represent the connected-agent-session regardless of identity type; if they do, rename to `agentSessionId` / `agentConnected`. 3da confirms this by reading the store. |
| every import site of the old modal | find + rename. Grep-driven, no missed sites. |
| `packages/shared/src/constants/pet-species.ts` | No change in Phase 1. Lobster-aliased species names stay for now — Phase 2 is where we remove them. |

**New file, if 3da recommends it:**
`apps/web/src/lib/three/agent-model-registry.ts` — extracted from the
inline `MODEL_REGISTRY` in `SelectAgentCanvas.tsx`, so the picker UI can
import it without touching the Canvas. 3da decides.

---

## 4. Category → model mapping — Phase 1 default

| Category | Models | Default | Notes |
|---|---|---|---|
| OpenClaw | lobster, crayfish, sweet_crab, lobster_plush, hermitcrab | **lobster** | Crustacean family, matches project's OpenClaw branding and memory `feedback_lobster_faces_negative_z.md`. |
| Hermes | chihiro | chihiro | Anime-style. Reduced from 3 → 1 to give Milady category real content. |
| Milady | priestess, chibi_goku | priestess | Shares anime-style pool with Hermes but distinct subset. Matches Milady's aesthetic. Flagged as placeholder — new Milady-branded GLBs can replace these later. |
| Other | jellyfish, octopus, seahorse | jellyfish | Sea-creature catch-all for users who don't identify with either framework. |

3da may revise this split if any of the models have load-time problems
or visual clipping on the pedestal that makes them unfit for the small
preview panel. The **OpenClaw=lobster default** is load-bearing and must
not move.

---

## 5. Agent harness selector — new UI control

Below the 3D preview and name/gender fields, add a single radio group:

```
Agent harness:
  ( ) OpenClaw (external gateway)
  ( ) Hermes
  (•) Milady (Eliza runtime)   ← default
  ( ) Custom / Other
```

Stored in sessionStorage as `harness: 'openclaw' | 'hermes' | 'milady' | 'custom'`.

The harness is independent of the visual category. A user can pick a
Hermes anime model with the Milady harness — that is fine and expected.
Phase 3 uses the harness to decide which export bundle format to emit.

The Milady default is the main product shift in this phase: new users
land with a Milady+Eliza agent by default, reinforcing Priority #1.

---

## 6. Rename scope — connect modal

### 6.1 File + component rename

- `apps/web/src/components/game/openclaw-connect-modal.tsx`
  → `apps/web/src/components/game/agent-connect-modal.tsx`
- Component: `OpenClawConnectModal` → `AgentConnectModal`
- Default export name updated to match.

### 6.2 Store rename decision

Store field rename only applies to **UI-scoped** fields. The back-end
`/api/agent/connect` session id is agent-identity-agnostic, so the
client-side session id field should be renamed for correctness.

Proposed store diff (3da to confirm against actual store file):

| Before | After |
|---|---|
| `openclawModalOpen` | `agentConnectModalOpen` |
| `setOpenclawModalOpen` | `setAgentConnectModalOpen` |
| `openclawConnected` | `agentConnected` |
| `openclawSessionId` | `agentSessionId` |
| `setOpenclawConnection` | `setAgentConnection` |

### 6.3 Global find-replace

Run `Grep` for every identifier in §6.2 before the rename. Every
consumer must update in the same commit. Any commented-out / legacy
reference stays as a plain `agent` too — no mixed-naming left behind.

### 6.4 What does NOT rename

- `/api/openclaw/register` (legacy endpoint, kept for backwards compat per
  `CLAUDE.md` §Agent Connection).
- `identityType: 'openclaw'` enum value — this is a protocol identity,
  not a UI concept.
- `openclawBots` table name in schema.
- `@clawville/app-clawville` plugin — product name, unrelated.

---

## 7. 3D implementation requirements (3da extension — 2026-04-16)

3da owns this section. The orchestrator's original constraints are preserved
as bullet 0 below; 3da's answers follow each topic heading.

### 7.0 Original constraints (unchanged)

1. No new InstancedMesh. No new ShaderMaterial. No new drei Text/Billboard.
2. Keep Canvas mounted across tab changes — swap `modelKey` prop only.
3. 3da chooses preload strategy.
4. 3da chooses canvas architecture (framed panel vs. full-background).
5. Keep existing OrbitControls limits.
6. Validate dispose fires on rapid tab switches.
7. Color palette decision optional.

---

### 7.1 Canvas architecture decision — REPLACE LandingScene, full-background SelectAgentCanvas

**Decision:** Remove `LandingScene` from `/create-agent` and mount
`SelectAgentCanvas` as the full-page background (`absolute inset-0 z-0`),
same position LandingScene currently occupies. The UI overlay (`z-10`) sits
on top, identical to the existing layout.

**Reasoning:**

Running two simultaneous R3F Canvases on Iris Xe is a hard no. LandingScene
creates a full WebGL context (shadows enabled, 60 coral/kelp instances, 60
bubble InstancedMesh, multiple directional lights, OceanFloor PlaneGeometry
with 60×40 segments). SelectAgentCanvas creates a second full WebGL context
(TSL node materials, UnderwaterAtmosphere, UnderwaterLightRays, EmberParticles,
SpotlightCone). Each context pays pipeline compile on first mount; together on
Iris Xe this reliably drops FPS below 30 based on prior ClawVille session
history.

SelectAgentCanvas already has its own underwater atmosphere (`UnderwaterAtmosphere`,
`UnderwaterLightRays`, `fog`, deep blue `scene.background`). The visual result
of keeping only SelectAgentCanvas is strictly better than the landing page ocean
scene — the user sees their chosen agent on an atmospheric pedestal, which is
exactly the right context for a creation screen.

LandingScene stays on `/login` and `/` where SelectAgentCanvas is not present.
It is removed only from `/create-agent/page.tsx`.

**Implication for page layout:** The existing wrapper structure is preserved:

```tsx
<div className="relative min-h-screen flex flex-col items-center px-4 py-8 bg-[#061520]">
  {/* SelectAgentCanvas takes the LandingScene slot */}
  <SelectAgentCanvas modelKey={selectedModel} color={selectedColor} />
  <div className="relative z-10 w-full flex flex-col items-center">
    {/* all UI */}
  </div>
</div>
```

SelectAgentCanvas already renders with `className="w-full h-full"` against its
container div. The container div must be `absolute inset-0 z-0` — same as
LandingScene's wrapping div today (line 298 of LandingScene.tsx).

The `SelectAgentCanvas` Canvas currently sets its own `scene.background`. The
bg-[#061520] on the outer div serves as a flash-prevention color before the
Canvas initializes — keep it.

---

### 7.2 Category switch strategy — keep Canvas mounted, swap modelKey prop

**Decision:** The Canvas is never unmounted. Category tabs are purely React state
(`selectedCategory`, `selectedModel`) that update `modelKey` passed as a prop.
`PlatformModel` is already `React.memo`'d and keyed by `modelKey` + `color` via
`useMemo` deps. A `modelKey` change triggers:

1. `useMemo` in `PlatformModel` recomputes `cloned` + animator — this is a new
   object reference, but the old clone is cleaned up by the `useEffect` cleanup
   that runs when `cloned` changes (line 306-318 of SelectAgentCanvas.tsx).

**Dispose validation — the actual sequence on rapid tab switch:**

```
Tab switch → selectedModel changes → PlatformModel re-renders with new modelKey
→ useMemo runs with new [scene, modelKey, color, useNewSystem]
  → new cloned object created
  → old cloned object reference captured in cleanup closure
→ useEffect cleanup fires for old cloned value
  → traverses old clone, disposes geometry + materials
→ new clone is now live
```

The key risk is rapid switching: if the user clicks 5 models in under 1s, 5
useMemo + 5 useEffect-cleanup pairs queue up. The issue is that `useGLTF` returns
the cached `scene` synchronously for preloaded models. Since all 11 models are
preloaded (see §7.3), each `useMemo` runs immediately, not deferred. The dispose
cleanup runs on the previous closure's `cloned` value — this is correct React
semantics. Each cleanup fires exactly once per `cloned` instance. No leak.

**Proposed test (CDP-based):**
After deploy, open Chrome DevTools Performance tab and:
1. Navigate to `/create-agent`.
2. Click through all 11 models as fast as possible (click each row in the picker
   grid, ~1s total).
3. In the CDP JS Heap snapshot taken 5s after rapid switching stops, compare
   `THREE.BufferGeometry` instance count to a baseline snapshot taken on
   initial load with only lobster active. If the counts match (or are within 1-2
   for the currently mounted model), no leak. If counts grow monotonically,
   dispose is not firing.

Alternative CDP approach using `renderer.info.memory` via the browser console:
```js
// In devtools console while on /create-agent after rapid switching:
// (requires exposing renderer ref — note for implementation: expose
//  window.__clawSelectRenderer = renderer in SelectAgentCanvas for debug builds)
window.__clawSelectRenderer?.info?.memory
// Expected: { geometries: 8-15 (scene geometry), textures: <50 }
// If geometries exceed ~50 after 11 rapid switches, dispose is broken.
```

**Transition style:** Hard-swap, no fade. Reasoning: fade/dissolve requires
keeping both old and new model mounted simultaneously, which doubles draw calls
and material pipelines for the duration of the transition. On Iris Xe this will
cause a visible frame drop. A hard-swap with a `Suspense fallback={null}` gives
a 1-3 frame blank on cache miss (preloaded = near-zero blank time) then the new
model appears — acceptable and honest.

---

### 7.3 GLB preload plan — preload-all on page mount

**Decision:** Preload all 11 agent GLBs via `useGLTF.preload` calls at module
level in `SelectAgentCanvas.tsx`, replacing the current single lobster preload.

**Reasoning:**

Total uncompressed size of the 11 agent GLBs: ~3.5 MB (measured):

| Model | Size |
|---|---|
| lobster.glb | 196K |
| crayfish.glb | 20K |
| sweet_crab_sketchfabweekly.glb | 924K |
| lobster_plush.glb | 700K |
| hermitcrab.glb | 756K |
| spirited_away_senchihiro.glb | 164K |
| young_priestess.glb | 228K |
| chibi_goku.glb | 48K |
| jellyfish.glb | 88K |
| octopus_toy.glb | 156K |
| sea_horse.glb | 176K |

3.5 MB over a normal broadband connection arrives in 1-3s. This is a dedicated
creation page — the user is about to spend 30-120 seconds filling out a form.
Front-loading all GLBs in the background while they choose a name costs nothing
visible to the user.

Preload-on-category-hover was considered. It would load 5 OpenClaw models (2.6
MB) on initial render of the first tab, then the remaining 6 on first hover of
the other tabs. This defers 0.9 MB but adds implementation complexity (hover
trigger, sequential loading, potential Suspense flash when user clicks a tab
before hover has fired). The complexity cost outweighs the ~0.3s cold-load
saving.

Lazy-with-Suspense was rejected: each new model shows a blank pedestal for 0.5-
2s on first select. Poor UX on a creation screen where the user is evaluating
visual options.

**Implementation:** Replace the single `useGLTF.preload('/models/lobster.glb')`
at line 76 of SelectAgentCanvas.tsx with:

```ts
// Preload all agent models so tab-switching is instant
Object.values(MODEL_REGISTRY).forEach((m) => useGLTF.preload(m.path));
```

This is a one-liner. It runs at module evaluation time (module-level, not inside
a hook), which is correct — `useGLTF.preload` is explicitly designed for this.
Three.js caches the GLTFLoader result; subsequent `useGLTF(path)` calls inside
`PlatformModel` return from cache synchronously.

---

### 7.4 Pedestal + scale audit per model

**Methodology:** All scale values produce a world-space height equal to
`modelHeight × scale` Three.js units. The pedestal top is at y=0 (the group
position in `RotatingPlatform` puts `PlatformModel` at y=1.5). The camera
`target={[0, 8, 0]}` is tuned for the lobster at scale 14.

**Per-model analysis:**

| Model | Scale | GLB native height (approx.) | World height | Assessment |
|---|---|---|---|---|
| lobster | 14 | ~0.15 | ~2.1 | Baseline — confirmed working |
| crayfish | 14 | ~0.12 | ~1.7 | Good — same family, similar proportions |
| sweet_crab | 10 | ~0.18 | ~1.8 | Good — wider than tall, low profile |
| lobster_plush | 10 | ~0.2 | ~2.0 | Good — plush toy shape, compact |
| hermitcrab | 10 | ~0.2 | ~2.0 | Good — shell adds height but stays within range |
| chihiro | 8 | ~0.22 | ~1.76 | **Needs validation.** Anime models are tall relative to crustaceans. Scale 8 was set in the registry. At fov=45 with camera at [0,18,55], target [0,8,0], a world height of 1.76 would show the character at roughly 40% of screen height — visually small. Recommend bumping to **scale 10** and re-verifying. |
| priestess | 8 | ~0.22 | ~1.76 | Same as chihiro. Recommend **scale 10**. |
| chibi_goku | 8 | ~0.18 | ~1.44 | Chibi proportions: shorter, wider head. Scale 8 may under-fill. Recommend **scale 11**. |
| jellyfish | 10 | ~0.15 | ~1.5 | The jellyfish bell faces upward — the model may render below the pedestal if origin is at bell base. Watch for floor-clipping. If clipping, adjust y-offset in the registry or set position.y override. |
| octopus_toy | 10 | ~0.18 | ~1.8 | Good — toy proportions, compact. |
| seahorse | 10 | ~0.22 | ~2.2 | Seahorses are vertically elongated. At scale 10 they may exceed the camera frame. Recommend **scale 8** and re-check. |

**Summary of scale changes needed before implementation:**
- chihiro: 8 → 10
- priestess: 8 → 10
- chibi_goku: 8 → 11
- seahorse: 10 → 8
- jellyfish: watch for floor-clip, may need `position.y` override in registry

These are recommendations based on geometry ratio analysis. Final confirmation
requires visual verification in the browser after deploy (per CLAUDE.md mandatory
browser verification rule). The implementation must include these adjusted values
as the starting point, not post-hoc tuning.

**Registry extension needed:** Add an optional `yOffset?: number` field to the
`MODEL_REGISTRY` entry type to handle jellyfish floor-clip without a special-case
in `PlatformModel`. `PlatformModel` reads `reg.yOffset ?? 0` and adds it to the
group y position.

---

### 7.5 Milady category roster — CONFIRMED priestess + chibi_goku

**Decision:** Confirm the scope doc's proposal. `priestess` and `chibi_goku`
map to `category: 'milady'` in MODEL_REGISTRY. `chihiro` maps to `category: 'hermes'`.

**Reasoning:**

The `AgentCategory` type in SelectAgentCanvas.tsx currently defines only
`'openclaw' | 'hermes' | 'other'` — `'milady'` does not exist yet. This type
must be extended to `'openclaw' | 'hermes' | 'milady' | 'other'` as part of
Phase 1 implementation.

The current registry assigns priestess and chibi_goku to `category: 'hermes'`
alongside chihiro. The roster reassignment:
- hermes: `[chihiro]`
- milady: `[priestess, chibi_goku]`

is purely a data change in MODEL_REGISTRY — no geometry or animation changes.
`MODEL_KEY_TO_TYPE` in `character-animations.ts` already correctly classifies all
three as `'anime'`, which is the CharacterType that drives the animator. This is
independent of AgentCategory and requires no change.

Default for Milady tab: `priestess` (per scope doc, §4). The `chibi_goku` GLB
is only 48K — the smallest model in the picker — which is appropriate as a
non-default option that loads instantly.

No Milady-branded GLBs exist today. This is explicitly Phase 5+ work per the
scope doc §2. The priestess/chibi_goku pairing is a placeholder labeled as such
in the UI tooltip or category description.

---

### 7.6 Color palette decision — KEEP 4, expose as named constants, defer 9

**Decision:** Keep 4 colors in Phase 1 (green / red / blue / yellow). Do not
extend to 9 in this phase.

**Reasoning:**

The UI already has 4 color buttons (`COLORS` array in page.tsx). Extending to
9 would require either a wider row (breaks mobile layout on 375px viewports) or
a color swatch grid (new component, new layout work). Neither fits within the
"pure UI swap, minimal new surfaces" constraint of Phase 1.

The `COLOR_TINTS` map in SelectAgentCanvas.tsx already defines 9 colors. The
4 colors in page.tsx use `bg` values that do not precisely match the `COLOR_TINTS`
hex values — these need to be aligned. Phase 1 implementation must ensure:

```ts
// In SelectAgentCanvas or extracted constants file:
export const PICKER_COLORS = [
  { id: 'green',  label: 'GREEN',  bg: '#30ff70' },  // matches COLOR_TINTS.green
  { id: 'red',    label: 'RED',    bg: '#ff3030' },  // matches COLOR_TINTS.red
  { id: 'blue',   label: 'BLUE',   bg: '#3070ff' },  // matches COLOR_TINTS.blue
  { id: 'yellow', label: 'YELLOW', bg: '#ffd700' },  // matches COLOR_TINTS.yellow
] as const;
```

The current page.tsx has slightly different hex values for bg (`#00E676`,
`#FF5252`, `#42A5F5`, `#FFD700`) — these are button background colors that don't
match what the GLB tint actually applies. Aligning them makes the color button
serve as an accurate preview of the applied tint.

Extending to 9 colors is a §7.7 stub for Phase 2.

---

### 7.7 Personality page preview strategy — canvas.toDataURL() thumbnail

**Decision:** On step 1 → step 2 navigation, capture a still-frame JPEG from
the SelectAgentCanvas and store it as a data URL in sessionStorage alongside the
existing `createPetStep1` payload. Step 2 renders an `<img>` tag with this
data URL as the preview.

**Reasoning:**

Option (a) — second SelectAgentCanvas on step 2 — was rejected. Step 2 is already
a long-scroll page with heavy DOM (14 archetype cards, 3 selects, stat bars).
Adding a second Canvas on Iris Xe on top of that layout is the same two-Canvas
problem as §7.1.

Option (c) — portal the same Canvas across routes — is architecturally wrong in
Next.js App Router. The Canvas lives inside `create-agent/page.tsx`'s component
tree. The personality page is a separate route; the component unmounts on
navigation. React portals cannot cross route boundaries.

Option (b) — `canvas.toDataURL()` — is clean and zero additional GPU cost on
step 2:
1. Before calling `router.push('/create-agent/personality')`, capture the frame:
   ```ts
   const canvasEl = document.querySelector('#select-agent-canvas canvas') as HTMLCanvasElement;
   const thumb = canvasEl?.toDataURL('image/jpeg', 0.8) ?? '';
   ```
2. Include `thumb` in the `createPetStep1` sessionStorage payload.
3. Step 2 reads `step1.thumb` and renders `<img src={thumb} />` in the
   192×192 preview box, replacing the emoji.

`canvas.toDataURL()` requires `preserveDrawingBuffer: true` on the Canvas. This
is not currently set in SelectAgentCanvas. Add it to the `gl` prop:

```tsx
gl={{ antialias: true, preserveDrawingBuffer: true }}
```

Note: `preserveDrawingBuffer: true` has a minor performance cost (~5-10% on some
drivers) because the GPU cannot swap-discard the back buffer. Acceptable for
this single-use creation screen. If it becomes a measurable FPS issue on
production (verify via CDP after deploy), the alternative is to set it only when
`handleNext` is called via a ref callback, then restore — but that is over-
engineering for a creation page that is rarely visited more than once per user.

The thumbnail on step 2 has no animate requirement. A static 192×192 JPEG frame
is the correct UX — it confirms what the user chose without requiring a second
renderer.

---

### 7.8 Harness radio placement — step 1, below config panel

**Decision:** Confirm step 1 placement per scope doc. The harness radio group
fits below the existing config panel (name + gender + next button) as a new
section within the same `bg-[#0a1628]` card, above the "Choose Personality"
button.

**Layout analysis:**

The current config panel contains:
- Species display label (1 line)
- Name + Gender row (~60px)
- Next button (48px)

Adding the harness radio group:
- Label: "Agent Harness" (1 line, 20px)
- 4 radio options in 2 columns (~48px)

Total card height increase: ~80px. On a 812px viewport (iPhone 13) the card
still fits without scroll when combined with the 3D preview panel above it.
The 3D panel needs to be sized correctly — see §7.9 on panel height.

The radio group must not overflow on 375px viewports. Use a 2-column grid at
≥480px, stacked single-column below. This is standard Tailwind responsive grid.

---

### 7.9 SelectAgentCanvas sizing on the page

The current emoji preview box is:
```
aspect-square max-h-[280px] w-full max-w-xl
```
This is a framed box. Since we are replacing LandingScene with SelectAgentCanvas
as the full background, the 280px framed box is eliminated entirely. The Canvas
is `absolute inset-0 z-0` behind the UI overlay.

The UI overlay (`z-10`) retains its existing padding and layout. The category
tabs, model grid, color buttons, and config panel are all overlay elements.
The 3D scene is ambient background — the agent rotates behind/below the UI rather
than in a discrete framed preview.

This is the same compositional pattern as the current landing page (`/`) where
LandingScene is absolute background and the hero text overlays it.

---

### 7.10 MODEL_REGISTRY extraction — YES, extract to shared module

**Decision:** Extract `MODEL_REGISTRY`, `AgentCategory` type, and `PICKER_COLORS`
to `apps/web/src/lib/three/agent-model-registry.ts`. `SelectAgentCanvas.tsx`
imports from there; `create-agent/page.tsx` also imports from there.

**Reasoning:** The page component needs to iterate over MODEL_REGISTRY to build
the category tabs and model picker grid. Without extraction, the page would have
to `import SelectAgentCanvas` just to access the registry — that pulls the entire
Canvas (TSL node materials, R3F, drei) into the page's synchronous bundle, which
blocks first paint. With extraction, `page.tsx` imports only the lightweight
registry file (no Three.js, no R3F) and lazy-loads the Canvas separately via
`dynamic(..., { ssr: false })`.

Extracted file should export:
```ts
export type AgentCategory = 'openclaw' | 'hermes' | 'milady' | 'other';

export interface ModelRegistryEntry {
  path: string;
  scale: number;
  label: string;
  category: AgentCategory;
  yOffset?: number; // pedestal height adjustment
}

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = { ... };

export const PICKER_COLORS = [ ... ] as const;
export type PickerColorId = typeof PICKER_COLORS[number]['id'];
```

SelectAgentCanvas.tsx imports from `@/lib/three/agent-model-registry`.

---

### 7.11 Acceptance-criteria testability — CDP verification checklist

For each criterion in §9, here is the exact CDP procedure post-deploy:

**"No Canvas unmount on tab switch"**
1. Open Chrome DevTools → Components tab (React DevTools extension).
2. Navigate to `clawville.world/create-agent`.
3. Find `SelectAgentCanvas` in the component tree — note its component instance
   ID (shown in the top-right of the component inspector).
4. Click each category tab (OpenClaw → Hermes → Milady → Other → OpenClaw).
5. After each click, verify the `SelectAgentCanvas` component instance ID is
   unchanged. A new ID means unmount+remount. Pass = same ID throughout.
   
Alternative without React DevTools extension: add a `useEffect(() => { console.log('Canvas mounted'); return () => console.log('Canvas UNMOUNTED'); }, [])` in `SceneContents` for the deploy. Check DevTools Console — "Canvas UNMOUNTED" should never appear during tab switching.

**"FPS ≥ 50 while idle and during category-switch"**
1. Open `clawville.world/create-agent` in Chrome.
2. Press F12 → Performance tab → Record.
3. Let idle for 5s, then click all 4 category tabs in sequence, then idle 3s.
4. Stop recording. In the Frames row, check average frame time.
5. Pass = average frame time < 20ms (50 FPS). Any sustained spike > 40ms
   (25 FPS) during tab switching is a fail.

Alternative using `stats.js` injection: In DevTools console:
```js
// Inject stats.js for live FPS overlay
const s = document.createElement('script');
s.src = 'https://cdnjs.cloudflare.com/ajax/libs/stats.js/r17/Stats.min.js';
document.head.appendChild(s);
s.onload = () => {
  const stats = new Stats();
  stats.showPanel(0); // FPS
  document.body.appendChild(stats.dom);
  requestAnimationFrame(function loop() { stats.update(); requestAnimationFrame(loop); });
};
```
Watch the FPS counter live. Pass = stays ≥ 50 at idle and ≥ 45 during tab switch.

**"No geometry leak on rapid model switches"**
1. In SelectAgentCanvas implementation, expose renderer info for debug:
   ```ts
   // In SelectAgentCanvas, add to Canvas onCreated callback:
   onCreated={({ gl }) => {
     if (process.env.NODE_ENV === 'development') {
       (window as any).__clawSelectRenderer = gl;
     }
   }}
   ```
2. After deploy (dev build), open DevTools console on `/create-agent`:
   ```js
   window.__clawSelectRenderer.info.memory
   // e.g.: {geometries: 12, textures: 8}
   ```
3. Note baseline reading immediately after page load.
4. Click through all 11 models rapidly (2 clicks/sec).
5. Wait 3s. Run `window.__clawSelectRenderer.info.memory` again.
6. Pass = `geometries` count within ±3 of baseline. Fail = geometries growing
   unboundedly (each rapid switch adds 1+ that never decreases).

Note: Production build strips `process.env.NODE_ENV === 'development'` guards.
Use a `?debug=1` query param check instead if testing on production:
```ts
const isDebug = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');
if (isDebug) (window as any).__clawSelectRenderer = gl;
```

---

### 7.12 Bug-prevention checklist from memory

The following known issues apply to this phase and must be avoided:

1. **InstancedMesh + ShaderMaterial = silent WebGPU crash.** LandingScene's
   `Bubbles` component uses InstancedMesh + MeshStandardMaterial — safe, but
   LandingScene is being removed from this page anyway. SelectAgentCanvas has
   no InstancedMesh. Do not add any. EmberParticles uses `PointsNodeMaterial`
   (safe).

2. **drei Text / Billboard = Iris Xe GPU crash.** SelectAgentCanvas has none.
   Do not add any label overlays using drei Text. Model names in the picker
   grid are plain HTML text in the overlay, not 3D text — correct.

3. **Per-frame `new THREE.Vector3()` / `new THREE.Color()` allocations.** The
   `LobsterAnimator` and `CharacterAnimator` systems in SelectAgentCanvas are
   already free of per-frame allocations (they use mutation, not construction).
   The `PlatformModel` useMemo correctly builds `tint` as a module-scope
   constant-ish `new THREE.Color(...)` inside the memo, not in the render loop.
   Verify that the `useFrame` callback in `RotatingPlatform` and `PlatformModel`
   has zero `new THREE.*` calls — it does (confirmed by reading lines 229-340).

4. **Two simultaneous R3F Canvases.** Addressed by removing LandingScene (§7.1).
   The personality page (step 2) uses a static `<img>` thumbnail — no Canvas.

5. **`useGLTF` called outside of R3F component tree.** `useGLTF.preload` at
   module level is explicitly supported by `@react-three/drei` and does not
   require an active Canvas. The hook form `useGLTF(path)` inside `PlatformModel`
   is called within the R3F component tree (inside `Canvas`). No issue.

6. **`scene.clone(true)` share problem.** The clone is created inside `useMemo`
   in `PlatformModel`. Each `modelKey+color` combination gets a dedicated clone.
   The original `scene` from `useGLTF` is never mutated — only the clone is
   tinted and animated. This is correct.

7. **Lobby page still loads LandingScene.** `/login` and `/` pages continue to
   use `LandingScene`. These pages do not mount `SelectAgentCanvas`. No dual-
   canvas issue on those routes.

8. **`preserveDrawingBuffer` performance.** Added to support thumbnail capture
   (§7.7). Monitor FPS in CDP after deploy — if measurably worse than baseline,
   downgrade to a one-shot flag approach. Flag the behavior in the audit.

9. **`resetStore` in `game.ts` does not reset new `agentConnected`/
   `agentSessionId` fields.** After the rename in §6.2, verify that `resetStore`
   (line 554 of game.ts) is updated to reset both `agentConnected: false` and
   `agentSessionId: null`. The current reset block explicitly lists every field;
   the renamed fields must be in the reset block or they survive logout.

10. **`SelectAgentCanvas` color default mismatch.** The component defaults
    `color = 'cyan'` (line 417), but `cyan` is not one of the 4 Phase 1 picker
    colors. The default must change to `color = 'green'` to match the picker's
    default selection.

---

### 7.13 Open questions resolved (from §12)

| Q | Answer |
|---|---|
| 1. Extract MODEL_REGISTRY? | Yes — extract to `agent-model-registry.ts` (§7.10) |
| 2. Fade/dissolve or hard-swap? | Hard-swap (§7.2) |
| 3. Preload strategy? | Preload-all on page mount (§7.3) |
| 4. Pedestal scale right for anime models? | No — chihiro/priestess → scale 10, chibi_goku → scale 11, seahorse → scale 8; jellyfish needs yOffset monitoring (§7.4) |
| 5. Harness radio — step 1 or 2? | Step 1, below config panel (§7.8) |

---

## 8. Data flow (post-change)

```
Step 1 — /create-agent
  ├─ 3D preview: <SelectAgentCanvas modelKey color />
  ├─ Category tabs: [OpenClaw | Hermes | Milady | Other]
  ├─ Model picker (filtered by category)
  ├─ Color buttons
  ├─ Name input (existing availability check)
  ├─ Gender select
  └─ Harness radio (default Milady)

   sessionStorage.createPetStep1 = {
     modelKey: 'lobster',
     category: 'openclaw',
     color: 'green',
     name: 'Shelly',
     gender: 'male',
     harness: 'milady',
   }

Step 2 — /create-agent/personality
  ├─ Small 3D preview of chosen model
  ├─ Archetype grid (unchanged)
  ├─ Habitat / Hobby / Greeting selectors (unchanged)
  ├─ Stats bars (unchanged)
  └─ CREATE button
       → POST /api/pets (existing shape + harness field passthrough;
         Phase 2 wires modelKey/category into DB)
```

---

## 9. Acceptance criteria

- `/create-agent` renders a rotating lobster in a 3D pedestal on first
  load, no emoji anywhere.
- Clicking Hermes tab swaps to chihiro without remounting the Canvas
  (3da verifies via React DevTools; we verify via CDP perf trace).
- Clicking Milady tab defaults to priestess, and the harness radio stays
  on Milady.
- Switching color re-tints without a pipeline recompile.
- Typing a name + selecting gender + clicking "Choose Personality"
  advances with correct sessionStorage payload.
- The renamed modal (`AgentConnectModal`) opens from every place that
  previously opened `OpenClawConnectModal`. No console errors about
  missing exports anywhere.
- No TypeScript errors on `bun run build`.
- CDP trace on `clawville.world/create-agent` shows FPS ≥ 50 while
  idle and category-switch interactions.
- Old species emoji code (cat/dragon/fox/etc. constants) is fully
  removed — no dead arrays left behind.

---

## 10. Testing / verification plan

1. **Local type check.** `bun run build` (web app only). Per `CLAUDE.md`,
   we do not run the dev server — Iris Xe crashes.
2. **Deploy to Hetzner.** Push to master. Coolify auto-deploys.
3. **CDP verification on `https://clawville.world/create-agent`.**
   - Load page. Confirm no emoji present in DOM for the preview.
   - Rotate camera, click through all four category tabs, confirm no
     Canvas unmount.
   - FPS trace over 10s ≥ 50.
   - Switch model within a category 5 times rapidly — confirm no
     geometry/material leak in `renderer.info.memory`.
4. **Modal smoke test on `https://clawville.world/game`.**
   - Open agent-connect-modal from the sidebar. Confirm it renders with
     the new name in the component tree.
   - Generate a connect token, confirm polling still works.
   - Disconnect flow still works.
5. **Every caller of the renamed modal gets hit manually.**

---

## 11. Audit plan — mandatory per CLAUDE.md

### 11.1 First audit pass
After 3da reports Phase 1 done, spawn a **collaborative audit team**
(general-purpose + solana-auditor for the general code-review skillset —
we are not doing crypto work here, but the auditor's line-by-line habits
are useful) with prompt:

> "Audit the Phase 1 commit against `.claude/plans/phase1-create-agent-3d.md`.
> Acceptance criteria at §9. Flag every deviation, every untested path,
> every dead code path left behind from the emoji grid, every rename
> that was missed. Check TypeScript, React hook rules, prop drilling,
> memory leaks in the Canvas, sessionStorage schema. Report in bug-list
> form — no summaries."

Fix every finding in a single follow-up commit.

### 11.2 Second audit pass
After bugs are fixed, spawn a **fresh** team (different models if
available) with prompt:

> "The previous audit found N issues which have been fixed in the
> follow-up commit. Audit again — look for new bugs introduced by the
> fixes and for anything the first audit missed. Same format."

Only merge to master after the second audit returns clean.

---

## 12. Open questions 3da must answer before coding

1. Is `MODEL_REGISTRY` better extracted to a shared module, or does it
   stay inlined in `SelectAgentCanvas`?
2. For category-switching: should the preview fade/dissolve between
   models, or hard-swap?
3. Preload-all vs. preload-on-category-hover — which wins on the
   Iris Xe cold-load budget?
4. Is the current pedestal scale/lighting right for the anime models?
   (Chibi goku and chihiro have different silhouette proportions from
   lobsters.)
5. Does the harness radio live on step 1 or step 2? (Spec says step 1.
   3da confirms it doesn't crowd the 3D panel.)

3da logs answers in this file before implementation.
