# KTX2 Tooling And Lab Notes

Date: 2026-06-08

## What Was Downloaded

- Downloaded Khronos KTX-Software 4.4.2 for Windows to `.tools/downloads/KTX-Software-4.4.2-Windows-x64.exe`.
- Downloaded Khronos KTX-Software 4.4.2 for Linux to `.tools/downloads/KTX-Software-4.4.2-Linux-x86_64.tar.bz2`.
- Extracted the Linux package to `.tools/ktx-linux/` and verified `./.tools/ktx-linux/bin/toktx --version` through WSL.
- `.tools/` is gitignored. These binaries are local tooling, not repo assets.

Verified version:

```text
toktx v4.4.2
```

## Why This Matters

Three.js KTX2 loading can avoid CPU-side image decode and reduce GPU upload pressure compared with WebP/PNG runtime texture uploads. This is the right kind of performance spike for ClawVille because it can preserve visual fidelity if the pipeline is correct. It should not replace buildings or avatars with lower-quality proxy meshes.

## Lab Finding: VRM KTX2 Is Blocked

Tested stock glTF Transform UASTC conversion on `apps/web/public/avatars/milady-chibi.vrm` into a lab copy.

Result:

- Source VRM includes `VRMC_vrm`.
- Converted lab GLB includes `KHR_texture_basisu`.
- Converted lab GLB does not retain `VRMC_vrm`.

Conclusion: do not run stock `gltf-transform uastc` on shipping VRM files. VRM texture compression needs an extension-preserving pipeline and a validator that fails if `VRMC_vrm` is missing. Any candidate must also pass idle, walk, run, and emote visual QA before a runtime swap.

## Lab Finding: Current WebP GLBs Are Not Direct KTX2 Inputs

Tested stock UASTC conversion on `apps/web/public/models/quest-bounty-pavilion.glb`.

Result:

- Source uses `EXT_texture_webp` and `EXT_meshopt_compression`.
- UASTC command skipped the embedded WebP textures.
- Output did not gain `KHR_texture_basisu`.
- Output was larger and lost meshopt compression.

Conclusion: do not run KTX2 conversion directly against current WebP-embedded runtime GLBs. KTX2 experiments must start from PNG/JPEG source GLBs, such as `apps/web/public/models/.webp-backup` where available, or another pre-WebP source export.

## Required Safety Gates

- VRM variants must preserve `VRMC_vrm`.
- GLB KTX2 variants must contain `KHR_texture_basisu`.
- WebP runtime GLBs must not be used as direct UASTC inputs.
- Meshopt/Draco geometry policy must be validated after texture conversion; do not silently ship a larger file that removed geometry compression.
- Browser metrics must compare wire bytes, texture upload timing, frame stability, and screenshots before any runtime asset swap.

## Next Implementation Step

Build a targeted KTX2 lab script that reads only source/pre-WebP GLBs, writes variants under `docs/perf-fidelity-spike/variants/`, and runs validators before it reports success. Keep runtime assets untouched until the lab output proves both fidelity and performance.
