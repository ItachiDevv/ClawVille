---
title: Avatar scale-down pass 2026-04-16 — proportions for 5120-unit world
category: solution
tags: [scale, PET_SCALE, TARGET_NPC_HEIGHT, CHARACTER_HEIGHT, SPEED, proportions, world-size]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary

Avatar scales set during the ring-expansion proportions pass (PET_SCALE=55, TARGET_NPC_HEIGHT=120, CHARACTER_HEIGHT=140) still looked too large after zooming out. Two iterative passes brought all down to final values (pass 1 → pass 2, both 2026-04-16).

## Details

After the world expansion to 160×160 tiles (5120×5120 world units), scales were raised in a proportions pass. Visual user testing drove two successive reductions.

### Pass 1 values (shipped, then user-tested)

| Constant | File | Old | After Pass 1 |
|---|---|---|---|
| `PET_SCALE` | `player-pet.tsx` | 55 | 33 |
| `TARGET_NPC_HEIGHT` | `arena-npcs.tsx` | 120 | 75 |
| `CHARACTER_HEIGHT` | `arena-location-npcs.tsx` | 140 | 90 |
| `SPEED` (player+NPC) | `player-pet.tsx`, `npc-controller.tsx` | 200 | 320 |
| `HARD_MAX` (wandering NPC cap) | `arena-npcs.tsx` | 250 | 160 |
| `HARD_MAX` (location NPC cap) | `arena-location-npcs.tsx` | 300 | 190 |
| Karen `scaleOverride` | `arena-location-npcs.tsx` | 93 | 60 |
| Larry `scaleOverride` | `arena-location-npcs.tsx` | 140 | 90 |

**Pass 1 user feedback:**
1. "The lobster is still too big for the npc I spawned" — 78-wu rendered lobster vs 800-wu building (1:10.3 ratio) still felt oversized. Target 1:16–1:20.
2. "WASD movement is not faster" — 200→320 (+60%) was perceivable in the camera-follow feel but not in direct WASD feel. Push harder.

### Pass 2 values (LIVE — confidence: high)

| Constant | File | After Pass 1 | After Pass 2 |
|---|---|---|---|
| `PET_SCALE` | `player-pet.tsx` | 33 | **20** |
| `TARGET_NPC_HEIGHT` | `arena-npcs.tsx` | 75 | **45** |
| `CHARACTER_HEIGHT` | `arena-location-npcs.tsx` | 90 | **55** |
| `SPEED` (player+NPC) | `player-pet.tsx`, `npc-controller.tsx` | 320 | **550** |
| `HARD_MAX` (wandering NPC cap) | `arena-npcs.tsx` | 160 | **95** |
| `HARD_MAX` (location NPC cap) | `arena-location-npcs.tsx` | 190 | **115** |
| Karen `scaleOverride` | `arena-location-npcs.tsx` | 60 | **37** |
| Larry `scaleOverride` | `arena-location-npcs.tsx` | 90 | **55** |

Pass 2 ratios: lobster ~48 wu / 800-wu building ≈ 1:16.7; NPC 45 wu / 800 ≈ 1:17.8; char NPC 55 wu / 800 ≈ 1:14.5. SPEED 550: crosses ~2000 wu visible area in ~3.6s.

### Speed increase rationale

SPEED needed to increase when scale went down — at smaller avatar scale, the *camera* stays at the same orbit distance, so the world looks more zoomed out. At 200 px/sec the pet visually crawled. Pass 1 at 320 was perceivable only in the perspective-follow feel, not direct WASD. Pass 2 at 550 targets 3-4s crossing of the visible 2000-wu area.

### HARD_MAX and scaleOverride coupling

When `TARGET_NPC_HEIGHT` or `CHARACTER_HEIGHT` changes:
- `HARD_MAX` must change proportionally (keep it 2× target).
- `scaleOverride` values: Karen (native h≈1.5) → CHARACTER_HEIGHT/1.5; Larry lobster_plush (native h≈1.0) → CHARACTER_HEIGHT/1.0.
- NPC_SCALE_CLAMP constants derive from the target variable automatically — no manual update needed.

## Context

Triggered by screenshot showing purple player-pet lobster (in NPC mode) appearing too large relative to the world. User said "a lobster nearly fills 1/6 of the viewport vertically." Pass 1 shipped, user retested, still too big and too slow → pass 2.
