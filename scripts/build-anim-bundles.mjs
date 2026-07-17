#!/usr/bin/env node
/**
 * build-anim-bundles.mjs
 *
 * Builds two animation bundles without crossing rig families:
 *   - _emotes.glb: 19 Mixamo-family single-clip emotes.
 *   - _emotes2.glb: 15 Meshy-family clips sourced from
 *     scripts/anim-sources/meshy-fun-pack/ outside the production public tree.
 * Locomotion (idle/walk/run) stays as separate single-clip
 * GLBs — they're already SW-precached and need to load eagerly with no
 * dependence on the emote bundle.
 *
 * Strategy:
 *   - Read all source GLBs.
 *   - Pick the FIRST source as the base document (keeps one source-family rig
 *     and rest-pose scene in the output).
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
 * _emotes2.glb uses one Meshy donor as its base document, preserving that
 * family's rest-pose scene. Rebinding animation channels by canonicalized node
 * name is safe only within the shared Meshy rig/rest-pose family. Never merge
 * Meshy clips into the Mixamo-base _emotes.glb (or cross any rig families).
 * Meshy donor meshes, skins, materials, textures, and duplicate scenes are
 * stripped before pruning and compression; only one rest-pose skeleton and the
 * 15 animations ship.
 *
 * Run:   node scripts/build-anim-bundles.mjs
 * Output: apps/web/public/avatars/animations/_emotes.glb
 *         apps/web/public/avatars/animations/_emotes2.glb
 *         (plus per-character bundles if their override emote dirs exist)
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { mergeDocuments, prune, dedup, meshopt } from '@gltf-transform/functions';
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
];

// Mixamo bakes use EXT_meshopt_compression — register encoder + decoder so
// we can read the inputs AND write the merged bundle with compression
// preserved. Without these the script bails on `Missing required extension`.
// Meshy exports in this pack all use the same canonicalized mixamorig* node
// names and, critically, the same Meshy rest pose. Keep this as a separate
// rig-family bundle: animation channels may be rebound by node name within the
// family, but must never be merged into the Mixamo-rest-pose _emotes.glb base.
const MESHY_SOURCE_ROOT = resolve(__dirname, 'anim-sources/meshy-fun-pack');
const MESHY_EMOTE_CLIPS = [
  ['sit_ground', 'sit_ground.glb'],
  ['shrug', 'shrug.glb'],
  ['think', 'think.glb'],
  ['stomp', 'stomp.glb'],
  ['backflip_2', 'backflip.glb'],
  ['breakdance', 'breakdance.glb'],
  ['handstand', 'handstand.glb'],
  ['dance_funny', 'dance_funny.glb'],
  ['pushup', 'pushup.glb'],
  ['kick_ball', 'kick_ball.glb'],
  ['clap', 'clap.glb'],
  ['wave_one', 'wave_one.glb'],
  ['idle_var_a', 'idle_var_a.glb'],
  ['idle_var_b', 'idle_var_b.glb'],
  ['doze', 'doze.glb'],
];

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
async function buildBundle(
  sources,
  outPath,
  {
    sourceRoot = ANIM_ROOT,
    stripRenderPayload = false,
    requireExactRig = false,
    meshoptCompress = false,
  } = {},
) {
  // Filter to sources that exist on disk.
  const real = [];
  for (const [name, rel] of sources) {
    const p = resolve(sourceRoot, rel);
    if (!existsSync(p)) {
      if (requireExactRig) throw new Error(`[fatal] missing required source: ${p}`);
      console.warn(`[skip] missing source: ${p}`);
      continue;
    }
    real.push({ name, path: p });
  }
  if (requireExactRig && real.length !== sources.length) {
    throw new Error(`[fatal] expected ${sources.length} sources, found ${real.length}`);
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
  if (requireExactRig && baseAnims.length !== 1) {
    throw new Error(`[fatal] ${real[0].path} has ${baseAnims.length} animations; expected exactly 1`);
  }
  const baseScene = baseDoc.getRoot().listScenes()[0];
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
    const otherAnims = otherDoc.getRoot().listAnimations();
    const otherAnim = otherAnims[0];
    if (!otherAnim) {
      console.warn(`[skip] no animation in ${path}`);
      continue;
    }
    if (requireExactRig && otherAnims.length !== 1) {
      throw new Error(`[fatal] ${path} has ${otherAnims.length} animations; expected exactly 1`);
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
      if (!targetNode) {
        if (requireExactRig) throw new Error(`[fatal] ${name} channel has no target node`);
        continue;
      }
      const targetName = targetNode.getName();
      if (!targetName) {
        if (requireExactRig) throw new Error(`[fatal] ${name} channel target node has no name`);
        continue;
      }
      const baseNode = baseNodesByName.get(targetName);
      if (requireExactRig && !baseNode) {
        throw new Error(`[fatal] ${name} channel targets unknown rig node: ${targetName}`);
      }
      if (baseNode && baseNode !== targetNode) {
        channel.setTargetNode(baseNode);
      }
    }
    merged++;
  }

  // Prune duplicate scenes/nodes/skins introduced by merge (orphans now that
  // channels point at base nodes), then dedup accessors/bufferViews.
  if (requireExactRig && merged !== sources.length) {
    throw new Error(`[fatal] expected ${sources.length} merged clips, got ${merged}`);
  }

  // Meshy donors contain a full 19-20 MB skinned character. Animation bundles
  // retain the base scene's rest-pose node hierarchy only; render payload and
  // duplicate imported scenes must not survive into the production asset.
  if (stripRenderPayload) {
    for (const node of baseDoc.getRoot().listNodes()) {
      if (node.getMesh()) node.setMesh(null);
      if (node.getSkin()) node.setSkin(null);
      if (node.getCamera()) node.setCamera(null);
    }
    for (const scene of baseDoc.getRoot().listScenes()) {
      if (scene !== baseScene) scene.dispose();
    }
  }

  if (meshoptCompress) {
    await MeshoptEncoder.ready;
    await baseDoc.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  } else {
    await baseDoc.transform(prune(), dedup());
  }

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

  if (requireExactRig) {
    const checkDoc = await io.read(outPath);
    const root = checkDoc.getRoot();
    const expectedNames = real.map(({ name }) => name);
    const actualNames = root.listAnimations().map((animation) => animation.getName());
    if (actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])) {
      throw new Error(
        `[fatal] output clips mismatch: expected ${expectedNames.join(', ')}, got ${actualNames.join(', ')}`,
      );
    }
    if (new Set(actualNames).size !== actualNames.length) {
      throw new Error(`[fatal] output contains duplicate animation names: ${actualNames.join(', ')}`);
    }
    const renderCounts = {
      meshes: root.listMeshes().length,
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
      skins: root.listSkins().length,
      cameras: root.listCameras().length,
    };
    if (Object.values(renderCounts).some((count) => count !== 0)) {
      throw new Error(`[fatal] render payload survived bundle build: ${JSON.stringify(renderCounts)}`);
    }
    if (root.listScenes().length !== 1 || root.listNodes().length === 0) {
      throw new Error(
        `[fatal] expected one non-empty rest-pose scene, got ${root.listScenes().length} scenes and ${root.listNodes().length} nodes`,
      );
    }
    const outputBytes = statSync(outPath).size;
    if (outputBytes >= 10 * 1024 * 1024) {
      throw new Error(`[fatal] animation-only bundle is unexpectedly large: ${outputBytes} bytes`);
    }
  }

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

  const meshyEmotesOut = resolve(ANIM_ROOT, '_emotes2.glb');
  await buildBundle(MESHY_EMOTE_CLIPS, meshyEmotesOut, {
    sourceRoot: MESHY_SOURCE_ROOT,
    stripRenderPayload: true,
    requireExactRig: true,
    meshoptCompress: true,
  });

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
