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

**GLB names verified for ClawVille buildings — AUTHORITATIVE SOURCE: CDP live traversal (2026-05-21):**

> **WARNING:** Hex-dump analysis proved unreliable for squidward-house.glb. The hex dump appeared to show U+2019 curly apostrophe, but CDP live scene traversal showed U+0027 straight apostrophe + underscore (the node name is `"Squidward’s_House"`, not `"Squidward’s House"`). Possible causes: editor auto-substitution when displaying UTF-8, or meshopt re-encoding between source and runtime. **Use CDP traversal as ground truth, not hex-dump.**

| File | Runtime node name | Notes |
|---|---|---|
| `squidward-house.glb` | `"Squidward’s_House"` | U+0027 straight + underscore (NOT space, NOT U+2019) |
| `krusty-krab-v2.glb` | `"The_Krusty_Krab"` | underscores, all ASCII |
| `pineapple-house.glb` | `"SpongebobsHouse"` | no separator — different artist |
| `sandy.glb` (NPC) | `"mixamorig:Head_05"` | colon preserved (bone nodes only) |

**How to verify (use CDP, not hex-dump):**
```js
// In Chrome DevTools on https://clawville.world/game:
window.__W3D.scene.getObjectByName("Squidward’s_House")   // must not be undefined
window.__W3D.scene.traverse(o => { if (o.name) console.log(o.name); });
```

See also: `gotchas/glb-name-conventions-cdp-ground-truth.md` — CDP is the only reliable verification method.

## Context

Surfaced when `childScaleOverrides` and `bodyAnchorChild` appeared to have zero effect on Squidward's house and Krusty Krab across multiple sessions. The features appeared implemented but were complete no-ops. The fix was changing underscore-sanitized keys to literal strings. The same issue applies to `getObjectByName()` calls anywhere in the codebase.

This is NOT a bug in Three.js — it is correct behavior. GLTFLoader faithfully preserves the source names. The assumption that sanitization would happen was wrong.
