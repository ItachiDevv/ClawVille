---
title: GLTFLoader preserves node names verbatim — no sanitization
category: gotcha
tags: [gltf, node-names, sanitization, childScaleOverrides, bodyAnchorChild, getObjectByName]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary

Three.js GLTFLoader does NOT sanitize node names. Apostrophes, spaces, colons, and other special characters are preserved verbatim from the GLTF JSON. Any code that uses assumed-sanitized names (underscores in place of apostrophes/spaces) will silently fail.

## Details

When looking for a named child node via `object.getObjectByName(name)` or traversal, you MUST use the exact string as it appears in the GLTF JSON (and by extension the authoring tool — Blender, Sketchfab, etc.).

**The bug that surfaced this (ClawVille 2026-05-18):**

```ts
// WRONG — these were silent no-ops for all prior commits:
childScaleOverrides: { 'Squidward_s_House': 1.4 }  // glb has "Squidward's House"
childScaleOverrides: { 'The_Krusty_Krab': 1.5 }    // glb has "The Krusty Krab"

// CORRECT — use the exact verbatim node name:
childScaleOverrides: { "Squidward's House": 1.7 }
childScaleOverrides: { 'The Krusty Krab': 1.5 }
```

The underlying `applyChildScaleOverrides()` uses `scene.traverse` + `obj.name === key` comparison — exact string match, no normalization. If the key doesn't match verbatim, the traversal simply finds nothing and returns silently with no error.

**How to verify actual node names:**

Run a Node.js/Bun GLB inspection script:
```js
import { readFileSync } from 'fs';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const buf = readFileSync('/path/to/model.glb');
const loader = new GLTFLoader();
loader.parse(buf.buffer, '', (gltf) => {
  gltf.scene.traverse(obj => console.log(obj.name || '(unnamed)'));
});
```

Or inspect the GLTF JSON directly — GLB files are binary GLTF; the JSON chunk contains `nodes[].name` verbatim.

**GLB names verified for ClawVille buildings:**
- `squidward-house.glb`: top body node = `"Squidward's House"` (apostrophe + space)
- `krusty-krab-v2.glb`: top body node = `"The Krusty Krab"` (spaces, no article dropped)
- `sandy.glb` (Sandy NPC): bone nodes = `"mixamorig:Head_05"` (colon preserved)

## Context

Surfaced when `childScaleOverrides` and `bodyAnchorChild` appeared to have zero effect on Squidward's house and Krusty Krab across multiple sessions. The features appeared implemented but were complete no-ops. The fix was changing underscore-sanitized keys to literal strings. The same issue applies to `getObjectByName()` calls anywhere in the codebase.

This is NOT a bug in Three.js — it is correct behavior. GLTFLoader faithfully preserves the source names. The assumption that sanitization would happen was wrong.
