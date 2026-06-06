#!/usr/bin/env bun
/**
 * compress-glb-targeted.ts
 *
 * Targeted sibling of assets-optimize.ts: runs the SAME proven gltf-transform
 * pipeline (dedup → weld → prune → textureCompress WebP≤1024 → meshopt medium)
 * on an EXPLICIT list of GLB files passed as argv, instead of sweeping every
 * asset under public/models + public/avatars.
 *
 * Why targeted: the broad sweep re-touches the whole scene (including already
 * -opt1 buildings and VRMs) and forces a full-scene re-verification. For a
 * single high-ROI prop (e.g. bazaar-merchant-stand.glb, a 2.34 MB GLB whose
 * single 1.49 MB baseColor PNG transcodes to WebP at ~60–70%) we want to touch
 * exactly one file with a known, contained blast radius.
 *
 * Safety (identical to assets-optimize.ts):
 *   - Backs up the original to apps/web/public/.assets-backup/<rel> before
 *     overwrite (never re-copies if a backup already exists — preserves the
 *     true pre-optimization original).
 *   - Size-guard: if the transformed output is >= the original, keeps the
 *     original untouched (no regression possible).
 *   - Skips files already EXT_meshopt_compression-encoded.
 *   - writeBinary() so no sidecar .bin / .webp files are emitted.
 *
 * NOTE: VRM files are intentionally NOT supported here — this is for static
 * GLB props/buildings only. Use assets-optimize.ts for VRMs (it preserves the
 * VRM extension block).
 *
 * Usage (from monorepo root):
 *   bun run scripts/compress-glb-targeted.ts apps/web/public/models/bazaar-merchant-stand.glb
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

const REPO_ROOT = process.cwd();
const BACKUP_DIR = path.join(REPO_ROOT, 'apps/web/public/.assets-backup');
const PUBLIC_ROOT = path.join(REPO_ROOT, 'apps/web/public');

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function isMeshoptCompressed(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 20) return false;
    const jsonLen = buf.readUInt32LE(12);
    if (jsonLen > buf.length - 20) return false;
    const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) as {
      extensionsRequired?: string[];
    };
    return (json.extensionsRequired ?? []).includes('EXT_meshopt_compression');
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const inputs = process.argv.slice(2).filter((a) => a.endsWith('.glb'));
  if (inputs.length === 0) {
    console.error('Usage: bun run scripts/compress-glb-targeted.ts <file.glb> [more.glb ...]');
    process.exit(1);
  }

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
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

  for (const rel of inputs) {
    const file = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
    if (!fs.existsSync(file)) {
      console.log(`[${rel}] MISSING — skipped`);
      continue;
    }
    if (file.endsWith('.vrm')) {
      console.log(`[${rel}] VRM not supported by this script — use assets:optimize`);
      continue;
    }
    const sizeBefore = fs.statSync(file).size;
    process.stdout.write(`[${rel}] `);

    if (isMeshoptCompressed(file)) {
      console.log('SKIP (already meshopt)');
      continue;
    }

    try {
      const doc = await io.read(file);
      await doc.transform(
        dedup(),
        weld({ tolerance: 0.0001 }),
        prune({ keepAttributes: false, keepLeaves: false }),
        // Slot-aware texture compression. COLOR maps (baseColor/emissive) take
        // high-quality lossy WebP — perceptually lossless at q92, big savings on
        // raw PNG/JPG. DATA maps (normal/metallicRoughness/occlusion) take
        // LOSSLESS WebP — lossy compression of a normal map corrupts the encoded
        // surface vectors and produces visible lighting/shading artifacts. The
        // gltf-transform docs explicitly call out excluding normal maps from
        // lossy passes; we route them to a lossless pass instead.
        // `formats: /png|jpeg/` so we only convert RAW PNG/JPG sources — textures
        // that are ALREADY WebP (e.g. the pavilion's 92 images) are left
        // untouched, so on an already-texture-optimized asset this pass is a
        // no-op and only the meshopt geometry win applies (no needless re-encode
        // of already-lossy data).
        textureCompress({
          encoder: sharp,
          targetFormat: 'webp',
          formats: /png|jpe?g/i,
          slots: /^(baseColorTexture|emissiveTexture)$/,
          quality: 92,
          resize: [1024, 1024],
        }),
        textureCompress({
          encoder: sharp,
          targetFormat: 'webp',
          formats: /png|jpe?g/i,
          slots: /(normalTexture|metallicRoughnessTexture|occlusionTexture)/,
          lossless: true,
          resize: [1024, 1024],
        }),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
      );
      const glbBytes = await io.writeBinary(doc);
      const tempPath = file + '.tgt.tmp.glb';
      fs.writeFileSync(tempPath, Buffer.from(glbBytes));
      const sizeAfter = fs.statSync(tempPath).size;

      if (sizeAfter >= sizeBefore) {
        fs.unlinkSync(tempPath);
        console.log(
          `SKIP-LARGER ${formatSize(sizeBefore)} → ${formatSize(sizeAfter)} (kept original)`,
        );
        continue;
      }

      const backupPath = path.join(BACKUP_DIR, path.relative(PUBLIC_ROOT, file));
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(file, backupPath);
      }
      fs.renameSync(tempPath, file);

      const pct = ((1 - sizeAfter / sizeBefore) * 100).toFixed(0);
      console.log(`${formatSize(sizeBefore)} → ${formatSize(sizeAfter)} (-${pct}%)  [backup: ${path.relative(REPO_ROOT, backupPath)}]`);
    } catch (err) {
      try { fs.unlinkSync(file + '.tgt.tmp.glb'); } catch { /* ignore */ }
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
