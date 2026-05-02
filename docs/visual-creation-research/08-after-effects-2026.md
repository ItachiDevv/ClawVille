# Adobe After Effects 2026 — Field Guide for the Pineapple House Canvas Creator Agent

> Compiled 2026-05-01. [NEW] = past 30 days. [STABLE] = older but current. **Note:** the brief said "v25.x" — actual current internal version is **26.x**, with 26.2 shipping mid-April 2026. Marketing brand is "After Effects 2026".

---

## 1. What AE 2026 (v26.x) is + the core model

**Production build: 26.2.1 (April 2026 release).** AE is Adobe's compositing, motion-graphics, and 2.5D/3D VFX application — the canonical tool between "the editor's timeline" (Premiere) and "the final render".

### Mental model
- **Project (.aep / .aepx)** — top-level container.
- **Composition ("comp")** — timeline + viewport with width/height/PAR/duration/fps. Fundamental render unit. Every comp is itself a layer-able item (this enables pre-comping).
- **Layers** — Footage, Solid, Shape, Text, Adjustment, Camera, Light, Null. Each has Transform (Anchor Point, Position, Scale, Rotation, Opacity), Audio, Effects, Masks, Layer Styles.
- **Timeline + keyframes** — every animatable property is a curve. Linear/Bezier/Hold/Auto-Bezier interpolation. Easing in **Graph Editor** (toggle in timeline header). Two graph modes: Value and Speed.
- **Masks** — bezier paths drawn directly on a layer; Add/Subtract/Intersect/Difference/Lighten/Darken; per-mask feather + expansion + opacity.
- **Track Mattes** — one layer's alpha or luminance drives another's transparency. Alpha/Alpha Inverted/Luma/Luma Inverted Matte. As of AE 22+, mattes are layer-attached (not adjacent-layer-required).
- **Parenting + Nulls** — pick-whip a child to a parent (or null) to inherit Transform. Null hierarchies are how riggers build skeletons before bone plugins (Duik, RubberHose).
- **Expressions** — JavaScript that drives any property. Two engines: **Legacy ExtendScript** (ECMAScript 3) and **JavaScript** (V8, ECMAScript 2018, ~5× faster at render). Selectable per-project at File → Project Settings → Expressions.
- **Pre-comps + nesting** — "Pre-compose" wraps selected layers into a child comp. **Collapse Transformations** (sun-icon switch) is the load-bearing toggle: ON = child's transforms+3D+effects collapse into parent's render pipeline (better quality, render order changes); OFF = child renders flat to a 2D layer first.
- **Render Queue vs AME** — Render Queue is built-in, blocking, fast. AME is async, queue-based, supports H.264/HEVC/MP4 properly.
- **Effects (third-party engine)** — 1000+ Adobe-built + entire third-party ecosystem (Boris FX, Red Giant, Video Copilot) plug into the same AEGP/AEFX C++ SDK.

### Panels you actually touch
Project · Composition · Timeline · Effect Controls · Effects & Presets · **Essential Graphics** (MOGRT authoring) · **Essential Properties** · Tracker · Content-Aware Fill · Roto Brush · Lumetri Scopes · Render Queue · Preview · Audio · **Quick Apply** [NEW April 2026 — Cmd/Ctrl+Shift+E to fuzzy-search every effect, preset, and menu command].

---

## 2. AI features

### Roto Brush 3 [STABLE]
Current production rotoscoping tool. AI segmentation model; replaced optical-flow-based v2. Paint a foreground stroke on one frame; AE propagates the matte forward and back, handling occlusion + fast motion better than v2. Refine Edge Tool catches semi-transparent regions (hair, motion blur). Output is alpha matte; pair with Refine Matte effect to clean.

### Object Matte [NEW — April 2026, AE 26.2]
**The headline AI feature of the past 30 days.** Single-click subject selection — click on a person/car/prop in one frame and AE generates + tracks the matte across the shot. No painting required. Built on the same vision model powering Premiere's Object Mask. Coexists with Roto Brush 3 (Object Matte = fast first pass, Roto Brush 3 = surgical refinement).

### Content-Aware Fill (video) [STABLE, with 2026 fixes]
Mask out an unwanted object → AE extrapolates background across all frames. Supports a **Reference Frame** workflow: click "Create Reference Frame" → opens a still in Photoshop → clean manually (Healing/Clone/Generative Remove) → "Generate Fill Layer". Reference frame becomes truth source the algorithm propagates. **Known 2026 bug:** CAF stalls after 1st/last/2nd frame in some 16-bit projects — workaround: switch project to 8 bpc until patched.

### AI Motion Tracking — 3D Camera Tracker + Mocha AE [STABLE]
- **3D Camera Tracker** — built-in, analyzes parallax, rebuilds virtual 3D camera + point cloud. Drop nulls/text/solids into the cloud.
- **Mocha AE** — Boris FX's planar tracker bundled free with AE since 2019. Better than built-in for planar surfaces (signs, screens, walls). Full **Mocha Pro** is paid upgrade with PowerMesh non-planar tracking.

### Firefly Video integration [NEW — 2026 rollout]
Firefly Video Model went from beta to integrated across Premiere + AE in early 2026. In AE, Firefly outputs auto-sync to Creative Cloud Libraries and are instantly droppable as footage layers.
- **Generative Extend** — drag clip's tail past real end; Firefly hallucinates 2–5 seconds of plausible continuation. Lives in Premiere natively; AE consumes via CC Libraries.
- **Generative Fill (video)** — frame-coherent inpainting; functionally CAF replacement on simple shots.

Firefly Video is commercially safe (Adobe Stock + licensed). Credit-based; programmatic access requires Firefly Services enterprise license.

### Generative video plugins (third-party)
- **Topaz Video AI** [NEW April 2026]: **Starlight Precise 2.5** (face/skin/text fidelity, 12GB+ VRAM NVIDIA local-only) and **Astra 2** (cloud, prompt-driven, Creativity/Sharpness sliders). Released in Topaz "Next-Gen" launch.
- **Wonder Studio** (Autodesk-acquired 2024) — auto rotoscope + replace humans with 3D CG characters; outputs to AE/Maya/Blender. Cloud-based.
- **Boris FX Continuum 2026** [NEW] — adds **BCC+ Face ML** (auto-mask facial features), **BCC+ Jump Cut Fixer ML** (optical-flow seamless cut bridging), **BCC+ Depth Wipe ML** (AI depth-map transitions). $325/yr or $48/mo.
- **Red Giant Magic Bullet** — color grading; Looks + Cosmo for skin retouch + Mojo for cinematic LUTs. Latest: Red Giant 2025.3 / Universe 2025.2; no 2026 release yet.
- **Runway** — does NOT ship a first-party AE plugin; workflow is "render in Runway → import MP4 to AE".

### The "AI roto + replace" pipeline (canonical AE 2026 recipe)
1. **Object Matte** (or Roto Brush 3) → isolate subject → pre-compose with alpha.
2. Duplicate original layer below; mask out subject region on duplicate.
3. **Content-Aware Fill** with Photoshop-cleaned **Reference Frame** → generate clean background plate.
4. Drop new background footage / Firefly Generative Fill output between plate and matted subject.
5. Color-match (Lumetri/Magic Bullet Looks), add depth-of-field (Camera Lens Blur), motion-blur match (CC Force Motion Blur or RSMB).

---

## 3. Editions + pricing (US, May 2026)

| Plan | Monthly | What you get |
|---|---|---|
| AE single-app (individual) | **$22.99/mo** | AE + 100 GB cloud + Firefly credits |
| Creative Cloud All Apps (individual) | **$59.99/mo** | All Adobe apps |
| AE single-app (Teams) | **$37.99/mo per license** | + 1 TB + admin console + 24/7 support |
| Creative Cloud All Apps (Teams) | **$89.99/mo per license** | All apps + team admin |
| Free trial | 7 days | Full functionality |

**Network rendering** — AE Render Engine still works in 2026 (install AE, drop `ae_render_only_node.txt` file, no GUI license needed).

---

## 4. Scripting + automation

### ExtendScript [STABLE — still canonical for AE in 2026]
Adobe's legacy JS engine. ECMAScript 3. Files: `.jsx` (source) and `.jsxbin` (obfuscated binary). **UXP migration has NOT yet reached After Effects** as of April 2026 — UXP covers Photoshop/InDesign/XD; AE is still ExtendScript-only for scripting (expressions can use the modern V8/JavaScript engine independently). Premiere's ExtendScript EOL (Sept 2026) does NOT apply to AE. De-facto reference: **`ae-scripting.docsforadobe.dev`**.

```javascript
// save as create-title.jsx, run via File → Scripts → Run Script File
app.beginUndoGroup("Create Title");
var proj = app.project;
var comp = proj.items.addComp("Logo Sting", 1920, 1080, 1.0, 5, 30);
comp.openInViewer();
var textLayer = comp.layers.addText("ClawVille");
var textProp = textLayer.property("Source Text");
var textDoc = textProp.value;
textDoc.fontSize = 180;
textDoc.fillColor = [1, 0.95, 0.2];
textDoc.font = "Arial-BoldMT";
textProp.setValue(textDoc);
var scale = textLayer.property("Transform").property("Scale");
scale.setValueAtTime(0, [0, 0]);
scale.setValueAtTime(1, [100, 100]);
var ease = new KeyframeEase(0, 75);
scale.setTemporalEaseAtKey(2, [ease, ease, ease], [ease, ease, ease]);
app.endUndoGroup();
```

### `aerender` CLI [STABLE]
Headless render binary next to `AfterFX.exe`/`AfterFX.app`. Drives Render Queue without GUI — used by nexrender, custom render farms, CI pipelines.

```bash
"C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\aerender.exe" ^
  -project "C:\proj\title.aep" ^
  -comp "Final" ^
  -output "C:\out\title_[#####].png" ^
  -OMtemplate "PNG Sequence" ^
  -RStemplate "Best Settings" ^
  -mp ^
  -mfr ON 90
```

`-mp` enables multi-machine; `-mfr ON 90` enables Multi-Frame Rendering at 90% CPU. MFR can boost render up to 30% with high-end GPU; VRAM usage rises 1.5–3× vs single-frame.

GPU acceleration: AE 2026 supports CUDA on Windows (NVIDIA only for hardware-encoded H.264/HEVC), Metal on macOS Apple Silicon, OpenCL deprecated for compute.

### Templates — `.aep`, `.mogrt`, Essential Graphics panel
**Motion Graphics Template (`.mogrt`)** is a parameterized comp wrapper. Author in AE: Window → Essential Graphics panel → drag any property (text source, slider, color, dropdown, font, video footage replacement) onto panel → "Export Motion Graphics Template" → installs into Premiere's Essential Graphics panel.

Programmatic .mogrt override via **Adobe Firefly Services Dynamic Graphics Render API** (the production path for "fill template with data, render N variants"):

```bash
curl -X POST https://video.adobe.io/v3/dynamic-graphics-render \
  -H "Authorization: Bearer $ADOBE_FIREFLY_TOKEN" \
  -H "x-api-key: $ADOBE_CLIENT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "template": { "url": "https://cdn.example.com/lower-third.mogrt" },
    "overrides": [
      { "name": "Headline",   "type": "text",  "value": "ClawVille Live" },
      { "name": "Subhead",    "type": "text",  "value": "Reef Race Finals" },
      { "name": "BrandColor", "type": "color", "value": "#FFD93D" }
    ],
    "output": { "format": "mp4", "resolution": "1920x1080" }
  }'
```

### Adobe IO Firefly Services for video — current state
Real, but enterprise-only. Endpoints:
- **Avatar API** — text/audio → talking-head video.
- **Dynamic Graphics Render API** — drives MOGRTs at scale.
- **Translate + Lip Sync API** — dub video to N languages, mouth-shape matched.
- **Reframe API** — auto-crop 16:9 → 9:16 / 1:1.
- **Text-to-Speech API** — voice synthesis.

OAuth server-to-server only. No consumer API key. ~80–120 hr engineering for production integration.

### Open-source automation: `nexrender`
Production-grade JS framework wrapping `aerender` with templating, asset prefetch, queue management. The standard answer for "Node.js service that takes JSON → renders an AE comp" without paying for Firefly Services.

---

## 5. Plugin ecosystem 2026

| Vendor | Suite | What it does | 2026 status |
|---|---|---|---|
| **Boris FX** | **Continuum 2026** | 700+ effects, BCC+ Face ML, Primatte chromakey, Title Studio | [NEW] late 2025/early 2026, major AI additions |
| Boris FX | **Sapphire 2026** | High-end VFX (lens flares, glows, distortion, Mocha-tracked S_Effects) | [NEW] adds AI whip transition, Pro Lens Flare Pack |
| Boris FX | **Mocha Pro** | Planar tracking, PowerMesh, screen replace | [STABLE] |
| Boris FX | **Silhouette** | Pro rotoscoping/paint | [STABLE] |
| **Maxon Red Giant** | **Magic Bullet** | Color grading (Looks, Colorista, Mojo, Cosmo) | [STABLE] 2025.3 |
| Red Giant | **Trapcode** | Particles + 3D (Particular, Form, Mir, Tao, Shine) | [STABLE] |
| Red Giant | **Universe** | Stylized transitions + effects | [STABLE] 2025.2 |
| Red Giant | **PluralEyes** | Multi-cam audio sync | [STABLE] |
| Maxon | **Cinema 4D Lite** | Bundled free with AE; "Cineware" pipeline | [STABLE] still bundled |
| **Video Copilot** | **Element 3D V2** | GPU-accelerated 3D model rendering inside AE; OBJ/C4D import | [STABLE] |
| Video Copilot | **Optical Flares** | Lens flare designer | [STABLE] v1.3.8; needs Apple Silicon native |
| Video Copilot | **Saber** | Energy beams / lightsabers | [STABLE] free |
| **aescripts+aeplugins** | marketplace | Top tools below | [STABLE] |
| aescripts | **Stardust** | Node-based 3D particles (rivals Trapcode) | [STABLE] |
| aescripts | **Plexus** | Geometric particle networks | [STABLE] |
| aescripts | **Newton 4** | 2D physics simulator | [STABLE] |
| aescripts | **Bodymovin** | Lottie JSON exporter (free) | [STABLE] |
| aescripts | **LottieFiles for AE** | Alt Lottie exporter; imports Lottie JSON | [STABLE] |
| aescripts | **Duik Ángela** (post-Bassel) | Free industry-standard rigging | [STABLE] |
| aescripts | **Limber** | Procedural IK limbs | [STABLE] |
| aescripts | **RubberHose 3** | Fastest-possible character rigging | [STABLE] |
| aescripts | **Joysticks 'n Sliders** | Pose-blend controllers | [STABLE] |
| aescripts | **Overlord** | Bidirectional Illustrator ↔ AE shape-layer transfer | [STABLE] |

---

## 6. Use case map

| Workflow | Recipe |
|---|---|
| **Logo sting (motion graphics intro)** | New comp 1920×1080 30fps 5s · import logo (AI/PSD layered) · Trim Paths + scale-up keyframes · Trapcode Shine for ray pulse · Audio sting · render via AME H.264 |
| **Title sequence + lower thirds** | Author in AE → Essential Graphics panel exposes Headline/Subhead/Color/Logo → Export `.mogrt` → editor in Premiere applies to every interview |
| **Green-screen VFX shot** | Footage → **Keylight 1.2** (despill + matte) → **Refine Matte** for hair → 3D Camera Tracker on background plate → composite + match grade |
| **Lottie web animation** | Shape layers only (no rasters, no effects, no expressions Bodymovin doesn't support) → File → Scripts → Bodymovin → Render → JSON → host with `lottie-web` / `lottie-react` |
| **Game cinematic (pre-rendered)** | Output PNG sequence (alpha) for VFX layers + Apple ProRes 4444 master; transcode to platform-specific codec (BC7 + AVIF for web, H.264 for in-game splash, .webm VP9 for cross-platform) |
| **2D character rig** | Illustrator art → Overlord → AE shape layers → Duik Ángela auto-rig OR RubberHose 3 + Joysticks 'n Sliders for face poses |
| **Data-driven motion graphics** | CSV/JSON → AE expression `footage("data.json").sourceData` (AE supports JSON footage natively) OR Essential Graphics + Firefly Services Dynamic Graphics Render API for batch |
| **AI re-composite (the headliner)** | Object Matte → pre-comp · CAF + Reference Frame → clean plate · drop new BG plate · Lumetri match · CC Force Motion Blur match · Camera Lens Blur for DOF |

---

## 7. Past 30-day shifts

- **2026-04-15** — **AE 26.2** ships: **Object Matte** (single-click AI subject isolation), **Quick Apply** (fuzzy command/effect search), **Proportional Scrubbing**, **3D Material displacement on parametric meshes**, improved SVG import.
- **April 2026** — **Topaz "Next-Gen"** drop: **Starlight Precise 2.5** + **Astra 2** released as Topaz Labs' largest single AI-model release ever.
- **Q1 2026** — **Boris FX Continuum 2026** with BCC+ Face ML, Jump Cut Fixer ML, Depth Wipe ML.
- **2026** — **Firefly Video** integration deepens across PP + AE.
- **STABLE** — **UXP for AE: still not shipping.** ExtendScript remains canonical. Premiere's ExtendScript EOL (Sept 2026) does NOT apply to AE.
- **April 2026 known bug** — **Compressed Disk Caching** crashes some configs — disable at Preferences → Disk → Disk Cache → uncheck "Enable Compressed Frames (Lossless)".
- **April 2026 known bug** — **Content-Aware Fill** stalls in some 16-bit projects after fill of 1st/last/2nd frame; downgrade to 8 bpc as workaround.

---

## 8. Common gotchas

1. **Pre-comp + Collapse Transformations** — turning collapse ON changes render order; effects on parent evaluate AFTER collapsed children.
2. **Expression engine mismatch** — opening a Legacy ExtendScript project file with the JavaScript engine selected breaks expressions relying on `.value` implicit, loose `if/else`, or `Number(x)` quirks.
3. **8 bpc vs 16/32 bpc** — banding in gradients/glows means 8 bpc; bump to 16. But MFR uses 1.5–3× VRAM in higher bit depths, and CAF can stall.
4. **MFR thread starvation** — 24+ logical cores starve on heavy effects (Particular, Element 3D); per-thread VRAM blows up. `-mfr ON 50` or `-mfr ON 70` is often faster than 90.
5. **CUDA vs Metal vs OpenCL** — AE 2026 picks based on OS. Intel/AMD on Windows fall back to CPU for many GPU-accelerated effects.
6. **"Missing footage" hell** — collaborative projects break when paths differ. **File → Dependencies → Collect Files** to bundle.
7. **Output Module 2GB-cap MOV surprise** — legacy QuickTime MOV writer hits 2 GB ceiling; pick "Apple ProRes 4444 (in MOV)" via QuickTime container, or render PNG/EXR sequence.
8. **.mogrt parameter type quirks** — Slider Control min/max in AE expression bind to the slider, but the `.mogrt` Essential Graphics control adds its own min/max that must match.
9. **Apple Silicon Rosetta-only plugins** — AE 24+ refuses Rosetta; an Intel-only plugin shows as "missing" or crashes load.
10. **Compressed Disk Cache** crash regression in 2026 — disable in prefs.

---

## 9. Resources

- AE Help Center: `helpx.adobe.com/after-effects/user-guide.html`
- Release Notes: `helpx.adobe.com/after-effects/release-note/release-notes-after-effects.html`
- AE Scripting Guide (de-facto reference): `ae-scripting.docsforadobe.dev`
- AE C++ Plugin SDK Guide: `ae-plugins.docsforadobe.dev`
- Firefly Services: `developer.adobe.com/firefly-services/docs/`
- Firefly Audio/Video API: `developer.adobe.com/audio-video-firefly-services/`
- aescripts + aeplugins: `aescripts.com`
- Boris FX learning hub: `borisfx.com/learn/`
- School of Motion: `schoolofmotion.com`
- nexrender (open-source): `github.com/inlife/nexrender`
