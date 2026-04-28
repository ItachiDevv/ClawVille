# Sea-Creature Animated GLB Pipeline

Drop rigged + animated GLBs here to give the game avatars (lobster, crayfish,
sea_horse) real skeletal animation. Wiring is already in place — the moment
you commit a `base.glb` + animation clips and flip the manifest, the players
in Reef Race and Bumper Shells start using them.

## Folder layout (per species)

```
sea-creatures/
├── lobster/
│   ├── base.glb                 # rigged base mesh (replaces /models/lobster.glb)
│   └── animations/
│       ├── idle.glb             # resting / cruising slow      LOOP
│       ├── swim.glb             # active locomotion             LOOP
│       ├── boost.glb            # boost active                  LOOP
│       ├── hit.glb              # knockback reaction            ONE-SHOT
│       ├── victory.glb          # post-finish celebration       ONE-SHOT
│       └── wipeout.glb          # off-track respawn freeze      ONE-SHOT
├── crayfish/  (same structure)
└── sea_horse/ (same structure)
```

Only the FIRST `AnimationClip` in each animation GLB is used — the loader
overrides the clip name with the state. Export each clip as its own GLB
file (Meshy's per-state animation export does this by default).

## Recommended pipeline (from CopyRebeldia tweet 2026-04-26)

1. **Auto-rig the existing static mesh.** Upload `/models/lobster.glb` (or
   `crayfish.glb` / `sea_horse.glb`) to **Meshy** or **Tripo** auto-rigger.
   Meshy supports arbitrary topology better than Mixamo for non-humanoid
   meshes (Mixamo only auto-rigs to a humanoid skeleton — wrong for a
   10-leg crustacean).
2. **Generate per-state animation clips.** Meshy's "Animate" feature
   produces idle / walk / attack / death-style clips for any rig. Export
   each as a separate GLB (the rig is shared; the clip is per-file).
3. **Drop into the matching folder above.** No filename munging — names
   must match the state enum in `apps/web/src/lib/three/sea-creature-types.ts`
   exactly.
4. **Update the manifest.** Edit
   `apps/web/src/lib/three/sea-creature-manifest.ts`:
   ```ts
   lobster: {
     hasRig: true,
     availableStates: new Set(['idle', 'swim', 'boost']),
   },
   ```
   Only list states you actually shipped GLBs for. Missing states fall
   through `swim → idle → first-available → no-clip-but-rig` automatically.

## State → game event mapping

| State    | When the player switches to it |
|----------|--------------------------------|
| `idle`   | Spawned, no input, velocity ≈ 0 |
| `swim`   | Default locomotion (any moving entity) |
| `boost`  | `activeBoosts` non-empty — drift / launch / ribbon / slipstream / pickup turbo |
| `hit`    | Knockback impulse received (Bumper Shells) — auto-reverts to prior state on clip end |
| `victory`| `entity.finishedAt !== null` — plays once, holds last frame |
| `wipeout`| `entity.respawnAt !== null` — plays during the off-track freeze |

State derivation lives in the player component (`ReefRacePlayer.tsx`,
`BumperShellsPlayer.tsx`). To add new states, extend the enum in
`sea-creature-types.ts` AND the derivation switch in the player.

## Fallback when a GLB is missing

Manifest defaults to `{ hasRig: false, availableStates: empty }` for every
species. While that's the case, the player components keep using the
existing static mesh + procedural per-bone code path — nothing regresses,
nothing crashes. Flipping `hasRig: true` activates the animator path; once
the requested base GLB 404s the loader returns `null` and the static path
is used again.

This means: shipping a partial set (e.g. only `idle.glb`) is safe.
Unsupported states transparently fall back to whatever IS available.

## Mesh constraints (Iris Xe budget)

The rigged base mesh should stay close to the original GLB's poly count
(lobster ≈ 2k tris). Meshy's auto-rig adds ~0% to tri count but introduces
a SkinnedMesh, which is a separate draw call from the mesh's child meshes
if topology was split. Verify ≤ 2 draw calls per kart in the dev build:

```bash
# In a Reef Race round, open Chrome devtools and eval:
window.__W3D?.gl?.info?.render?.calls   # should stay under 70 for the whole scene
```

## Why not Mixamo for these specifically

Mixamo's auto-rigger and animation library are humanoid (2 arms, 2 legs).
Forcing a 10-leg lobster onto a humanoid skeleton produces unusable rigs.
Meshy + Tripo support quadruped + arbitrary topology rigs. Mixamo stays
the right choice for the humanoid VRM characters (Nori, Milady) — those
go through `apps/web/src/lib/three/vrm-character-animator.ts` instead.
