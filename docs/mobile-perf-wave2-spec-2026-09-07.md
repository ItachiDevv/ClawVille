# Mobile Perf Wave 2 — phone texture cap + VRM precache

**Date:** 2026-09-07 · **Founder approval:** phone-tier 512² textures approved 2026-08-20
("3 is good"). **Branch:** `perf/cold-load-diet` (cv-covefreeze, on origin/staging).
**Authors:** Fable (spec/verify/ship) · Codex (implement) · 3da (review) — Rule E3.
**Prior art:** P1b (`ed2684d8`, docs/perf-p1b-texture-vram-spec-2026-07-14.md) already
shipped character KTX2 + VRM cross-instance texture dedupe. Wave 1 (`0e2fa0c2`,
docs/mobile-perf-wave1-spec-2026-08-20.md) shipped device classes + the phone profile.

## Measured baseline (live staging census 2026-09-07, CDP probe)

237 scene textures ≈ **293 MB** estimated GPU memory. The remaining fat:
**51 uncompressed textures ≈ 188 MB (64%)** — 35× uncompressed 1024² `map` slots plus
one 1536×1152, mostly VRM avatar textures (names `Image_0`, `Image_1`, numeric ids;
P1b deliberately did NOT re-encode the VRM files) and a few stragglers. The
compressed KTX2 set is only ~104 MB and is NOT a target here.

## Deliverable — one web-only diff, two parts

### 1. Phone-class uncompressed-texture cap (512²)

Add `maxUncompressedTextureSize` to `WORLD_DEVICE_PROFILE`
(`apps/web/src/lib/three/device-class.ts`): phone = **512**, tablet = 1024,
desktop-low / desktop-capable = **null (no cap — desktop stays byte-identical)**.

Mechanism — runtime downscale BEFORE first GPU upload, no asset re-encode:
- Apply in `apps/web/src/lib/three/vrm-loader.ts` at the point where P1b's
  cross-instance canonical texture registration happens: downscale FIRST, then
  register, so every instance shares the already-small texture and the cap runs
  once per unique texture, never per instance.
- Also apply to any other uncompressed-texture load path in the world scene
  (non-KTX2 GLB loads through `use-gltf-ktx2.ts` / drei `useGLTF` — Codex maps the
  real set; the census shows a 1536×1152 uncompressed `map` and a 1024²
  `roughnessMap` outside the VRM set). A shared helper in one file, e.g.
  `downscaleTextureForDevice(tex, maxSize)`, used by both paths.
- Downscale via `createImageBitmap(image, { resizeWidth, resizeHeight, resizeQuality: 'high' })`
  with an OffscreenCanvas/canvas fallback; preserve `colorSpace`, `flipY`,
  `wrap*`, `minFilter`/`magFilter`; set `needsUpdate`. Only when
  `max(width, height) > cap` and the texture is NOT `isCompressedTexture` and NOT
  a render target. Never touch KTX2/compressed textures (transcoded size is fixed).
- SkinnedMesh/MToon safe: this swaps `texture.image` content only — no material,
  UV, or extension changes. Async is acceptable ONLY if the texture is not yet
  uploaded; if the image is already uploaded, do the swap synchronously from the
  decoded source before first render of that instance (P1b registration point is
  pre-upload — confirm and keep it that way).
- ⚠️ TRAP: the P1b dedupe registers canonical textures keyed by glTF texture index
  via `gltf.parser.associations`. Downscaling must not break association lookup —
  downscale the texture OBJECT in place (image swap), never replace the texture
  instance.
- ⚠️ TRAP: VRM textures are WebP-decoded `ImageBitmap`s in three r185;
  `createImageBitmap(imageBitmap, …)` re-sampling is supported, but a `null`/
  closed bitmap must fail open (keep original). Every failure path keeps the
  original texture — the cap is an optimization, never a correctness gate.
- Escape hatch: `?texcap=0` disables the cap; `?texcap=512` forces it on any
  device class (desktop verification). Same URLSearchParams pattern as
  `?fpscap`/`?devclass` in wave 1.

Expected effect on phone: uncompressed bucket ~188 MB → ~47 MB; scene total
~293 MB → ~150 MB. Desktop/tablet unchanged (tablet cap 1024 only clamps the
1536×1152 straggler).

### 2. VRM roster precache in sw.js

- Add the ambient/wanderer VRM paths (the 13 preloaded VRMs under `/avatars/…`;
  Codex reads `asset-preload-manifest.ts` for the authoritative list) to the
  page-signaled deferred precache roster in `apps/web/public/sw.js`
  (`PRECACHE_GLBS`-style array; the v11/v12 `clawville:precache` handshake and
  the byte-ledger eviction from wave 1 stay UNCHANGED).
- Respect `MAX_INDIVIDUAL_BYTES` (10 MB) — every VRM in the roster is under it;
  verify sizes on disk and list them in the report. Do NOT raise the cap and do
  NOT add `cove-interior-cleaned-v1-ktx.glb` (18.8 MB) — that is a separate
  decision, flag it in the report only.
- Bump the sw.js `CACHE_VERSION` comment/version per its established pattern
  (v12 → v13) with a header changelog line.

## Hard constraints (kill-the-build)

- Desktop render behavior byte-identical (cap null on both desktop classes).
- NO per-frame work: the cap runs at load/registration time only.
- NO `InstancedMesh + ShaderMaterial`, NO drei `<Text>`/`<Billboard>`, NO
  per-frame allocations, NO runtime `setPixelRatio`.
- NEVER `bun run dev`. Verify = `bun run build && bun run start`.
- TypeScript strict; kebab-case files.
- Same-diff docs: `3dStructure.md` (texture pipeline section: the phone cap +
  precache, bump Last Audited) + `FOUNDER-REVIEW.md` (extend the existing
  "Mobile perf wave 1 phone feel-pass" entry to a wave 1+2 entry — texture
  sharpness on phone is the new question; do not add a duplicate entry).

## Verify loop (before ship)

1. `bun run build` green; `cd apps/web && bunx tsc --noEmit` clean.
2. Local prod bundle :3010 + CDP census probe
   (scratchpad `cdp-texture-census.mjs`): desktop pass unchanged (~293 MB,
   51 uncompressed); `?devclass=phone` pass shows the uncompressed bucket
   collapsed (expect ≤ ~60 MB) with textures still visually correct
   (screenshot NPCs up close — no black/blurry-beyond-expected maps).
3. `?texcap=0` restores the desktop numbers on phone class.
4. sw.js: cold load → VRM entries appear in the v13 cache after the page signal.
5. Real-phone verdict = founder (FOUNDER-REVIEW entry).

## Out of scope

API telemetry beacon (next slice — touches backend), cove-interior cache-cap
decision, any VRM/GLB re-encode, tablet 512 cap.
