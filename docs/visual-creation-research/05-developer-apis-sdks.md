# AI Visual Creation APIs — Agent Quick-Reference (2026-05-01)

> Audience: an in-game AI agent writing TS/Node/Bun code that calls these vendors. Recency bias: past 30 days.

---

## 1. Anthropic Claude — vision input + tool use [NEW Opus 4.7, Apr 16 2026]

Claude **does not generate images** itself. Visual surface is **vision input** + tool-use orchestration that calls one of the generators below. Claude Design (2026-04-17) is a hosted product, not a public REST endpoint.

**Past 30 days:** Opus 4.7 raised max image input to **2576px / 3.75 MP** (was 1568px / 1.15 MP) — important for screenshots, diagrams, "render then audit" loops.

- Endpoint: `POST https://api.anthropic.com/v1/messages`
- Auth: `x-api-key: $ANTHROPIC_API_KEY` + `anthropic-version: 2023-06-01`
- Models: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- Image source types: `base64`, `url`, `file_id` (Files API — upload once, reference by id; cheaper than re-base64'ing)
- Pricing (Opus 4.7): $5 / $25 per MTok in/out. Image tokens ≈ `(width × height) / 750`.

```ts
import Anthropic from "@anthropic-ai/sdk";
const c = new Anthropic();
const r = await c.messages.create({
  model: "claude-opus-4-7", max_tokens: 1024,
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
    { type: "text", text: "What broke in this UI?" }
  ]}]
});
```

---

## 2. OpenAI — `gpt-image-1.5`, `gpt-image-1-mini`, Sora 2

**Image** (`POST https://api.openai.com/v1/images/generations` and `/v1/images/edits`)
- Models: `gpt-image-1.5` [NEW main flagship as of Mar 2026], `gpt-image-1-mini`, legacy `gpt-image-1`
- Pricing per 1024×1024 output:
  - `gpt-image-1-mini` low/medium/high: **$0.005 / $0.011 / $0.04**
  - `gpt-image-1.5` low/med/high: **$0.009 / $0.034 / $0.133**
  - 2048×2048 high: ~$0.20
- Edits/inpaint: same endpoint with `image[]` + `mask` multipart fields

**Sora 2 video** (`POST https://api.openai.com/v1/videos`)
- Models: `sora-2`, `sora-2-pro`. Snapshot pinning: `sora-2-2025-12-08`
- Body: `model`, `prompt`, `size` ("1280x720" or "720x1280"; pro adds 1024×1792), `seconds` (4, 8, or 12; pro adds up to 25)
- Pricing: **sora-2 = $0.10/sec @720p**, **sora-2-pro = $0.30/sec @720p, $0.50/sec @1024p**
- Queue: returns `{id, status: "queued"}` — poll `GET /v1/videos/{id}`. **No native webhook — wire your own poll loop.**
- Rate limit: 25 RPM Tier 1 → 375 RPM Tier 5; free tier blocked.

```bash
curl -X POST https://api.openai.com/v1/videos \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F model=sora-2 -F prompt="a lobster racing on a reef track" \
  -F size=1280x720 -F seconds=8
```

---

## 3. Google Gemini API / Vertex AI — Nano Banana Pro, Imagen 4, Veo 3.1

Two surfaces: Gemini Developer API (`generativelanguage.googleapis.com`, simple key auth) and Vertex AI (`*-aiplatform.googleapis.com`, OAuth + project/region). **Veo and Imagen-4 production scale → Vertex; prototype → Gemini API.**

### Nano Banana Pro = `gemini-3-pro-image-preview`
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent`
- Pricing: $2/$12 per MTok in/out → **~$0.134 per 1K/2K image, $0.24 per 4K**. Batch API halves cost (24h SLA).
- 65,536 token context — supports multi-image edit / character consistency in one call.

### Imagen 4 (Vertex)
- Endpoint: `POST https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT/locations/us-central1/publishers/google/models/imagen-4.0-generate-001:predict`
- Tiers: Fast **$0.02**, Standard **$0.04**, Ultra **$0.06** per image

### Veo 3.1 (Vertex) [NEW: extension in preview, Apr 2026]
- Endpoint: `…/models/veo-3.1-generate-001:predictLongRunning` → returns LRO name → poll `…:fetchPredictOperation`
- Pricing: **Lite $0.05/s · Fast no-audio $0.10/s · with audio $0.35–0.50/s**

```ts
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const r = await ai.models.generateContent({
  model: "gemini-3-pro-image-preview",
  contents: [{ parts: [{ text: "isometric reef race kart, top-down, transparent" }] }]
});
```

---

## 4. fal.ai — model aggregator with TS-first SDK

- SDK: `npm i @fal-ai/client` (`fal.config({ credentials })`)
- Pattern: **subscribe** (await full result, internally polls) OR **queue.submit** + webhook
- Pricing varies — `fal-ai/flux/schnell` ~$0.003/MP; `flux/dev` $0.025; `flux-2-pro` ~$0.03; Seedream V4 $0.03/img; Grok Imagine Edit $0.022; Kling 2.5 Turbo Pro **$0.07/s**; Wan 2.5 **$0.05/s**; Seedance 1.5 Pro $0.26 per 5s 720p

```ts
import { fal } from "@fal-ai/client";
fal.config({ credentials: process.env.FAL_KEY! });

const r = await fal.subscribe("fal-ai/flux/schnell", {
  input: { prompt: "lobster racer", image_size: "square_hd" },
  logs: true,
});

const { request_id } = await fal.queue.submit("fal-ai/kling-video/v2.5/turbo/pro/text-to-video", {
  input: { prompt: "...", duration: "5" },
  webhookUrl: "https://api.clawville.world/webhooks/fal",
});
```

Webhook payload: `{ request_id, gateway_request_id, status: "OK"|"ERROR", payload }`. Verify with `fal-webhook-secret` header.

---

## 5. Replicate [NEW Cloudflare]

- SDK: `npm i replicate`
- **Predictions** = one-shot run (cold-startable). **Deployments** = your own auto-scaling pool with `min_instances` to keep warm.
- Cold start 3–10s for cold; ~0s for "Official models" (always-warm).
- Billing: per-second of GPU time. CPU $0.0001/s → 8× H100 $0.0122/s. Typical SDXL-class run ~$0.012.
- Webhooks: `webhook` + `webhook_events_filter: ["completed"]` on create.

```ts
import Replicate from "replicate";
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN! });
const out = await replicate.run("black-forest-labs/flux-1.1-pro", {
  input: { prompt: "lobster racer", aspect_ratio: "1:1" },
  webhook: "https://api.clawville.world/webhooks/replicate",
  webhook_events_filter: ["completed"],
});
```

**Fastest cold-start:** Official models (`black-forest-labs/flux-schnell`, `meta/meta-llama-3-8b-instruct`, `stability-ai/sdxl`) — always warm.

---

## 6. Black Forest Labs (FLUX direct)

- Base: `https://api.bfl.ai`
- Auth: `x-key: $BFL_API_KEY`
- Pattern: `POST /v1/<model>` → returns `{ id, polling_url }` → GET `polling_url` until `status:"Ready"`
- 1 credit = $0.01. **24 concurrent task cap** per key.
- Pricing (April 2026):
  - **FLUX.2 [klein] 4B from $0.014**
  - **FLUX.2 [pro] $0.03** (text-to-image; **2× faster as of Mar 3 2026, no price change**)
  - FLUX.2 [pro] edit ~$0.045 · FLUX.1 Kontext [pro] **$0.04** · FLUX.1 [pro] Ultra $0.06

**Direct vs fal/Replicate:** direct BFL is ~10–20% cheaper, but you implement your own queue + retry. fal gives LoRAs, ControlNet variants, unified TS SDK. Most teams: prototype on fal, migrate hot path to BFL direct.

---

## 7. Runway API [NEW Seedance 2.0 Apr 17 2026]

- Base auth: API key from `dev.runwayml.com` dashboard, header `X-Runway-Version` + `Authorization: Bearer`
- Credits = $0.01 each.
- Models: `gen4_image` (5cr 720p / 8cr 1080p = **$0.05–0.08/img**), `gen4_image_turbo`, `gen4_turbo` (video, **5cr/s = $0.05/s**), `gen4.5` (**12cr/s = $0.12/s**), `gen3a_turbo`, `act_two`, `veo3`, `veo3.1`, `veo3.1_fast`. One subscription = access to Veo / Kling / Seedance / FLUX / Seedream alongside Runway-native.

```ts
import RunwayML from "@runwayml/sdk";
const runway = new RunwayML();
const task = await runway.imageToVideo.create({
  model: "gen4_turbo", promptImage: "https://...png",
  promptText: "camera dollies in", duration: 5, ratio: "1280:720",
});
```

---

## 8. Stability AI — SD 3.5 + Stable Image v2beta

- Base: `https://api.stability.ai`
- Endpoints (`v2beta/stable-image/generate/...`): `core`, `ultra`, `sd3`
- Auth: `Authorization: Bearer $STABILITY_KEY`, `Accept: image/*` (binary back) or `application/json` (b64)
- ControlNet: `v2beta/stable-image/control/{sketch,structure,style}`
- Pricing per image (credits @ $0.01 each): Core 3cr · Ultra 8cr · SD3.5 Large 6.5cr · ControlNet 3–4cr
- **Multipart-form bodies (NOT JSON).** Quirk worth knowing.

---

## 9. Higgsfield Soul + Soul ID

Direct REST is gated; production access via aggregators (WaveSpeedAI, Segmind, fal).
- Soul 2.0 text-to-image: $0.12–0.23 per generation
- **Soul ID character training: $3 per session, 15–20 reference photos, ~3–5 min**
- Soul ID inference: same Soul 2.0 endpoint with `soul_id` field
- Video (Higgsfield motion): $0.10/s

When you need a **persistent character** across many gens — don't roll your own LoRA training loop, pay the $3.

---

## 10. ElevenLabs v3 [NEW video-to-music Apr 1 2026]

- Base: `https://api.elevenlabs.io`
- Auth: `xi-api-key: $ELEVENLABS_KEY`
- TTS: `POST /v1/text-to-speech/{voice_id}` (1 credit per character)
- TTS streaming: `POST /v1/text-to-speech/{voice_id}/stream` → chunked PCM/MP3 (low-latency for game NPCs)
- Sound effects: `POST /v1/sound-generation`
- **Music:** `POST /v1/music`, `POST /v1/music/stream`, **`POST /v1/music/video-to-music` [NEW Apr 1 2026]** — multipart video in, score out
- Music params: `prompt` OR `composition_plan` (mutually exclusive), `length_ms` 3000–600000, `force_instrumental`.

```ts
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
const el = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_KEY! });
const audio = await el.textToSpeech.convert("21m00Tcm4TlvDq8ikWAM", {
  text: "Welcome to ClawVille",
  modelId: "eleven_v3",
  outputFormat: "mp3_44100_128",
});
```

---

## 11. Suno / Udio

**No sanctioned developer API from either** as of May 2026. Suno v5.5 (Mar 2026) added voice cloning + Suno Studio DAW but kept ToS that forbids automation. Programmatic access is via reverse-engineered third-parties (sunoapi.org, aimusicapi.ai, kie.ai) — **carry account-ban + ToS risk; do not use for shippable production**.

---

## 12. Kling / Hailuo / MiniMax

- **MiniMax / Hailuo direct:** `platform.minimax.io`. Hailuo 2.3 video **$0.08/s**. China-region account required for some keys.
- **Kling direct:** subscription-only at consumer tier; **no good per-call API for foreigners** — go through fal (`fal-ai/kling-video/v2.5/turbo/pro/...` at $0.07/s) or WaveSpeed.

---

## 13. Image upload patterns

| Method | When | Cost / latency |
|---|---|---|
| **base64 inline** | <1 MB, single-shot | High token cost |
| **HTTPS URL** | Public CDN already | Cheapest; provider fetches |
| **Files API / file_id** | Multi-turn vision (Anthropic, OpenAI) | Upload once, cuts tokens 5–10× |
| **Multipart form** | Stability, Sora 2, BFL edits | Required for some; binary-safe |
| **Signed S3/R2 URL** | Private user uploads | 5-min presigned → pass URL to provider |

**Recommended for ClawVille:** Cloudflare R2 (no egress fee — saves 80%+ vs S3 for image-heavy game).

---

## 14. Webhook + queue patterns

**Long video (Sora 2, Veo, Kling):** all return immediately with `{id, status}`. Two patterns:

1. **Polling:** `setTimeout` exponential 2s → 5s → 10s → 30s, give up at 10 min. Idempotent.
2. **Webhook:** preferred when supported (fal, Replicate, Runway). Verify HMAC signature header. **Idempotency:** dedupe on `request_id`.

```ts
async function pollUntilDone<T>(get: () => Promise<{status:string,result?:T}>, key:string) {
  for (let i = 0; i < 20; i++) {
    const s = await get();
    if (s.status === "succeeded") return s.result!;
    if (s.status === "failed") throw new Error(`failed:${key}`);
    await new Promise(r => setTimeout(r, Math.min(30000, 2000 * 1.5 ** i)));
  }
  throw new Error(`timeout:${key}`);
}
```

**Retry rules:** never retry `POST /create` without `Idempotency-Key` (OpenAI, Stripe-style) or you'll be billed twice.

---

## 15. Cost optimization

- **Cache by prompt hash.** Same prompt + same seed + same model = identical output. SHA-256(prompt+seed+model+size) → R2 key. 30–50% hit rate on game-asset workloads.
- **Batch APIs cut 50%.** Google batch (24h SLA), OpenAI batch (24h). Use for non-realtime asset pipelines (NPC portrait pre-bake).
- **Tier per intent:**
  - In-flow loading icon → `gpt-image-1-mini low` ($0.005) or `flux/schnell` ($0.003)
  - Hero asset (curated/manual approval) → FLUX.2 [pro] direct ($0.03) or Imagen 4 Ultra ($0.06)
  - Character locked across N scenes → Higgsfield Soul ID ($3 once + $0.15/gen) beats per-call img-edit
  - 30-second cinematic → Veo 3.1 Lite ($0.05/s × 30 = $1.50) over Sora 2 ($3.00)
- **Dedupe in-flight requests.** `Map<string, Promise>` keyed by prompt hash.
- **Always set max output size.** Don't ask for 4K when you'll downscale to 512px in CSS — Nano Banana Pro charges 78% more for 4K.

---

## "Which API, when" decision tree

| Need | Pick | Why |
|---|---|---|
| Latency-critical realtime image (<2s) | `fal-ai/flux/schnell` via subscribe, or `gpt-image-1-mini low` | Sub-second on warm fal; sub-3s mini |
| Cheapest bulk image | `flux/schnell` ($0.003/MP) → batch via fal queue | Cheapest non-trivial-quality |
| Highest-quality single image | Nano Banana Pro at 4K, or FLUX.2 [max] | Top SOTA leaderboards |
| Character-locked across scenes | Higgsfield Soul ID | Cheaper and better than rolling LoRA |
| Steerable (ControlNet, depth, edges) | Stability v2beta `/control/*` or fal FLUX ControlNet | Direct geometric control |
| Multimodal + steerable | Nano Banana Pro or `gpt-image-1.5 edit` | Both natively accept image + edit prompt |
| Longest video (>20s) | Sora 2 Pro (up to 25s) or chained Veo 3.1 + extension | Sora native; Veo via extension |
| Cheapest video | Veo 3.1 Lite $0.05/s or Wan 2.5 $0.05/s on fal | Tied at the floor |
| Best-quality video w/ audio | Veo 3.1 (with audio) $0.35–0.50/s | Native synced audio, beats Sora 2 on physics |
| Image-to-video w/ keyframes | Runway Seedance 2.0 (Apr 17 2026) | Keyframe control + audio |
| Music for game scene | ElevenLabs `/v1/music/stream` | Streaming, instrumental flag, MIT-style usage rights |
| Music from existing video | ElevenLabs `/v1/music/video-to-music` [NEW] | Only major API doing this |
| TTS for NPC dialog (low-latency) | ElevenLabs `/v1/text-to-speech/{voice_id}/stream` | Sub-300ms first byte |
| Multi-vendor failover | Replicate or fal as gateway | One SDK, dozens of models |

---

## Past 30 days

| Date | Vendor | Change |
|---|---|---|
| Apr 1 | ElevenLabs | New `POST /v1/music/video-to-music` endpoint |
| Apr 16 | Anthropic | Claude Opus 4.7: 2576px / 3.75 MP image input ceiling (3.3× prior) |
| Apr 17 | Anthropic | Claude Design product launched (UI tool, not API) |
| Apr 17 | Runway | Seedance 2.0 added with keyframe + audio |
| Apr 21 | ElevenLabs | API schema 2.44.0 — `trust_context`, `pre_tool_speech` mode |
| Apr 27 | ElevenLabs | SDK 2.45.0 — phonetic names + `song_id` surfacing |
| Mar 3 | BFL | FLUX.2 [pro] 2× faster, no price change |
| Late Mar | OpenAI | gpt-image-1.5 promoted to default |
| Ongoing | Cloudflare | Replicate acquisition closing; FLUX.2-dev native on Workers AI |

**No-change:** Suno/Udio still no official API · Kling still aggregator-only for non-CN devs · Anthropic still does not generate images · Sora 2 still has no native webhook · BFL direct still capped at 24 concurrent tasks.
