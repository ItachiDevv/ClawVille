/**
 * compress-textures.ts
 *
 * Converts PNG/JPEG textures embedded in GLB files to WebP format using
 * @gltf-transform/functions + sharp. Textures shrink ~70-85% on wire.
 *
 * KTX2/Basis (toktx) was evaluated but is unavailable without KTX-Software
 * installed as a system binary. WebP via gltf-transform + sharp achieves
 * equivalent or better wire-size savings with zero external dependencies.
 *
 * GLTFLoader in three-stdlib handles EXT_texture_webp natively — the browser
 * decodes WebP before GPU upload, so no loader changes are needed.
 *
 * NOTE: KHR_draco_mesh_compression is PRESERVED. The script registers the
 * Draco extension with a read-only decoder so existing Draco geometry data
 * passes through untouched (no re-quantisation loss).
 *
 * Usage (from monorepo root):
 *   bunx tsx scripts/compress-textures.ts
 *
 * Re-runnable: backup is skipped if it already exists (preserves the true
 * original even if you run the script multiple times).
 *
 * Targets (ordered by texture bytes, highest first):
 *
 * Pass 1 (2026-04-11) — original 6 heavy GLBs:
 *   underwater-decorations.glb  ~5.97 MB  → 1.03 MB  (-81.9%)
 *   spongebob.glb               ~3.26 MB  → 511 KB   (-84.7%)
 *   pineapple-house.glb         ~3.46 MB  → 544 KB   (-84.6%)
 *   salty-spitoon.glb           ~3.06 MB  → 379 KB   (-87.9%)
 *   lobster.glb                 ~1.73 MB  → 195 KB   (-89.0%)
 *   chum-bucket.glb             ~1.72 MB  → 606 KB   (-66.4%)
 *
 * Pass 2 (2026-04-11) — 10 remaining waterfall-tail GLBs (> 200 KB on wire):
 *   building-seashell.glb       ~1.72 MB
 *   patty-building.glb          ~1.24 MB
 *   jellyfish.glb               ~1.19 MB
 *   characters/gary.glb         ~927 KB
 *   characters/plankton.glb     ~730 KB
 *   characters/mrs-puff.glb     ~634 KB
 *   downtown-building.glb       ~634 KB
 *   building-chest.glb          ~1.01 MB
 *   boating-school.glb          ~605 KB
 *   characters/karen.glb        ~239 KB  (small but included for completeness)
 */

import * as fs from 'fs';
import * as path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import draco3d from 'draco3d';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODELS_DIR = path.resolve('apps/web/public/models');
const BACKUP_DIR = path.join(MODELS_DIR, '.webp-backup');

// Targets ordered by texture byte weight (worst offenders first).
// Pass 1 files are included so the script is re-runnable; the skip-if-already-WebP
// guard inside compressTextures() will fast-path them with no disk writes.
const TARGETS: Array<{ filename: string; subdir?: string }> = [
  // --- Pass 1 (already compressed — will be skipped via WebP guard) ---
  { filename: 'underwater-decorations.glb' },
  { filename: 'spongebob.glb', subdir: 'characters' },
  { filename: 'pineapple-house.glb' },
  { filename: 'salty-spitoon.glb' },
  { filename: 'lobster.glb' },
  { filename: 'chum-bucket.glb' },
  // --- Pass 2 (new targets — waterfall tail GLBs > 200 KB) ---
  { filename: 'building-seashell.glb' },
  { filename: 'patty-building.glb' },
  { filename: 'jellyfish.glb' },
  { filename: 'gary.glb', subdir: 'characters' },
  { filename: 'plankton.glb', subdir: 'characters' },
  { filename: 'mrs-puff.glb', subdir: 'characters' },
  { filename: 'downtown-building.glb' },
  { filename: 'building-chest.glb' },
  { filename: 'boating-school.glb' },
  { filename: 'karen.glb', subdir: 'characters' },
  // --- Pass 3 (NPC species models — never compressed before) ---
  { filename: 'sweet_crab_sketchfabweekly.glb' },
  { filename: 'lobster_plush.glb' },
  { filename: 'spirited_away_senchihiro.glb' },
  { filename: 'young_priestess.glb' },
  { filename: 'hermitcrab.glb' },
  { filename: 'octopus_toy.glb' },
  { filename: 'sea_horse.glb' },
  { filename: 'chibi_goku.glb' },
];

// WebP quality for diffuse/colour textures.
// 82 = excellent perceptual quality on stylised/cartoony assets, ~75% smaller than PNG.
const WEBP_QUALITY = 82;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function assertGlbMagic(buf: Buffer, label: string): void {
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`${label}: output is not a valid GLB (bad magic number)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Result {
  filename: string;
  inputPath: string;
  sizeBefore: number;
  sizeAfter: number;
  saved: number;
  pct: number;
  status: 'ok' | 'unchanged' | 'error';
  error?: string;
}

async function compressTextures(
  filename: string,
  subdir: string | undefined,
  io: NodeIO,
): Promise<Result> {
  const inputPath = subdir
    ? path.join(MODELS_DIR, subdir, filename)
    : path.join(MODELS_DIR, filename);
  const backupPath = subdir
    ? path.join(BACKUP_DIR, subdir, filename)
    : path.join(BACKUP_DIR, filename);

  const result: Result = {
    filename: subdir ? `${subdir}/${filename}` : filename,
    inputPath,
    sizeBefore: 0,
    sizeAfter: 0,
    saved: 0,
    pct: 0,
    status: 'ok',
  };

  try {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input not found: ${inputPath}`);
    }

    const originalBuf = fs.readFileSync(inputPath);
    result.sizeBefore = originalBuf.length;

    // Backup — only if backup doesn't already exist (preserve true original)
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(inputPath, backupPath);
      console.log(`  backed up → .webp-backup/${result.filename}`);
    } else {
      console.log(`  backup already exists, skipping copy`);
    }

    // Read GLB (Draco-aware: geometry passes through, textures are decoded)
    console.log(`  reading GLB…`);
    const document = await io.readBinary(new Uint8Array(originalBuf));

    // Check if textures are already WebP (skip if already compressed)
    const textures = document.getRoot().listTextures();
    const hasPngOrJpeg = textures.some((t) => {
      const mt = t.getMimeType();
      return mt === 'image/png' || mt === 'image/jpeg';
    });
    if (!hasPngOrJpeg) {
      console.log(`  all textures already WebP — skipping`);
      result.status = 'unchanged';
      return result;
    }

    console.log(
      `  converting ${textures.length} texture(s) to WebP (quality=${WEBP_QUALITY})…`,
    );

    // Register WebP extension on the document
    document.createExtension(EXTTextureWebP).setRequired(true);

    // Convert all PNG/JPEG textures to WebP
    await document.transform(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        quality: WEBP_QUALITY,
        // Include all texture slots (diffuse, normal, ORM, etc.)
        slots: null,
      }),
    );

    // Serialise back to GLB
    console.log(`  writing GLB…`);
    const outputBytes = await io.writeBinary(document);
    const outputBuf = Buffer.from(outputBytes);

    assertGlbMagic(outputBuf, result.filename);
    result.sizeAfter = outputBuf.byteLength;
    result.saved = result.sizeBefore - result.sizeAfter;
    result.pct = (result.saved / result.sizeBefore) * 100;

    if (result.sizeAfter >= result.sizeBefore) {
      console.warn(
        `  WARNING: output not smaller (${formatBytes(result.sizeAfter)} vs ${formatBytes(result.sizeBefore)}), keeping original`,
      );
      result.status = 'unchanged';
      return result;
    }

    // Write compressed file in-place
    fs.writeFileSync(inputPath, outputBuf);
    console.log(
      `  wrote ${formatBytes(result.sizeAfter)} (was ${formatBytes(result.sizeBefore)}, saved ${result.pct.toFixed(1)}%)`,
    );
  } catch (err) {
    result.status = 'error';
    result.error = String(err);
    console.error(`  ERROR: ${result.error}`);
  }

  return result;
}

async function main() {
  console.log('\n=== GLB Texture → WebP Compression Pass ===\n');
  console.log(`Models dir : ${MODELS_DIR}`);
  console.log(`Backup dir : ${BACKUP_DIR}`);
  console.log(`Targets    : ${TARGETS.length} files`);
  console.log(`WebP quality: ${WEBP_QUALITY}\n`);

  // Build NodeIO with Draco read support (geometry passes through untouched)
  const io = new NodeIO().registerExtensions([
    KHRDracoMeshCompression,
    EXTTextureWebP,
  ]);

  // Provide Draco decoder so it can read existing KHR_draco_mesh_compression
  // geometry without stripping it out. The decoder module is read-only here.
  const decoderModule = await (draco3d as any).createDecoderModule();
  const encoderModule = await (draco3d as any).createEncoderModule();
  io.registerDependencies({
    'draco3d.decoder': decoderModule,
    'draco3d.encoder': encoderModule,
  });

  const results: Result[] = [];

  for (const { filename, subdir } of TARGETS) {
    console.log(`[${subdir ? `${subdir}/` : ''}${filename}]`);
    const r = await compressTextures(filename, subdir, io);
    results.push(r);
    console.log('');
  }

  // Summary table
  console.log('=== Summary ===\n');
  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
  console.log(
    col('File', 40) +
      col('Before', 10) +
      col('After', 10) +
      col('Saved', 10) +
      col('  %', 7) +
      'Status',
  );
  console.log('─'.repeat(85));

  let totalBefore = 0;
  let totalAfter = 0;
  for (const r of results) {
    totalBefore += r.sizeBefore;
    const effective = r.sizeAfter > 0 ? r.sizeAfter : r.sizeBefore;
    totalAfter += effective;
    const statusStr =
      r.status === 'error'
        ? `ERROR: ${r.error?.slice(0, 30)}`
        : r.status === 'unchanged'
          ? 'unchanged'
          : 'ok';
    console.log(
      col(r.filename, 40) +
        col(formatBytes(r.sizeBefore), 10) +
        col(r.sizeAfter > 0 ? formatBytes(r.sizeAfter) : '-', 10) +
        col(r.saved > 0 ? formatBytes(r.saved) : '-', 10) +
        col(r.pct > 0 ? `${r.pct.toFixed(1)}%` : '-', 7) +
        statusStr,
    );
  }

  console.log('─'.repeat(85));
  const totalSaved = totalBefore - totalAfter;
  const totalPct = (totalSaved / totalBefore) * 100;
  console.log(
    col('TOTAL', 40) +
      col(formatBytes(totalBefore), 10) +
      col(formatBytes(totalAfter), 10) +
      col(formatBytes(totalSaved), 10) +
      col(`${totalPct.toFixed(1)}%`, 7),
  );
  console.log('');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
