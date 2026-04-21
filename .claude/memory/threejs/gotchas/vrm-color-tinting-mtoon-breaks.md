---
title: VRM MToon materials break under MeshStandardMaterial color lerp
category: gotcha
tags: [vrm, mtoon, color-tinting, milady, material]
date: 2026-04-21
confidence: high
threejs_version: r182 / @pixiv/three-vrm 3.5.2
---

## Summary
Applying `applyColorTint()` (MeshStandardMaterial clone + color.lerp + emissive) to a VRM model breaks the MToon toon-shading pipeline — the avatar renders with flat unlit or glitchy appearance.

## Details
VRM avatars use `MToonMaterial` (or `MToonNodeMaterial` in v3.x). These are custom Three.js materials that implement a two-pass toon shader. When you call `.clone()` on them and set `.color`, `.emissive`, `.emissiveIntensity`, the toon shader's internal uniform system is bypassed and the material fails silently — no error, just wrong rendering.

**Do NOT** traverse VRM scene and apply `applyColorTint()`.

**Instead:** Store the user's `petColor` preference in the Zustand store but skip visual tinting for VRM avatars. Document this clearly in the registry entry comment.

## Context
Surfaced during Milady VRM avatar integration (2026-04-21). The fix is to branch on `reg.avatar_type === 'vrm'` and skip the color tinting path entirely.
