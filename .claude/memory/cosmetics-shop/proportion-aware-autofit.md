---
name: proportion-aware-autofit
description: "FIXED/respected: hat/glasses fit uses computeCosmeticHeadFit with a bone-world-scale-corrected localScale (the head bone world scale already bakes the ~169-320x avatar render-scale) -- never a hand-rolled height-only scale (the Agent-Forge bug). Aura uses raw-GLSL ShaderMaterial, never TSL/NodeMaterial in the WebGL world canvas."
category: pattern
confidence: high
date: 2026-06-22
---

---
name: proportion-aware-autofit
description: "Head-fit via computeCosmeticHeadFit + bone-world-scale-corrected localScale across all humanoid rigs; aura is raw-GLSL ShaderMaterial NOT TSL. FIXED in current code."
category: pattern
confidence: 0.9
date: 2026-06-22
---

## Head-fit math (HatOrGlassesRenderer)
Fit MUST use `computeCosmeticHeadFit` / `computeVRMAvatarFit` (`vrm-avatar-sizing.ts`, 3da-owned), which is **axis-sign-safe across all humanoid rigs** (Milady/Hermes/Tekk/Phanes/chibi). The renderer scales by:

`groupLocalScale = desiredWorldWidth / (assetWidth * boneWorldScaleX) * nudge`

because the head bone's WORLD scale already bakes the ~169-320x avatar render-scale -- **setting localScale off the raw world width was the prior BUG.** Clamp `[0.01, 1000]`. Without `vrm + vrmRenderScale` it falls back to the legacy `findHeadBone` path. A hand-rolled height-only scale is the documented **Agent-Forge VRM fit bug** (`project_agent_forge_vrm_fit_bug`) -- never do that.

Also: `hideHeadGeometryUnderHat` hides the scalp under a hat (re-shows on unequip).

## Aura / shader cosmetics
`AuraRenderer` (`cosmetic-loader.tsx`) uses **raw-GLSL `THREE.ShaderMaterial`, NOT TSL/NodeMaterial.** The main world R3F canvas is a `WebGLRenderer`; a `NodeMaterial` there causes a per-frame `.replace()` crash on undefined. **NEVER `import 'three/webgpu'` in `cosmetic-loader.tsx`.** Iris-Xe also bans `InstancedMesh + ShaderMaterial` -- keep shader cosmetics as a plain `Mesh`. Aura geometry is shared module-scope (not disposed); scratch vectors are module-scope (zero per-frame `new Vector3()`); `compileAsync` before adding; dispose GLBs/materials on unmount; `frustumCulled=false` on the cosmetic meshes.

## State
**FIXED/respected** in current code; the trap is regressing either rule in a new renderer. All non-trivial render work is dispatched to 3da.

Related: [[applybonetransform-skeleton-update]], [[sku-needs-row-asset-mesh]], [[asset-cache-bust-v-query]].
