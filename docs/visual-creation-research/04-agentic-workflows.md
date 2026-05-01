# Agentic Visual Creation Workflows (2026-05-01)

> Audience: agents/devs chaining image/video/3D into pipelines. Three structural events reshape the playbook in April 2026: **Replicate joining Cloudflare**, **Freepik rebranding to Magnific** ($230M ARR, unified suite), and **OpenAI's Sora 2 standalone API end-of-life 2026-09-24** — every Sora-dependent pipeline must migrate to Veo 3.1, Kling 3.0, or Seedance 2.0.

---

## 1. Aggregator / Router Platforms

### fal.ai [NEW HappyHorse-1.0]
- 600+ production-ready models behind one API key. HTTP-over-WebSocket queue saves ~100ms/req vs polling-only. Uniform `fal.queue.submit / fal.queue.status / fal.queue.result` across image, video, 3D, audio, training.
- Pricing: pay-per-output for inference, pay-per-step for training. Examples: Kling 3 Pro $0.224/s no-audio, $0.28/s with audio; Seedance 1.5 Pro $0.26 for 720p/5s with audio; FLUX-LoRA-fast trainer $0.0024/step (1000-step min ~$2.40); FLUX.2 [dev] trainer $0.008/step.
- API: REST + WebSocket queue. SDKs: Python, JS/TS, Swift, Kotlin. Webhook callbacks (preferred over polling for >30s jobs).
- **fal launched Seedance 2.0 API on 2026-04-15.**
- Pipeline example — train LoRA → generate consistent shoot:
  ```bash
  curl -X POST https://queue.fal.run/fal-ai/flux-lora-fast-training \
    -H "Authorization: Key $FAL_KEY" \
    -d '{"images_data_url":"https://.../zip","steps":1000,"webhook_url":"$CB"}'
  curl -X POST https://queue.fal.run/fal-ai/flux-lora \
    -d '{"loras":[{"path":"$lora_url","scale":1.0}],"prompt":"..."}'
  ```

### Replicate [NEW — joining Cloudflare]
- Same shape — model marketplace, REST API, prediction objects with status polling. Replicate is being acquired by Cloudflare (April 2026), positioning the API for tighter Workers/R2 integration.
- Seedream 5.0 added 2026-04-15 with multi-step reasoning + example-based editing.
- Pricing: pay-per-second of GPU time OR pay-per-output. ~1.1–1.4× underlying provider's cost.
- API: REST, polling-only by default (webhooks optional). SDKs: Python, JS, Go, Swift, Elixir, Ruby.

### Pollo AI [STABLE]
- Aggregates Sora 2, Veo 3.1, Kling, Runway, Hailuo, Luma, Pika, PixVerse, Vidu, DALL-E, FLUX Pro Ultra, GPT-4o image gen, plus Pollo 2.5, single credit pool.
- 2026 update added Reference-to-Video for cross-shot character/environment consistency.
- Less developer-facing — UI-first, but has API tiers for agencies.

### Higgsfield [NEW Soul ID]
- Aggregates 15+ models (Sora 2, Veo 3.1, Kling 3.0, Wan 2.6, Seedance 2.0). Real differentiator: **Soul ID** — train a persistent identity from 20–70 photos in ~5 min, then lock that identity across every subsequent generation regardless of style preset, camera, or prompt.
- Pricing: subscription credits, ~$9/mo Basic.

### Krea [NEW redesign 2026-03-29]
- Unified suite spanning image, video, edit, enhancer, train, realtime.
- **Realtime Canvas** — sketch on left, photoreal output updates in <50ms on right.
- **Krea Stage** — pose 3D primitives (low-fi diorama) and render to 2D photoreal.
- **Krea Realtime 14B** open-sourced on Hugging Face — real-time AI video model.
- Pricing: $10/mo Basic, $35/mo Pro. Free tier with daily credits.
- Recraft V4 lives natively on Krea; Topaz video upscaler integrated (8K + 120fps interpolation).

### Magnific (formerly Freepik) [NEW rebrand 2026-04-28]
- Freepik rebranded to Magnific on 2026-04-28, $230M ARR.
- Combines image+video models, 4K with audio, real-time collab workspaces, 3D/virtual scene tools, 250M+ asset library.
- Headline: **Magnific Precision v2** for true-to-life upscaling. Bundled models include Veo 3.1, Seedance 2.0.

### Adobe Firefly API [NEW Image 5 + AI Assistant]
- Photoshop 27.6 (2026-04-28) ships **Generative Fill on Firefly Image 5** at 2K res.
- **Firefly AI Assistant public beta** went live 2026-04-27.
- Image 3 **retired from model picker as of 2026-04-28** — migrate to Firefly Fill & Expand.

---

## 2. ComfyUI Ecosystem

### ComfyUI core [NEW v0.20.0 / v0.20.1 — 2026-04-27]
- Graph-based diffusion runtime. April 27 release added SUPIR super-res, RIFE + FILM frame interpolation, SAM 3.1 segmentation, LTXV audio VAE improvements, faster Ernie inference, anti-cycle workflow validation, 4K resolution for ByteDance 2 / Veo / Kling partner nodes, **Veo 3 Lite** node, higher bit-depth + alpha video support.
- **ComfyUI-Manager v4.2.1** (2026-04-22) — node registry + dependency installer.
- Free, open-source. Pay only for the GPU you run it on.

### ComfyDeploy [STABLE]
- "Vercel for ComfyUI" — push a workflow JSON, get a versioned API endpoint backed by Modal-powered serverless GPUs. Cold start in **seconds** (vs RunPod's minutes), unlimited model storage included.

### RunPod Serverless ComfyUI [STABLE]
- Deploy ComfyUI as a serverless RunPod worker. Pay per-second of GPU. Higher control over hardware (H100, L40S, A100), more setup overhead, slower cold start.

### Modal [STABLE]
- Generic Python-on-GPU serverless. ComfyDeploy is built on it. Best when ComfyUI is one node in a larger Python orchestration.

---

## 3. Character Consistency Tooling

| Tool | Mechanic | Best for |
|---|---|---|
| **Higgsfield Soul ID** [NEW] | Train identity from 20–70 photos, ~5 min, locks across every gen | High-volume editorial / ad shoots |
| **Sora 2 Cameos** | Self-recorded video → reusable likeness, 95%+ consistency | Personal video; **API EOL 2026-09-24** |
| **Veo 3.1 Reference** | Up to **4 reference images**, 80–85% consistency | Post-Sora default for video |
| **FLUX.2 Multi-Reference / Kontext** | Up to **10 reference images** in one request; "Identity Persistence" | Comic strips, brand campaigns, hundreds of stills |
| **Runway Gen-4.5 References** | Reference-image input + camera control + character handling | Strongest all-round image-to-video |
| **Recraft V4 consistency** | Design-taste model with raster + vector + Pro 2K | Brand-consistent UI/illustration |
| **fal-ai/flux-lora-fast-trainer** | $2.40 floor, 1000 steps, ~10 min | DIY character LoRA when refs alone aren't enough |

**Rule:** start with reference-image conditioning (cheapest, no training). If consistency drops below requirement, escalate to Soul ID (managed) or LoRA training (owned).

---

## 4. Upscaling / Refinement

- **Topaz Photo + Video AI "Next-Gen"** [NEW 2026-04-28] — largest model release in company history. Wonder 3 (one-click sharpen+upscale+denoise), Denoise Max, Super Focus 3, High Fidelity 3 for images; Starlight Precise 2.5 + Astra 2 for video. **NeuroStream tech cuts VRAM by up to 95%** — runs locally on consumer GPUs.
- **Magnific Precision v2** [NEW] — true-to-life upscaling, integrated in Magnific suite.
- **Krea Enhance** — bundled in Krea Pro; 8K image, 120fps video interpolation, integrates Topaz video.
- **SUPIR (in ComfyUI v0.20.0)** [NEW] — open-source super-res, drop-in for self-hosted pipelines.
- **Real-ESRGAN successors** — for budget self-host: 4x-UltraSharp, RemacriX still common in Comfy graphs.

---

## 5. Style / Training Services

- **fal-ai/flux-lora-fast-trainer** — $0.0024/step, 1000-step min ($2.40 floor), 10× faster than reference impl.
- **fal-ai/flux-2-trainer** [NEW] — $0.008/step, FLUX.2 [dev] LoRAs.
- **fal-ai/wan-22-trainer (i2v-a14b)** [NEW] — Wan 2.2 image-to-video LoRA training.
- **fal-ai/hunyuan-video-lora-training** — for Hunyuan video LoRAs.
- **fal-ai/flux-kontext-trainer** — train for the Kontext editing variant.
- **fal-ai/z-image-trainer** — Z-Image Turbo LoRAs, $2.26 / 1000 steps.
- **Replicate-LoRA + ostris/ai-toolkit** — open trainer used widely; Replicate hosts managed runs.
- **Higgsfield Soul ID training** — managed, no LoRA file produced; identity locked inside Higgsfield.

**Cost ceiling:** $2.40–$10 per character LoRA on a managed service. Cheaper to LoRA than to prompt-engineer for consistency past ~50 outputs.

---

## 6. Voice + Music

- **ElevenLabs v3 + Eleven Music** — natural vibrato, breathing, **commercially licensed from day one**. ~$0.80/min for music API. Best for ads + commercial use.
- **Suno v5** [NEW early 2026] — 44.1kHz CD-quality, full songs with vocals.
- **Udio** — 48kHz output + stem separation + inpainting + section-by-section regen — closest to a real DAW.
- **MiniMax Music 2.5 via fal** — $0.035/generation, developer-API price leader.
- **Google Lyria 3** [NEW] — three specialist variants including singing-capable variant; Vertex AI.
- **Stable Audio 2** — solid sfx and short loops, weaker on full songs.

---

## 7. Editing / Compositing / Lipsync

- **Runway editor + Aleph** — best-in-class generative video editor; reference-conditioned shot continuation.
- **Pika 2.x — Pikaframes / Pikaffects / Pikaswaps** — first/last-frame keyframe transitions.
- **Krea Edit** — region edits, object move, relight, palette shift, image expansion in one workflow.
- **Photoshop AI Generative Fill (Firefly Image 5)** [NEW] — 2K natural-language fill.
- **Sync.so LipSync 2 Pro** — studio-grade, batch up to **500 videos**, Python + TS SDKs, usage-based billing — **the only one priced for programmatic agents**.
- **Hedra Character-3** — talking-photo specialist; cheaper for low-realism.

---

## 8. Real-time / Live

- **Krea Realtime** — sub-50ms sketch→render canvas; **Krea Realtime 14B** open-sourced.
- **Decart** — real-time game/scene transformation.
- **fal real-time SDXL Turbo descendants** — WebSocket streaming endpoints; <300ms p50.

---

## "Build me a 30-second product ad" — full agent pipeline

| Step | Tool | Why |
|---|---|---|
| 1. Talent reference | Higgsfield Soul ID (trained once, reused forever) | 95%+ identity lock |
| 2. Hero stills (8 frames) | FLUX.2 + Kontext with 10 ref images via fal queue | Multi-ref consistency, brand colors |
| 3. Product placement / brand fix | Photoshop 27.6 Generative Fill (Firefly Image 5) | Commercial-safe edits |
| 4. 3D scene block-out | Krea Stage → render to 2D | Pre-vis without DCC tool |
| 5. Image → video (4–6 shots, 5s each) | Veo 3.1 Reference via fal (4 ref images) | Character + style consistency |
| 6. Lipsync if speaking | Sync.so LipSync 2 Pro API | Batchable, agent-friendly |
| 7. Music bed | Suno v5 (creative) or ElevenLabs Music (license-safe) | Pick by commercial-rights need |
| 8. Voiceover | ElevenLabs v3 | Industry-leading expressiveness |
| 9. Frame interpolation 24→60fps | ComfyUI v0.20.0 RIFE/FILM nodes on ComfyDeploy | Smoother motion, free |
| 10. Upscale to 4K | Topaz Astra 2 (video) or Magnific Precision v2 | Final mastering pass |
| 11. Compose final cut | Runway editor (Aleph) or Pika Frames | Trim, transitions, end-card |
| 12. Export + caption burn | Remotion or post in CapCut/Premiere | Deterministic export |

**Agent orchestration:** wrap each step as a fal queue submission (or Replicate prediction), webhook back to a state machine, gate next step on `status == COMPLETED`. Total cost ≈ **$8–15** of API spend per 30s ad.

---

## Past 30-day shifts

1. **Replicate joining Cloudflare** — expect Workers/R2-native model invocation.
2. **Freepik → Magnific** rebrand 2026-04-28 with $230M ARR.
3. **Topaz "Next-Gen"** 2026-04-28 — six new models, NeuroStream cuts VRAM 95%.
4. **fal Seedance 2.0 API** 2026-04-15.
5. **fal HappyHorse-1.0** 2026-04-26 — Alibaba 15B unified joint audio-video, 1080p, multilingual lipsync.
6. **ComfyUI v0.20.0 / v0.20.1** 2026-04-27 — SUPIR + RIFE + FILM + SAM 3.1 + Veo 3 Lite + 4K partner nodes.
7. **Photoshop 27.6 + Firefly Image 5** 2026-04-28.
8. **Firefly AI Assistant public beta** 2026-04-27.
9. **Sora 2 standalone discontinued** 2026-03-24, API EOL 2026-09-24.
10. **Replicate Seedream 5.0** 2026-04-15.
11. **Krea Realtime 14B** open-sourced.
12. **Artlist Studio** 2026-04-30 — bundles Nano Banana Pro + Seedance 2 + Kling + Veo 3.1 + Lyria 3 + ElevenLabs.

**Pricing direction:** image LoRA training drifting down (~$2 floor), video at ~$0.20–0.30/s with audio, music API consolidating around $0.035–$0.80/min.

---

## Operator's heuristics for agents

1. **Default to fal** for any task with a queue and webhooks — best DX for agents.
2. **Default to Veo 3.1** for character video (post-Sora). Fall back to Kling 3.0 / Seedance 2.0.
3. **Default to FLUX.2 + Kontext** for character stills with multi-reference; jump to LoRA only above ~50 outputs.
4. **Default to Sync.so** for any lipsync that runs without a human in the loop.
5. **Default to ComfyUI on ComfyDeploy** when you need a custom mutating graph.
6. **Default to Topaz Astra 2 / Magnific Precision v2** as the final upscale node.
7. **Treat Sora 2 as deprecated** in any new pipeline shipping past June 2026.
