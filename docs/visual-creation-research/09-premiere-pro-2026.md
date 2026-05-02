# Adobe Premiere Pro 2026 — Field Manual for the Pineapple House Agent

> Compiled 2026-05-01. [NEW] = past 30 days; [STABLE] = older but current.

---

## 1. What Premiere 26.x is + the core model

Adobe's NLE. Current shipping version **26.x** ("Premiere Pro 2026"); 26.0 dropped at Sundance late January 2026, **26.2 [NEW] shipped April 16, 2026**. Adobe rebranded the desktop app as "Adobe Premiere" in marketing, but the binary, project file (`.prproj`) and scripting DOM are still "Premiere Pro."

**Core model:**
- **Project (`.prproj`)** — single XML/binary container holding bins, sequences, references to media (NOT the media itself), markers, color settings, ingest presets. A `.prproj` opened by another editor in **Productions** mode locks parts of itself.
- **Sequence** — timeline + settings (resolution, frame rate, color space, audio sample rate). Sequences can be **nested**.
- **Source Monitor** vs **Program Monitor** — Source previews a clip (set in/out marks); Program shows the timeline output. Most ExtendScript work targets `app.project.activeSequence`.
- **Timeline + tracks** — V1, V2, V3… video tracks (top wins, alpha composites down), A1, A2, A3… audio tracks. Each track has lock/sync/mute/solo flags scriptable.
- **In/out points** — sequence-level (`sequence.getInPoint() / setInPoint()`) and clip-level (used by `encodeSequence`).
- **Trim modes** — Ripple (closes gap), Roll (moves edit point, neighbors absorb), Slip (changes clip's source in/out without moving timeline position), Slide (moves clip in time, neighbors absorb). UI tools (`B/N/Y/U` keys).
- **Multicam source sequence** — multiple synced angles (audio waveform / timecode / marker sync) collapsed into one clip with Camera 1..N pickable in Program. Created via `Create Multi-Camera Source Sequence`, flattened with `Multicam → Flatten` for color grading.
- **Proxies** — low-res sidecar media; ingest preset attaches `.proxy.mov`. Toggle with FX wrench in Program. Mismatched dimensions/aspect = #1 proxy gotcha.
- **Color management** — three project-level pipelines: **Direct** (legacy, no transforms), **Lumetri** (default; Rec.709/Rec.2100, scene→display transforms), **ACES** (IDT/ODT LUTs). Set in `File → Project Settings → Color Management`.
- **Audio bus + sub-mix tracks** — output to Master, Submix tracks, or hardware sends. Submix routes a group through a single processing chain.

---

## 2. AI features

### Generative Extend (Firefly Video) [NEW, 26.0]
Extends a clip's head or tail by generating frames with the **Firefly Video Model**. Right-click a clip's edge → `Generative Extend`. Up to **2 seconds extension** at **1080p**, **10-second clip cap** per Firefly Video model run. Cost: **~100 generative credits per ~5 seconds**. **Creative Cloud Pro subscribers got uncapped Firefly Video generations in 2026** [NEW]. Standalone: Firefly Standard $9.99/mo (2,000 credits ≈ 20 video clips), Pro $19.99/mo (4,000), Premium $199.99/mo (50,000).

### Enhance Speech [STABLE]
Essential Sound panel → tag clip as `Dialogue` → click `Enhance Speech` → background AI removes room noise/reverb/HVAC. **Mix Amount slider** blends original/enhanced; runs in background.

### Text-Based Editing [STABLE]
`Window → Text → Transcript`. Auto-transcribes via **Adobe Speech to Text v2.2.5** [NEW]. Select text in transcript, press Delete — corresponding range is ripple-deleted from the timeline. Generate captions via `Create Captions` button.

### AI Scene Edit Detection [STABLE]
Right-click a flat baked clip → `Scene Edit Detection` → produces individual cuts where algorithm detects a hard cut. Useful for re-conforming a baked edit you lost the project for.

### AI Object Masking (beta) [NEW, 26.0]
On-device AI. Hover-click a person/object → mask auto-tracks across frames; refine with lasso/rectangle/add-subtract; pipe straight into a Lumetri Color instance for skin-tone-only grading. **26.2 [NEW]** added **Sharp/Smooth edge modes**.

### Lumetri Auto Color Match [STABLE]
`Lumetri Color → Color Wheels & Match` tab. Set comparison view, click `Apply Match`, optionally enable **Face Detection** to lock to skin tones. Sensei AI under the hood.

### AI Captions / SRT export with translation [STABLE]
After auto-transcribe → `Create Captions`. Export as `.srt` sidecar or burned-in. Multilingual translation via Speech-to-Text v2.2.5 supports 20+ languages.

### Premiere model picker
Generative tools UI surfaces multiple model options. As of 26.2 release notes, the **Generative Extend picker in Premiere is still Firefly-only**; the cross-model picker pattern (GPT-Image / Nano Banana Pro alongside Firefly) is established in Photoshop/AE — confirm in the live `Generative` panel before promising third-party models inside Premiere itself.

### Frame.io integration [STABLE → V4 NEW]
`Window → Frame.io → Frame.io V4 Comments` (Premiere 25.2+). Native review-and-approval panel; comments time-coded against the timeline. **Camera-to-Cloud (C2C)** auto-uploads from RED, Sony Venice, Atomos, Teradek directly into a Frame.io project — ingestable by Premiere via Productions.

---

## 3. Editions + pricing 2026

| Plan | USD/month |
|---|---|
| Premiere Pro single-app (annual) | $20.99–$22.99 |
| Premiere Pro single-app (month-to-month) | $31.49–$34.49 |
| Creative Cloud All Apps (annual) | $59.99 |
| Creative Cloud Pro (with unlimited Firefly Video [NEW]) | $69.99 |
| Teams (per seat, annual) | $37.99 single-app / $89.99 All Apps |
| Student/Teacher | from $19.99 |
| Free trial | 7 days |

---

## 4. Scripting + automation

### ExtendScript [STABLE → DEPRECATED]
ES3 JavaScript with the Adobe DOM. Reference: `ppro-scripting.docsforadobe.dev`. **Sunset: September 2026** [NEW]. What you can do: open/save projects, walk bins, create sequences, set in/out, manipulate markers, apply export presets, queue to AME, read/write metadata. What you can't easily do: anything in `qe.*`, complex effect parameter automation.

```javascript
// ExtendScript: open project, render active sequence to AME with preset
var proj = app.openDocument(File("/work/myproj.prproj"));
var seq  = proj.activeSequence;
seq.setInPoint(0);
seq.setOutPoint(seq.end);
var out = "/renders/" + seq.name + ".mp4";
var preset = "/presets/H264_YouTube_4K.epr";
app.encoder.encodeSequence(seq, out, preset, app.encoder.ENCODE_IN_TO_OUT, 1);
app.encoder.startBatch();
```

### QE DOM (undocumented)
`app.enableQE(); var qe = qe.project;` exposes power-user internals (track operations, multicam flatten, time-remap edit). **Adobe support won't help if it crashes**; APIs change between point releases.

### UXP (current path) [NEW]
Premiere v25.6+ added UXP support; Premiere 26.x ships **UXP plugin runtime in beta**. V8 engine, ES6+, modern HTML/CSS panels. Enable via `Preferences → Plugins → Enable Developer Mode`. Sample plugins: `github.com/AdobeDocs/uxp-premiere-pro-samples`. Migration is **slower than Photoshop's** — many ExtendScript surfaces still missing in UXP as of 26.2.

```javascript
// UXP plugin (manifest v5) — add a marker at playhead
const ppro = require("premierepro");
async function addMarker() {
  const project = await ppro.Project.getActiveProject();
  const sequence = await project.getActiveSequence();
  const time = await sequence.getPlayerPosition();
  const marker = await sequence.getMarkers();
  await marker.createMarker("Cut here", time, time);
}
```

### CEP (legacy) [DEPRECATED]
Node.js + Chromium panels. Going away with ExtendScript.

### Adobe Media Encoder (AME) — render farm
**No headless CLI exists.** Supported automation paths:
1. **Watch Folder** — AME tab `Watch Folders` → add folder + preset(s). Drop `.prproj` in → AME renders to `/Output`.
2. **AME Scripting API** — same ExtendScript-style DOM (`ame-scripting.docsforadobe.dev`). Methods `encodeFile(path, presetPath, outputPath)` and `encodeSequence(seq, outputPath, presetPath, workArea, removeOnComplete)` return job IDs.
3. **Windows hack:** `"Adobe Media Encoder.exe" --console es.executeScript script.jsx` — unofficial but works for headless runners.

### Premiere Productions [STABLE]
Built-in shared-project mode. Open a Production folder; multiple editors open separate `.prproj` siblings; sequence-level locks prevent double-edit. Battle-tested on _Mank_, _Dolemite Is My Name_, _Terminator: Dark Fate_.

### Templates: `.prproj`, `.prtl`, `.mogrt`
- `.prproj` — full project template (drag onto bin to import sequences/bins).
- `.prtl` — Premiere title preset (legacy titler, mostly retired in favor of Essential Graphics).
- `.mogrt` — Motion Graphics Template, authored in **After Effects** via Essential Graphics panel, exposes parameters (text, color, slider, checkbox, point, font, **CSV/TSV data source**) consumable in Premiere.

### Frame.io V4 API [NEW]
Webhooks + Custom Actions. Curl example:

```bash
curl -X POST "https://api.frame.io/v4/accounts/$ACCOUNT_ID/folders/$FOLDER_ID/files" \
  -H "Authorization: Bearer $FRAME_IO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "name": "clawville-trailer-v3.mp4",
      "file_size": 184320000,
      "mime_type": "video/mp4"
    }
  }'
# Response includes upload_urls[] (multipart S3 URLs) — PUT chunks, then POST commit.
```

---

## 5. Plugin ecosystem 2026

| Plugin | What it does | Status |
|---|---|---|
| **Boris FX Sapphire 2026** | 270+ VFX (lens flares, glow, transitions); AI-driven whip transition + Pro Lens Flare Pack [NEW] | borisfx.com/sapphire |
| **Boris FX Continuum 2026** | 350+ tools; PixelChooser + Primatte chromakey rebuilt; **BCC+ Face ML** auto-masks face features [NEW] | |
| **Boris FX Mocha Pro** | Industry-standard planar tracking + roto inside Premiere | Bundled in Continuum |
| **Maxon Red Giant Universe** | 270+ GPU-accelerated stylized effects + transitions | [STABLE] |
| **Maxon Red Giant Magic Bullet** | Looks (color grading), Cosmo (skin retouch), Denoiser | [STABLE] |
| **Maxon Trapcode** | Particular, Form, Mir — used via Dynamic Link from AE | [STABLE] |
| **FilmConvert Nitrate** | Film stock emulation LUTs + grain | [STABLE] |
| **Topaz Video AI** | Standalone upscaler/de-noiser/frame-interpolator; used **outside** Premiere then re-imported | [STABLE] |
| **Frame.io panel** | Adobe-owned review/comment panel; V4 native [NEW] | Built-in 25.2+ |

---

## 6. Use case map

### YouTube edit (15-min talking head + B-roll)
1. Ingest into Production. 2. Auto-transcribe (`Window → Text`). 3. Text-Based Edit to remove ums/restarts. 4. Apply `Enhance Speech` to dialogue track. 5. Add B-roll on V2. 6. Lumetri Auto Color Match across A/B-roll. 7. Drop `.mogrt` lower-thirds. 8. `Create Captions` → burn or sidecar `.srt`. 9. Send to AME with `H264_YouTube_4K.epr` preset.

### Short-form vertical (TikTok/Reels)
Sequence preset 1080×1920@30 or 60. Apply `Auto Reframe` (Sensei) on a 16:9 source. Drop a vertical-aware `.mogrt`. Burn captions. Export 9:16 H.264 ≤60s ≤287MB.

### Multicam interview
Bin-select 4 angles → right-click → `Create Multi-Camera Source Sequence` → sync by **Audio**. Drag multicam clip to timeline. Hit `0` to enter multicam mode → press 1/2/3/4 to cut live to camera angles. `Multicam → Flatten` then grade with Lumetri.

### Long-form podcast video
Submix audio: route Host A1, Guest A2 through `Submix 1` → loudness/EQ chain. Auto-transcribe → Text-Based Editing for filler removal. Apply Enhance Speech per speaker. Use `.mogrt` chapter markers driven from sequence markers.

### Documentary with archive footage
Standalone Topaz Video AI: upscale 480p archive → 4K HQ → import as .mov. Inside Premiere: nest the upscale on V2, original on V3 for split-screen reference. Color-grade with ACES pipeline if mixing log/SDR/HDR sources.

### Trailer / hype reel
Music-first: drop track on A1, hit `M` repeatedly on beats to drop sequence markers. Snap clips to markers. Stack Sapphire transitions (S_Whip, S_FilmBurn) between cuts. Lumetri creative LUT on adjustment layer.

### Game capture → 60s ad
Import 1080p60 game capture. New 1920×1080@60 sequence. Use `Auto Color Match` between gameplay and on-cam reaction. Audio-duck sfx with Essential Sound `Ducking`. Burn captions. Export H.264 8 Mbps ≤300MB.

### Render farm with AME watch folder + Frame.io
1. Editor saves `.prproj` to `\\nas\watch\renders\`. 2. AME polls folder → renders all sequences using attached preset. 3. Post-render hook (Windows scheduled task) `curl`s the output to Frame.io V4 upload endpoint. 4. Webhook fires → Slack notify reviewers.

---

## 7. Past 30-day shifts

- **Premiere 26.2** — April 16, 2026: Channel Blur, Gradient, Noise effects (Film Impact–powered); Dynamic 3D Spinback + Slide transitions; Sharp/Smooth mask edge refinement; audio waveforms in Source Monitor; offline media reconnect path detection; one-click sequence audio mute.
- **Firefly Video unlimited** for Creative Cloud Pro [NEW] — promo became permanent in 2026.
- **Adobe Speech to Text v2.2.5** [NEW] — improved multilingual transcription accuracy.
- **Boris FX Continuum 2026** [NEW] — BCC+ Face ML auto-masks facial features through a shot.
- **Sapphire 2026** [NEW] — Pro Lens Flare Pack + AI Whip Transition.
- **ExtendScript sunset for September 2026** [NEW] — UXP migration is now a real deadline.

---

## 8. Common gotchas

- **Proxies detach silently** on Project → Project Settings → Ingest preset change. Symptom: full-res playback but Toggle Proxies button greyed. Fix: re-attach via Project panel right-click → `Proxy → Attach Proxies`.
- **GPU acceleration**: `File → Project Settings → General → Renderer`. Mac: Metal. Windows: CUDA (NVIDIA) or OpenCL (AMD/Intel). Magenta timeline = CUDA decode failure on H.265 — switch to **Software Only** to confirm GPU bug.
- **Audio sample-rate mismatch on import** — 44.1kHz files in 48kHz sequence are conformed (creates `.cfa` cache); first import is slow.
- **Lumetri scene-linear vs gamma** — applying creative LUTs in scene-linear ACES gives wildly different results vs gamma-corrected Direct. Set color management BEFORE grading.
- **Dynamic Link AE → Premiere render-time CUDA crashes** — when AE comp uses 32-bit float + heavy Trapcode, Dynamic Link bridge can OOM the GPU. Workaround: pre-render the AE comp to ProRes 4444.
- **`.mogrt` parameter type traps** — text fields with non-Latin scripts can break if source font isn't embedded; use Adobe Fonts only for `.mogrt` text params; **slider** with min/max=0 silently locks the parameter.
- **Premiere Productions lock-stealing** — `Edit → Take Over` forcibly steals a sequence lock. Two editors hitting `Take Over` simultaneously can corrupt lock metadata.
- **Mixed frame rate sequences** — 29.97 in 30fps sequence drops/duplicates frames every 1001 frames. For 59.94 in 23.976, use **Time Interpolation: Optical Flow**.
- **HDR setup** — `Project Settings → Working Color Space: Rec.2100 PQ` (broadcast) or `Rec.2100 HLG` (streaming). Don't mix HLG + PQ sources without explicit transforms.
- **Mixed codec timeline performance** — H.265 + DNxHR + ProRes RAW + R3D in one sequence will thrash decoders. Transcode to a single mezzanine codec (DNxHR HQ for SDR, ProRes 4444 for HDR) for >60min projects.
- **Warp Stabilizer** — analyze pass is single-threaded CPU. A 10-min 4K clip can pin one core for 6–8 hours.

---

## 9. Resources

- Premiere Help: `helpx.adobe.com/premiere/desktop/whats-new/whats-new.html`
- Release notes: `helpx.adobe.com/premiere/desktop/whats-new/release-notes.html`
- Premiere Pro Scripting Guide (community canonical): `ppro-scripting.docsforadobe.dev`
- AME Scripting API: `ame-scripting.docsforadobe.dev/reference/index.html`
- UXP for Premiere: `developer.adobe.com/premiere-pro/uxp/`
- UXP samples: `github.com/AdobeDocs/uxp-premiere-pro-samples`
- Generative credits FAQ: `helpx.adobe.com/creative-cloud/apps/generative-ai/generative-credits-faq.html`
- Frame.io V4 docs: `help.frame.io`
- Boris FX learning hub: `borisfx.com`
