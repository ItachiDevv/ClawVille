#!/usr/bin/env bun
/**
 * Builds a candidate matrix for fidelity-preserving asset experiments.
 *
 * This does not overwrite runtime assets. It converts the asset audit into a
 * concrete experiment queue, with command lines and safety gates for each
 * candidate. Binary variants should be generated only after the runtime timing
 * harness confirms which load phase is actually hurting play.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

type AuditAsset = {
  path: string;
  publicPath: string;
  kind: 'model' | 'avatar';
  sizeBytes: number;
  referenced: boolean;
  triangleCount: number;
  textures: number;
  textureBytes: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  candidateNotes: string[];
};

type AuditJson = {
  generatedAt: string;
  assets: AuditAsset[];
};

type Candidate = {
  asset: string;
  kind: 'glb' | 'vrm';
  size: string;
  triangles: number;
  textures: number;
  textureBytes: string;
  experiments: string[];
  command: string;
  safetyGate: string;
};

const REPO_ROOT = process.cwd();
const OUT_DIR = path.join(REPO_ROOT, 'docs/perf-fidelity-spike');
const AUDIT_JSON = path.join(OUT_DIR, 'asset-audit.json');

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function commandExists(command: string): boolean {
  const probe = spawnSync(command, ['--version'], { stdio: 'ignore', shell: true });
  return probe.status === 0;
}

function assetKind(asset: AuditAsset): Candidate['kind'] {
  return asset.publicPath.endsWith('.vrm') ? 'vrm' : 'glb';
}

function publicPathToRepoPath(asset: AuditAsset): string {
  return asset.path;
}

function isBuildingMergeRisk(asset: AuditAsset): boolean {
  return asset.publicPath.startsWith('/models/') &&
    !asset.publicPath.startsWith('/models/cove/') &&
    !asset.publicPath.startsWith('/models/characters/') &&
    !asset.publicPath.startsWith('/models/reef-race/');
}

function experimentsFor(asset: AuditAsset, hasToktx: boolean): { experiments: string[]; command: string; safetyGate: string } {
  if (assetKind(asset) === 'vrm') {
    return {
      experiments: [
        'runtime-vrm-metrics',
        'texture-basis-lab',
        'no-combineSkeletons-without-animation-proof',
      ],
      command: `bun run perf:fidelity:browser --label=vrm-${path.basename(asset.publicPath)} "--url=https://staging.clawville.world/game?perf=1" --durationMs=30000`,
      safetyGate: 'Do not run combineSkeletons. Any VRM binary variant must preserve VRM/VRMC extensions and pass idle/walk/run/emote screenshot or video QA.',
    };
  }

  if (asset.textures > 0 && !hasToktx) {
    return {
      experiments: ['ktx2-blocked-missing-toktx', 'texture-only-webp-regression-check'],
      command: `COMPRESS_NO_MESHOPT=1 bun run scripts/compress-glb-targeted.ts ${publicPathToRepoPath(asset)}`,
      safetyGate: 'toktx is not installed, so KTX2 cannot run here. Texture-only WebP command is safe for merge-risk buildings because it leaves geometry byte-identical.',
    };
  }

  if (asset.textures > 0 && hasToktx) {
    return {
      experiments: ['ktx2-uastc-lab', 'texture-upload-compare'],
      command: `# Install/update a targeted KTX2 script before overwriting runtime assets; existing scripts/compress-ktx2.ts is hard-coded to older model names.`,
      safetyGate: 'Compare wire bytes, GPU upload duration, screenshot quality, and KTX2Loader coverage before any runtime swap.',
    };
  }

  if (asset.triangleCount > 50_000 && isBuildingMergeRisk(asset)) {
    return {
      experiments: ['meshopt-lab-only', 'mergeStaticMeshesByMaterial-compat-check'],
      command: `# Lab copy only: do not overwrite ${publicPathToRepoPath(asset)} until mergeStaticMeshesByMaterial accepts the output accessor types.`,
      safetyGate: 'Building GLBs that enter mergeStaticMeshesByMaterial must not ship meshopt-quantized geometry until mixed accessor types are proven safe.',
    };
  }

  return {
    experiments: ['meshopt-lab', 'runtime-render-compare'],
    command: `bun run scripts/compress-glb-targeted.ts ${publicPathToRepoPath(asset)}`,
    safetyGate: 'Only accept if output is smaller, renders identically, and browser metrics improve.',
  };
}

function score(asset: AuditAsset): number {
  let value = asset.sizeBytes;
  value += asset.textureBytes * 1.5;
  value += asset.triangleCount * 2;
  if (assetKind(asset) === 'vrm') value *= 1.4;
  if (asset.candidateNotes.some((n) => n.includes('large-wire'))) value *= 1.2;
  return value;
}

async function main(): Promise<void> {
  const audit = JSON.parse(await fs.readFile(AUDIT_JSON, 'utf8')) as AuditJson;
  const hasToktx = commandExists('toktx');

  const candidates: Candidate[] = audit.assets
    .filter((a) => a.referenced)
    .filter((a) => a.candidateNotes.some((n) => /ktx2|meshopt|vrm-runtime|large-wire/.test(n)))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 24)
    .map((asset) => {
      const plan = experimentsFor(asset, hasToktx);
      return {
        asset: asset.publicPath,
        kind: assetKind(asset),
        size: formatBytes(asset.sizeBytes),
        triangles: asset.triangleCount,
        textures: asset.textures,
        textureBytes: formatBytes(asset.textureBytes),
        ...plan,
      };
    });

  const jsonPath = path.join(OUT_DIR, 'variant-plan.json');
  const mdPath = path.join(OUT_DIR, 'variant-plan.md');
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), hasToktx, candidates }, null, 2));

  const md = `# Fidelity Variant Plan

Generated: ${new Date().toISOString()}

- Source audit: \`docs/perf-fidelity-spike/asset-audit.json\`
- \`toktx\` available: ${hasToktx ? 'yes' : 'no'}
- Runtime assets overwritten: no

This is an experiment queue, not a shipping list. Generate variants only after the browser harness identifies whether VRM parse, VRM normalization, texture upload, or geometry decode is the active bottleneck.

| Asset | Kind | Size | Tris | Textures | Texture bytes | Experiments | Command | Safety gate |
|---|---|---:|---:|---:|---:|---|---|---|
${candidates.map((c) => `| \`${c.asset}\` | ${c.kind} | ${c.size} | ${c.triangles.toLocaleString()} | ${c.textures} | ${c.textureBytes} | ${c.experiments.join(', ')} | \`${c.command.replace(/\|/g, '\\|')}\` | ${c.safetyGate} |`).join('\n')}

## Engine Rewrite Gate

Do not start PlayCanvas/Babylon migration work from this matrix alone. The trigger is a failed Three.js spike with evidence: preserved-fidelity asset/runtime changes still cannot keep HUD-visible normal play stable, and the remaining bottleneck is structural enough that a renderer/engine migration would remove it.
`;
  await fs.writeFile(mdPath, md);

  console.log(JSON.stringify({
    hasToktx,
    candidates: candidates.length,
    json: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/'),
    markdown: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
