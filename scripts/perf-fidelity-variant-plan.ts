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
import * as fsSync from 'node:fs';
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

type ToktxAvailability =
  | { available: false; mode: 'missing'; version?: undefined; commandPrefix?: undefined }
  | { available: true; mode: 'path' | 'wsl-local'; version: string; commandPrefix: string };

const REPO_ROOT = process.cwd();
const OUT_DIR = path.join(REPO_ROOT, 'docs/perf-fidelity-spike');
const AUDIT_JSON = path.join(OUT_DIR, 'asset-audit.json');
const LOCAL_WSL_TOKTX = path.join(REPO_ROOT, '.tools/ktx-linux/bin/toktx');

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function commandOutput(command: string, args: string[]): string | null {
  const probe = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false });
  if (probe.status !== 0) return null;
  return (probe.stdout ?? '').trim();
}

function toWslPath(absPath: string): string {
  const normalized = path.resolve(absPath).replace(/\\/g, '/');
  const drive = normalized[0]?.toLowerCase();
  return `/mnt/${drive}${normalized.slice(2)}`;
}

function detectToktx(): ToktxAvailability {
  const debug = process.env.PERF_DEBUG_TOKTX === '1';
  const pathVersion = commandOutput('toktx', ['--version']);
  if (debug) console.log('[toktx-detect]', { cwd: REPO_ROOT, local: LOCAL_WSL_TOKTX, localExists: fsSync.existsSync(LOCAL_WSL_TOKTX), pathVersion });
  if (pathVersion) {
    return { available: true, mode: 'path', version: pathVersion, commandPrefix: '' };
  }

  if (fsSync.existsSync(LOCAL_WSL_TOKTX)) {
    const wslRepo = toWslPath(REPO_ROOT);
    const version = commandOutput('wsl', ['--cd', wslRepo, './.tools/ktx-linux/bin/toktx', '--version']);
    if (debug) console.log('[toktx-detect:wsl]', { wslRepo, version });
    if (version !== null) {
      return {
        available: true,
        mode: 'wsl-local',
        version: version || 'toktx v4.4.2 (WSL local)',
        commandPrefix: `wsl --cd ${wslRepo} env PATH="$PWD/.tools/ktx-linux/bin:$PATH"`,
      };
    }
  }

  return { available: false, mode: 'missing' };
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

function hasWebpTextures(asset: AuditAsset): boolean {
  return asset.extensionsUsed.includes('EXT_texture_webp') || asset.extensionsRequired.includes('EXT_texture_webp');
}

function experimentsFor(asset: AuditAsset, toktx: ToktxAvailability): { experiments: string[]; command: string; safetyGate: string } {
  if (assetKind(asset) === 'vrm') {
    return {
      experiments: [
        'runtime-vrm-metrics',
        toktx.available ? 'ktx2-blocked-vrm-extension-preservation' : 'texture-basis-lab-blocked-missing-toktx',
        'no-combineSkeletons-without-animation-proof',
      ],
      command: `bun run perf:fidelity:browser --label=vrm-${path.basename(asset.publicPath)} "--url=https://staging.clawville.world/game?perf=1" --durationMs=30000`,
      safetyGate: 'Do not run stock gltf-transform uastc on VRM shipping files: local milady-chibi.uastc.glb lab stripped VRMC_vrm. Any VRM binary variant must preserve VRM/VRMC extensions and pass idle/walk/run/emote screenshot or video QA before a runtime swap.',
    };
  }

  if (asset.textures > 0 && !toktx.available) {
    return {
      experiments: ['ktx2-blocked-missing-toktx', 'texture-only-webp-regression-check'],
      command: `COMPRESS_NO_MESHOPT=1 bun run scripts/compress-glb-targeted.ts ${publicPathToRepoPath(asset)}`,
      safetyGate: 'toktx is not installed, so KTX2 cannot run here. Texture-only WebP command is safe for merge-risk buildings because it leaves geometry byte-identical.',
    };
  }

  if (asset.textures > 0 && toktx.available) {
    if (hasWebpTextures(asset)) {
      return {
        experiments: ['ktx2-blocked-webp-source-needed', 'source-backup-uastc-lab'],
        command: `# Use PNG/JPEG source GLB from apps/web/public/models/.webp-backup or another pre-WebP source; do not run uastc directly on ${publicPathToRepoPath(asset)}.`,
        safetyGate: 'Current GLB already uses EXT_texture_webp. Local quest-bounty lab skipped all WebP textures, removed meshopt compression, and produced a larger no-KTX output. KTX2 tests must start from PNG/JPEG source GLBs and then validate KHR_texture_basisu plus retained geometry compression policy before any runtime swap.',
      };
    }

    const runner = `${toktx.commandPrefix} npx --yes @gltf-transform/cli uastc`.trim();
    return {
      experiments: ['ktx2-uastc-lab', 'texture-upload-compare'],
      command: `${runner} ${publicPathToRepoPath(asset)} docs/perf-fidelity-spike/variants/${path.basename(asset.publicPath, '.glb')}.uastc.glb --level 2 --zstd 18`,
      safetyGate: 'Lab copy only. Compare wire bytes, GPU upload duration, screenshot quality, and KTX2Loader coverage before any runtime swap.',
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
  const toktx = detectToktx();

  const candidates: Candidate[] = audit.assets
    .filter((a) => a.referenced)
    .filter((a) => a.candidateNotes.some((n) => /ktx2|meshopt|vrm-runtime|large-wire/.test(n)))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 24)
    .map((asset) => {
      const plan = experimentsFor(asset, toktx);
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
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), toktx, hasToktx: toktx.available, candidates }, null, 2));

  const md = `# Fidelity Variant Plan

Generated: ${new Date().toISOString()}

- Source audit: \`docs/perf-fidelity-spike/asset-audit.json\`
- \`toktx\` available: ${toktx.available ? `yes (${toktx.mode}, ${toktx.version})` : 'no'}
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
    toktx,
    hasToktx: toktx.available,
    candidates: candidates.length,
    json: path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/'),
    markdown: path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/'),
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
