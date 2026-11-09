# BrainChain Office compression review

Date: 2026-11-09. Local preview evidence only. No production claim.

Source: Meshy task `01a1c089-73c6-75ca-94dd-56f8f2ce7da9`.
Source SHA-256: `7cbc9950491f5a63ac66f1b1772b1f6d16750ad14af1dbdd1069282d892962d8`.
The source contains 11,311 triangles, one material, one base-color atlas, and no skin or animation.

## Controlled comparisons

All comparison views use the same Three.js camera, lights, uniform scale, and cyan 179 wu avatar proxy.
The rendered model measures 588 x 694.58 x 486.40 wu.
The front opening appears wider than the avatar proxy.
The collider contains the entire model, including roof overhangs and the beacon.

- Original PNG with meshopt geometry: clean. Evidence: `.brainchain-work/control-geometry-front.png`.
- Original geometry with a 1024 PNG: clean. Evidence: `.brainchain-work/control-resize-front.png`.
- 1024 ETC1S q128 and q255: rejected. Both show colored atlas seams across triangle edges.
- Vertically flipped KTX: rejected. The atlas maps to unrelated colors across entire triangles.
- 1024 UASTC: clean compared with the source. Evidence: `.brainchain-work/uastc-control-front.png` and `.brainchain-work/uastc-control-3q.png`.
- 512 UASTC RDO2: rejected despite its 319,116-byte size. Thin atlas seams return. Evidence: `.brainchain-work/rejected-512-uastc-front.png`.

Within the isolated WebGL preview only, these controls isolate the visible atlas seams to texture compression and resolution. They do not rule out a separate WebGPU normalized-attribute defect.
The original 350 KiB target conflicts with the tested clean 1024 KTX2 atlas.
1024 UASTC RDO2 uses 696,692 bytes. RDO10 uses 665,580 bytes.
The earlier single-mip candidate used a provisional 700 KiB exception. The final mipmapped candidate uses the separately documented 1 MiB exception below.

## Preview limits

The local preview uses WebGL and a single building.
It does not establish actual-world lighting, placement, navigation, sustained FPS, or WebGPU behavior.
The world scene and actual Claude review remain separate gates.

## Earlier single-mip candidate

The earlier single-mip 1024 UASTC RDO2 asset uses 696,692 bytes.
SHA-256: `48e657ab1c59c10b981099df02684d54607d6aa0c229e83369571f0b74e1f5c4`.
The final front and three-quarter views preserve the source colors without the rejected ETC1S seams.
Evidence: `.brainchain-work/optimized-office-front.png` and `.brainchain-work/optimized-office-3q.png`.
The WebGL probe reports one BC7 texture with one mip and 1,048,576 GPU bytes.
The building uses one draw and 11,311 triangles. The cyan avatar proxy adds one draw and 312 triangles.
The preview does not establish WebGPU performance on Iris Xe.

The optimizer writes a candidate file and validates bounds and size before it replaces the selected asset.

## Actual-world WebGPU gate

The clean isolated WebGL preview does not establish WebGPU acceptance.
The selected quantized asset shows severe triangular atlas and dark-face faults in the actual WebGPU scene.
A browser service worker served old bytes during some controls, despite Network.setCacheDisabled.
Controls now require Network.setBypassServiceWorker and a browser-side byte count and SHA-256 before comparison.
The verified untouched PNG source removes the severe half-black wall fault in the actual WebGPU scene.
Float32 geometry with the selected UASTC texture remains under comparison.
No final asset acceptance or resource exception covers an unverified control.

## Final rebuild candidate

The lead authorizes a provisional 1 MiB transfer cap for the 963,764-byte 1024 UASTC RDO2 asset with 11 mip levels.
The complete mip chain prevents the known distant single-mip sampling risk.
Expected BC7 allocation is 1,398,128 bytes (1.33 MiB), below the 1.5 MiB GPU texture cap.
SHA-256: `9b5e625433ef97fcf5bb65143ed117da53794282471458dccce12339154ae752`.
The new filename is `/models/brainchain/brainchain-office-exterior-v2-mips-mo-ktx.glb?v=1`.
The previous public filename is removed; rejected controls remain local evidence only.

Verified actual-world controls establish that both untouched PNG and Float32 KTX geometry remove the severe WebGPU corruption.
The 892,396-byte Float32 KTX control uses the same selected single-mip UASTC atlas.
Its SHA-256 is `503e67b4400a6f4f6f90837dd9598d78b1e9365f7ca7b8f7997c7347cd862241`.
This isolates the production defect to normalized attribute handling rather than KTX texture content alone.
The final renderer clones Office geometry and converts normalized POSITION/NORMAL/UV values to independent Float32 attributes before GPU upload.
The conversion preserves GLB node transforms and keeps cached geometry and materials unchanged.
One clone serves every mesh that shares the same source geometry; teardown disposes only those owned clones.
Tests compare transformed bounds, every fixture normal and UV value, shared allocations, and disposal events.
Actual-world acceptance still requires the new bundle, moving-camera captures, performance evidence, and independent Claude review.

Float32 vertex attributes require 398,304 GPU bytes (12,447 vertices x 8 float components x 4 bytes).
The WebGPU index buffer requires an expected 135,732 bytes after Uint16-to-Uint32 promotion (33,933 indices).
Expected Office geometry total is 534,036 bytes; with 1,398,128 BC7 texture bytes, the Office totals 1,932,164 bytes before renderer bookkeeping.
WebGL uses 67,866 index bytes when it retains Uint16 indices. These are format-derived budgets, not a GPU allocator measurement.
