/**
 * dedup-buildings.mjs — Phase 2 material/texture dedup for all 12 building GLBs.
 *
 * Strategy: Strategy 2A (within-file dedup + untextured material consolidation).
 * See docs/perf-phase2-recon-2026-05-22.md for full rationale.
 *
 * What it does per GLB:
 *   1. Backup original to <name>.glb.preopt.bak (skip if bak already exists).
 *   2. Load with full Draco + meshopt decoders.
 *   3. Run `dedup()` to merge byte-identical material objects and texture refs.
 *   4. Run `consolidateUntextured()` — a custom pass that merges solid-color
 *      materials (no baseColorTexture) that share the same {r,g,b,a} baseColorFactor
 *      into one material, updating all mesh primitives. This targets:
 *        - arcade/claw-arcade-exterior.glb: 34 mats → 23 untextured lambert/blinn/phong
 *        - sandy-treedome-v3.glb: 15 mats, 0 textures → all untextured vertex-color
 *      Other buildings are also processed (correctness pass); if no untextured
 *      materials exist it's a no-op.
 *   5. Write output to same path with '-opt1' suffix appended before '.glb'.
 *      E.g. pineapple-house.glb → pineapple-house-opt1.glb
 *      Exception: for arcade/claw-arcade-exterior.glb → arcade/claw-arcade-exterior-opt1.glb
 *
 * UV tiling safety:
 *   - `dedup()` only touches texture references and material object identity —
 *     it NEVER modifies UV attribute data. UV tiling is preserved exactly.
 *   - `consolidateUntextured()` only reassigns the .material pointer on primitives
 *     that had NO texture. UV attributes are untouched.
 *   - No material with UV outside [0,1] is remapped; the pass targets only
 *     untextured materials (no baseColorTexture), so UV data is irrelevant.
 *
 * AABB safety:
 *   - No geometry (vertex positions, normals, indices) is modified.
 *   - BUILDING_EXTENTS in world-colliders.ts is unchanged.
 *
 * Usage:
 *   node scripts/dedup-buildings.mjs
 *
 * Output:
 *   - <model>-opt1.glb written next to each original
 *   - Console summary with before/after material counts and file sizes
 */

import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(REPO_ROOT, 'apps/web/public/models');

// All 12 building GLBs (relative to MODELS_DIR). Must match BUILDING_GLBS in
// asset-preload-manifest.ts (strip any ?v= query).
const BUILDING_GLBS = [
  'pineapple-house.glb',
  'chum-bucket-v2.glb',
  'krusty-krab-v2.glb',
  'sandy-treedome-v3.glb',
  'salty-spitoon.glb',
  'boating-school.glb',
  'patty-building.glb',
  'building-lighthouse.glb',
  'arcade/claw-arcade-exterior.glb',
  'cove/cove-exterior.glb',
  'patricks-rock-v2.glb',
  'squidward-house.glb',
];

// Round a color channel to N decimal places for bucketing.
// Materials with nearly identical colors are NOT merged — only exact-equal factors.
// This avoids accidentally merging visually-distinct dark-gray vs black materials.
function colorKey(factors) {
  // factors is a 4-element array [r, g, b, a]. Round to 3dp.
  return factors.map((v) => Math.round(v * 1000) / 1000).join(',');
}

/**
 * Merge solid-color (untextured) materials that share the same
 * {baseColorFactor, roughnessFactor, metallicFactor, alphaMode, alphaCutoff, doubleSided}
 * into a single material. Updates all mesh primitive .material references.
 *
 * Returns the number of materials eliminated.
 */
function consolidateUntextured(document) {
  const root = document.getRoot();
  const materials = root.listMaterials();

  // Identify untextured materials.
  const untextured = materials.filter((m) => {
    // Has a baseColorTexture → skip (keep as-is)
    if (m.getBaseColorTexture()) return false;
    // Has any other texture → skip (normal, metallic, emissive, occlusion)
    if (m.getNormalTexture()) return false;
    if (m.getMetallicRoughnessTexture()) return false;
    if (m.getEmissiveTexture()) return false;
    if (m.getOcclusionTexture()) return false;
    return true;
  });

  if (untextured.length === 0) return 0;

  // Build a key for each untextured material.
  function matKey(m) {
    const bcf = m.getBaseColorFactor(); // [r,g,b,a]
    const rough = Math.round((m.getRoughnessFactor() ?? 1) * 1000) / 1000;
    const metal = Math.round((m.getMetallicFactor() ?? 0) * 1000) / 1000;
    const alphaMode = m.getAlphaMode() ?? 'OPAQUE';
    const alphaCutoff = Math.round((m.getAlphaCutoff() ?? 0.5) * 1000) / 1000;
    const doubleSided = m.getDoubleSided() ? '1' : '0';
    return `${colorKey(bcf)}|${rough}|${metal}|${alphaMode}|${alphaCutoff}|${doubleSided}`;
  }

  // Group by key; keep the first material as the canonical one.
  const groups = new Map(); // key → canonical material
  for (const m of untextured) {
    const k = matKey(m);
    if (!groups.has(k)) {
      groups.set(k, m);
    }
  }

  // For each non-canonical material, reroute all primitive refs to canonical.
  let eliminated = 0;
  const meshes = root.listMeshes();
  for (const mesh of meshes) {
    for (const prim of mesh.listPrimitives()) {
      const primMat = prim.getMaterial();
      if (!primMat) continue;
      // Only reroute untextured materials that are non-canonical.
      if (!untextured.includes(primMat)) continue;
      const k = matKey(primMat);
      const canonical = groups.get(k);
      if (!canonical) continue;
      if (canonical === primMat) continue; // already canonical
      prim.setMaterial(canonical);
    }
  }

  // Remove orphaned (now-unreferenced) materials via prune.
  // Count before to compute eliminated count.
  const before = root.listMaterials().length;

  // Dispose non-canonical untextured mats that are no longer used.
  const usedMats = new Set();
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const m = prim.getMaterial();
      if (m) usedMats.add(m);
    }
  }
  for (const m of root.listMaterials()) {
    if (!usedMats.has(m)) {
      m.dispose();
    }
  }

  const after = root.listMaterials().length;
  eliminated = before - after;
  return eliminated;
}

async function main() {
  // Wire decoders + encoders once.
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const dracoDecoder = await draco3d.createDecoderModule({});
  const dracoEncoder = await draco3d.createEncoderModule({});

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
      'draco3d.decoder': dracoDecoder,
      'draco3d.encoder': dracoEncoder,
    });

  console.log('\n=== Phase 2 Building Dedup ===\n');
  console.log(
    'GLB'.padEnd(45) +
    'MatBefore'.padEnd(12) +
    'MatAfter'.padEnd(12) +
    'Saved'.padEnd(8) +
    'SizeBefore'.padEnd(14) +
    'SizeAfter'.padEnd(14) +
    'Delta'
  );
  console.log('-'.repeat(115));

  let totalMatBefore = 0;
  let totalMatAfter = 0;
  let totalSizeBefore = 0;
  let totalSizeAfter = 0;

  for (const relPath of BUILDING_GLBS) {
    const srcPath = path.join(MODELS_DIR, relPath);
    if (!fs.existsSync(srcPath)) {
      console.warn(`  SKIP (not found): ${relPath}`);
      continue;
    }

    // Derive output path: insert '-opt1' before '.glb'.
    const ext = path.extname(srcPath); // '.glb'
    const base = srcPath.slice(0, -ext.length);
    const outPath = base + '-opt1' + ext;

    // Backup original (skip if bak already exists — idempotent).
    const bakPath = srcPath + '.preopt.bak';
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(srcPath, bakPath);
    }

    const sizeBefore = fs.statSync(srcPath).size;

    let document;
    try {
      document = await io.read(srcPath);
    } catch (e) {
      console.error(`  ERROR reading ${relPath}: ${e.message}`);
      continue;
    }

    const matBefore = document.getRoot().listMaterials().length;

    // Pass 1: gltf-transform built-in dedup (byte-identical textures, materials).
    // dedup({ propertyTypes: [...] }) merges objects that are byte-for-byte equal.
    await document.transform(
      dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.TEXTURE] })
    );

    // Pass 2: consolidate untextured solid-color materials.
    const consolidatedCount = consolidateUntextured(document);

    // Pass 3: prune unreferenced nodes/accessories.
    await document.transform(prune());

    const matAfter = document.getRoot().listMaterials().length;

    // Write output.
    try {
      await io.write(outPath, document);
    } catch (e) {
      console.error(`  ERROR writing ${relPath}: ${e.message}`);
      continue;
    }

    const sizeAfter = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;

    totalMatBefore += matBefore;
    totalMatAfter += matAfter;
    totalSizeBefore += sizeBefore;
    totalSizeAfter += sizeAfter;

    const label = relPath.padEnd(45);
    const saved = matBefore - matAfter;
    const sizeDelta = sizeAfter - sizeBefore;
    const sizeDeltaStr = (sizeDelta >= 0 ? '+' : '') + (sizeDelta / 1024).toFixed(1) + 'KB';

    console.log(
      label +
      String(matBefore).padEnd(12) +
      String(matAfter).padEnd(12) +
      String(saved).padEnd(8) +
      (sizeBefore / 1024).toFixed(1).padEnd(14) + 'KB'.padEnd(0) +
      (sizeAfter / 1024).toFixed(1).padEnd(14) + 'KB'.padEnd(0) +
      sizeDeltaStr
    );
  }

  console.log('-'.repeat(115));
  console.log(
    'TOTAL'.padEnd(45) +
    String(totalMatBefore).padEnd(12) +
    String(totalMatAfter).padEnd(12) +
    String(totalMatBefore - totalMatAfter).padEnd(8) +
    (totalSizeBefore / 1024).toFixed(1).padEnd(14) + 'KB'.padEnd(0) +
    (totalSizeAfter / 1024).toFixed(1).padEnd(14) + 'KB'.padEnd(0) +
    ((totalSizeAfter - totalSizeBefore) >= 0 ? '+' : '') + ((totalSizeAfter - totalSizeBefore) / 1024).toFixed(1) + 'KB'
  );
  console.log('\nOptimized GLBs written as *-opt1.glb next to originals.');
  console.log('Backups written as *.glb.preopt.bak (idempotent — skipped if already exists).\n');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
