#!/usr/bin/env node
/**
 * canonicalize-meshy-clip.mjs — turn a raw Meshy animation bake (full 16 MB
 * scene, BARE bone names) into a small retarget-ready single-clip GLB.
 *
 * WHY: the runtime retargeter (mixamo-retarget.ts) maps ONLY mixamorig*
 * donor track names — bare Meshy names ("Hips") are silently unmatched.
 * The Meshy fun pack (_emotes2.glb) proved the fix: rename the skeleton
 * nodes to canonical mixamorig names in the source GLB. This script does
 * that rename AND strips the render payload (meshes/skins/materials/
 * textures) so only the rest-pose node hierarchy + the animation ship.
 *
 * The rest-pose scene is preserved because the retargeter computes its
 * rest-pose-differential quaternions from `animation.scene` — a clip baked
 * on the character's own rig retargets onto that character's VRM with an
 * identity-ish differential.
 *
 * Usage:
 *   bun scripts/hermes-pipeline/canonicalize-meshy-clip.mjs <in.glb> <out.glb> [clipName]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { statSync } from 'node:fs';

const [inPath, outPath, clipName = 'idle'] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: canonicalize-meshy-clip.mjs <in.glb> <out.glb> [clipName]');
  process.exit(1);
}

// Meshy 24-bone bare names → canonical mixamorig names (the exact keys
// MIXAMO_TO_VRM in mixamo-retarget.ts consumes). head_end / headfront are
// deliberately unmapped — the retargeter skips unknown names.
const RENAME = {
  Hips: 'mixamorigHips',
  Spine: 'mixamorigSpine',
  Spine01: 'mixamorigSpine1',
  Spine02: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  Neck: 'mixamorigNeck',
  Head: 'mixamorigHead',
  LeftShoulder: 'mixamorigLeftShoulder',
  LeftArm: 'mixamorigLeftArm',
  LeftForeArm: 'mixamorigLeftForeArm',
  LeftHand: 'mixamorigLeftHand',
  RightShoulder: 'mixamorigRightShoulder',
  RightArm: 'mixamorigRightArm',
  RightForeArm: 'mixamorigRightForeArm',
  RightHand: 'mixamorigRightHand',
  LeftUpLeg: 'mixamorigLeftUpLeg',
  LeftLeg: 'mixamorigLeftLeg',
  LeftFoot: 'mixamorigLeftFoot',
  LeftToeBase: 'mixamorigLeftToeBase',
  RightUpLeg: 'mixamorigRightUpLeg',
  RightLeg: 'mixamorigRightLeg',
  RightFoot: 'mixamorigRightFoot',
  RightToeBase: 'mixamorigRightToeBase',
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const doc = await io.read(inPath);
const root = doc.getRoot();

// 1. Strip render payload. Detach mesh/skin from nodes first, then dispose
//    the resources. Node hierarchy (rest TRS) + animations stay. NO prune()
//    — it could drop skeleton leaves the animation doesn't target.
for (const node of root.listNodes()) {
  if (node.getMesh()) node.setMesh(null);
  if (node.getSkin()) node.setSkin(null);
}
for (const skin of root.listSkins()) skin.dispose();
for (const mesh of root.listMeshes()) mesh.dispose();
for (const mat of root.listMaterials()) mat.dispose();
for (const tex of root.listTextures()) tex.dispose();

// 2. Rename bones.
let renamed = 0;
for (const node of root.listNodes()) {
  const to = RENAME[node.getName()];
  if (to) { node.setName(to); renamed++; }
}

// 3. Canonical clip name + stats.
const anims = root.listAnimations();
if (anims.length !== 1) {
  throw new Error(`expected exactly one animation, found ${anims.length}`);
}
anims[0].setName(clipName);
const channels = anims[0].listChannels();
const trackCount = channels.length;
const rotationTrackCount = channels.filter((channel) => channel.getTargetPath() === 'rotation').length;

// 4. Drop orphaned render resources. Disposing meshes/skins/textures above is
// NOT sufficient — their accessors/buffer views survive into the written GLB
// (measured 2026-07-30: no-prune output was 3,748 KB vs 35 KB with this pass).
// The prune is NODE-SAFE by construction: Node/Scene/Animation types are not
// listed, and keepLeaves preserves un-animated skeleton leaves. Verified on the
// ansem idle: all 26 hierarchy nodes survive (independently re-inspected).
await doc.transform(
  prune({
    propertyTypes: ['Accessor', 'Buffer', 'BufferView', 'Texture', 'TextureInfo', 'Material', 'Mesh', 'Primitive', 'PrimitiveTarget', 'Skin'],
    keepLeaves: true,
  }),
);

// 5. Compress + write.
await doc.transform(meshopt({ encoder: MeshoptEncoder }));
await io.write(outPath, doc);

const inMB = (statSync(inPath).size / 1024 / 1024).toFixed(1);
const outKB = (statSync(outPath).size / 1024).toFixed(0);
const hasHips = root.listNodes().some((n) => n.getName() === 'mixamorigHips');
console.log(
  `renamed ${renamed} bones (mixamorigHips present: ${hasHips}); ` +
  `clip '${clipName}' with ${trackCount} tracks (${rotationTrackCount} rotation)`,
);
console.log(`${inPath} (${inMB} MB) -> ${outPath} (${outKB} KB)`);
if (!hasHips) { console.error('FATAL: mixamorigHips missing after rename'); process.exit(1); }
if (trackCount < 60) { console.error('FATAL: fewer than 60 animation tracks'); process.exit(1); }
if (rotationTrackCount === 0) { console.error('FATAL: no rotation tracks'); process.exit(1); }
if (Number(outKB) > 500) { console.error('FATAL: output larger than 500 KB'); process.exit(1); }
