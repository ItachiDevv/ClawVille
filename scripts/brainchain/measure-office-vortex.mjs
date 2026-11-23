#!/usr/bin/env node
// Reproduce the door measurement from the shipped geometry and the exact
// pre-KTX base texture produced by build-office-v3.mjs. No paid API calls.
// node scripts/brainchain/measure-office-vortex.mjs [pipeline-base.png]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const texturePath = process.argv[2] ?? '.brainchain-work/office-v3/building/base.png';
const texture = await sharp(texturePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
  .read('apps/web/public/models/brainchain/brainchain-office-v3-ktx.glb');
const samples = [];
for (const node of document.getRoot().listNodes()) {
  if (!node.getMesh()) continue;
  const matrix = node.getWorldMatrix();
  for (const primitive of node.getMesh().listPrimitives()) {
    const positions = primitive.getAttribute('POSITION'), uvs = primitive.getAttribute('TEXCOORD_0');
    const indices = primitive.getIndices();
    const vertex = (index) => {
      const p = positions.getElement(index, []); // getElement normalizes quantized accessors.
      return [0, 1, 2].map(k => p[0] * matrix[k] + p[1] * matrix[k + 4] + p[2] * matrix[k + 8] + matrix[k + 12]);
    };
    for (let i = 0; i < indices.getCount(); i += 3) {
      const ids = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)];
      const vertices = ids.map(vertex), uv = ids.map(index => uvs.getElement(index, []));
      const a = vertices[1].map((v, k) => v - vertices[0][k]);
      const b = vertices[2].map((v, k) => v - vertices[0][k]);
      const normal = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
      if (normal[2] / Math.hypot(...normal) < 0.7) continue;
      for (let j = 0; j <= 16; j++) for (let k = 0; k <= 16 - j; k++) {
        const weights = [1 - (j + k) / 16, j / 16, k / 16];
        const xyz = [0, 1, 2].map(axis => vertices.reduce((sum, v, n) => sum + v[axis] * weights[n], 0));
        // Crop the central facade; exclude the roof, orbit arms and outer frame.
        if (Math.abs(xyz[0]) >= 0.38 || xyz[1] <= -0.55 || xyz[1] >= 0.19 || xyz[2] <= 0 || xyz[2] >= 0.25) continue;
        const t = [0, 1].map(axis => uv.reduce((sum, v, n) => sum + v[axis] * weights[n], 0));
        const x = Math.min(texture.info.width - 1, Math.floor(t[0] * texture.info.width));
        const y = Math.min(texture.info.height - 1, Math.floor(t[1] * texture.info.height));
        const offset = (y * texture.info.width + x) * 3;
        const [r, g, b] = texture.data.subarray(offset, offset + 3);
        if (r > 170 && r - g > 55 && b > 80 && b < r) samples.push(xyz);
      }
    }
  }
}
if (!samples.length) throw new Error('No facade pink samples; verify pipeline texture and model.');
const bounds = [0, 1, 2].map(k => [Math.min(...samples.map(p => p[k])), Math.max(...samples.map(p => p[k]))]);
const center = bounds.slice(0, 2).map(([min, max]) => (min + max) / 2);
const radius = Math.max(...samples.map(p => Math.hypot(p[0] - center[0], p[1] - center[1])));
console.log(JSON.stringify({ samples: samples.length, bounds, center, radius, planeZ: 0.26, normal: [0, 0, 1] }, null, 2));
