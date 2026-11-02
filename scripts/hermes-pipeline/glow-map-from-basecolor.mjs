#!/usr/bin/env bun
// glow-map-from-basecolor.mjs — replace a Meshy model's emissive texture with a
// real glow mask built from its own base color.
//
// WHY (Hydra 2026-10-31): Meshy wires `emissiveTexture` = a dim copy of the
// whole base color at emissiveFactor 1, so EVERYTHING self-lights (hair looks
// washed-out white) and the neon parts do not stand out. This keeps only the
// saturated neon pixels (hue band, saturation and value floors), slightly
// dilated and feathered, tinted with the base color, as the emissive map.
// The runtime pulses `material.emissiveIntensity` on top of it.
//
// Run on the rigged GLB BEFORE `inject-vrm-meshy.mjs` (gltf-transform would drop
// VRMC_vrm on a VRM). The image is written as PNG — never JPEG (the JPEG
// re-pack trap in character-pipeline.md).
//
//   bun scripts/hermes-pipeline/glow-map-from-basecolor.mjs <in.glb> <out.glb> [hueMin=185] [hueMax=230] [satMin=0.6] [valMin=0.5] [boost=1]

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const [inPath, outPath, ...rest] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: glow-map-from-basecolor.mjs <in.glb> <out.glb> [hueMin] [hueMax] [satMin] [valMin] [boost]');
  process.exit(1);
}
const [hueMin = 185, hueMax = 230, satMin = 0.6, valMin = 0.5, boost = 1] = rest.map(Number);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);
const mats = doc.getRoot().listMaterials();
if (mats.length !== 1) throw new Error(`expected 1 material (Meshy), got ${mats.length}`);
const mat = mats[0];
const baseTex = mat.getBaseColorTexture();
if (!baseTex) throw new Error('material has no base color texture');

const { data, info } = await sharp(Buffer.from(baseTex.getImage())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;
const mask = new Float32Array(w * h);
let hits = 0;
for (let i = 0, p = 0; i < w * h; i++, p += 3) {
  const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (mx < valMin || d / (mx || 1) < satMin || d === 0) continue;
  let hue;
  if (mx === r) hue = 60 * (((g - b) / d) % 6);
  else if (mx === g) hue = 60 * ((b - r) / d + 2);
  else hue = 60 * ((r - g) / d + 4);
  if (hue < 0) hue += 360;
  if (hue >= hueMin && hue <= hueMax) { mask[i] = 1; hits++; }
}

// Dilate by 1 texel, then a light blur, so thin lines survive mip filtering.
const dil = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  let m = 0;
  for (let dy = -1; dy <= 1 && !m; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) { m = 1; break; }
  }
  dil[y * w + x] = m;
}
const maskImg = await sharp(Buffer.from(Uint8Array.from(dil, (v) => v * 255)), { raw: { width: w, height: h, channels: 1 } })
  .blur(1.2).raw().toBuffer();

// Emit ONE full-value neon color scaled by the feathered mask. Copying the baked
// texel is too dim after tone mapping, and normalizing each texel to full value
// turns the grey armor highlights under the feathered edge into white blotches.
const NEON = [48, 168, 255]; // Hydra cyan-blue (#30a8ff)
const out = Buffer.alloc(w * h * 3);
for (let i = 0, p = 0; i < w * h; i++, p += 3) {
  const m = Math.min(1, (maskImg[i] / 255) * boost);
  if (m <= 0) continue;
  out[p] = NEON[0] * m;
  out[p + 1] = NEON[1] * m;
  out[p + 2] = NEON[2] * m;
}
const png = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();

const emTex = doc.createTexture('hydra_glow').setImage(new Uint8Array(png)).setMimeType('image/png');
const old = mat.getEmissiveTexture();
mat.setEmissiveTexture(emTex).setEmissiveFactor([1, 1, 1]);
if (old && old.listParents().filter((p) => p !== doc.getRoot()).length === 0) old.dispose();
await io.write(outPath, doc);
console.log(`glow mask: ${(100 * hits / (w * h)).toFixed(2)}% of texels (hue ${hueMin}-${hueMax}, sat>=${satMin}, val>=${valMin}, boost ${boost}) -> ${outPath}`);
