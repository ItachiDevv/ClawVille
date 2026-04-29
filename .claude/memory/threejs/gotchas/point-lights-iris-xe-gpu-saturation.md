---
title: 7+ point lights cause GPU context loss on Iris Xe (overdraw saturation)
category: gotcha
tags: [iris-xe, point-lights, gpu-context-loss, performance, lighting, bumper-shells]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

7 point lights (3 neon accents in scene + 4 rim accents in arena) combined with a PCF shadow map caused WebGL context loss on Intel Iris Xe during bumper-shells activity.

## Details

Each point light in Three.js WebGLRenderer adds one full per-fragment lighting evaluation to the fragment shader. At 1280×720 that is ~920k fragments/frame. With 7 point lights plus a shadow-casting directional, the lighting shader runs ~8 passes per fragment — ~7.4M ALU ops/frame above the hemisphere baseline.

On Intel Iris Xe (96 EUs, ~1.7 TFLOPS FP32) at 60Hz, that is ~446 GFLOPS just from lighting — roughly 26% of peak throughput gone before any geometry work, texturing, or raster ops. Add a 1024×1024 PCF shadow depth-prepass (~4ms/frame on Iris Xe) and the GPU saturates, triggering a driver-level context loss.

### What caused it in bumper-shells

Scene had:
- `hemisphereLight` (free — no GPU pass, baked into ambient uniform)
- `directionalLight` with `castShadow=true`, 1024² map (= 2 passes: depth + main)
- 3 neon `pointLight`s in `BumperLight` component (neon cyan, pink, purple accents)
- 4 `pointLight`s in `BumperShellsArena` at cardinal rim positions (cyan glow)

Total light count: 8 lights + 1 shadow map = GPU saturation on Iris Xe.

### Fix

Removed all 7 point lights and the shadow map. Hemisphere (1.8 intensity) + directional no-shadow is sufficient for bumper game readability. The removed lights were purely decorative. Lost glow effect is recoverable via additive MeshBasicMaterial on the rim torus (already doing that) — no light needed.

## Rule of thumb for Iris Xe

- Hemisphere light: free (no GPU pass).
- Directional (no shadow): 1 pass — OK.
- Directional with PCF shadow: 2 passes + ~4ms depth-prepass — expensive; only use when shadows are gameplay-critical.
- Each point/spot light: 1 additional full lighting pass per fragment.
- **Budget: 1 directional no-shadow + optional hemisphere. Every point light beyond that on Iris Xe costs ~920k ALU ops/frame at 720p.**
- If you need glow/accent: use additive `MeshBasicMaterial` or emissive on `MeshStandardMaterial` (baked into the main pass, not extra passes).

## Context

PR #55 — bumper-shells perf fix (2026-04-24). The lighting teardown dropped effective GPU lighting passes from 8 → 1, eliminating context loss and restoring stable render.
