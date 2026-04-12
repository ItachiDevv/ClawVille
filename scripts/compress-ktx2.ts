/**
 * compress-ktx2.ts
 *
 * Converts PNG/JPEG textures embedded in GLB files to KTX2 UASTC format using
 * the gltf-transform CLI + toktx (KTX-Software 4.4.2+).
 *
 * UASTC textures transcode to BC7 on Iris Xe / desktop GPUs, ASTC on mobile,
 * and ETC2 on older hardware. They are GPU-resident (never decoded to RGBA on
 * the CPU), which reduces main-thread GPU upload cost compared to WebP.
 *
 * IMPORTANT — Wire size vs WebP:
 *   UASTC + Zstd produces files 4-5x LARGER than WebP for most of these
 *   assets. The trade-off is: smaller GPU memory footprint and faster GPU
 *   upload, at the cost of higher wire payload. For bandwidth-sensitive
 *   deployments, consider ETC1S instead (--etc1s flag), which is comparable
 *   to WebP on wire but has lower visual quality (banding on gradients).
 *
 * Known limitation — gltf-transform 4.3.0 parse error:
 *   GLBs with BOTH KHR_materials_clearcoat AND KHR_draco_mesh_compression
 *   fail with "Cannot read properties of undefined (reading 'source')".
 *   Affected file: characters/spongebob.glb. This file is SKIPPED and
 *   retains its WebP textures. To fix, either:
 *     a) Upgrade gltf-transform once the bug is patched, or
 *     b) Strip clearcoat metadata before recompressing.
 *
 * Requirements:
 *   - toktx v4.4.2+ installed at /c/KTX-Software/bin/toktx
 *     Run with: export PATH="/c/KTX-Software/bin:$PATH"
 *   - @gltf-transform/cli in devDependencies (already present at 4.3.0)
 *
 * Usage (from monorepo root):
 *   export PATH="/c/KTX-Software/bin:$PATH"
 *   bunx tsx scripts/compress-ktx2.ts
 *
 * Sources: .webp-backup/ (post-Draco, pre-WebP, original PNG textures)
 * Output:  apps/web/public/models/ (overwrites current WebP-compressed files)
 * Rollback: .ktx2-backup/ stores the current WebP files before overwriting
 *
 * Re-runnable: backup is skipped if it already exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MODELS_DIR = path.resolve('apps/web/public/models');
const SOURCE_DIR = path.join(MODELS_DIR, '.webp-backup');  // PNG-textured sources
const BACKUP_DIR = path.join(MODELS_DIR, '.ktx2-backup');  // WebP backup before overwrite

// UASTC quality level 2 = good quality/speed balance; Zstd 18 = 8 MB window
const UASTC_LEVEL = 2;
const ZSTD_LEVEL = 18;

// Targets ordered by texture byte weight (worst offenders first)
// spongebob.glb is SKIPPED due to gltf-transform 4.3.0 clearcoat+Draco bug
const TARGETS: Array<{ filename: string; subdir?: string; skipReason?: string }> = [
  { filename: 'underwater-decorations.glb' },
  { filename: 'pineapple-house.glb' },
  { filename: 'salty-spitoon.glb' },
  { filename: 'lobster.glb' },
  { filename: 'chum-bucket.glb' },
  {
    filename: 'spongebob.glb',
    subdir: 'characters',
    skipReason:
      'gltf-transform 4.3.0 parse error — KHR_materials_clearcoat + KHR_draco_mesh_compression combination crashes uastc command',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function assertGlbMagic(filePath: string, label: string): void {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  if (buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`${label}: output is not a valid GLB (bad magic number)`);
  }
}

function verifyToktx(): void {
  try {
    execSync('toktx --version', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'toktx not found in PATH. Run:\n  export PATH="/c/KTX-Software/bin:$PATH"\nbefore executing this script.',
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Result {
  filename: string;
  sizeBefore: number;   // source PNG file size
  sizeWebP: number;     // current WebP file size (what we're replacing)
  sizeAfter: number;    // KTX2 output file size
  status: 'ok' | 'skipped' | 'error' | 'worse';
  skipReason?: string;
  error?: string;
}

async function compressKtx2(
  filename: string,
  subdir: string | undefined,
  skipReason: string | undefined,
): Promise<Result> {
  const label = subdir ? `${subdir}/${filename}` : filename;

  // Source: PNG-textured file in .webp-backup/
  const sourcePath = subdir
    ? path.join(SOURCE_DIR, subdir, filename)
    : path.join(SOURCE_DIR, filename);

  // Current: WebP-textured file in main models dir (what we overwrite)
  const currentPath = subdir
    ? path.join(MODELS_DIR, subdir, filename)
    : path.join(MODELS_DIR, filename);

  // Backup: save current WebP before overwriting
  const backupPath = subdir
    ? path.join(BACKUP_DIR, subdir, filename)
    : path.join(BACKUP_DIR, filename);

  const result: Result = {
    filename: label,
    sizeBefore: 0,
    sizeWebP: 0,
    sizeAfter: 0,
    status: 'ok',
  };

  if (skipReason) {
    result.status = 'skipped';
    result.skipReason = skipReason;
    console.log(`  SKIPPED: ${skipReason}`);
    return result;
  }

  try {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source not found: ${sourcePath}`);
    }

    result.sizeBefore = fs.statSync(sourcePath).size;

    if (fs.existsSync(currentPath)) {
      result.sizeWebP = fs.statSync(currentPath).size;
    }

    // Backup current WebP before overwriting
    if (!fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      if (fs.existsSync(currentPath)) {
        fs.copyFileSync(currentPath, backupPath);
        console.log(`  backed up current → .ktx2-backup/${label}`);
      }
    } else {
      console.log(`  backup already exists, skipping copy`);
    }

    // Run gltf-transform uastc via CLI
    // --level 2: UASTC quality level (0=fastest, 4=best quality)
    // --zstd 18: Zstandard supercompression level (smaller wire payload)
    const outPath = currentPath;
    const tmpPath = `${currentPath}.tmp.glb`;

    console.log(`  running gltf-transform uastc (level=${UASTC_LEVEL}, zstd=${ZSTD_LEVEL})…`);

    const cmd = [
      'npx @gltf-transform/cli uastc',
      `"${sourcePath}"`,
      `"${tmpPath}"`,
      `--level ${UASTC_LEVEL}`,
      `--zstd ${ZSTD_LEVEL}`,
    ].join(' ');

    execSync(cmd, { stdio: 'pipe', timeout: 300_000 });

    if (!fs.existsSync(tmpPath)) {
      throw new Error('gltf-transform produced no output file');
    }

    assertGlbMagic(tmpPath, label);
    result.sizeAfter = fs.statSync(tmpPath).size;

    if (result.sizeAfter >= result.sizeBefore) {
      console.warn(
        `  WARNING: KTX2 output (${formatBytes(result.sizeAfter)}) not smaller than PNG source (${formatBytes(result.sizeBefore)}) — still writing (GPU memory benefit remains)`,
      );
      result.status = 'worse';
    }

    // Move tmp into place
    fs.renameSync(tmpPath, outPath);
    console.log(
      `  wrote ${formatBytes(result.sizeAfter)} (PNG=${formatBytes(result.sizeBefore)}, WebP=${formatBytes(result.sizeWebP)})`,
    );
  } catch (err) {
    result.status = 'error';
    result.error = String(err);
    console.error(`  ERROR: ${result.error}`);

    // Clean up any partial tmp file
    const tmpPath = `${currentPath}.tmp.glb`;
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }

  return result;
}

async function main() {
  console.log('\n=== GLB Texture → KTX2 UASTC Compression Pass ===\n');
  console.log(`Source dir (PNG originals): ${SOURCE_DIR}`);
  console.log(`Output dir                : ${MODELS_DIR}`);
  console.log(`Backup dir (WebP → KTX2)  : ${BACKUP_DIR}`);
  console.log(`UASTC level               : ${UASTC_LEVEL}`);
  console.log(`Zstd level                : ${ZSTD_LEVEL}`);
  console.log(`Targets                   : ${TARGETS.length} files\n`);

  // Verify toktx is in PATH before starting
  verifyToktx();
  console.log('toktx: OK\n');

  const results: Result[] = [];

  for (const { filename, subdir, skipReason } of TARGETS) {
    console.log(`[${subdir ? `${subdir}/` : ''}${filename}]`);
    const r = await compressKtx2(filename, subdir, skipReason);
    results.push(r);
    console.log('');
  }

  // Summary table
  console.log('=== Summary ===\n');
  const col = (s: string, w: number) => s.padEnd(w).slice(0, w);

  console.log(
    col('File', 38) +
    col('PNG src', 10) +
    col('WebP was', 10) +
    col('KTX2', 10) +
    col('vs PNG', 8) +
    col('vs WebP', 8) +
    'Status',
  );
  console.log('─'.repeat(98));

  let totalPng = 0;
  let totalWebP = 0;
  let totalKtx2 = 0;

  for (const r of results) {
    const effectiveKtx2 = r.sizeAfter > 0 ? r.sizeAfter : r.sizeWebP;
    totalPng  += r.sizeBefore;
    totalWebP += r.sizeWebP > 0 ? r.sizeWebP : r.sizeBefore;
    totalKtx2 += effectiveKtx2 > 0 ? effectiveKtx2 : r.sizeBefore;

    const vsPng = r.sizeBefore > 0 && r.sizeAfter > 0
      ? `${(((r.sizeAfter - r.sizeBefore) / r.sizeBefore) * 100).toFixed(1)}%`
      : '-';
    const vsWebP = r.sizeWebP > 0 && r.sizeAfter > 0
      ? `${(((r.sizeAfter - r.sizeWebP) / r.sizeWebP) * 100).toFixed(1)}%`
      : '-';

    const statusStr =
      r.status === 'error'    ? `ERROR: ${r.error?.slice(0, 30)}`
      : r.status === 'skipped' ? `SKIPPED: ${r.skipReason?.slice(0, 30)}`
      : r.status === 'worse'   ? 'ok (larger than PNG)'
      : 'ok';

    console.log(
      col(r.filename, 38) +
      col(formatBytes(r.sizeBefore), 10) +
      col(r.sizeWebP > 0 ? formatBytes(r.sizeWebP) : '-', 10) +
      col(r.sizeAfter > 0 ? formatBytes(r.sizeAfter) : '-', 10) +
      col(vsPng, 8) +
      col(vsWebP, 8) +
      statusStr,
    );
  }

  console.log('─'.repeat(98));

  const totalVsPng  = totalPng  > 0 ? (((totalKtx2 - totalPng)  / totalPng)  * 100).toFixed(1) : '-';
  const totalVsWebP = totalWebP > 0 ? (((totalKtx2 - totalWebP) / totalWebP) * 100).toFixed(1) : '-';
  console.log(
    col('TOTAL', 38) +
    col(formatBytes(totalPng), 10) +
    col(formatBytes(totalWebP), 10) +
    col(formatBytes(totalKtx2), 10) +
    col(`${totalVsPng}%`, 8) +
    col(`${totalVsWebP}%`, 8),
  );

  console.log(`
NOTE: UASTC KTX2 textures are larger than WebP on wire but smaller in GPU memory.
      GPU upload is significantly faster (compressed data transferred directly to GPU).
      Consider ETC1S (gltf-transform etc1s) if wire size is the primary concern —
      ETC1S achieves WebP-comparable wire size but with lower visual quality.
`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
