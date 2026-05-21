---
name: mixamo-force-inplace
description: "Mixamo's per-animation default In-Place is OFF for walk/run; without forcing it ON in scripts/mixamo/fetch-animations.ts the FBX hip.Z ramps linearly and after Blender's Y-up→glTF axis-swap the avatar shoots vertically every cycle."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 735b5afc-95a7-4172-bd62-c10121462343
---

When fetching any Mixamo animation that's intended to play at a transform-driven character position (walk/run/idle/most emotes), `scripts/mixamo/fetch-animations.ts` MUST force the `In Place` param ON in `gms_hash.params` before submitting the export job. The script does this automatically; opt out only with `--no-inplace` for cinematic clips where you want baked root motion.

**Why:** Mixamo's per-animation defaults vary — Walking / Running ship with In-Place OFF, so forward locomotion gets baked into the hip bone's Z track (cm units). After Blender import (`global_scale=100`, 90° X-axis rotation to convert FBX Y-up→Blender Z-up) and glTF export (Z-up→Y-up), the Z forward drift becomes Y up drift. Symptom: avatar appears to "shoot vertically into the sky" once per walk cycle, then snap back. Verified on `apps/web/public/models/hermes-mesh/female-animations/female-walk.fbx` 2026-05-15: hip.Y oscillated correctly (0.88–0.94, 5cm bob) while hip.Z ramped 0→1.73 linearly across 30 frames — exactly the In-Place-OFF signature.

**How to apply:** If a per-character walk/run/idle bake plays back as vertical drift, the bake is bad — re-run `bun scripts/mixamo/fetch-animations.ts <slug> Walking` (no `--no-inplace`). Use `bun scripts/mixamo/diagnose-fbx-walk.py <fbx>` via headless Blender to confirm hip.Z is flat. Related: [[walk-shoot-vertical-fallback]], [[vrm-crossfade-must-play]].
