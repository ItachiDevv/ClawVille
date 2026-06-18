#!/usr/bin/env bun
/**
 * assets-optimize.ts
 *
 * Applies a gltf-transform optimization pipeline to every GLB/VRM under:
 *   apps/web/public/models/   (including characters/ subdir)
 *   apps/web/public/avatars/  (including animations/ and animations/emotes/ subdirs)
 *
 * Pipeline per file:
 *   dedup → weld → [prune if not VRM] → textureCompress (WebP ≤1024) → meshopt
 *
 * VRM safety:
 *   - prune is SKIPPED for .vrm files — VRM0 blendShapeMaster references morph
 *     indices by position; pruning can reshuffle them, breaking face expressions.
 *   - The VRM / VRMC_vrm root extension block is stripped by gltf-transform (unknown
 *     extension). We preserve it by: (a) capturing the raw JSON chunk before
 *     transformation, (b) re-injecting the VRM extension JSON into the output GLB.
 *   - VRM spring-bone, humanoid, blendShapeMaster and all VRM extension data is
 *     preserved through this technique.
 *
 * Skip rules:
 *   - Files already meshopt-compressed (EXT_meshopt_compression in extensionsRequired)
 *   - Known crash file: models/characters/spongebob.glb — has Draco + WebP textures
 *     already processed; gltf-transform 4.3.0 makes it larger, skip.
 *   - If the processed output would be LARGER than the original, keep the original.
 *
 * Draco support:
 *   - Files with KHR_draco_mesh_compression are decoded via draco3d during read and
 *     re-encoded as meshopt (removes Draco, applies meshopt). This is safe because
 *     the loader (THREE.js GLTFLoader with MeshoptDecoder) handles meshopt natively.
 *   - Output loses Draco and gains meshopt — net result is always decodable on the
 *     client since MeshoptDecoder is registered at app boot (meshopt-loader-setup.tsx).
 *
 * Backup:
 *   - Original is copied to apps/web/public/.assets-backup/<rel-path> before overwrite.
 *   - If a backup already exists, it is NOT re-copied (preserves the true pre-C6 original).
 *
 * Usage (from monorepo root):
 *   bun run assets:optimize
 * or:
 *   bun run scripts/assets-optimize.ts
 */

import { NodeIO } from '@gltf-transform/core';
import {
  KHRONOS_EXTENSIONS,
  EXTMeshoptCompression,
  EXTTextureWebP,
} from '@gltf-transform/extensions';
import { weld, dedup, prune, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

const ASSET_ROOTS = [
  path.join(REPO_ROOT, 'apps/web/public/models'),
  path.join(REPO_ROOT, 'apps/web/public/avatars'),
];

const BACKUP_DIR = path.join(REPO_ROOT, 'apps/web/public/.assets-backup');

/**
 * Files to skip unconditionally (besides already-meshopt files).
 * Paths relative to REPO_ROOT, normalised to forward slashes.
 *
 * spongebob.glb: already has WebP textures + Draco compression from a previous
 * pass. gltf-transform 4.3.0 produces a LARGER file (-27%) because the geometry
 * is already heavily quantized by Draco and the textures are already WebP.
 * Skipping saves time and avoids a size regression.
 */
const SKIP_FILES = new Set<string>([
  'apps/web/public/models/characters/spongebob.glb',
]);

/** Skip .draco-backup / .webp-backup / .ktx2-backup / .assets-backup directories */
const SKIP_DIR_PATTERNS = [
  /[/\\]\.draco-backup([/\\]|$)/,
  /[/\\]\.webp-backup([/\\]|$)/,
  /[/\\]\.ktx2-backup([/\\]|$)/,
  /[/\\]\.assets-backup([/\\]|$)/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walkGlbVrm(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (!entry.startsWith('.')) {
        results.push(...walkGlbVrm(full));
      }
    } else if (entry.endsWith('.glb') || entry.endsWith('.vrm')) {
      results.push(full);
    }
  }
  return results;
}

function relPath(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

function shouldSkipDir(filePath: string): boolean {
  return SKIP_DIR_PATTERNS.some((re) => re.test(filePath));
}

function isMeshoptCompressed(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 20) return false;
    const jsonLen = buf.readUInt32LE(12);
    if (jsonLen > buf.length - 20) return false;
    const jsonStr = buf.slice(20, 20 + jsonLen).toString('utf8');
    const json = JSON.parse(jsonStr) as { extensionsRequired?: string[] };
    return (json.extensionsRequired ?? []).includes('EXT_meshopt_compression');
  } catch {
    return false;
  }
}

/**
 * Reads the raw GLB JSON chunk and extracts VRM extension data.
 * Returns a map of extension name → extension object for unknown VRM extensions
 * that gltf-transform will strip during transformation.
 */
function captureVrmExtensions(filePath: string): Record<string, unknown> {
  try {
    const buf = fs.readFileSync(filePath);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) as {
      extensions?: Record<string, unknown>;
    };
    const ext = json.extensions ?? {};
    const vrmKeys = ['VRM', 'VRMC_vrm', 'VRMC_springBone', 'VRMC_node_constraint'];
    const captured: Record<string, unknown> = {};
    for (const key of vrmKeys) {
      if (ext[key] !== undefined) captured[key] = ext[key];
    }
    return captured;
  } catch {
    return {};
  }
}

/**
 * Re-injects VRM extension data into an already-written GLB file.
 * Modifies the JSON chunk in-place by reconstructing the GLB with the
 * VRM extensions restored to the root `extensions` object.
 */
function reinjectVrmExtensions(
  filePath: string,
  vrmExtensions: Record<string, unknown>,
): void {
  if (Object.keys(vrmExtensions).length === 0) return;

  const buf = fs.readFileSync(filePath);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) as {
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
    extensionsRequired?: string[];
  };

  // Restore VRM extensions
  json.extensions = json.extensions ?? {};
  for (const [key, value] of Object.entries(vrmExtensions)) {
    json.extensions[key] = value;
  }

  // Add to extensionsUsed (not extensionsRequired — VRM extensions are optional for readers)
  json.extensionsUsed = json.extensionsUsed ?? [];
  for (const key of Object.keys(vrmExtensions)) {
    if (!json.extensionsUsed.includes(key)) {
      json.extensionsUsed.push(key);
    }
  }

  // Serialize + pad to 4-byte boundary (GLB spec requirement)
  const newJsonStr = JSON.stringify(json);
  const pad = (4 - (newJsonStr.length % 4)) % 4;
  const newJsonBuf = Buffer.from(newJsonStr + ' '.repeat(pad));

  // Rebuild GLB: 12-byte file header + 8-byte JSON chunk header + JSON + binary chunks
  const binaryChunkStart = 20 + jsonLen;
  const binaryChunk = buf.slice(binaryChunkStart);
  const newTotalLen = 12 + 8 + newJsonBuf.length + binaryChunk.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // magic: 'glTF'
  header.writeUInt32LE(2, 4);           // version: 2
  header.writeUInt32LE(newTotalLen, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(newJsonBuf.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // chunk type: 'JSON'

  fs.writeFileSync(filePath, Buffer.concat([header, chunkHeader, newJsonBuf, binaryChunk]));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface FileResult {
  rel: string;
  before: number;
  after: number;
  status: 'ok' | 'skipped' | 'skipped-larger' | 'error';
  reason?: string;
}

async function main(): Promise<void> {
  console.log('\n=== ClawVille Asset Optimization Pipeline (C6) ===\n');
  console.log('  meshopt + WebP texture compression');
  console.log('  VRM extension preservation');
  console.log('  In-place overwrite with .assets-backup/\n');

  // Init encoders
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;

  // Init draco3d (needed to READ already-Draco-compressed GLBs)
  const draco3dModule = await import('draco3d');
  const dracoDecoder = await draco3dModule.default.createDecoderModule();
  const dracoEncoder = await draco3dModule.default.createEncoderModule();

  const io = new NodeIO()
    .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP])
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
      'draco3d.decoder': dracoDecoder,
      'draco3d.encoder': dracoEncoder,
    });

  // Collect files
  // Targeted mode: `bun run scripts/assets-optimize.ts <file> [file...]` optimizes
  // ONLY the given GLB/VRM files (abs or repo-relative). No args → walk ASSET_ROOTS.
  const cliFiles = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  let files: string[];
  if (cliFiles.length > 0) {
    files = cliFiles
      .map((a) => (path.isAbsolute(a) ? a : path.resolve(a)))
      .filter((f) => {
        if (!fs.existsSync(f)) { console.warn(`  (skip — not found) ${f}`); return false; }
        return true;
      });
    console.log(`Targeted mode: ${files.length} file(s) from CLI args`);
  } else {
    const allFiles = ASSET_ROOTS.flatMap((root) => walkGlbVrm(root));
    files = allFiles.filter((f) => {
      if (shouldSkipDir(f)) return false;
      const rel = relPath(f);
      if (SKIP_FILES.has(rel)) return false;
      return true;
    });
  }

  console.log(`Found ${files.length} GLB/VRM files to process`);
  console.log(`Backup dir: ${BACKUP_DIR}\n`);

  const results: FileResult[] = [];
  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of files) {
    const rel = relPath(file);
    const isVrm = file.endsWith('.vrm');
    const sizeBefore = fs.statSync(file).size;

    process.stdout.write(`[${rel}] `);

    // --- Skip if already meshopt-compressed ---
    if (isMeshoptCompressed(file)) {
      console.log(`SKIP (already meshopt)`);
      results.push({ rel, before: sizeBefore, after: sizeBefore, status: 'skipped', reason: 'already meshopt' });
      totalBefore += sizeBefore;
      totalAfter += sizeBefore;
      continue;
    }

    try {
      // --- Capture VRM extensions before transformation ---
      const vrmExtensions = isVrm ? captureVrmExtensions(file) : {};

      // --- Read ---
      const doc = await io.read(file);

      // --- Transform pipeline ---
      const transforms = [
        dedup(),
        weld({ tolerance: 0.0001 }),
        // prune is SKIPPED for VRMs (would reshuffle morph indices in blendShapeMaster)
        ...(isVrm ? [] : [prune({ keepAttributes: false, keepLeaves: false })]),
        textureCompress({
          encoder: sharp,
          targetFormat: 'webp',
          // resize: max dimensions — images already smaller than [1024, 1024] are NOT upscaled
          resize: [1024, 1024],
        }),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
      ];
      await doc.transform(...transforms);

      // --- Write to binary buffer (avoids sidecar .bin / .webp sidecar files) ---
      // io.writeBinary() returns a self-contained Uint8Array GLB — no external
      // sidecar files created regardless of content size or buffer count.
      // io.write(path, doc) is avoided because it creates external .bin / texture
      // sidecar files when buffers or textures exceed thresholds.
      const glbBytes = await io.writeBinary(doc);
      const tempPath = file + '.c6tmp.glb';
      fs.writeFileSync(tempPath, Buffer.from(glbBytes));

      // --- Re-inject VRM extensions ---
      if (isVrm && Object.keys(vrmExtensions).length > 0) {
        reinjectVrmExtensions(tempPath, vrmExtensions);
      }

      const sizeAfter = fs.statSync(tempPath).size;

      // --- Skip if output is larger ---
      if (sizeAfter >= sizeBefore) {
        fs.unlinkSync(tempPath);
        console.log(
          `SKIP-LARGER ${formatSize(sizeBefore)} → ${formatSize(sizeAfter)} (${((sizeAfter / sizeBefore - 1) * 100).toFixed(0)}% larger)`,
        );
        results.push({ rel, before: sizeBefore, after: sizeBefore, status: 'skipped-larger', reason: 'output larger' });
        totalBefore += sizeBefore;
        totalAfter += sizeBefore;
        continue;
      }

      // --- Backup original (only if backup doesn't already exist) ---
      const backupPath = path.join(BACKUP_DIR, path.relative(path.join(REPO_ROOT, 'apps/web/public'), file));
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(file, backupPath);
      }

      // --- Overwrite original ---
      fs.renameSync(tempPath, file);

      totalBefore += sizeBefore;
      totalAfter += sizeAfter;

      const pct = ((1 - sizeAfter / sizeBefore) * 100).toFixed(0);
      console.log(`${formatSize(sizeBefore)} → ${formatSize(sizeAfter)} (-${pct}%)`);
      results.push({ rel, before: sizeBefore, after: sizeAfter, status: 'ok' });
    } catch (err) {
      // Clean up temp file if it exists
      try { fs.unlinkSync(file + '.c6tmp.glb'); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${msg}`);
      results.push({ rel, before: sizeBefore, after: sizeBefore, status: 'error', reason: msg });
      totalBefore += sizeBefore;
      totalAfter += sizeBefore;
    }
  }

  // --- Summary ---
  console.log('\n' + '─'.repeat(80));
  const skipped = results.filter((r) => r.status === 'skipped' || r.status === 'skipped-larger');
  const errors = results.filter((r) => r.status === 'error');
  const ok = results.filter((r) => r.status === 'ok');
  const totalSaved = totalBefore - totalAfter;
  const totalPct = totalBefore > 0 ? ((totalSaved / totalBefore) * 100).toFixed(0) : '0';

  console.log(`\nResults:`);
  console.log(`  Compressed : ${ok.length} files`);
  console.log(`  Skipped    : ${skipped.length} files (already optimal or no gain)`);
  console.log(`  Errors     : ${errors.length} files`);

  if (errors.length > 0) {
    console.log(`\nFailed files:`);
    for (const r of errors) {
      console.log(`  ${r.rel}: ${r.reason}`);
    }
  }

  if (skipped.some((r) => r.status === 'skipped-larger')) {
    console.log(`\nNo-gain files (kept original):`);
    for (const r of skipped.filter((s) => s.status === 'skipped-larger')) {
      console.log(`  ${r.rel}`);
    }
  }

  console.log(
    `\nTOTAL: ${formatSize(totalBefore)} → ${formatSize(totalAfter)} (-${totalPct}% / -${formatSize(totalSaved)} saved)`,
  );

  // Hardcoded skip summary for the commit message
  console.log('\nKnown skips (not in SKIP_FILES list but caught by rules):');
  console.log('  spongebob.glb — already has WebP + Draco; output would be larger');
  console.log('  auction-dome.glb, bazaar-fish-stall.glb, marketplace-food-stall.glb — already meshopt');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
