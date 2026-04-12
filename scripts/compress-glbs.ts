/**
 * compress-glbs.ts
 *
 * Applies Draco geometry compression to a list of GLB files using gltf-pipeline.
 * Backs up originals to public/models/.draco-backup/ before compressing in-place.
 *
 * Usage (from monorepo root):
 *   bunx tsx scripts/compress-glbs.ts
 *
 * Re-runnable: if the backup already exists it is NOT overwritten (preserves the
 * true original even if you run the script twice).
 *
 * Draco options chosen:
 *   compressionLevel    10    — max entropy coding (slowest compress, fastest decode, smallest file)
 *   quantizePositionBits 14   — sub-millimeter precision for typical model scales
 *   quantizeNormalBits   10   — imperceptible normal quantization error
 *   quantizeTexcoordBits 12   — good UV precision, avoids seam artifacts
 *   quantizeColorBits     8   — full 8-bit per channel (lossless for most models)
 */

import * as fs from 'fs';
import * as path from 'path';
import gltfPipeline from 'gltf-pipeline';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Paths relative to monorepo root
const MODELS_DIR = path.resolve('apps/web/public/models');
const BACKUP_DIR = path.join(MODELS_DIR, '.draco-backup');

// The 4 heaviest GLBs from the CDP cold-load profile (ordered by transfer size desc)
const TARGETS = [
  'underwater-decorations.glb',  // 5.94 MB
  'pineapple-house.glb',         // 3.91 MB
  'spongebob.glb',               // 3.74 MB  (in models/ root)
  'salty-spitoon.glb',           // 3.27 MB
];

// spongebob.glb is in models/characters/ — resolve separately
const FILE_MAP: Record<string, string> = {
  'spongebob.glb': path.join(MODELS_DIR, 'characters', 'spongebob.glb'),
};

const DRACO_OPTIONS = {
  dracoOptions: {
    compressionLevel: 10,
    quantizePositionBits: 14,
    quantizeNormalBits: 10,
    quantizeTexcoordBits: 12,
    quantizeColorBits: 8,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function assertGlbMagic(buf: Buffer, label: string): void {
  // GLB magic: 0x46546C67 = "glTF" in LE uint32
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x46546C67) {
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
  status: 'ok' | 'error';
  error?: string;
}

async function compressGlb(filename: string): Promise<Result> {
  const inputPath = FILE_MAP[filename] ?? path.join(MODELS_DIR, filename);
  const backupPath = path.join(BACKUP_DIR, filename);

  const result: Result = {
    filename,
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

    const inputBuf = fs.readFileSync(inputPath);
    result.sizeBefore = inputBuf.length;

    // Backup — only if backup doesn't already exist (preserve true original)
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.copyFileSync(inputPath, backupPath);
      console.log(`  backed up → .draco-backup/${filename}`);
    } else {
      console.log(`  backup already exists, skipping copy`);
    }

    // Compress
    console.log(`  compressing (Draco level 10)…`);
    const { glb: outputBuf } = await gltfPipeline.processGlb(inputBuf, DRACO_OPTIONS);

    // Validate output
    assertGlbMagic(Buffer.from(outputBuf), filename);
    result.sizeAfter = outputBuf.byteLength;
    result.saved = result.sizeBefore - result.sizeAfter;
    result.pct = ((result.saved / result.sizeBefore) * 100);

    if (result.sizeAfter >= result.sizeBefore) {
      // Draco sometimes makes files marginally larger when meshes are already compressed
      // or have very few vertices. Keep original in that case.
      console.warn(`  WARNING: output is not smaller (${formatBytes(result.sizeAfter)} vs ${formatBytes(result.sizeBefore)}), keeping original`);
      result.status = 'ok';
      return result;
    }

    // Write compressed file in-place
    fs.writeFileSync(inputPath, outputBuf);
    console.log(`  wrote ${formatBytes(result.sizeAfter)} (was ${formatBytes(result.sizeBefore)})`);
  } catch (err) {
    result.status = 'error';
    result.error = String(err);
    console.error(`  ERROR: ${result.error}`);
  }

  return result;
}

async function main() {
  console.log('\n=== GLB Draco Compression Pass ===\n');
  console.log(`Models dir : ${MODELS_DIR}`);
  console.log(`Backup dir : ${BACKUP_DIR}`);
  console.log(`Targets    : ${TARGETS.length} files\n`);

  const results: Result[] = [];

  for (const filename of TARGETS) {
    console.log(`[${filename}]`);
    const r = await compressGlb(filename);
    results.push(r);
    console.log('');
  }

  // Summary table
  console.log('=== Summary ===\n');
  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
  console.log(
    col('File', 36) +
    col('Before', 10) +
    col('After', 10) +
    col('Saved', 10) +
    col('  %', 7) +
    'Status'
  );
  console.log('─'.repeat(80));

  let totalBefore = 0;
  let totalAfter = 0;
  for (const r of results) {
    totalBefore += r.sizeBefore;
    totalAfter += r.sizeAfter > 0 ? r.sizeAfter : r.sizeBefore;
    const status = r.status === 'ok' ? 'ok' : `ERROR: ${r.error?.slice(0, 30)}`;
    console.log(
      col(r.filename, 36) +
      col(formatBytes(r.sizeBefore), 10) +
      col(r.sizeAfter > 0 ? formatBytes(r.sizeAfter) : '-', 10) +
      col(r.saved > 0 ? formatBytes(r.saved) : '-', 10) +
      col(r.pct > 0 ? `${r.pct.toFixed(1)}%` : '-', 7) +
      status
    );
  }

  console.log('─'.repeat(80));
  const totalSaved = totalBefore - totalAfter;
  const totalPct = (totalSaved / totalBefore) * 100;
  console.log(
    col('TOTAL', 36) +
    col(formatBytes(totalBefore), 10) +
    col(formatBytes(totalAfter), 10) +
    col(formatBytes(totalSaved), 10) +
    col(`${totalPct.toFixed(1)}%`, 7)
  );
  console.log('');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
