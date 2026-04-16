---
title: Multi-variant merged seaweed with per-blade TSL amplitude
category: pattern
tags: [seaweed, vegetation, mergeGeometries, TSL, webgpu, animation, clusters]
date: 2026-04-09
confidence: high
threejs_version: r170+
---

## Summary
3000 seaweed blades in 3 shape variants baked into ONE BufferGeometry with per-variant sway amplitude stored as a custom vertex attribute for TSL.

## Details

### Three variants via separate geo builders
Each builder uses `Math.random()` for height variation before baking:
- Short grass (segs=4, h=10-15, curve=0.8, amplitude 2-3)
- Tall kelp (segs=6, h=35-45, S-curve, amplitude 6-8)
- Medium fern (segs=5, h=20-25, wide taper + bulge, amplitude 3.5-5)

### Key attribute: aAmplitude
Store per-variant sway amplitude as a Float32 vertex attribute so the TSL
shader can drive different sway strengths without any branch or lookup:
```ts
merged.setAttribute('aAmplitude', new THREE.Float32BufferAttribute(allAmplitudes, 1));
```

In TSL:
```ts
const amplitude = attribute('aAmplitude', 'float');
const wave1X = sin(time.mul(float(0.9)).add(phase)).mul(height).mul(amplitude);
```

### Two-wave oceanic motion
Wave 1 (fast, 0.9/1.4 Hz): primary directional sway
Wave 2 (slow, 0.18/0.12 Hz): full-field oceanic current drift at 0.4x amplitude

```ts
const wave2X = cos(time.mul(float(0.18)).add(phase.mul(float(0.3))))
  .mul(height).mul(amplitude.mul(float(0.4)));
```

### Organic clustering instead of uniform random
Generate N cluster centres first, then for each item:
1. Pick a random cluster
2. Sample at `angle + dist` where `dist = (rng() + rng()) * radius` (triangular distribution)

This creates natural dense patches and sparse gaps without any noise texture.

**Tuning parameters for GLB decoration scatter (120 items, 18 clusters, radius 280):**
```ts
const N_CLUSTERS    = 18;
const CLUSTER_RADIUS = 280; // world units
const clusters = [];
for (let i = 0; i < N_CLUSTERS; i++)
  clusters.push({ x: (rng()-0.5)*EXTENT_X, z: (rng()-0.5)*EXTENT_Z });

// Per item:
const cluster = clusters[Math.floor(rng() * N_CLUSTERS)];
const dist  = (rng() + rng()) * CLUSTER_RADIUS; // triangular falloff
const angle = rng() * Math.PI * 2;
const x = cluster.x + Math.cos(angle) * dist;
const z = cluster.z + Math.sin(angle) * dist;
```
Also clamp to map extents after computing position to avoid off-plane spawns.

### Vertex count (seaweed)
- Grass: (4+1)*2 = 10 verts
- Kelp: (6+1)*2 = 14 verts
- Fern: (5+1)*2 = 12 verts
- Average ~12 verts × 3000 blades = ~36K vertices — single draw call

## Context
ClawVille underwater world. Cluster algorithm verified in two contexts:
1. 3000 merged seaweed blades
2. 120 GLB decoration props (arena-terrain.tsx)
Critical: must NOT use InstancedMesh (crashes Intel Iris Xe WebGPU silently).
