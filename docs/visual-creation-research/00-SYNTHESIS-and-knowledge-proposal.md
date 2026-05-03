# Visual Creation — Synthesis & Knowledge[] Proposal

> Generated 2026-05-01 from a 5-agent ultrathink research team. Source reports live alongside this doc (`01-image-generation.md`, `02-video-generation.md`, `03-3d-asset-generation.md`, `04-agentic-workflows.md`, `05-developer-apis-sdks.md`).

## Recommended building to repurpose

**`visual-creation` (Pineapple House) — currently themed "Data & Analytics", teacher SpongeBob the Canvas Creator.**

Rationale:
- Name "Canvas Studio" already maps to visual creation.
- Existing `knowledge[]` cites DALL-E and "Stable Diffusion" as flagships — both severely stale (DALL-E demoted to legacy at OpenAI; SD3.5 has been overtaken by HiDream + FLUX.2 in the open-weight tier).
- Lowest-utilization theme in the current building set.
- SpongeBob's voice ("MAKE IT COLORFUL!") fits the visual-creation domain perfectly — no character rewrite needed.

**Theme rename:** `BUILDING_OPENCLAW_THEMES['visual-creation']` from `Data & Analytics` → `Visual Creation (Image / Video / 3D)`.

---

## Five canonical "what shifted" headlines

Any agent reading this knowledge whose snapshot is older than 2026-04-01 will get these wrong:

1. **Sora's consumer app died 2026-04-26.** API alive until 2026-09-24, then gone. New pipelines default to Veo 3.1, Kling 3.0, or Seedance 2.0.
2. **Nano Banana Pro = `gemini-3-pro-image-preview`** is the current frontier image model, not Imagen 5 (which doesn't exist).
3. **FLUX.2 Pro got 2× faster in April 2026** at the same $0.03/image — and accepts up to 10 reference images per call.
4. **Multi-reference is the headline 2026 feature** — FLUX.2 takes 10, Seedream 5 Lite takes 14, Nano Banana Pro identity-preserves 5. Single-ref work leaves consistency wins on the table.
5. **MCP-native image gen exists** — Higgsfield's MCP server (`mcp.higgsfield.ai/mcp`) lets MCP-aware agents call 30+ image/video models with no per-vendor API keys.

---

## Proposed `knowledge[]` for `packages/agent-templates/src/locations/visual-creation.ts`

Replaces the current 7-item array. 25 items, each callable-actionable, written to be voiced by SpongeBob without losing technical precision.

```ts
knowledge: [
  // === image generation ===
  'For frontier-tier image generation in 2026, the top three are Nano Banana Pro (gemini-3-pro-image-preview), GPT Image 2, and FLUX.2 Pro — all callable via OpenAI-compatible REST or the fal.ai aggregator.',
  'Nano Banana Pro (Google) is best for in-image text rendering, infographics, and identity preservation across up to 5 subjects. Pricing is token-based, ~$0.13 per 2K image, ~$0.24 per 4K.',
  'FLUX.2 Pro accepts up to 10 reference images in one call and got a 2× speed upgrade in April 2026 at the same $0.03/image — best default for multi-reference brand/character work.',
  'GPT Image 2 (OpenAI) is best for brand-consistent product shots and pixel-perfect typography; pricing is token-based ($0.005 low / $0.053 medium / $0.21 high per 1024×1024).',
  'For SVG and vector logos, Recraft V4 Pro is the only model with true SVG output — name a style ID like `digital_illustration/pixel_art` for best results.',
  'Ideogram 3 Turbo at $0.03/image is the budget pick for posters and signage; quote your text in double quotes ("Save the Reefs") to trigger its typography renderer.',
  'For character consistency across many shots, escalate in this order: multi-reference prompts → Higgsfield Soul ID ($3 to train an identity, then $0.15/gen) → custom LoRA training on fal.ai (~$2.40 floor, 1000 steps).',
  // === video generation ===
  'For frontier-tier video, default to Veo 3.1 (native synced audio, $0.10–0.40/s depending on tier), Kling 3.0 Pro (native 4K as of 2026-04-24, multi-shot), or Seedance 2.0 (multimodal text+image+audio+video input, up to 20s).',
  'OpenAI Sora 2 is deprecating: the consumer app shut down 2026-04-26 and the API ends 2026-09-24. New pipelines should target Veo 3.1, Kling 3.0, or Seedance 2.0.',
  'For talking-head video from a still photo, Hedra Character-3 is the specialist (~6 credits/sec @ 720p, 15+ languages); for lipsync onto an existing video, Sync.so is the only API priced for programmatic batch use.',
  'Veo 3.1 reads quoted dialogue with speaker tags ("A grizzled fisherman says, \'The reef is restless.\'") — its native audio engine will synthesize the line. Kling 3.0 cuts on numbered shot prompts ("Shot 1: ... Shot 2: ...").',
  'Open-source video is now viable on a single RTX 4090 thanks to HunyuanVideo 1.5 with the December 2025 distilled I2V model and the CVPR 2026 DisCa accelerator (~11× faster).',
  // === 3d asset generation (Three.js consumer) ===
  'For game-ready rigged humanoid 3D characters, Tripo 3.0 Ultra is the fastest pipeline — exports T-pose with skeleton, retargets cleanly via AccuRIG 2 → Mixamo. Always request T-pose explicitly or Mixamo retargets break.',
  'For stylised characters with clean quad topology, Hunyuan 3D + PolyGen produces the best public auto-retopo on the market. Feed a roughly front-3/4 view on a clean white/transparent background.',
  'For hard-surface props with clean part separation (modular gear, mechanical detail), Rodin Gen-2 is the pick — set `tier=Gen-2` and `tapose=true` or you get an action-pose mesh that breaks every retarget.',
  'Three.js consumes glTF 2.0 with sharp edges: glTF is Y-up (Blender is Z-up — export with +Y Up); Draco compresses geometry, KTX2 compresses textures, meshopt overlaps both — never combine Draco + meshopt on the same mesh.',
  'Always use `three/addons/loaders/KTX2Loader.js` — the `three-stdlib` copy is WebGL-only and crashes silently under WebGPU. Set `SkinnedMesh.frustumCulled = false` on every cloned skinned mesh or animated characters disappear at certain camera angles.',
  // === workflows / aggregators / patterns ===
  'fal.ai (`@fal-ai/client`) is the default aggregator for agent code — 600+ models behind one API, queue-with-webhooks via `fal.queue.submit({input, webhookUrl})`, ~30–50% cheaper than Replicate. Use it for any task that needs to run async with a callback.',
  'Replicate is being acquired by Cloudflare (April 2026) — expect tight Workers/R2 integration. For warmest cold-starts, use "Official models" (`black-forest-labs/flux-schnell` etc.) which stay always-warm.',
  'Higgsfield ships an MCP server at `mcp.higgsfield.ai/mcp` (streamable-http + OAuth) — MCP-aware agents can call GPT Image 2, Nano Banana Pro, FLUX 2, and Soul 2.0 with no per-vendor API keys.',
  'For complex chained workflows (image → video → lipsync → music), build with ComfyUI and ship as an API via ComfyDeploy (Vercel-style cold start in seconds) or RunPod Serverless (more hardware control, slower cold start).',
  'A typical 30-second AI product ad pipeline: train Soul ID once → FLUX.2+Kontext storyboards (10 refs) → Veo 3.1 Reference for 5s clips → Sync.so lipsync if speaking → ElevenLabs Music + v3 voiceover → Topaz Astra 2 upscale to 4K → Runway Aleph or Pika Frames final cut. Total cost ≈ $8–15 of API spend.',
  'Always set an `Idempotency-Key` header on POST /create or you get billed twice on retry. Long jobs (Sora 2, Veo, Kling) return immediately with `{id, status}` — poll with exponential 2s→30s backoff capped at 10 min, or set a webhook and verify the HMAC signature.',
  // === cost discipline ===
  'Cache by SHA-256 of (prompt + seed + model + size) → R2 key — same inputs produce identical outputs and game-asset workloads see 30–50% hit rates. Use OpenAI/Google Batch APIs (24h SLA) to halve cost on non-realtime asset bakes.',
  'Tier the model by intent: in-flow loading icons → flux/schnell ($0.003) or gpt-image-1-mini low ($0.005); hero curated assets → FLUX.2 Pro ($0.03) or Imagen 4 Ultra ($0.06); 30-second cinematic → Veo 3.1 Lite ($0.05/s × 30 = $1.50) instead of Sora 2 Pro ($3+).',
],
```

---

## Same-diff doc updates required (per CLAUDE.md mandate)

When this knowledge[] change ships, the same diff MUST update:

1. **`packages/shared/src/constants/building-types.ts`** (or wherever `BUILDING_OPENCLAW_THEMES` lives) — change `visual-creation` from `Data & Analytics` to `Visual Creation (Image / Video / 3D)`.
2. **`packages/agent-templates/src/locations/town-guide.ts`** (Nori) — update `knowledge[]` entries that name `visual-creation` so Nori's onboarding chat reflects the new theme.
3. **`GameFeatures.md`** — update the 10-buildings table row for `visual-creation`.
4. **`packages/agent-templates/src/locations/visual-creation.ts`** — `bio[]`, `lore[]`, `topics[]`, `messageExamples[]` should mention image/video/3D pipelines, not "rainbow charts that made Mr. Krabs cry". Bio can stay SpongeBob-flavored — just shift the subject from data-viz to visual creation.
5. **`packages/shared/src/constants/knowledge-books.ts`** — the 2 books currently themed for visual-creation's "Data & Analytics" focus need re-themed to Visual Creation (one image-focused, one video-focused, or one image+video and one 3D — pick by economy spread).
6. **CLAUDE.md** — the "10 SpongeBob-Landmark Buildings" table row for `visual-creation` should change `Data & Analytics` → `Visual Creation`.

---

## Open questions for the user

1. **Confirm building choice** — `visual-creation` is the recommendation; if you'd rather repurpose a different one, name it.
2. **Knowledge depth** — 25 items is a balance between teachability and recall hit. Want it shorter (15, more memorable) or longer (40, more reference-y)?
3. **Tone** — the entries are written to be SpongeBob-voiceable (factual on top, character renders in chat). Confirm or push to a different teacher.
4. **Books** — should I propose specific replacements for the 2 knowledge books too (per `knowledge-books.ts`), or leave that as a follow-up?

Once you confirm, I'll wire all six same-diff edits in one commit and push to deploy.
