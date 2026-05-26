---
title: GLB node names — CDP scene traversal is the ONLY reliable source of truth
category: gotcha
tags: [gltf, node-names, cdp, scene-traversal, apostrophe, underscore, getObjectByName, childScaleOverrides, bodyAnchorChild]
date: 2026-05-21
confidence: high
threejs_version: r182
---

## Summary

GLB node names visible in editors, hex dumps, or the GLB JSON chunk may NOT match what Three.js exposes at runtime. CDP live scene traversal (`window.__W3D.scene.getObjectByName(...)`) is the ONLY authoritative source of node names for `childScaleOverrides`, `bodyAnchorChild`, and any `getObjectByName()` call.

## Details

**The trap:** hex-dumping the GLB JSON chunk and reading `nodes[].name` looks definitive but can be wrong. In the ClawVille case (2026-05-21), the GLB binary JSON chunk appeared to show `"Squidward's House"` with a curly apostrophe (U+2019). The actual runtime node name — as verified by CDP — is `"Squidward's_House"` (straight U+0027 + underscore, no space).

Two wrong attempts were made before CDP verification:
1. `"Squidward_s_House"` — underscore replaced apostrophe (never worked)
2. `"Squidward’s House"` — curly apostrophe + space (wrong — believed the hex dump)
3. `"Squidward's_House"` — straight U+0027 + underscore (CORRECT — from CDP)

**Naming pattern confirmed via CDP for ClawVille buildings (2026-05-21):**

| Building | Node name in runtime scene |
|---|---|
| Squidward's House | `"Squidward's_House"` (U+0027 + underscore) |
| The Krusty Krab | `"The_Krusty_Krab"` (underscores only) |
| Chum Bucket | `"Chum_Bucket"` (underscore) |
| Pineapple House | `"SpongebobsHouse"` (no separator at all — different artist) |

General pattern: **spaces become underscores, apostrophes stay as straight U+0027**. But `SpongebobsHouse` is an exception (different artist convention), so never assume — always verify via CDP.

**How to verify:**

```js
// In Chrome DevTools console against https://clawville.world/game:
window.__W3D.scene.getObjectByName("Squidward's_House")  // must NOT be undefined

// Or traverse to list all node names:
window.__W3D.scene.traverse(o => { if (o.name) console.log(o.name); });
```

**Why hex-dumps fail:** The GLB binary is a GLTF JSON chunk followed by binary buffer. Editors and hex-dump scripts read the UTF-8 JSON, but:
- The file may have been post-processed (Draco, meshopt, Blender re-export) which can re-encode node names
- Editors may auto-substitute curly quotes when displaying JSON
- The binary content may differ from what the loader exposes after mesh-opt decode

**Rule:** never write a `childScaleOverrides` key, `bodyAnchorChild`, or `getObjectByName()` argument for a ClawVille GLB without first checking the CDP scene graph. A silent no-op is worse than a crash — it looks correct for months.

## Context

Surfaced 2026-05-21 during the body-anchor fix cycle. Two incorrect fixes were shipped before CDP verification was performed. The CDP ground-truth session (team-lead, Chrome 148, fresh load against prod) took 2 minutes and resolved the ambiguity that two rounds of hex-dump analysis could not.
