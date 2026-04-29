---
title: Velocity-derived facing snaps on knockback impulses — use server rot
category: gotcha
tags: [bumper-shells, multiplayer, facing, rotation, knockback, snapshot]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
Deriving `group.rotation.y` from `atan2(entity.vx, entity.vy)` causes violent facing snaps on every knockback impulse — reads as "spazzing".

## Details
In Bumper Shells the server sends `entity.vx/vy` which include knockback impulses from collisions. If you derive facing from velocity, every hit causes the lobster to snap toward the knockback direction, not the player's intended movement direction.

The server also sends `entity.rot` (radians), which is only updated when the player provides actual input direction (`body.rot = atan2(intent.dir.x, intent.dir.y)` on the sim side). This field is immune to knockback.

**Fix:** Use `entity.rot` for `group.rotation.y`. Continue using velocity magnitude for idle/walk classification — speed is correct from velocity, only facing needs the server-authoritative field.

**NaN guard:** When `entity.rot === 0` AND velocity is also zero (initial spawn before first input), treat as NaN and fall back to last rendered rotation. Once the player moves, trust `entity.rot` unconditionally.

## Context
Surfaced in ClawVille Bumper Shells after PR #55. The velocity-derived facing worked on the open world (no knockback) but was exposed immediately in the bumper arena where collision impulses dominate velocity on every frame after a hit.
