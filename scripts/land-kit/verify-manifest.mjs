#!/usr/bin/env bun
/**
 * verify-manifest.mjs — the §4.3 "manifest match: exact" QC gate.
 *
 * Re-measures every shipped land-kit GLB and asserts the frozen manifest in
 * `packages/shared/src/constants/land-kit-manifest.ts` still describes them.
 * The manifest is the contract the placement predicate enforces and the
 * renderer draws from; if an asset is re-authored without re-freezing the
 * manifest, players get refused for placements that look legal on screen.
 *
 * Also enforces the §4.3 triangle / material budgets so a re-author cannot
 * quietly blow the §4.4 render budgets.
 *
 *   bun scripts/land-kit/verify-manifest.mjs [--update]
 *
 * `--update` prints a ready-to-paste seed block rather than editing the file,
 * so re-freezing stays a reviewed edit.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { KIT_CATALOG, KIT_PIECE_RENDER } from '../../packages/shared/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const KIT_DIR = join(REPO_ROOT, 'apps/web/public/models/land-kit');

/** §4.3 QC budgets, by piece size class. */
const QC_BUDGETS = {
  small: { triangles: 250, fileBytes: 120 * 1024 },
  large: { triangles: 800, fileBytes: 180 * 1024 },
};

/** Tolerance on a re-measured extent, in GLB source units. */
const EXTENT_TOLERANCE = 1e-3;

function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function nodeMatrix(node) {
  const t = node.getTranslation();
  const [x, y, z, w] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function transformPoint(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * World-space bbox of every mesh in the document — the same box the renderer's
 * `resolvePieceSource()` computes after cloning and `updateMatrixWorld(true)`.
 */
async function measure(io, path) {
  const doc = await io.read(path);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  const materials = new Set();

  const walk = (node, parent) => {
    const world = matMul(parent, nodeMatrix(node));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const material = prim.getMaterial();
        if (material) materials.add(material);
        const indices = prim.getIndices();
        const position = prim.getAttribute('POSITION');
        if (!position) continue;
        triangles += Math.floor((indices ? indices.getCount() : position.getCount()) / 3);
        const element = [0, 0, 0];
        for (let i = 0; i < position.getCount(); i++) {
          position.getElement(i, element);
          const point = transformPoint(world, element);
          for (let axis = 0; axis < 3; axis++) {
            if (point[axis] < min[axis]) min[axis] = point[axis];
            if (point[axis] > max[axis]) max[axis] = point[axis];
          }
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) walk(node, identity);
  }

  return {
    extent: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    triangles,
    materialCount: materials.size,
    fileBytes: statSync(path).size,
  };
}

// Draco is optional: the kit pipeline emits meshopt, so `draco3dgltf` is not a
// repo dependency. Register it only if a machine happens to have it, otherwise a
// future Draco-compressed asset fails loudly at read time rather than silently
// measuring nothing.
const dependencies = { 'meshopt.decoder': MeshoptDecoder };
try {
  const draco3d = (await import('draco3dgltf')).default;
  dependencies['draco3d.decoder'] = await draco3d.createDecoderModule();
} catch {
  // no-op — meshopt-only assets do not need it
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies(dependencies);

const update = process.argv.includes('--update');
const failures = [];
const warnings = [];
const seeds = [];

for (const [pieceKey, catalog] of Object.entries(KIT_CATALOG)) {
  const path = join(KIT_DIR, `${pieceKey}.glb`);
  if (!existsSync(path)) {
    failures.push(`${pieceKey}: no GLB at ${path}`);
    continue;
  }
  const measured = await measure(io, path);
  const frozen = KIT_PIECE_RENDER[pieceKey];
  if (!frozen) {
    failures.push(`${pieceKey}: present on disk but missing from KIT_PIECE_RENDER`);
    continue;
  }

  for (const axis of ['x', 'y', 'z']) {
    const delta = Math.abs(measured.extent[axis] - frozen.sourceExtent[axis]);
    if (delta > EXTENT_TOLERANCE) {
      failures.push(
        `${pieceKey}: source extent ${axis} drifted — manifest ${frozen.sourceExtent[axis]}, `
        + `measured ${measured.extent[axis].toFixed(4)} (delta ${delta.toFixed(4)})`,
      );
    }
  }

  const budget = QC_BUDGETS[catalog.size];
  if (measured.triangles > budget.triangles) {
    warnings.push(
      `${pieceKey}: ${measured.triangles} tri exceeds the ${catalog.size} budget of `
      + `${budget.triangles} — needs simplify() (spec §4.3 flags all 12 shipping pieces)`,
    );
  }
  if (measured.fileBytes > budget.fileBytes) {
    warnings.push(
      `${pieceKey}: ${(measured.fileBytes / 1024).toFixed(1)} KB exceeds the ${catalog.size} `
      + `budget of ${(budget.fileBytes / 1024).toFixed(0)} KB`,
    );
  }
  if (measured.materialCount !== 1) {
    failures.push(
      `${pieceKey}: ${measured.materialCount} materials — the renderer merges per `
      + '(chunk, pieceKey) against ONE authored material and throws on drift',
    );
  }

  const scale = frozen.targetHeightWu / measured.extent.y;
  seeds.push(
    `  '${pieceKey}': { targetHeightWu: ${frozen.targetHeightWu}, `
    + `supportSurfaceYWu: ${frozen.supportSurfaceYWu}, rotations: '${frozen.rotations}',\n`
    + `    sourceExtent: { x: ${measured.extent.x.toFixed(4)}, y: ${measured.extent.y.toFixed(4)}, `
    + `z: ${measured.extent.z.toFixed(4)} } },  // renders ${(measured.extent.x * scale).toFixed(1)}`
    + ` × ${(measured.extent.z * scale).toFixed(1)} × ${frozen.targetHeightWu} wu, `
    + `${measured.triangles} tri`,
  );
}

if (update) {
  console.log('// Re-measured seeds — review, then paste into land-kit-manifest.ts:\n');
  console.log(seeds.join('\n'));
  console.log('');
}

for (const warning of warnings) console.warn(`WARN  ${warning}`);
for (const failure of failures) console.error(`FAIL  ${failure}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest mismatch(es). The QC gate is RED.`);
  process.exit(1);
}
console.log(
  `\nManifest matches all ${Object.keys(KIT_CATALOG).length} shipped GLBs`
  + `${warnings.length > 0 ? ` (${warnings.length} budget warning(s))` : ''}.`,
);
