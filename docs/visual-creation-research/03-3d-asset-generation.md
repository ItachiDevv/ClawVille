# AI 3D Asset Generation — State of the Art (May 2026)

> Audience: agents and devs building 3D assets that ship into a Three.js world. Recency bias on the past 30 days. `[NEW]` = released or materially updated in April 2026; `[STABLE]` = mature.

---

## Tool-by-tool

### Tencent Hunyuan 3D 2.5 / 3.0 / PolyGen `[NEW core stack]`
- Hunyuan3D-2.5 released 2025-04-23 (1024-res, 10B-param geometry, 4K PBR textures); **Hunyuan3D-PolyGen (2025-07-08)** is the retopology head producing all-quad / quad+tri meshes ready for rigging. Continuous Blender-addon and ComfyUI 2.1 updates throughout April 2026.
- Output: GLB / OBJ / FBX. PolyGen path produces **quad-dominant topology** — currently the best public auto-retopo on the market.
- Topology: game-ready quads via PolyGen; raw 2.5 path is denser tri-soup.
- Rigged OOTB: yes — "Auto-Rig" toggle creates spine/arms/legs joints, expects T/A pose. Bone names are Hunyuan-native (not `mixamorig:*`); plan to retarget.
- Texture: PBR with bump, multi-view PBR, up to 4K.
- Best at: stylised characters and creatures with clean topology after PolyGen. Worst at: hard-surface mechanical detail (softens edges).
- Pricing: free tier 20/day on official site; commercial via Tencent Cloud API. Open-source 2.1 weights on HF.
- API: Tencent Cloud API; **Replicate** `tencent/hunyuan3d-2`; **fal.ai**; first-party **blender-mcp** addon (`mcp__blender__generate_hunyuan3d_model` already wired in this repo).
- Latency: ~30–90s via API; ~1–2 min self-hosted on a 4090.
- Tip: render input image on clean white/transparent bg, feed roughly front-3/4 view; PolyGen's topology cleanup degrades sharply on busy backgrounds.

### Tripo 3.0 / 3.0 Ultra `[NEW]`
- Tripo 3.0 official release 2026-01-27, **Algorithm 3.1** (200B+ params) actively rolling, Tripo Studio AI texturing tools updated 2026-04-03.
- Output: GLB, FBX, OBJ, USDZ. Standard mode ~30–80k tris; **Ultra mode** up to 2M polys.
- Rigged OOTB: yes — exports T-pose with skeleton. **Most reliable auto-rig on humanoids of any current API**; bone naming Tripo-native, retargets cleanly to Mixamo via Auto-Rig Pro or AccuRIG 2.
- Texture: 4K PBR. Magic Brush local repaint (April 2026).
- Best at: humanoid characters with rig — fastest rigged-character pipeline available. Worst at: tiny props at <500-tri budgets.
- Pricing: free ~600 credits/mo; Pro $20/mo; Studio $40/mo.
- API: first-party Tripo API; **fal.ai**; **Replicate**.
- Latency: 8–10s text-to-textured-mesh in standard; 30–60s in Ultra.
- Tip: always request T-pose explicitly for characters — Tripo defaults to A-pose if you say "stand", and Mixamo retargets break on A-pose.

### Rodin Gen-2 / Gen-2 Edit (Hyper3D) `[NEW Edit features]`
- Gen-2 stable; **Gen-2 Edit unveiled January 2026**, patch updates through April 2026 (T/A-pose enforcement, alpha respect, recursive part-based generation).
- Output: GLB, FBX, OBJ, USDZ.
- Topology: marketed as "4× improved geometric mesh quality". Recursive part-based generation produces cleanly separated parts (head/body/arms separate by default — useful for skinning and modular cosmetics).
- Rigged OOTB: no native rig, but T/A-pose enforcement makes downstream Mixamo / AccuRIG painless.
- Texture: PBR 2K–4K, **respects input image alpha** (only major API that does this reliably).
- Best at: hard-surface props, mechanical detail, modular gear. Worst at: stylised cartoon characters (outputs lean realistic).
- Pricing: business subscription gates Gen-2 (`tier=Gen-2`); credit-based.
- API: first-party `api.hyper3d.com/api/v2/rodin`; **fal.ai** (`fal-ai/hyper3d/rodin`); **Replicate** (`hyper3d/rodin`); **blender-mcp** (`mcp__blender__generate_hyper3d_model_via_text|images` — in this repo's MCP set).
- Latency: 60–120s.
- Tip: pass `tier=Gen-2` and explicitly set `tapose=true`; without the flag you'll get an action-pose mesh that breaks every retarget.

### Meshy 6 `[NEW]`
- v6 released 2026-01-18; v6 API Playground + nano-banana / nano-banana-pro Text-to-Image and Image-to-Image APIs added April 2026.
- Output: GLB, FBX, OBJ, USDZ, STL, BLEND. **Low-Poly mode** (new in v6). Quad output available.
- Rigged OOTB: yes for humanoids — Meshy auto-rigs to Mixamo-compatible bone names (`mixamorig:*` style on FBX export). **Friendliest for `three-vrm` retargeting and Three.js AnimationMixer.**
- Texture: PBR up to 4K.
- Best at: stylised game props with low-poly toggle. Best Mixamo bone-name compatibility. Worst at: photoreal humans (faces uncanny).
- Pricing: free; Pro $20/mo; Max $60/mo. v6 preview = 20 credits, v6 full textured = 30 credits.
- API: first-party Meshy API + Playground; **fal.ai**; **Replicate**.
- Latency: 20–60s.
- Tip: for Three.js, use **Low-Poly mode** + GLB + Draco — you get a 200–500KB asset that drops straight in without retopo.

### CSM / Cube `[DEPRECATED]`
- **Cube shutting down 2026-01-05.** Migrate parts-based workflows to Rodin Gen-2 (recursive parts) or Hunyuan PolyGen (clean retopo).

### Microsoft TRELLIS.2 `[NEW]`
- TRELLIS.2-4B released December 2025, ComfyUI wrappers and pipeline integrations active through April 2026.
- Output: GLB with PBR materials including opacity. Sparse voxel ("O-Voxel") backbone.
- 512³ in ~3s, 1024³ in ~17s, 1536³ in ~60s on H100.
- Rigged OOTB: no.
- Texture: PBR with **full opacity channel** — handles hair, leaves, foliage cards correctly (rare for AI 3D).
- Best at: complex topology with transparency. Worst at: animatable characters.
- Pricing: open-source weights, free.
- API: self-host via HF; ComfyUI wrappers (`visualbruno/ComfyUI-Trellis2`); demo on `trellis2.com`.
- Tip: 1024³ tier is game-ready — 512³ has voxel artifacts, 1536³ over-budget for browser.

### Stable Fast 3D / TripoSR `[STABLE]`
- Stability + Tripo. SF3D is maintained TripoSR successor (UV unwrap + illumination disentanglement built in).
- Output: GLB, OBJ. Sub-second image-to-3D.
- Pricing: open-source; ~$0.07/call on fal.
- Best at: sub-second prop iteration. Use SF3D for "iterate on 50 prop concepts in 5 minutes", then re-roll winners through Hunyuan / Rodin for production mesh.

### Polycam / Luma AI / Scaniverse / KIRI Engine `[STABLE — capture]`
- Mobile capture-to-Gaussian-Splat and capture-to-mesh. **Luma Genie sunset 2026-01-01.**
- Polycam exports 15+ formats including PLY, OBJ, FBX, USDZ, GLTF, DAE.
- Topology: photogrammetry-quality mesh = noisy, requires retopo for animation. **Splats render directly via Three.js' Gaussian-splat libraries** (Mark Kellogg's `GaussianSplats3D`).
- Tip: for Three.js, ship the **splat** (not the mesh) when the asset is static set-dressing — looks dramatically better at the same byte cost.

### AccuRIG 2 (Reallusion) `[STABLE — Mixamo replacement]`
- Free auto-rigger; outputs FBX with `mixamorig:`-compatible naming. **Better than Mixamo in 2026** (Mixamo dev stalled, Adobe hasn't updated it in years).
- Best at: adding skeletons to AI-generated meshes that came out unrigged (Rodin, TRELLIS, SF3D).

### Mixamo `[LEGACY — still works]`
- Adobe. Still online, free, no updates. **Tip:** use only as the animation-clip library; rig with AccuRIG 2 or Tripo, then upload to Mixamo for the clip.

### Animate3D `[STABLE research]`
- Multi-view video diffusion + 4D-SDS to animate ANY static 3D model. NeurIPS 2024, code/weights public, MV-Video dataset (84K animations / 1.3M videos).
- Use the local `animate3d` skill (already configured) when input is a rigless GLB.

### Animate Anyone 2 / MimicMotion / Champ `[STABLE — 2D-video animation, not 3D]`
- These animate **a 2D image of a character** following a pose sequence — output is MP4, not a rigged 3D animation. Wrong tool for Three.js-playable AnimationClip; right tool for promo content.

---

## Decision tree

| Goal | Pick | Why |
|---|---|---|
| **Humanoid character (game-ready, rigged)** | **Tripo 3.0 Ultra** → AccuRIG 2 retarget → Mixamo clips | Cleanest auto-rig + T-pose enforcement |
| **Stylised character with clean quad mesh** | **Hunyuan PolyGen** → AccuRIG 2 | Best-in-class auto-retopo |
| **Creature / non-humanoid character** | **Rodin Gen-2** (parts-based) → manual rig in Blender | Recursive parts segmentation |
| **Hard-surface prop (mechanical, weapon, vehicle)** | **Rodin Gen-2 Edit** | Sharp edges, alpha respect |
| **Stylised game prop, low-poly budget** | **Meshy 6 Low-Poly** | Built-in low-poly mode, 200–500KB |
| **Iteration / concepting (50 variants fast)** | **Stable Fast 3D** via fal.ai | Sub-second, $0.07/call |
| **Foliage / hair / transparent geometry** | **TRELLIS.2** @ 1024³ | Only model with proper opacity-channel PBR |
| **Texture-only on existing mesh** | **Meshy 6** "Texture" mode or **Tripo Studio Magic Brush** | Both accept GLB upload |
| **Animation-only on existing rig** | **Mixamo** clip library (rig with AccuRIG 2 first) | Free, vast clip library still wins |
| **Animation on un-rigged static GLB** | **Animate3D** (local skill) | 4D-SDS pipeline animates without rig |
| **Capture real object → 3D mesh** | **Polycam** → mesh export | Best multi-format export |
| **Capture real environment → render** | **Scaniverse** (free) → splat → Three.js splat viewer | Best free splat capture |

---

## Past 30-day shifts

- **Tripo Studio AI texturing tools** (2026-04-03) — Magic Brush local repaint, smarter PBR map generation. `[NEW]`
- **Meshy 6 API Playground + nano-banana models** (April 2026) — interactive playground. `[NEW]`
- **fal.ai April 2026 launches** — Seedance 2.0 (2026-04-09, video) and GPT Image 2 (2026-04-21) raise quality of front-view character renders that feed image-to-3D pipelines. `[NEW adjacent]`
- **CSM Cube shutdown** finalised through Q1 — migrate to Rodin Gen-2 or Hunyuan PolyGen. `[DEPRECATED]`
- **Luma Genie sunset** (2026-01-01) — capture-to-mesh consolidates around Polycam / Scaniverse. `[DEPRECATED]`
- **Mixamo de-facto deprecated as auto-rigger** — community migrated to AccuRIG 2 and Tripo for auto-rig, kept Mixamo only for clip library.

---

## glTF / GLB pipeline gotchas (Three.js specific)

1. **Y-up vs Z-up.** glTF spec is **Y-up**. Blender is Z-up. Always export from Blender with `+Y Up`. Never rotate the GLB on import to "fix it" — breaks every animation track.
2. **Draco is for geometry, KTX2 for textures, meshopt overlaps both.** Pick one geometry compressor (Draco OR meshopt) and one texture compressor (KTX2). Combining Draco + meshopt on the same mesh is invalid per spec.
3. **`three/addons` vs `three-stdlib` KTX2Loader trap.** Use `three/addons/loaders/KTX2Loader.js`. The `three-stdlib` copy is **WebGL-only** and crashes silently under WebGPU. Has bitten ClawVille before.
4. **GLTFLoader requires explicit decoder wiring:**
   ```ts
   const dracoLoader = new DRACOLoader().setDecoderPath('/draco/');
   const ktx2Loader = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
   const loader = new GLTFLoader()
     .setDRACOLoader(dracoLoader)
     .setKTX2Loader(ktx2Loader)
     .setMeshoptDecoder(MeshoptDecoder);
   ```
5. **KTX2 picks wrong format on Iris Xe.** UASTC textures decode to BC7 desktop, ETC2 mobile/Iris Xe. ETC2 has visible banding on smooth gradients — for cartoon GLBs **WebP textures embedded in GLB** can be 4–5× smaller on the wire AND look better.
6. **Meshopt with gzip ≈ Draco file size** at faster decode. Default to **meshopt** for Three.js if your CDN has gzip — better decode latency on low-end CPUs.
7. **AI-generated rigs often skip `skinningMatrices` setup.** Hunyuan and Rodin sometimes export skinned meshes where inverseBindMatrices are slightly off. Symptom: T-pose at frame 0, animation looks "shrunk". Fix in Blender: Object → Apply → All Transforms before re-export.
8. **`SkinnedMesh.frustumCulled = true` is the silent disappear bug.** Three.js calculates bounding box from rest pose; animated character whose limbs leave rest-pose AABB pops out. Always set `frustumCulled = false` on every cloned `SkinnedMesh`.
9. **Mixamo FBX → GLB scale trap.** Mixamo exports in cm (FBX); Three.js / glTF assume meters. Either scale 0.01 in Blender before export OR scale the loaded scene by 0.01 at runtime — don't mix.
10. **VRM is a glTF extension, not a separate format.** A `.vrm` IS a `.glb` with extra `extensions.VRMC_*` metadata. Bones / spring-bones / lookAt only activate via `@pixiv/three-vrm`.
