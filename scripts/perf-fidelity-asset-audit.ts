#!/usr/bin/env bun
/**
 * Fidelity-preserving asset audit for the ClawVille performance spike.
 *
 * This is read-only. It does not rewrite GLB/VRM files. The goal is to produce
 * a ranked optimization queue with enough evidence to decide whether KTX2,
 * Meshopt, texture resize, VRMUtils, or progressive loading is worth testing.
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import * as fs from 'node:fs';
import * as path from 'node:path';

type AssetKind = 'model' | 'avatar' | 'animation';

interface AssetMetrics {
  path: string;
  publicPath: string;
  kind: AssetKind;
  referenced: boolean;
  sizeBytes: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  images: number;
  skins: number;
  animations: number;
  morphTargetPrimitives: number;
  vertexCount: number;
  triangleCount: number;
  textureBytes: number;
  maxTextureBytes: number;
  imageMimeTypes: Record<string, number>;
  extensionsUsed: string[];
  extensionsRequired: string[];
  hasVrmExtension: boolean;
  hasMeshopt: boolean;
  hasDraco: boolean;
  hasKtx2: boolean;
  hasWebP: boolean;
  candidateNotes: string[];
  errors: string[];
}

const REPO_ROOT = process.cwd();
const OUT_DIR = path.join(REPO_ROOT, 'docs/perf-fidelity-spike');
const JSON_OUT = path.join(OUT_DIR, 'asset-audit.json');
const MD_OUT = path.join(OUT_DIR, 'asset-audit.md');
const PUBLIC_ROOT = path.join(REPO_ROOT, 'apps/web/public');
const ASSET_ROOTS = [
  path.join(PUBLIC_ROOT, 'models'),
  path.join(PUBLIC_ROOT, 'avatars'),
];
const SKIP_DIR_RE = /[/\\](\.assets-backup|\.draco-backup|\.webp-backup|\.ktx2-backup|turnaround|tmp|raw-output)([/\\]|$)/i;

function walkAssets(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (SKIP_DIR_RE.test(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walkAssets(full));
    else if (/\.(glb|vrm)$/i.test(entry)) out.push(full);
  }
  return out;
}

function toPublicPath(abs: string): string {
  return '/' + path.relative(PUBLIC_ROOT, abs).replace(/\\/g, '/');
}

function toRepoPath(abs: string): string {
  return path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readGlbJson(file: string): any {
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('not a GLB/VRM binary');
  }
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
}

function collectReferencedPublicPaths(): Set<string> {
  const roots = [
    path.join(REPO_ROOT, 'apps/web/src'),
    path.join(REPO_ROOT, 'packages/shared/src'),
    path.join(REPO_ROOT, 'GameFeatures.md'),
    path.join(REPO_ROOT, '3dStructure.md'),
    path.join(REPO_ROOT, 'WorldContent.md'),
  ];
  const files: string[] = [];
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      if (/\.(ts|tsx|js|jsx|md|json)$/i.test(p)) files.push(p);
      return;
    }
    for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
  };
  roots.forEach(walk);

  const refs = new Set<string>();
  const re = /\/(?:models|avatars)\/[^'"`)\s]+?\.(?:glb|vrm)(?:\?v=\d+)?/gi;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      refs.add((m[0] ?? '').replace(/\?v=\d+$/i, ''));
    }
  }
  return refs;
}

function inferKind(publicPath: string): AssetKind {
  if (publicPath.includes('/avatars/animations/')) return 'animation';
  if (publicPath.startsWith('/avatars/')) return 'avatar';
  return 'model';
}

function addCandidateNotes(asset: AssetMetrics): void {
  if (!asset.referenced) {
    asset.candidateNotes.push('unreferenced-or-archive: exclude from runtime preload and deploy payload if confirmed dead');
  }
  if (asset.textures > 0 && !asset.hasKtx2) {
    asset.candidateNotes.push('ktx2-candidate: texture payload still decodes/uploads as non-GPU-native texture');
  }
  if (!asset.hasMeshopt && asset.kind !== 'avatar' && asset.triangleCount > 10_000) {
    asset.candidateNotes.push('meshopt-candidate: geometry is not EXT_meshopt_compression and has non-trivial triangle count');
  }
  if (asset.kind === 'avatar' && asset.hasVrmExtension) {
    asset.candidateNotes.push('vrm-runtime: keep VRM extension intact; measure VRMUtils.removeUnnecessaryVertices and avoid combineSkeletons unless retargeting is proven');
  }
  if (asset.sizeBytes > 2_000_000) {
    asset.candidateNotes.push('large-wire: prioritize for progressive loading or texture/geometry variant test');
  }
  if (asset.skins > 0 || asset.animations > 0 || asset.morphTargetPrimitives > 0) {
    asset.candidateNotes.push('identity-sensitive: optimize with visual/animation regression checks');
  }
  if (asset.hasDraco) {
    asset.candidateNotes.push('draco-present: decode cost may move to load-time; compare against Meshopt variant');
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await MeshoptDecoder.ready;
  const dracoDecoder = await draco3d.createDecoderModule({});
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'draco3d.decoder': dracoDecoder,
    });

  const referenced = collectReferencedPublicPaths();
  const files = ASSET_ROOTS.flatMap(walkAssets).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const assets: AssetMetrics[] = [];

  for (const file of files) {
    const publicPath = toPublicPath(file);
    const json = readGlbJson(file);
    const extensionsUsed = [...(json.extensionsUsed ?? [])].sort();
    const extensionsRequired = [...(json.extensionsRequired ?? [])].sort();
    const imageMimeTypes: Record<string, number> = {};
    let textureBytes = 0;
    let maxTextureBytes = 0;
    for (const image of json.images ?? []) {
      const mime = image.mimeType ?? 'external/unknown';
      imageMimeTypes[mime] = (imageMimeTypes[mime] ?? 0) + 1;
      if (typeof image.bufferView === 'number') {
        const view = json.bufferViews?.[image.bufferView];
        const bytes = view?.byteLength ?? 0;
        textureBytes += bytes;
        maxTextureBytes = Math.max(maxTextureBytes, bytes);
      }
    }

    const metrics: AssetMetrics = {
      path: toRepoPath(file),
      publicPath,
      kind: inferKind(publicPath),
      referenced: referenced.has(publicPath),
      sizeBytes: fs.statSync(file).size,
      meshes: 0,
      primitives: 0,
      materials: json.materials?.length ?? 0,
      textures: json.textures?.length ?? 0,
      images: json.images?.length ?? 0,
      skins: json.skins?.length ?? 0,
      animations: json.animations?.length ?? 0,
      morphTargetPrimitives: 0,
      vertexCount: 0,
      triangleCount: 0,
      textureBytes,
      maxTextureBytes,
      imageMimeTypes,
      extensionsUsed,
      extensionsRequired,
      hasVrmExtension: Boolean(json.extensions?.VRM || json.extensions?.VRMC_vrm),
      hasMeshopt: extensionsUsed.includes('EXT_meshopt_compression') || extensionsRequired.includes('EXT_meshopt_compression'),
      hasDraco: extensionsUsed.includes('KHR_draco_mesh_compression') || extensionsRequired.includes('KHR_draco_mesh_compression'),
      hasKtx2: extensionsUsed.includes('KHR_texture_basisu') || extensionsRequired.includes('KHR_texture_basisu'),
      hasWebP: extensionsUsed.includes('EXT_texture_webp') || extensionsRequired.includes('EXT_texture_webp') || Boolean(imageMimeTypes['image/webp']),
      candidateNotes: [],
      errors: [],
    };

    try {
      const doc = await io.read(file);
      const root = doc.getRoot();
      const meshes = root.listMeshes();
      metrics.meshes = meshes.length;
      for (const mesh of meshes) {
        for (const prim of mesh.listPrimitives()) {
          metrics.primitives++;
          const position = prim.getAttribute('POSITION');
          const indices = prim.getIndices();
          const vertexCount = position?.getCount() ?? 0;
          metrics.vertexCount += vertexCount;
          metrics.triangleCount += indices ? Math.floor(indices.getCount() / 3) : Math.floor(vertexCount / 3);
          if (prim.listTargets().length > 0) metrics.morphTargetPrimitives++;
        }
      }
    } catch (err) {
      metrics.errors.push(err instanceof Error ? err.message : String(err));
    }

    addCandidateNotes(metrics);
    assets.push(metrics);
  }

  const totals = {
    generatedAt: new Date().toISOString(),
    assetCount: assets.length,
    referencedCount: assets.filter((a) => a.referenced).length,
    totalBytes: assets.reduce((sum, a) => sum + a.sizeBytes, 0),
    referencedBytes: assets.filter((a) => a.referenced).reduce((sum, a) => sum + a.sizeBytes, 0),
    textureBytes: assets.reduce((sum, a) => sum + a.textureBytes, 0),
    triangles: assets.reduce((sum, a) => sum + a.triangleCount, 0),
    vertices: assets.reduce((sum, a) => sum + a.vertexCount, 0),
  };

  fs.writeFileSync(JSON_OUT, JSON.stringify({ totals, assets }, null, 2));

  const top = assets.slice(0, 30);
  const referencedTop = assets.filter((a) => a.referenced).slice(0, 30);
  const hotCandidates = assets
    .filter((a) => a.referenced && a.candidateNotes.some((n) => /ktx2|meshopt|large-wire|vrm-runtime/.test(n)))
    .slice(0, 30);

  const table = (rows: AssetMetrics[]) => [
    '| Asset | Size | Referenced | Tris | Textures | Extensions | Notes |',
    '|---|---:|---:|---:|---:|---|---|',
    ...rows.map((a) => [
      `| \`${a.publicPath}\``,
      formatBytes(a.sizeBytes),
      a.referenced ? 'yes' : 'no',
      String(a.triangleCount),
      `${a.textures} (${formatBytes(a.textureBytes)})`,
      [...a.extensionsRequired, ...a.extensionsUsed.filter((x) => !a.extensionsRequired.includes(x))].join(', ') || '-',
      a.candidateNotes.slice(0, 3).join('; ') || '-',
      '|',
    ].join(' | ')),
  ].join('\n');

  const md = `# Fidelity Performance Asset Audit

Generated: ${totals.generatedAt}

This is a read-only audit. It ranks GLB/VRM assets for fidelity-preserving performance work. It intentionally does **not** recommend primitive building blocks, cylinder characters, or DPR-first degradation.

## Summary

- Assets scanned: ${totals.assetCount}
- Referenced assets detected in source/docs: ${totals.referencedCount}
- Total asset bytes scanned: ${formatBytes(totals.totalBytes)}
- Referenced asset bytes: ${formatBytes(totals.referencedBytes)}
- Embedded texture bytes: ${formatBytes(totals.textureBytes)}
- Decoded triangle count across readable assets: ${totals.triangles.toLocaleString()}
- Decoded vertex count across readable assets: ${totals.vertices.toLocaleString()}

## Highest-Value Referenced Candidates

${table(hotCandidates)}

## Largest Referenced Assets

${table(referencedTop)}

## Largest Assets Overall

${table(top)}

## Interpretation Rules

- \`ktx2-candidate\`: test KTX2/Basis on a copy and compare GPU upload time, memory, and visual quality. Do not assume wire-size wins.
- \`meshopt-candidate\`: safe only after confirming the asset is not passed through merge code that rejects mixed accessor types.
- \`vrm-runtime\`: VRM extension preservation and animation regression checks are mandatory. Runtime already applies \`VRMUtils.removeUnnecessaryVertices\`; \`combineSkeletons\` is unsafe until proven for Mixamo retargeting.
- \`unreferenced-or-archive\`: remove from deploy/preload only after a source search or asset manifest check confirms it is dead.
`;

  fs.writeFileSync(MD_OUT, md);
  console.log(JSON.stringify({ totals, json: toRepoPath(JSON_OUT), markdown: toRepoPath(MD_OUT) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
