---
title: Palette texture swap — replace avatar albedo map at runtime
category: pattern
tags: [palette, texture, swap, material, cosmetic, MeshStandardMaterial]
date: 2026-04-28
confidence: medium
threejs_version: r170+
---

## Summary
Swap the albedo (`map`) texture on an avatar's body materials to apply a color palette cosmetic. Saves originals for restore on unequip.

## Details

### Load + apply
```ts
const loader = new THREE.TextureLoader();
const originalMaps = new Map<THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, THREE.Texture | null>();

loader.load(variant.assetUrl, (texture) => {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  parentObject.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
        if ((mat as any).isMToonMaterial) continue; // skip VRM MToon
        originalMaps.set(mat, mat.map);
        mat.map = texture;
        mat.needsUpdate = true;
      }
    }
  });
});
```

### Restore on dispose
```ts
for (const [mat, originalMap] of originalMaps) {
  mat.map = originalMap;
  mat.needsUpdate = true;
}
originalMaps.clear();
```

### colorSpace
Palette textures are colour data (sRGB). Always set `texture.colorSpace = THREE.SRGBColorSpace` after load. Data textures (normal, roughness) must remain Linear — this only applies to the colour palette texture.

### MToon skip
VRM avatars use MToonMaterial (`isMToonMaterial === true`). Their `map` property is the diffuse/base colour map, but the MToon shading model is coupled to specific properties (shadeColorFactor, outlineColorFactor, etc.). Blindly swapping `map` on MToon will partially recolour the avatar but break shading. Skip MToon materials for now; a full VRM palette requires patching `mtoon.map` + `mtoon.shadeMultiplyTexture`. Phase 3 launch defers this.

### UV region specificity
The `assetMeta.uvMap` field is reserved for future UV-region-specific palette painting (compositing only part of the texture onto the avatar's UV layout). Phase 3 does a whole-texture swap (simpler, correct for species that have a dedicated palette texture). UV-region compositing via CanvasTexture is a Phase 4+ enhancement.

### assetMeta fields
```jsonc
{
  "uvMap": "body",          // reserved; not used in Phase 3 implementation
  "paletteIndex": 2         // which of the 6 palette variants for this species
}
```

## Context
Phase 3.3 cosmetic render pipeline. `cosmetic-loader.tsx` `PaletteRenderer`. Used for `category: 'palette'` SKUs. Not exercised by the Phase 3 test bed (4 surfboards are `category: 'board'`). First exercise will be the 30 color-palette SKUs in the full 55-SKU catalog (30 = 5 palettes × 6 species).
