#!/usr/bin/env node
/**
 * build-anim-bundles.mjs
 *
 * Merges the 19 single-clip emote GLBs under apps/web/public/avatars/animations/emotes/
 * + the 3 surf clips (skateboarding/wipeout/cheering) into ONE multi-clip GLB
 * named _emotes.glb. Locomotion (idle/walk/run) stays as separate single-clip
 * GLBs — they're already SW-precached and need to load eagerly with no
 * dependence on the emote bundle.
 *
 * Strategy:
 *   - Read all source GLBs.
 *   - Pick the FIRST source as the base document (keeps one Mixamo rig + scene
 *     in the output).
 *   - For each subsequent source, copy ONLY its animations into the base doc
 *     and re-target each AnimationChannel's target node to the base doc's
 *     matching-named node. The base doc already has a full Mixamo skeleton
 *     (all 65 bones present in every Mixamo bake) so every channel finds a
 *     match by name.
 *   - Rename each animation to the canonical AnimName so runtime
 *     `animations.find(a => a.name === clipName)` works.
 *   - Write the merged GLB.
 *
 * This is safe because all Mixamo bakes use the EXACT same default Mixamo
 * skeleton with the EXACT same rest pose. The retargeter computes
 * rest-pose-differential quaternions from `animation.scene` — since all
 * source rigs share the rest pose, picking one of them is fine for ALL
 * animations targeting node names that exist in that scene.
 *
 * Run:   node scripts/build-anim-bundles.mjs
 * Output: apps/web/public/avatars/animations/_emotes.glb
 *         (plus per-character bundles if their override emote dirs exist)
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup } from '@gltf-transform/functions';
import { resolve, dirname, basename, join } from 'node:path';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');
const ANIM_ROOT  = resolve(REPO_ROOT, 'apps/web/public/avatars/animations');

// AnimName → source file basename (without dir). Must match vrm-character-animator.ts
// ANIM_PATHS keys exactly so the runtime can resolve clipName -> animations[i].name.
const EMOTE_CLIPS = [
  // 6 original peaceful emotes
  ['looking_around', 'emotes/looking-around.glb'],
  ['squat',          'emotes/squat.glb'],
  ['waving',         'emotes/waving-both-hands.glb'],
  ['talk',           'emotes/talk.glb'],
  ['dance_happy',    'emotes/dance-happy.glb'],
  ['float',          'emotes/float.glb'],
  // 13 imported (Milady fork)
  ['crawling',       'emotes/crawling.glb'],
  ['crying',         'emotes/crying.glb'],
  ['dance_breaking', 'emotes/dance-breaking.glb'],
  ['dance_hiphop',   'emotes/dance-hiphop.glb'],
  ['dance_popping',  'emotes/dance-popping.glb'],
  ['fall',           'emotes/fall.glb'],
  ['fishing',        'emotes/fishing.glb'],
  ['flip',           'emotes/flip.glb'],
  ['jump',           'emotes/jump.glb'],
  ['kiss',           'emotes/kiss.glb'],
  ['rude_gesture',   'emotes/rude-gesture.glb'],
  ['sorrow',         'emotes/sorrow.glb'],
  ['spell_cast',     'emotes/spell-cast.glb'],
  // Charge-jump prep pose (added 2026-05-18). Fetch via Mixamo CLI
  // ("Crouch Idle" — must be a static feet-on-floor knees-bent pose,
  // NOT the squat-cycle variant). The build script auto-skips this
  // entry until the source file exists, so this can be merged before
  // the asset lands without breaking the bundle build.
  ['crouch_idle',    'emotes/crouch-idle.glb'],
];

// Mixamo bakes use EXT_meshopt_compression — register encoder + decoder so
// we can read the inputs AND write the merged bundle with compression
// preserved. Without these the script bails on `Missing required extension`.
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

/**
 * Build one merged GLB containing all the named clips. Picks the first
 * existing source as the base doc, then folds each subsequent clip's
 * animation into it. Returns the number of clips merged.
 */
async function buildBundle(sources, outPath) {
  // Filter to sources that exist on disk.
  const real = [];
  for (const [name, rel] of sources) {
    const p = resolve(ANIM_ROOT, rel);
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

  // Read first as base.
  const baseDoc = await io.read(real[0].path);
  // Rename the base's animation to the canonical clipName.
  const baseAnims = baseDoc.getRoot().listAnimations();
  if (baseAnims.length === 0) {
    throw new Error(`[fatal] base source ${real[0].path} has no animations`);
  }
  baseAnims[0].setName(real[0].name);
  // Discard any extra animations in the base.
  for (let i = 1; i < baseAnims.length; i++) baseAnims[i].dispose();

  // Build a name -> Node lookup in the base for re-targeting channel pointers.
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

    // Move otherDoc's bin data into base via mergeDocuments. This brings
    // every accessor / bufferView / buffer / sampler / channel / animation
    // from otherDoc into baseDoc, and they live alongside the base.
    mergeDocuments(baseDoc, otherDoc);

    // Locate the animation we just merged in baseDoc (it's the last one).
    const baseAnimsNow = baseDoc.getRoot().listAnimations();
    const moved = baseAnimsNow[baseAnimsNow.length - 1];
    moved.setName(name);

    // Re-target each channel's targetNode to the BASE doc's matching-named node.
    // After merge, channels point at the OTHER doc's nodes (now part of the
    // merged graph as duplicates). We rebind to base nodes so we can prune
    // the duplicates and shrink the file.
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

  // Prune duplicate scenes/nodes/skins introduced by merge (orphans now that
  // channels point at base nodes), then dedup accessors/bufferViews.
  await baseDoc.transform(prune(), dedup());

  // Consolidate buffers — GLB format requires 0 or 1 buffer. After merging
  // N source docs we have N buffers. Move everything into the first one
  // and dispose the rest.
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
  console.log(`[build-anim-bundles] ANIM_ROOT=${ANIM_ROOT}`);

  // Generic emotes bundle.
  const emotesOut = resolve(ANIM_ROOT, '_emotes.glb');
  await buildBundle(EMOTE_CLIPS, emotesOut);

  // Per-character emote bundles — only build if the override dir has any
  // emote-named files. Today none of the character override dirs contain
  // emote bakes (only locomotion + surf overrides), so these are no-ops,
  // but keeping the loop here means a future per-character emote bake just
  // needs to drop files in <charId>/emotes/<emote>.glb and re-run.
  const characterDirs = ['hermes-female', 'hermes-male', 'tekk-male'];
  for (const charId of characterDirs) {
    const charRoot = resolve(ANIM_ROOT, charId);
    if (!existsSync(charRoot)) continue;
    const charSources = EMOTE_CLIPS
      .map(([name, rel]) => [name, join(charId, rel)])
      .filter(([, rel]) => existsSync(resolve(ANIM_ROOT, rel)));
    if (charSources.length === 0) continue;
    const out = resolve(ANIM_ROOT, charId, '_emotes.glb');
    await buildBundle(charSources, out);
  }

  console.log('[done]');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
