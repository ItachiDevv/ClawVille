#!/usr/bin/env node
/**
 * build-cove-sit-bundle.mjs
 *
 * Merges the 5 mesh-stripped Meshy cove sit-flow clips under
 * apps/web/animations-src/cove-sit/ into ONE multi-clip GLB, _cove_sit.glb,
 * written to apps/web/public/avatars/animations/ — mirrors
 * scripts/build-anim-bundles.mjs's merge strategy (§6f rule 1: "bundle,
 * don't fan out").
 *
 * animations-src/ is a BUILD-INPUT-ONLY directory (git-tracked, but a
 * sibling of public/, not inside it) — the 5 per-clip source GLBs are never
 * fetched by the runtime, only _cove_sit.glb is. Keeping them out of
 * public/ means sw.js's broad `/avatars/` prefix match never precaches
 * ~550KB of payload nobody loads (Codex adversarial review finding,
 * 2026-07-13).
 *
 * Safe to share one base scene across all 5 clips because they were
 * verified (headlessly, before this script was written) to share a
 * BIT-IDENTICAL rest pose with each other and with the rigging task's own
 * rigged.glb — Meshy's animation library retargets onto the exact rig it
 * just built for this character, not a separate shared skeleton with a
 * different rest pose. Source clips were already mesh/material/texture/skin
 * -stripped via strip-meshy-anim-mesh.mjs (13.5MB -> 35-150KB each — Meshy's
 * /animations endpoint bakes the full rigged character into every export,
 * unusable for a bundle un-stripped).
 *
 * walk_to_sit is deliberately NOT included — see mixamo-retarget.ts's
 * retargetMeshyClip doc comment: it has large, real forward hip drift
 * (~312 rig-units over 8.37s) that the shared position-track policy (X/Z
 * zeroed, only Y kept) would turn into an in-place moonwalk-then-sit. Needs
 * distance-matched root-motion consumption before it's usable — separate
 * feature, not blocking v1.
 *
 * Run:   node scripts/build-cove-sit-bundle.mjs
 * Output: apps/web/public/avatars/animations/_cove_sit.glb
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup } from '@gltf-transform/functions';
import { resolve, dirname } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');
const ANIM_ROOT  = resolve(REPO_ROOT, 'apps/web/public/avatars/animations');
const SIT_SRC    = resolve(REPO_ROOT, 'apps/web/animations-src/cove-sit');

// AnimName → source file basename. Must match the ANIM_PATHS keys added in
// vrm-character-animator.ts (bundle.glb#clipName syntax) exactly.
const SIT_CLIPS = [
  ['sit_stand_to_sit',   'stand_to_sit.glb'],
  ['sit_idle_m',         'sit_idle_m.glb'],
  ['sit_idle_f',         'sit_idle_f.glb'],
  ['sit_to_stand_m',     'sit_to_stand_m.glb'],
  ['sit_to_stand_f',     'sit_to_stand_f.glb'],
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function buildBundle(sources, outPath) {
  const real = [];
  for (const [name, rel] of sources) {
    const p = resolve(SIT_SRC, rel);
    if (!existsSync(p)) {
      console.warn(`[skip] missing source: ${p}`);
      continue;
    }
    real.push({ name, path: p });
  }
  if (real.length === 0) {
    console.warn(`[skip] no sources found for ${outPath}`);
    return 0;
  }

  const baseDoc = await io.read(real[0].path);
  const baseAnims = baseDoc.getRoot().listAnimations();
  if (baseAnims.length === 0) {
    throw new Error(`[fatal] base source ${real[0].path} has no animations`);
  }
  baseAnims[0].setName(real[0].name);
  for (let i = 1; i < baseAnims.length; i++) baseAnims[i].dispose();

  const baseNodesByName = new Map();
  for (const n of baseDoc.getRoot().listNodes()) {
    const nm = n.getName();
    if (nm && !baseNodesByName.has(nm)) baseNodesByName.set(nm, n);
  }

  let merged = 1;
  for (let i = 1; i < real.length; i++) {
    const { name, path } = real[i];
    const otherDoc = await io.read(path);
    const otherAnim = otherDoc.getRoot().listAnimations()[0];
    if (!otherAnim) {
      console.warn(`[skip] no animation in ${path}`);
      continue;
    }

    mergeDocuments(baseDoc, otherDoc);

    const baseAnimsNow = baseDoc.getRoot().listAnimations();
    const moved = baseAnimsNow[baseAnimsNow.length - 1];
    moved.setName(name);

    for (const channel of moved.listChannels()) {
      const targetNode = channel.getTargetNode();
      if (!targetNode) continue;
      const targetName = targetNode.getName();
      if (!targetName) continue;
      const baseNode = baseNodesByName.get(targetName);
      if (baseNode && baseNode !== targetNode) {
        channel.setTargetNode(baseNode);
      }
    }
    merged++;
  }

  await baseDoc.transform(prune(), dedup());

  const buffers = baseDoc.getRoot().listBuffers();
  if (buffers.length > 1) {
    const target = buffers[0];
    for (const accessor of baseDoc.getRoot().listAccessors()) {
      if (accessor.getBuffer() !== target) accessor.setBuffer(target);
    }
    for (let i = 1; i < buffers.length; i++) buffers[i].dispose();
  }

  mkdirSync(dirname(outPath), { recursive: true });
  await io.write(outPath, baseDoc);

  const sizeBytes = statSync(outPath).size;
  const sizeKB = (sizeBytes / 1024).toFixed(0);
  console.log(`[ok] ${outPath}  (${merged} clips, ${sizeKB} KB)`);
  return merged;
}

async function main() {
  console.log(`[build-cove-sit-bundle] SIT_SRC=${SIT_SRC}`);
  const out = resolve(ANIM_ROOT, '_cove_sit.glb');
  await buildBundle(SIT_CLIPS, out);
  console.log('[done]');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
