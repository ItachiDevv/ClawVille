# Adobe Photoshop 2026 — Field Guide for AI Visual-Creation Agents

> Compiled 2026-05-02. Recency cut: past 30 days. [NEW] = past 30 days; [STABLE] = current but older.

---

## 1. What Photoshop 2026 (v27.x) is + the core model

Current shipping desktop build **27.6 (released April 28, 2026)**, paired with a coordinated Lightroom release. 27.5 shipped April 1, 2026 with Firefly Boards integration. Runs on desktop (Win/macOS), Web (`photoshop.adobe.com`), iPad — feature parity for AI workflows is approaching but not yet 1:1.

**Core layer model:**
- **Pixel layers** — raster bitmaps, mutable destructively unless converted.
- **Smart Objects** — embedded/linked container preserving source resolution; non-destructive transforms, smart filters, content replacement (`File > Replace Contents`). Critical for templating.
- **Adjustment layers** — non-destructive Curves, Levels, Hue/Saturation, Selective Color.
- **Shape layers** — vector paths with fill/stroke.
- **Type layers** — live text driven by font + paragraph/character config.
- **Generative layers** [NEW since 25.x] — output of Generative Fill/Expand; pixel layers carrying prompt + variation history.

**Masks:** raster, vector, clipping. Single layer can carry both raster AND vector mask.

**Channels, paths, smart filters, layer comps:** Channels = per-component grayscale + alphas + spot. Paths = vector data (Pen tool). Smart Filters = re-editable when applied to Smart Objects. Layer Comps = named snapshots of layer visibility/position/styles for variant export.

**28 blend modes** including Pass Through (groups only).

**Panels:** Layers, Channels, Paths, Properties, Adjustments, Actions, History, Character, Paragraph, Brushes, Color, Swatches, Info, Histogram, Navigator, Libraries, Layer Comps, Variables (under Image > Variables), Contextual Task Bar (floating AI bar).

**Key tools:** Move (V), Marquee (M), Lasso (L), Object/Quick Selection/Magic Wand (W), Crop (C), Spot Healing/Healing Brush (J), Brush/Pencil (B), Clone Stamp (S), Pen (P), Type (T), Shape (U), Hand (H), Zoom (Z), **Remove Tool** (J cycle), **Selection Brush** [NEW with Generative Fill workflow].

---

## 2. AI features

### Generative Fill / Expand / Workspace
- **Default model = Adobe Firefly Image 5** (Photoshop 27.6, 2026-04-28). Firefly Image 3 retired from the model picker on the same date; will fully sunset in versions 26.0–27.5 by August 2026.
- **Output: 2K resolution** (Image 5 supports 4MP, ~2048×2048 square or 2304×1728 at 4:3).
- **Model Picker** (Contextual Task Bar → Generative Fill → Model button) exposes side-by-side: **Adobe Firefly Image 5**, **Firefly Image 5 Color**, **Google Gemini 3.1 (Nano Banana 2)** [NEW], **Gemini 3 (Nano Banana Pro)**, **Gemini 2.5 (Nano Banana)**, **Black Forest Labs FLUX.2 Pro**, **FLUX.1 Kontext**, **OpenAI GPT-Image**.
- **Reference images** — partner models (FLUX, Gemini) accept multiple reference uploads to lock composition/style/subject identity.
- **Generative Expand** — extend canvas beyond original bounds; same model picker.

### Firefly AI Assistant [NEW — public beta 2026-04-27]
Adobe's "creative agent" — natural-language chat that orchestrates multi-step edits across Photoshop, Lightroom, Premiere, Firefly. Auto-routes between Firefly + partner models based on task. Available to Creative Cloud Pro / Firefly Pro / Pro Plus / Premium subscribers. Includes "Creative Skills" — pre-built single-prompt workflows.

### Remove Tool / Generative Remove / Distraction Removal [NEW in 27.6]
Brushes over an unwanted region; AI generates fill. **Find Distractions** in 27.6 adds **"general distractions"** category (background clutter) on top of the original 26.0 people + wires/cables. 27.6 also adds **Reflection Removal** as a non-destructive layer-generating operation.

### Photoshop Web + iPad parity [NEW]
Both run Generative Fill at the same 2K Firefly Image 5 quality as desktop. AI Assistant beta on web and mobile, including voice input on mobile.

### Firefly Boards integration [NEW since 27.5, expanded in 27.6]
Bidirectional sync via **PSDC (cloud documents)**. Open cloud doc → "Open in Firefly Boards" → explore variations on the board → re-open any variation back in Photoshop with editable layers preserved. Local PSDs only get one-way "Open copy in Photoshop".

### Prompt structure that works
- **Short and specific** — Firefly already reads scene context.
- **Name the object, not the scene** — "Leather armchair" beats "comfortable-looking chair."
- **Skip lighting/color when matching** — model reads from context; over-specifying causes drift.
- **DO describe environment for new content** — "vintage leather chair, harsh directional sunlight from the left, deep shadows".
- **Selection > prompt** — extend selections 10–20% past target so model sees enough context pixels.
- **Empty prompt = remove** — leave prompt blank to fill from surroundings.

---

## 3. Editions + pricing 2026

| Plan | Price | Includes |
|---|---|---|
| Photoshop Single App | $22.99/mo | Desktop + iPad + Web, 100GB |
| Photography Plan (1TB) | $19.99/mo [NEW pricing] | Photoshop + Lightroom + LR Classic, 1TB |
| Photography Plan (legacy 20GB) | $9.99/mo if grandfathered | RETIRED for new subs in 2025 |
| Creative Cloud All Apps | $59.99/mo | All Adobe apps + 100GB |
| Creative Cloud Pro | ~$69.99/mo | All Apps + Pro Firefly credits |
| Firefly Standard | $9.99/mo | 2,000 premium credits |
| Firefly Pro | $19.99/mo | 4,000 credits |
| Firefly Premium | $199.99/mo | 50,000 credits |

**Generative credits:**
- Standard Generative Fill = **1 credit per generation**; Fast mode = **2 credits**.
- Pre-June-17-2025 Photography subs: **100 credits/mo**. Post: **25 credits/mo** unless higher tier.
- **Standard generations are unlimited** for Creative Cloud Pro, Firefly, and credit-bundle subscribers — credits only meter "premium" features.
- Education ~60% off All Apps. 7-day Photoshop trial; Photoshop Web has free entry tier.

---

## 4. Scripting + automation

### Actions (.atn) [STABLE]
Macro recorder. Window > Actions. Record steps → save .atn → run via `File > Automate > Batch`. Non-programmatic. 27.6 ships a redesigned Actions panel.

### ExtendScript (.jsx) [LEGACY, still works]
ES3 JavaScript. Run via `File > Scripts > Browse…`. Adobe says CEP/ExtendScript will be deprecated; use only for legacy maintenance.

```javascript
// JSX — duplicate active layer, offset 100px right, save copy
var doc = app.activeDocument;
var dup = doc.activeLayer.duplicate();
dup.translate(100, 0);
doc.saveAs(new File(doc.path + "/" + doc.name + "_offset.psd"), new PhotoshopSaveOptions(), true);
```

### UXP plugins + UXP Scripts (.psjs) [MODERN]
ES2020+ on V8, async APIs, manifest-based, Spectrum UI components.
- **Plugins** — packaged with `manifest.json`, persistent panel UI, distributed via Adobe Exchange.
- **UXP Scripts (.psjs)** — single-file automations. Run from `File > Scripts`.
- Document mutations must run inside `executeAsModal`.
- **BatchPlay** is the escape hatch — sends raw action descriptors to Photoshop's queue.

```javascript
// UXP — create doc, add adjustment layer, run gen fill
const { app, action, core } = require("photoshop");
await core.executeAsModal(async () => {
  await app.documents.add({ width: 2048, height: 2048, resolution: 300 });
  const doc = app.activeDocument;
  await doc.createLayer({ name: "BG", opacity: 100 });
  await doc.createLayer({ kind: "brightnessContrast", name: "+20% Bright" });
  await action.batchPlay([
    { _obj: "syntheticFill", prompt: "neon coral reef at golden hour",
      _options: { dialogOptions: "dontDisplay" }}
  ], {});
}, { commandName: "Build SKU Frame" });
```

### Photoshop API / Firefly Services [STABLE — server-side]
REST at `developer.adobe.com/firefly-services/docs/photoshop/api/`. Headless. OAuth Server-to-Server. Endpoints: `/v1/fill-masked-areas`, `/v1/mask-objects`, `/v1/refine-mask`, `/v1/photoshop/documents`, smart-object replace.

```bash
curl -X POST https://image.adobe.io/pie/psdService/fillMaskedAreas \
  -H "Authorization: Bearer $IMS_TOKEN" \
  -H "x-api-key: $CLIENT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": [{ "href": "https://presigned/input.psd", "storage": "external" }],
    "options": {
      "prompt": "weathered teak deck planks, warm afternoon light",
      "masks": [{ "href": "https://presigned/mask.png", "storage": "external" }]
    },
    "outputs": [{ "href": "https://presigned/output.psd", "storage": "external", "type": "vnd.adobe.photoshop" }]
  }'
```

Server-side capabilities: open PSD, render thumbnails, replace smart object contents, apply fill mask, edit text layers, export JPG/PNG/PSD. Cannot record/play arbitrary Actions or Neural Filters via API.

### Bridge + Image Processor + Headless Render [STABLE]
Bridge handles batch metadata. `File > Scripts > Image Processor` is the built-in batch resize/format converter.

---

## 5. AI plugin ecosystem

| Plugin | What it does | PS integration |
|---|---|---|
| **Topaz Photo AI** + **Gigapixel** + **Bloom** | Upscale, denoise, sharpen, creative upres | Native panel; Gigapixel + Bloom inside PS's **Generative Upscale** as partner models |
| **Boris FX Optics 2026** | Cinematic effects, AI face masking, depth maps | Dockable Optics Essentials panel inside PS. $149 perpetual / $9 mo / $99 yr |
| **Magnific AI** | Creative upscaling | No native PS plugin (lives at Freepik post-acquisition); round-trip via export/import |
| **Krea** | Realtime gen + enhance | No native PS plugin; uses Topaz under hood |
| **Nano Banana Generative Fill** (aescripts) | Third-party Gemini/Nano-Banana panel for PS | UXP panel before Adobe added native Gemini |

**Default reach:** built-in Generative Fill (Firefly Image 5) for content; Topaz for upscale; Boris FX Optics for cinematic looks. Try partner models inside the picker (Gemini 3 Pro for character consistency, FLUX.2 Pro for photoreal text/textures) before reaching for an external plugin.

---

## 6. Use case map

1. **Brand-consistent product shoot, 50 SKUs** — Master PSD with Smart Object placeholders + text variables (Image > Variables). Smart Objects can't be swapped via Variables panel — write a UXP script that loops a CSV, calls `replaceSmartObjectContents()`, sets text-layer contents, saves JPG. For server-side scale: Photoshop API `documentManifest` + `smartObject.replace`.
2. **Game UI mockup with text + icons + states** — Layer Comps for normal/hover/pressed/disabled. Smart Objects for icon atlas. Export each comp as PNG via UXP loop.
3. **Character concept sheet from one base image** — Generative Expand to widen → Generative Fill in batches with same prompt + reference image (Firefly Image 5 + reference) → variations panel → pin best → flatten poses to one sheet.
4. **Batch background removal on 500 images** — Action + Image Processor (`Select Subject → Inverse → Delete → Save PNG`) OR UXP script calling `removeBackground()` (BatchPlay descriptor) OR Firefly Services `/v1/cutout` if headless.
5. **Style transfer / re-lighting** — Generative Fill with prompt naming new lighting + reference image of target style.
6. **PSD-as-template render farm** — Master PSD with named Smart Objects + text layers → upload to S3 → Photoshop API `documentManifest` to discover layer names → smart-object replace + text edit endpoints with per-row data → export JPG.
7. **Concept art bash** — Sketch on pixel layer → Generative Fill iterations → manual paint → flatten copy → Topaz Bloom upres for hero render.

---

## 7. What shifted past 30 days (2026-04-02 → 2026-05-02)

- **2026-04-01:** Photoshop **27.5** ships — Firefly Boards bidirectional sync via cloud documents.
- **2026-04-15:** Adobe announces Firefly AI Assistant.
- **2026-04-27:** **Firefly AI Assistant enters public beta** for CC Pro / Firefly paid plans.
- **2026-04-28:** Photoshop **27.6** ships:
  - Generative Fill default switches Image 3 → **Firefly Image 5** at **2K**.
  - **Firefly Image 3 retired** from picker.
  - **Gemini 3.1 (Nano Banana 2)** added as partner model.
  - **Reflection Removal** ships (non-destructive layer output).
  - **Find Distractions** adds "general distractions" category.
  - **Rotate in 3D** for flat layers.
  - **AI Layer Cleanup** auto-renames + reorganizes Layers panel.
  - Redesigned **Actions panel**.
  - **Dynamic Text on shapes**, gradient re-editing, updated Contextual Task Bar.
  - Multi-image reference upload for partner models.
- **2026-04-03:** Topaz Photo AI 1.4.0 (PS plugin batch upgrade).
- **2026-04 ongoing:** AI Assistant rollout to Photoshop Web + iPad in beta.

---

## 8. Common gotchas

- **Color profile drift on Gen Fill:** keep working space at **sRGB IEC61966-2.1** when running Gen Fill; Adobe processes in sRGB regardless. Display P3 / ProPhoto documents show edge-color mismatches at selection borders. Convert to sRGB → run Gen Fill → convert back if you need wide-gamut delivery.
- **16-bit smart filters:** several Neural Filters and a handful of Filter Gallery options refuse 16-bit/channel mode.
- **Smart Object Gen Fill resolution cap:** Gen Fill on a smart object is rasterized at the SO's current display resolution — shrink a 4K SO to 800px and Gen Fill into it gives 800px output.
- **Layer-style + Gen Fill interaction:** Gen Fill output ignores existing layer styles on the target layer. Apply Gen Fill BEFORE layer styles or rasterize first.
- **Save-As-JPG silent flatten:** JPG flattens transparency to white silently. PSD/PSB/TIFF preserve layers. PNG preserves transparency but flattens layers.
- **Variables panel does NOT swap Smart Object contents** — only text, pixel layers, visibility. Use `replaceContents()` in script.
- **UXP vs ExtendScript API gaps:** some legacy APIs (full color picker callbacks, certain print options, Neural Filter invocations) aren't in UXP yet — fall through to BatchPlay.
- **Credit consumption is per generation, not per accept:** every "Generate" click costs 1 credit (2 in Fast mode), even if you reject all variations.
- **Photoshop API smart-object replace fails silently if target layer is locked or if layer name has duplicates** — use `id` not `name` when doc has dupes.
- **Firefly Image 5 cannot be commercially safe with reference-image partner models** — Content Credentials only attach to pure Firefly outputs.

---

## 9. Resources

- Photoshop release notes: `helpx.adobe.com/photoshop/desktop/whats-new/photoshop-on-desktop-release-notes.html`
- What's new: `helpx.adobe.com/photoshop/desktop/whats-new/whats-new-in-adobe-photoshop-on-desktop.html`
- Generative Fill help: `helpx.adobe.com/photoshop/desktop/create-open-import-images/create-images/edit-images-with-generative-fill.html`
- Model picker: `helpx.adobe.com/photoshop/desktop/generative-ai/select-an-ai-model-for-generative-control.html`
- Generative credits FAQ: `helpx.adobe.com/creative-cloud/apps/generative-ai/generative-credits-faq.html`
- UXP for Photoshop reference: `developer.adobe.com/photoshop/uxp/2022/ps_reference/`
- UXP plugin samples: `github.com/AdobeDocs/uxp-photoshop-plugin-samples`
- ES → UXP migration tool: `github.com/adobe-uxp/ps-es-to-uxp`
- Photoshop API: `developer.adobe.com/firefly-services/docs/photoshop/api/`
- Firefly API overview: `developer.adobe.com/firefly-services/docs/firefly-api/`
- Boris FX Optics: `borisfx.com/products/optics/`
- Topaz Photo AI: `topazlabs.com/topaz-photo-ai`
