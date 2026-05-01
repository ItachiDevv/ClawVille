# AI Video Generation — State of the Art (2026-05-01)

> Field has consolidated around five frontier vendors (Google, OpenAI, Kling, Runway, ByteDance) plus open-source (Wan, Hunyuan) and specialist (Hedra, Sync). **Sora's consumer app died 2026-04-26 — agents trained on pre-April data will hand users a dead URL.**

---

## Frontier Tier — text/image-to-video

### Google Veo 3.1 / Veo 3.1 Fast / Veo 3.1 Lite [NEW]
- **Veo 3.1 Lite released 2026-03-31; Fast price-cut + 4K + reference-image + extend rolled out 2026-04-07**.
- Specs: 8s clips (extendable), 720p / 1080p / **4K (Fast tier as of 2026-04-07)**, up to 60fps, **native audio in single pass** (dialog + SFX + music).
- Best at: native synced audio with cinematic realism. Worst at: >8s coherent narrative without explicit extend calls.
- Pricing per second (with audio): Standard $0.40/s · Fast $0.15/s · Lite ~$0.10/s. 8s standard ≈ $3.20.
- API: Direct via Gemini API (`generateContent` with `veo-3.1-generate-preview`) and Vertex AI; routed through fal.ai, Replicate, Pollo, Higgsfield, Kie.ai.
- **No Veo 4 yet.** Likely Google I/O 2026 (May 19–20). Agent answers claiming "Veo 4 is live" today are wrong.
- Tip: best in class at *spoken dialogue* — use literal quoted dialogue + speaker tags: `"A grizzled fisherman says, 'The reef is restless tonight.'"`
- Controls: image-to-video, **last-frame anchoring via reference images (April update)**, extend, prompt-based camera.

### OpenAI Sora 2 / Sora 2 Pro [DEPRECATING]
- **Consumer app shut 2026-04-26. API live until 2026-09-24.**
- Specs: 4–25s per clip (Pro), stitched 60–120s via `extend`, 720p (Sora 2) / 1024p (Pro), native audio.
- Pricing: Sora 2 $0.10/s @ 720p · Sora 2 Pro $0.30/s @ 720p, **$0.50/s @ 1024p**. 10s Pro HD ≈ $5.
- API: OpenAI direct (`/videos`), Pollo, Replicate, fal.ai, OpenRouter.
- Tip: use **Remix** with `strength: 0.3–0.6` to iterate on a base clip without re-rolling the seed lottery.
- Controls: image-to-video, `extend` (max 6 chained = ~120s), `remix` (4 strength levels).
- **Migrate off** before September 2026 if shipping past then.

### Kling 3.0 / Kling 3.0 Pro [NEW]
- Released **2026-02-05**; **native 4K rolled out 2026-04-24**. #1 ELO benchmark (1243), beating Veo 3.1, Runway, Pika.
- Specs: up to **15s** (was 10s), **native 4K** (single prompt, no upscale), native multilingual audio, **6 camera cuts in one generation**. Up to 2 minutes via stitching.
- Best at: multi-shot storytelling with cuts and continuity.
- Pricing: Standard $0.168/s (no audio) / $0.252/s (audio) · Pro $0.224/s / $0.336/s.
- API: klingai.com, fal.ai (exclusive on 3.0 + O3), PiAPI, Novita, WaveSpeed, Higgsfield, Pollo.
- Tip: explicitly number shots: `"Shot 1: wide of the kelp forest. Shot 2: close on the lobster's eye."` — Kling 3.0 cuts on numbered prompts.
- Controls: image-to-video, **first+last frame anchoring**, multi-shot cuts.

### Runway Gen-4.5 [STABLE — Dec 2025, no Gen-5 yet]
- Specs: 5/10s clips, 720p/1080p, 24fps, **no native audio**.
- Best at: controllability (camera, motion brushing, character lock via References).
- Pricing: plan-based credits, ~$0.05–0.12/s effective.
- API: Runway direct (Enterprise), fal.ai, Replicate. Gate-listed for Enterprise on production.
- Tip: use **References** (3 ref images) for character lock — Runway's strongest feature.
- Controls: motion brush, advanced camera controls (orbit/dolly/zoom dropdown), References, GWM-1 world model.

### ByteDance Seedance 2.0 [NEW]
- Public beta on BytePlus ModelArk **2026-04-14**; live on fal.ai **2026-04-09**.
- Specs: up to **20s**, 1080p, native audio, multi-shot, accepts **text + image + audio + video** as inputs.
- Pricing: ~$0.05–0.10/s on fal.
- API: fal.ai (`fal-ai/seedance-2.0/...`), Replicate, BytePlus ModelArk direct, Atlas Cloud.
- Tip: ship reference images + audio together — Seedance is the only frontier model that locks audio rhythm to motion via reference audio.

---

## Strong Tier — production-ready, cheaper

### MiniMax Hailuo 2.3 / 2.3 Fast [STABLE]
- 2025-10. Up to 10s, 1080p, 24–30fps. Audio not native.
- Best at: cost-per-quality. Anime/illustration/ink-wash style support unusually strong.
- Pricing: Pro $0.08/s; Fast ~50% cheaper.
- API: MiniMax direct, fal.ai (`fal-ai/minimax/hailuo-02/pro/...`), WaveSpeed, Atlas Cloud, Pollo.
- Tip: lead with style noun in first 3–5 tokens.

### Luma Ray3 / Ray 3.14 [NEW]
- **Ray3.14 update April 2026: native 1080p, 4× faster, 3× cheaper.**
- Specs: 5/10s, 540p–1080p (HDR option), no native audio.
- Best at: HDR + EXR pipeline output for VFX.
- Pricing: ~$0.04–0.08/s SDR 1080p (post-April cut); HDR/EXR ~5×.
- Tip: use Luma's "concept" presets via API parameter rather than prompt text.

### Wan 2.5 / 2.6 / 2.7 (Alibaba) [NEW for 2.7]
- Wan 2.5 (Sep 2025) added native synced audio. **Wan 2.7 announced — first-frame control, 15s clips, open weights.**
- Wan 2.5: 10s, 1080p, 24fps, native audio. Managed-API only; **2.1/2.2 weights are open**.
- Pricing: ~$0.05–0.12/s.
- API: fal.ai, Kie.ai, OpenRouter, WaveSpeed, RunPod (self-host 2.1/2.2), Alibaba Cloud direct.
- Tip: shot-list prose: `"Opens on a boy holding a paper boat. Cut to the boat in a puddle. Cut to a wave swallowing it."`

### Pika 2.2 [STABLE]
- 5–10s, 720p/1080p, no native audio.
- Best at: **Pikaframes** (5-keyframe interpolation for transformations/loops) and **Pikascenes** (multi-reference compositing).
- Pricing: ~$0.10–0.20/s on fal.
- Tip: default to Pikaframes (not raw T2V) when you have any reference visual.

### Hunyuan Video 1.5 [NEW updates]
- Tencent. **HunyuanVideo-1.5 Nov 2025; LoRA scripts + FP8 + 8/12-step distilled I2V Dec 2025; DisCa accel paper CVPR 2026.**
- 8.3B params, runs on RTX 4090. **Self-hosted free path is genuinely viable on consumer GPUs.**
- API: self-host via `Tencent-Hunyuan/HunyuanVideo`, fal.ai managed, Replicate.
- Tip: use the LoRA tuning script for character lock — train a 50-image LoRA, get character-consistent video for the cost of one fine-tune.

---

## Specialist Tier — lipsync, talking head, animation

### Hedra Character-3 [NEW pricing]
- API launched Feb 2026; **pricing dropped April 2026 after $32M Series A.**
- Photo + audio → talking-head video, up to 60s+, 720p HD, 15+ languages.
- Pricing: 6 credits/sec @ 720p. Creator $24/mo gets 4000 credits (~11 min HD).
- API: Hedra direct (`api.hedra.com`), Atlabs.
- Tip: feed clean reference audio (no music underbed, ≤–6dB peak).

### Sync.so (Sync v2/Lipsync) [STABLE]
- **Only lipsync vendor priced for programmatic-first usage.** Existing-video + new-audio → video with lips swapped.
- Best for: API-driven pipelines, batch jobs, swapping audio on pre-rendered video.
- Pricing: ~$0.05–0.10/s effective.
- API: Sync.so direct, fal.ai (`fal-ai/sync-lipsync`).
- Tip: pre-cut input video to ≤30s blocks.

### Wan-Animate (Wan 2.2-Animate) [NEW]
- Released open-source 2026-01-29 (Apache 2.0).
- Two modes — **Animation** (your character image + reference video → character mimics video) and **Replacement** (swap character into existing video, scene-light/color matched).
- Pricing: $0 self-hosted; ~$0.06–0.10/s on managed.
- API: HF / GitHub `Wan-Video/Wan2.2`, fal.ai (`fal-ai/wan-animate`), ComfyUI native node.
- Tip: feed a clean rim-lit reference image — Animate uses lighting cues to relight in the swap.

---

## Decision Tree

```
GOAL                                           FIRST CHOICE          FALLBACK
Short ad, 5–8s, native audio, polish        →  Veo 3.1 Standard      Kling 3.0 Pro
Talking head from a photo                    →  Hedra Character-3     Wan 2.5 I2V
Lipsync onto existing video                  →  Sync.so               Hedra
Cinematic 8s with dialogue                   →  Veo 3.1 (English)     Kling 3.0 (other langs)
Animated character w/ pose control           →  Wan-Animate           Runway Gen-4.5 References
60s narrative                                →  Kling 3.0 (15s × 4)   Sora 2 Pro extend chain
Highest motion controllability               →  Runway Gen-4.5        Seedance 2.0
Cheapest watchable 1080p                     →  Hailuo 2.3 Fast       Wan 2.6
Self-hosted / free                           →  Hunyuan Video 1.5     Wan 2.2 weights
Multi-keyframe transformation                →  Pika 2.2 Pikaframes   Kling first+last anchor
Multimodal (text+img+audio+vid input)        →  Seedance 2.0          Wan 2.7
HDR / VFX pipeline                           →  Luma Ray3 HDR/EXR     (no real fallback)
```

---

## Past 30-day shifts

1. **Sora's consumer app died 2026-04-26.** API still works until 2026-09-24, then gone too.
2. **Veo 3.1 Lite released 2026-03-31** — cheapest Google video tier (~$0.10/s).
3. **Veo 3.1 Fast got 4K + reference images + extend on 2026-04-07, plus a price cut.**
4. **Veo 3.1 free tier on personal Google accounts 2026-04-02** — 10 free generations/month.
5. **Kling 3.0 added native 4K on 2026-04-24** (highest native res of any frontier model).
6. **Seedance 2.0 public beta opened 2026-04-09 (fal) and 2026-04-14 (BytePlus ModelArk).**
7. **Luma Ray3.14 update April 2026:** 4× faster, 3× cheaper, native 1080p.
8. **No Veo 4 yet** despite many "Veo 4 release" blog posts.
9. **No Runway Gen-5 yet** — Gen-4.5 (Dec 2025) is still current.
10. **Hedra dropped Character-3 prices in April 2026** after Series A.
11. **Wan 2.7 announced** with first-frame control + 15s + open weights.
12. **Hunyuan Video DisCa accelerator** (CVPR 2026) — ~11× faster.
13. **Wan-Animate (open Apache-2.0)** released 2026-01-29 — pose-control + character-swap is no longer closed-source-only.

---

## Quick prompting cheats

- **Veo 3.1:** quoted dialogue + speaker tags. Native audio reads them.
- **Sora 2 Pro:** Remix at strength 0.4 to iterate without losing seed.
- **Kling 3.0:** number shots literally — "Shot 1:", "Shot 2:".
- **Runway Gen-4.5:** always use References for character.
- **Seedance 2.0:** send image + audio together.
- **Hailuo 2.3:** lead with style noun in first 3 tokens.
- **Luma Ray3:** preset enum, not free-form text, for camera moves.
- **Wan 2.5+:** shot-list prose ("Opens on… Cut to… Cut to…").
- **Pika 2.2:** default to Pikaframes when you have any reference image.
- **Hunyuan 1.5:** LoRA-train a 50-img character pack.
- **Hedra Character-3:** scrub music/SFX off reference audio.
- **Sync.so:** cut input to ≤30s blocks.
- **Wan-Animate:** rim-lit reference char image.
