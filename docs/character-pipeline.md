# Hatcher / Realistic Character Pipeline (SOLVED 2026-06-09)

**Status:** user-confirmed working on Helen ("actually good quality, we solved the pipeline issue").
**Quality reference:** first-round Hermes ONLY (`hermes-female.vrm`, `hermes-male.vrm`, May 12). Phanes is NOT a reference (defective eyes). Tripo builds (old helen/clytemnestra/cronus) were defective (mangled faces) and are superseded.

## The recipe

| # | Step | Tool / command | Cost | Notes |
|---|------|----------------|------|-------|
| 1 | Turnarounds | `bun scripts/hermes-pipeline/gemini-turnaround.ts <ref.png> prompts/<slug>-<view>.txt <out.png>` | ~free | Gemini `gemini-3-pro-image-preview` image gen works even while Gemini TEXT billing is 403'd. Prompts: strict T-pose, separated arms w/ armpit gaps, short skirt so both legs read, anti-webbing clauses. SIDE view: foreshorten the near arm to a stub — a forward-reaching side arm makes i2m grow a phantom 2nd arm (cost 2 paid re-rolls on Cronus). |
| 2 | **APPROVAL GATE** | show turnarounds to the user | — | MANDATORY before any paid step. |
| 3 | Mesh gen | `bun scripts/hermes-pipeline/meshy-i2m.ts <slug>` → `<slug>-mesh/raw.glb` | **PAID** | fal `fal-ai/meshy/v6/multi-image-to-3d`, HQ settings pinned in script (quad, 60k polys, 4096 tex, remesh, PBR, auto symmetry). **NEVER use `fal-i2m.ts` (Tripo) for realistic characters** — its low/cartoon settings produced the demented faces. **NEVER run a paid fal call without explicit per-call user permission.** |
| 4 | QC | `blender --background --python scripts/hermes-pipeline/blender-preview-glb.py -- <ABS raw.glb> <ABS outdir>` | free | View EVERY ortho angle (front+side+back) — phantom arms hide in the front view. ABS paths only (headless Blender resolves relative paths against `C:\`). |
| 5 | Weld + Mixamo FBX | `blender --background --python scripts/hermes-pipeline/blender-glb-to-fbx-mixamo.py -- <ABS raw.glb> <ABS out.fbx> 0` | free | **Meshy faces -Y → rotateZdeg=0** (Tripo faced +X and needed -90). `bake_space_transform=False` (True imports SIDEWAYS in Mixamo → manual rotate → wrong arm rig). Verify dead-front: bbox X (armspan) ≫ Y (depth). |
| 6 | Auto-rig | **manual Mixamo web upload** (user does this — no rigging API exists) | free | Upload FBX → place markers → Download as **FBX Binary, T-pose, With Skin**. Mixamo preview always looks rough — that's their viewport, not the mesh. Paid alternative: `meshy-rig.ts` (fal `fal-ai/meshy/rigging`) — needs per-call permission. |
| 7 | VRM finalize | `blender --background --python scripts/hermes-pipeline/blender-vrm-finalize-rigged.py -- <slug> <ABS rigged.fbx> <ABS avatars/<slug>.vrm> [mtoon]` | free | THE script for Mixamo-rigged FBX with embedded textures. Imports at NATIVE scale + **asserts 1.0–2.6 m height** (this FBX lands ~1.91 m at scale 1.0; the older `blender-vrm-finalize-cli.py` `global_scale=100` is ONLY for cm-unit FBX and would produce a 191 m avatar). Keeps embedded material/texture (no GLB re-extract → can't grab the normal map by mistake), gentle 1e-5 dedup, 22/22 humanoid bones, VRM 1.0. |
| 8 | Manual cleanup | per-character Blender scripts (e.g. circlet/jewelry modeling) | free | See "Jewelry rule" below. Hermes needed several of these passes (weld islands, dress re-weight, skirt rig, MToon). |
| 9 | Optimize | `assets:optimize` | free | 18.5 MB → ~2 MB (hermes-female is 1.7 MB). Bump `?v=N` on any mutated asset URL (CF edge TTL 7 days, no purge scope). |

## Jewelry / fine-accessory rule

Thin ornate metal (forehead circlets, diadem filigree, fine chains) does **not** survive image-to-3D — every tool melts it into a soft raised band. Re-rolling the generation does NOT fix it (fundamental limitation, not settings — don't spend credits on it). Fix: **model the accessory as real geometry in Blender** (band + pendant, gold material), weight it 100% to `mixamorig:Head`, export with the body. Never texture-repaint it — flat painted-on accessories were already rejected ("shoes are just a texture on the leg").

## Which finalize script when

| Script | Use when |
|--------|----------|
| `blender-vrm-finalize-rigged.py` | Mixamo-rigged FBX that already embeds textures (the Meshy→Mixamo path). Native scale + height assert. **Default.** |
| `blender-vrm-finalize-with-textures.py` | Mixamo round-trip LOST textures → re-attach from the source GLB. Optional `rotateZdeg`. |
| `blender-vrm-finalize-cli.py` | Legacy cm-unit FBX (`global_scale=100` hardcoded — wrong for the Meshy path). |

## QC viewers (local, Iris-Xe-safe WebGL)

`bun scripts/hermes-pipeline/serve-public.ts apps/web/public 8123` → `http://localhost:8123/vrm-viewer.html` (three-vrm, real engine) and `/glb-viewer.html` (raw Meshy mesh). Never trust Blender viewport shading for final judgment — alpha-HASHED preview + AgX view transform both lie; force OPAQUE + Standard.

## Asset layout per slug

`apps/web/public/models/<slug>-turnaround/` (approved turnarounds + source-ref) · `<slug>-mesh/` (`raw.glb` paid Meshy output, `<slug>-rigged-meshy.fbx` rigged, previews) · `apps/web/public/avatars/<slug>.vrm`.
