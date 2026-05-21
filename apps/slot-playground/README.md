# ClawVille Slot Rig Playground

Standalone Vite + R3F sandbox for iterating the slot reel 3D rig **without** shipping to prod, and **without** running `bun run dev` on the main monorepo (which crashes Iris Xe).

## Run in StackBlitz (no install)

Open this URL in any browser:

```
https://stackblitz.com/github/ItachiDevv/ClawVille/tree/master/apps/slot-playground
```

StackBlitz boots a WebContainer, installs deps, runs `vite`, and exposes the live URL. Zero local setup. Tweak Leva controls live in the right-side panel; press **SPIN** to trigger an animation cycle.

## Run locally (if you have a working dev machine)

```bash
cd apps/slot-playground
bun install
bun run dev
```

Open http://localhost:5173.

## Rig variants

Three options selectable from the Leva control panel:

1. **Drum (3D)** — current focus. Per-character billboard sprites orbit a horizontal cylinder axis. Decouples the 8 visible drum cells from the 84-position virtual reel strip. Bezel rings frame the drum body. Should read as a true 3D drum with readable symbols.
2. **Hybrid** — planar reels with perspective tilt + faked top/bottom curvature. Fallback if Drum fails.
3. **Planar (shipped)** — mirror of the production texture-scroll rig. Baseline for comparison.

## Contract

Every rig accepts the same `SlotRigProps` shape — mirrors the production `SlotReels3DProps`:

```ts
interface SlotRigProps {
  reels:          number[][] | null;  // 5×3 server result
  isSpinning:     boolean;
  spinTrigger:    number;             // increments on each press
  onReelsSettled: () => void;         // called exactly once after landing
  showFx?:        boolean;            // toggle overlays
}
```

A winning rig variant can be lifted into `apps/web/src/components/casino/SlotReels3D.tsx` with zero contract changes.

## Mock data

`src/constants.ts` ships:

- `CLASSIC_REEL_STRIPS` — verbatim copy of the production 5×84 strips (drift between this and `packages/shared` is OK for visual iteration but breaks line-evaluation if you wire mock spin logic).
- `SYMBOL_ASSETS` — verbatim copy of `CLASSIC_SLOT_SYMBOL_ASSETS`. Asset PNGs are mirrored at `public/symbols/` so StackBlitz can serve them.
- `mockSpinResult(seed)` — deterministic fake spin result generator.

## Pipeline

When a rig variant works:

1. Screenshot the Leva-tuned values you like.
2. Copy `DrumRig.tsx` (or whichever wins) into `apps/web/src/components/casino/SlotReels3D.tsx`.
3. Bake the Leva-tuned defaults into the constants at the top of the file.
4. Remove the Leva imports — production rig is non-tunable at runtime.
5. Replace the mock `CLASSIC_REEL_STRIPS` import with `from '@clawville/shared'`.
6. Verify against the real engine via the existing production verifier.
