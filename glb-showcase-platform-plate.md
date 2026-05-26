# Sketchfab "showcase" GLBs ship with a baked-in product-photography platform

**Symptom:** Mount a Sketchfab GLB in the world. A flat circular or rectangular "platform" appears under it that looks like a stray pedestal. Source code grep finds no `CylinderGeometry`/`PlaneGeometry` placed at that position.

**Cause:** Many Sketchfab assets — especially those tagged "Showcase" or originally rendered for product photography — bake a flat floor/platform plate into the GLB itself, alongside the actual prop. The author put it there so their thumbnail render had a base to sit on. When we mount the GLB in our scene, that plate comes with it.

**Detection:** Inspect the GLB's mesh tree:
```bash
node -e "const fs=require('fs');const buf=fs.readFileSync('models/your.glb');const j=JSON.parse(buf.toString('utf8',20,20+buf.readUInt32LE(12)));(j.meshes||[]).forEach((m,i)=>console.log(i,m.name));"
```
Look for a mesh named `Background_*`, `ground_*`, `platform_*`, `floor_*`, `base_*`, `stage_*`, `pedestal_*`, or similar.

**Fix:** Hide the plate at load time inside the cloned scene traverse:
```ts
useEffect(() => {
  cloned.traverse((obj) => {
    obj.matrixAutoUpdate = false;
    obj.updateMatrix();
    if (/^Background_Material|^ground|^platform|^base_plate/i.test(obj.name)) {
      obj.visible = false;
    }
  });
}, [cloned]);
```

**Concrete cases in this repo:**
- `auction-dome.glb` (Sketchfab "Space Dome Showcase" by dylanheyes) — has `Background_Material.004_0`. Hidden in `auction-podium.tsx` (commit `b194bbf`).
- `marketplace-food-stall.glb` (SpatialNeglect, CC-BY) — has `ground_ground_0`. Hidden in `marketplace-stall.tsx`.

**Diagnostic shortcut:** if a user complains about a "random disc / platform / pedestal" they can see but you can't find in code, **inspect the GLBs at world-center props first** before grepping. Cost of the GLB inspection is one Node one-liner; cost of a wild grep through the codebase is 20× higher.

**Pattern reuse:** The hide-regex approach is now codified in two stalls + auction podium. Any future Sketchfab GLB that ships with a showcase plate gets the same treatment. If a third asset needs the same fix, consider promoting to a shared utility (`hideShowcaseGroundPlate(cloned)`).
