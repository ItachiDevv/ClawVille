---
title: Static-mesh transform-only swim animator (sea-creature-swim.ts)
category: pattern
tags: [animation, procedural, transform, static-mesh, lobster, no-bones, reef-race, bumper-shells]
date: 2026-04-26
confidence: high
threejs_version: r170+
---

## Summary
Pure rotation.x/z + position.y oscillation on the whole mesh group for GLBs with 0 bones.

## Details
`sea-creature-swim.ts` exports `applyTransformSwim(meshRoot, petId, dt, speed, baseY)`.

- Module-scope `Map<petId, ProceduralState>` stores `{t, hasBones, probed}`. Zero per-frame allocations.
- On first call: traverses root once to detect isBone nodes (cached in `probed`). If bones exist → returns early (rigged species handled by bone animator).
- Speed envelope: `clamp(0.4 + speed * 0.0012, 0.4, 1.2)` — at speed=0 barely moves; at speed=500wu/s energetic.
- Roll: `sin(t * (8 + speed*0.006)) * 0.08 * env` — dominant visual cue.
- Pitch: `sin(t * 6) * 0.04 * env`
- Bob: `baseY + sin(t * 4) * 0.03 * env` — uses baseY so no drift from repeated +=.
- NEVER touches rotation.y — that is owned by server-authoritative facing.
- `resetTransformSwimState(petId)` clears map entry on clone remount (re-probes bones on next call).

## Context
lobster.glb has 0 isBone===true nodes. The old `applySwimmingAnim` traverse was a complete no-op.
`clonedScene` in ReefRacePlayer lives inside `riderMountRef` (player writes group.rotation.y, not clonedScene's).
`clonedScene` in BumperShellsPlayer lives inside `meshRoot` (player writes group.rotation.y; meshRoot.scale for squash-stretch — also orthogonal).
Both contexts safe for rotation.x/z and position.y on the inner clonedScene.
16 callsites/frame (8 reef-race + 8 bumper-shells) — 4 Math.sin calls each, well within Iris Xe budget.
