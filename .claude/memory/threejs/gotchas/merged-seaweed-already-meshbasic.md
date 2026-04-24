---
title: merged-seaweed already uses MeshBasicNodeMaterial — no Lambert swap needed
category: gotcha
tags: [seaweed, material, performance, MeshBasicNodeMaterial, Lambert]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

`apps/web/src/lib/three/merged-seaweed.tsx` uses `MeshBasicNodeMaterial` — not `MeshStandardMaterial`. No Lambert swap is needed.

## Details

The FPS plan B8 item called for "MeshStandardMaterial → MeshLambertMaterial" on merged-seaweed. When the file was read, `createSeaweedMaterial()` returns a `THREE.MeshBasicNodeMaterial` — which skips ALL lighting calculations (no diffuse model, no ambient, nothing). This is cheaper than Lambert (which still computes a diffuse dot product per fragment). The TSL `positionNode` wind animation runs regardless of material type.

No code change was needed. The file was already at the correct material class.

## Context

Verified 2026-04-24 during Pod 2+3 implementation pass. If future sessions suggest swapping seaweed material, check this first — the material is already optimal.
