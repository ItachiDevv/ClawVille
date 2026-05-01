# State of AI Image Generation — May 2026

> Audience: the in-game "Visual Creation" agent at ClawVille. Bias: API-callable, not consumer marketing. Recency cut: 30 days back from 2026-05-01. **[NEW]** = released or repriced since 2026-04-01. **[STABLE]** = older but currently the right answer.

---

## Frontier Tier

### Nano Banana Pro (Gemini 3 Pro Image Preview) — Google DeepMind
- Released 2025-11-20 [STABLE]; on Together, OpenRouter, Kie.ai, Vertex AI as of April 2026.
- Best at: complex multimodal reasoning + identity-preservation across **5 subjects**, plus best in-image text rendering on the market (long passages, multilingual layouts, infographics).
- Worst at: raw painterly aesthetic feel; price is steep.
- Resolution: up to **2K and 4K** native; flexible aspect ratios; localized edits, lighting/focus adjustments, camera transforms.
- Pricing: token-based — $2/M input, $12/M output on OpenRouter. Per-image ~$0.08–0.13 at 2K, ~$0.20+ at 4K.
- Endpoints: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent`; OpenRouter `google/gemini-3-pro-image-preview`; Together `nano-banana-pro`; fal `fal-ai/nano-banana/edit` (Pro routes through Google direct or Together).
- Editing: instruct-edit via natural language, localized masks, multi-image composition (5 subject refs). No separate inpaint endpoint.
- Tip: treat it like a thinking model — give it a *brief* (subject, action, environment, lighting plan, camera, mood) instead of tag soup.

### GPT Image 2 — OpenAI **[NEW]**
- On fal: 2026-04-21 (enterprise API). Direct OpenAI access predates that.
- Best at: brand-consistent product photography + pixel-perfect typography in tight layouts; reference-image fidelity in edits.
- Worst at: edit chains expensive — every edit reprocesses reference at high fidelity.
- Resolution: up to **4K**, max edge 3840px, aspect up to 3:1.
- Pricing: token-based — $5/M text in, $8/M image in, $30/M image out. ~$0.006 (low), ~$0.053 (medium), ~$0.211 (high).
- Endpoints: `POST https://api.openai.com/v1/images/generations` model `gpt-image-2`; fal `fal-ai/openai/gpt-image-2[/edit]`; OpenRouter `openai/gpt-5.4-image-2`.
- Editing: true mask-based inpaint/outpaint at edit endpoint.
- Tip: state quality tier explicitly (`"quality": "high"`) — auto skews medium and that's where typography degrades.

### FLUX.2 Pro / Max / Klein — Black Forest Labs
- Released 2025-11-25 [STABLE]; **FLUX.2 Pro 2× speed upgrade in April 2026** [NEW] at same $0.03/image.
- Best at: multi-reference composition — accepts **up to 10 reference images** in a single call.
- Worst at: edge-angle faces drift; Asian-art styles weaker than Hunyuan.
- Resolution: up to 4 megapixels.
- Pricing (1 credit = $0.01):
  - FLUX.2 [pro]: **$0.03/image** text-to-image, **$0.045/image** edit.
  - FLUX.2 [max]: $0.03/MP input, $0.07 first MP output (4MP gen ≈ $0.28).
  - FLUX.2 [klein] 4B/9B: open-weight Apache 2.0, sub-second locally.
  - FLUX.1 Kontext Pro/Max: still served, $0.04 / $0.08 per edit.
- Endpoints: `https://api.bfl.ai/v1/flux-2-pro|max|flux-1-kontext-pro` (async — POST returns task id, GET `/v1/get_result/{id}`); fal `fal-ai/flux-2/pro|max`, `fal-ai/flux-pro/kontext`; Replicate `black-forest-labs/flux-2-pro|max`; OpenRouter `black-forest-labs/flux.2-pro|max|klein-4b`.
- Editing: Kontext is the editing branch.
- Tip: when passing 10 refs, **order matters** — ref 0 dominates style; refs 1–N contribute features in decreasing weight.

### Imagen 4 (Standard / Ultra / Fast) — Google
- Released 2025-05 [STABLE]; **no Imagen 5 announced as of 2026-05-01**.
- Best at: photorealism, Google-grade safety + SynthID watermarking.
- Worst at: agent ergonomics — more rigid than Gemini-image-pro; less editing surface.
- Resolution: up to 2K.
- Pricing: ~$0.03–0.06/image at 2K via Vertex AI; Fast cheaper.
- Endpoints: Gemini API `imagen-4.0-generate-001:predict`, `imagen-4.0-ultra-generate-001`, `imagen-4.0-fast-generate-001`; fal `fal-ai/imagen4/preview`.
- Tip: Imagen rewards adjective-heavy descriptive prompts; verb-heavy "thinking" prompts work better on Nano Banana Pro. Don't cross-port.

### MAI-Image-2 + MAI-Image-2-Efficient — Microsoft **[NEW]**
- MAI-Image-2 2026-03-18; MAI-Image-2-Efficient public preview April 2026, **41% cheaper, 22% faster**.
- Best at: "lived-in" photoreal — natural lighting, accurate skin tones. Top-3 on Arena.ai.
- Worst at: new entrant; community LoRAs / prompt libraries don't exist yet.
- Pricing: MAI-Image-2: $5/M text in, $33/M image out. MAI-Image-2e: $5/M text in, **$19.50/M image out**.
- Endpoint: Microsoft Foundry — `https://<resource>.services.ai.azure.com/models` with `model: "MAI-Image-2"` or `"MAI-Image-2e"`.
- Tip: explicit lighting language ("low key with rim light from camera-left") translates better than mood words.

---

## Strong Tier

### Midjourney V8.1 Alpha **[NEW]**
- V8 2026-03-17; **V8.1 2026-04-14**. HD default, **3× faster, 3× cheaper**.
- Best at: aesthetic quality, painterly/cinematic feel.
- Worst at: **NO PUBLIC API**. Web + Discord only. Unofficial proxies (WaveSpeedAI, Runware) are fragile.
- Pricing: $10–$120/mo subscription; no per-call.
- Tip: if forced to integrate, use `--oref <url>` with one clean character ref; `--iw 1.5` works again in V8.1.

### Recraft V4 — Recraft
- Released 2026-02 (V4 + V4 Pro).
- Best at: **vector / SVG export, logos, brand work** — only model with true SVG output.
- Worst at: photoreal portraits — V4 sacrifices realism for design coherence.
- Resolution: V4 = 1MP, V4 Pro = 4MP.
- Pricing: ~$0.04/image; SVG slightly more.
- Endpoints: `https://external.api.recraft.ai/v1/images/generations` (OpenAI-compatible); Replicate `recraft-ai/recraft-v3`; fal `fal-ai/recraft-v3`, `/v3/text-to-image`.
- Editing: mask inpaint, image-to-image, raster→SVG vectorize, background removal, generative upscale.
- Tip: specify the **style ID** (Recraft has 30+ named styles like `realistic_image/studio_portrait`, `digital_illustration/pixel_art`).

### Ideogram 3.0 — Ideogram
- 2025-03-26 [STABLE]. Still the typography king for budget tier.
- Best at: **in-image text rendering ~90–95% accuracy**, posters, ads, signage.
- Worst at: painterly ceiling lower than Midjourney; raw photoreal lower than Imagen 4 / FLUX.2.
- Pricing: Turbo $0.03, Default $0.05–0.075, Quality $0.09–0.11.
- Endpoints: `https://api.ideogram.ai/generate`; fal `fal-ai/ideogram/v3`; Replicate `ideogram-ai/ideogram-v3-turbo|quality`; Together `ideogram-3-0`.
- Editing: mask edit (`/v1/edit`), inpaint, "Remix", reference-style.
- Tip: put text in **double quotes** — `"Save the Reefs"` rendered as a banner is night-and-day vs unquoted text.

### Reve Image 1.5 / Edit / Remix
- Reve 1.0 2025-03; 1.5 + Edit + Remix updated through early 2026.
- Best at: prompt adherence on long prompts (200+ words); 98% text accuracy.
- Worst at: smaller community, fewer integrations.
- Resolution: 2048×2048 native, optional 4K upscale.
- Pricing: ~$0.04–0.06/image via AIMLAPI / WaveSpeedAI / Lumenfall.
- Tip: lean into long, structured prompts. Reve is one of the few models that *keeps getting better* past 100 words.

### Adobe Firefly Image 5 — Adobe **[NEW]**
- Image 5 announced late 2025; **Firefly AI Assistant public beta 2026-04-27** uses Image 5 + GPT-Image-1.5 + Nano Banana Pro side-by-side.
- Best at: **commercially safe** training data, native 4MP, integrated into Photoshop/Express, "Instruct Edit" natural-language workflow.
- Worst at: OAuth server-to-server + ~$1k/mo enterprise minimum.
- Endpoint: `https://firefly-api.adobe.io/v3/images/generate|edit`. OAuth.
- Tip: only frontier-tier choice with IP indemnification for commercial work.

### Seedream 5.0 Lite — ByteDance **[NEW]**
- 2026-02. Full Seedream 5.0 announced but not yet public.
- Best at: **Asian-art / anime / character-design**; chain-of-thought visual reasoning + real-time web search baked in.
- Resolution: native 2K + 4K, 2–3s gen.
- Pricing: **$0.035/image** (~22% cheaper than 4.5). Up to **14 reference images per call**.
- Endpoints: BytePlus, Volcano Ark, Replicate `bytedance/seedream-5-lite`, Atlas Cloud `bytedance/seedream-v5.0-lite/edit`, Runware.
- Editing: sequential edit (I2I), example-based edit.
- Tip: drop it 14 character refs and a single prompt sentence — its reasoning step picks consistent features automatically.

### Grok Imagine Image Pro — xAI **[NEW]**
- Grok Imagine API 2026-01-28; Image Pro variant March 2026.
- Best at: speed + low pricing among frontier-adjacent; Grok auto-expands prompts.
- Pricing: ~$0.02–0.04/image.
- Endpoints: `https://api.x.ai/v1/images/generations` model `grok-imagine-image-pro`; AIMLAPI `xai/grok-imagine-image-pro`.
- Tip: prompts can be terse — Grok auto-expands them.

---

## Open / Self-Host

### Stable Diffusion 3.5 Large / Medium / Turbo — Stability AI
- 2024-10 [STABLE]; **no SD4 announced as of 2026-05-01**. Stability has gone quiet.
- Best at: massive LoRA / ControlNet ecosystem on a 24GB GPU.
- Endpoints: HF `stabilityai/stable-diffusion-3.5-large`; Replicate `stability-ai/stable-diffusion-3.5-large`; fal `fal-ai/stable-diffusion-v35-large`.

### HiDream-I1 (Full / Dev / Fast) + HiDream-E1 — HiDream-ai
- I1 open-sourced 2025-04-07, MIT [STABLE]; E1-1 editing 2025-07.
- Best at: **#1 on Artificial Analysis open leaderboard**, 17B params, sparse diffusion transformer.
- Endpoints: HF `HiDream-ai/HiDream-I1-Full|-Dev|-Fast|-E1-Full`; fal `fal-ai/hidream-i1-full`.
- Tip: less sensitive to prompt-engineering tricks than SD/FLUX. Plain natural language outperforms tag soup.

---

## Aggregator / Niche

### Krea — Krea AI
- Real-time canvas painting + multi-model swap through one endpoint (20+ image models, 64+ total).
- "Nano Banana 2" branded experience launched 2026-02-27 + March 2026 UI redesign.
- Endpoint: `https://api.krea.ai/v1/...` (Business/Enterprise).
- Use for: rapid model A/B in production.

### Higgsfield — Higgsfield AI
- **MCP server** at `mcp.higgsfield.ai/mcp` (streamable-http + OAuth) — **no API keys needed for MCP-aware agents**.
- Aggregates GPT Image 2, Nano Banana Pro, FLUX 2, Seedream 5 Lite, Soul 2.0.
- Use for: lowest-friction integration for MCP-aware agents.

---

## Decision Tree

```
START: what's the goal?

├─ Photoreal portrait, single subject
│  ├─ Commercial-rights-clean? → Adobe Firefly Image 5
│  ├─ "Lived-in" natural light? → MAI-Image-2 [NEW]
│  ├─ Best raw quality, no rights worry? → GPT Image 2 (high) or FLUX.2 Pro
│  └─ Cheap + fast? → FLUX.2 Pro at $0.03 or Imagen 4 Fast
│
├─ Stylized illustration / painterly
│  ├─ Best aesthetics, ok with no API? → Midjourney V8.1 (web only)
│  ├─ Anime / Asian art? → Seedream 5.0 Lite (14 refs!)
│  └─ With API? → FLUX.2 Pro + style reference
│
├─ Typography / poster / signage
│  ├─ Frontier text + complex layout? → Nano Banana Pro
│  ├─ Budget? → Ideogram 3 Turbo ($0.03) — quote your text!
│  └─ Long prompts + dense info? → Reve Image 1.5
│
├─ Logo / vector / SVG export
│  └─ → Recraft V4 Pro (ONLY one with true SVG)
│
├─ Product mockup / brand-consistent ad shoot
│  ├─ → GPT Image 2 (reference fidelity) OR FLUX.2 Pro/Max with 10 refs
│  └─ Adobe Firefly Image 5 if licensing matters
│
├─ Character sheet — same character across many shots
│  ├─ → FLUX.2 Pro with 10 refs (best of API-available group)
│  ├─ → Nano Banana Pro for up to 5 subjects + identity preservation
│  └─ → Midjourney V8.1 with --oref (best aesthetics, no API)
│
├─ Batch ad variants (same product, 50 backgrounds)
│  ├─ Cheap: FLUX.2 Pro $0.03/image, parallel via fal/Replicate
│  └─ Premium: GPT Image 2 medium quality, ~$0.05/image
│
├─ Open weights / self-host
│  ├─ Best quality? → HiDream-I1-Full (17B, MIT)
│  ├─ Sub-second? → FLUX.2 Klein 4B
│  └─ Mature ecosystem (LoRAs, ControlNet)? → SD 3.5 Large
│
└─ Need image editing
   ├─ Instruct-edit ("remove the chair"): Nano Banana Pro, GPT Image 2 edit, Firefly Instruct Edit
   ├─ Mask inpaint: GPT Image 2 /edit, FLUX Kontext, Recraft, Ideogram /edit
   └─ Multi-image compose: FLUX.2 (10 refs), Seedream 5 Lite (14 refs), Nano Banana Pro (5 subjects)
```

---

## Past 30-day shifts

1. **GPT Image 2 hit fal.ai's enterprise tier 2026-04-21 [NEW]** — friendlier billing surface vs OpenAI direct.
2. **Midjourney V8.1 Alpha shipped 2026-04-14 [NEW]** — HD default, 3× cheaper, `--iw` works again.
3. **MAI-Image-2-Efficient launched April 2026 [NEW]** — 41% price drop.
4. **FLUX.2 Pro got a 2× speed upgrade April 2026 [NEW]** at same $0.03.
5. **Adobe Firefly AI Assistant entered public beta 2026-04-27 [NEW]**.
6. **Nano Banana Pro pricing is token-based** — at 4K can hit $0.20+ per image. Footgun.
7. **Imagen 5 does NOT exist as of 2026-05-01** — Google's frontier image moved to Gemini 3 Pro Image instead.
8. **FLUX Kontext is the editing branch of FLUX, not a newer model** — released May 2025.
9. **Stable Diffusion 4 has not been announced**. Open-weight torch passed to HiDream-I1 + FLUX.2 Klein.
10. **Seedream 5.0 *full* is announced but not public** — only Lite is API-callable.
11. **fal.ai is now ~30–50% cheaper than Replicate** for the same models, with 600+ vs ~200 endpoints.
12. **MCP-native image generation exists** — Higgsfield's MCP server (`mcp.higgsfield.ai/mcp`).
13. **"Nano Banana" vs "Nano Banana Pro" vs "Nano Banana 2" are all different things.** Always check.
14. **Multi-reference is the headline feature of 2026** — FLUX.2 takes 10, Seedream 5 Lite takes 14, Nano Banana Pro identity-preserves 5, Recraft V4 takes multiple style refs.
15. **Token-based pricing is replacing per-image** at the frontier (Nano Banana Pro, GPT Image 2, MAI-Image-2).
