#!/usr/bin/env node
/**
 * Replaces only the clyt arm-chain keys in Blender-authored card poses with
 * normalized humanoid rotations solved against the live Milady reference.
 * The inverse below is the exact inverse of retargetMeshyClip's established
 * rest-pose differential, so the authored clyt tracks remain the single
 * proportion-independent source delivered to every VRM.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Matrix4, Quaternion, Vector3 } from '../apps/web/node_modules/three/build/three.module.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = resolve(process.argv[2] ?? '.cardpose-authoring');
const SOURCE_PATH = resolve(
  process.argv[3] ?? 'apps/web/animations-src/cove-sit/sit_on_chair_arms_crossed.glb',
);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const sourceDocument = await io.read(SOURCE_PATH);
const sourceAnimation = sourceDocument.getRoot().listAnimations()[0];
if (!sourceAnimation) throw new Error(`${SOURCE_PATH}: missing animation`);

function sampleSampler(sampler, time) {
  const input = sampler.getInput()?.getArray();
  const output = sampler.getOutput();
  const values = output?.getArray();
  if (!input || !output || !values) throw new Error('animation sampler is incomplete');
  const size = output.getElementSize();
  const cubic = sampler.getInterpolation() === 'CUBICSPLINE';
  const stride = cubic ? size * 3 : size;
  const valueOffset = cubic ? size : 0;
  let upper = 1;
  while (upper < input.length && input[upper] < time) upper += 1;
  upper = Math.min(upper, input.length - 1);
  const lower = Math.max(0, upper - 1);
  const span = input[upper] - input[lower];
  const alpha = span > 1e-8 ? (time - input[lower]) / span : 0;
  if (size === 4) {
    const a = new Quaternion().fromArray(values, lower * stride + valueOffset);
    const b = new Quaternion().fromArray(values, upper * stride + valueOffset);
    return a.slerp(b, Math.max(0, Math.min(1, alpha))).toArray();
  }
  const sampled = [];
  for (let component = 0; component < size; component += 1) {
    const a = values[lower * stride + valueOffset + component];
    const b = values[upper * stride + valueOffset + component];
    sampled.push(a + (b - a) * Math.max(0, Math.min(1, alpha)));
  }
  return sampled;
}

const sourceSamples = new Map();
for (const channel of sourceAnimation.listChannels()) {
  const node = channel.getTargetNode();
  if (!node) continue;
  sourceSamples.set(
    `${node.getName()}.${channel.getTargetPath()}`,
    sampleSampler(channel.getSampler(), 0.20),
  );
}

// The selected lap phase is a good seated lower-body base, but live joint
// positions prove its hips→head line is already ~35deg reclined. The previous
// 8–25deg authored Spine corrections could not cancel it (peek/rest landed at
// ~47deg). Rebuild Spine from the sampled base plus one absolute, idempotent
// 67deg forward correction; this preserves hips/legs and places the upper
// torso just forward of vertical on the VRM0 reference.
const BASE_SPINE_SAMPLE = sourceSamples.get('Spine.rotation');
if (!BASE_SPINE_SAMPLE) throw new Error(`${SOURCE_PATH}: missing Spine.rotation sample`);
const UPRIGHT_SPINE_CORRECTION = new Quaternion()
  .setFromAxisAngle(new Vector3(1, 0, 0), -67 * Math.PI / 180);

const REST = {
  LeftShoulder: [-0.0050132170, 0.2036849482, -0.1032045445, -0.9735687606],
  LeftArm: [0.3588700891, 0.3330475092, -0.2437275350, -0.8371908069],
  LeftForeArm: [0.6711813445, 0.0920426274, 0.0631080087, -0.7328445516],
  LeftHand: [0.1380056441, -0.0531837605, 0.0113005191, -0.9889379144],
  RightShoulder: [-0.0078029762, 0.1895655361, -0.1187065372, 0.9746346901],
  RightArm: [-0.4402768612, 0.2994548678, -0.2436303049, 0.8106340170],
  RightForeArm: [-0.6172684434, 0.1156008542, 0.0392673239, 0.7772220973],
  RightHand: [0.0249351580, -0.0983217061, 0.0317024514, -0.9943369627],
};

const POSES = {
  cove_peek: {
    ...REST,
    LeftArm: [-0.3456019929, -0.3699144350, 0.2501497766, 0.8253167044],
    LeftForeArm: [-0.3524069839, -0.5069039117, -0.6588080059, 0.4299183100],
    RightArm: [-0.4351753155, 0.3125371234, -0.2437157780, 0.8084216788],
    RightForeArm: [-0.2586980901, 0.4481284040, 0.7357796090, 0.4369034202],
  },
  cove_think: {
    ...REST,
    LeftArm: [-0.3166141734, -0.4719973914, 0.3283964983, 0.7544068317],
    LeftForeArm: [-0.6579207425, -0.1883187210, -0.1277159766, 0.7178892569],
    RightArm: [-0.3722544217, 0.4563731471, -0.2279094136, 0.7750664860],
    RightForeArm: [-0.3157464411, 0.4002502289, 0.6687135303, 0.5400540086],
  },
  cove_watch: {
    ...REST,
    LeftArm: [-0.3166141734, -0.4719973914, 0.3283964983, 0.7544068317],
    LeftForeArm: [-0.6579207425, -0.1883187210, -0.1277159766, 0.7178892569],
    RightArm: [-0.4000821878, 0.4044716102, -0.2699669964, 0.7768235195],
    RightForeArm: [-0.5722425119, 0.1768841648, 0.2136150949, 0.7717636238],
  },
  cove_rest: {
    ...REST,
    LeftArm: [-0.3166141734, -0.4719973914, 0.3283964983, 0.7544068317],
    LeftForeArm: [-0.6579207425, -0.1883187210, -0.1277159766, 0.7178892569],
    RightArm: [-0.4000821878, 0.4044716102, -0.2699669964, 0.7768235195],
    RightForeArm: [-0.5722425119, 0.1768841648, 0.2136150949, 0.7717636238],
  },
};

const parentWorld = new Quaternion();
const restWorld = new Quaternion();
const desired = new Quaternion();
const trackValue = new Quaternion();
const translation = new Vector3();
const scale = new Vector3();

for (const [poseName, rotations] of Object.entries(POSES)) {
  const authoredPath = resolve(ROOT, `clyt-${poseName}.glb`);
  const path = existsSync(authoredPath) ? authoredPath : resolve(ROOT, `${poseName}.glb`);
  const document = await io.read(path);
  const animation = document.getRoot().listAnimations()[0];
  if (!animation) throw new Error(`${path}: missing animation`);

  let restored = 0;
  const preservedRotations = new Set(['Spine', 'Head', ...Object.keys(rotations)]);
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode();
    const pathName = channel.getTargetPath();
    if (!node || (pathName === 'rotation' && preservedRotations.has(node.getName()))) continue;
    const sampled = sourceSamples.get(`${node.getName()}.${pathName}`);
    const output = channel.getSampler().getOutput();
    if (!sampled || !output) continue;
    // Blender exports these two-key frozen actions as CUBICSPLINE. Replacing
    // the output with two values while leaving that interpolation intact is
    // malformed glTF: CUBICSPLINE requires in-tangent/value/out-tangent for
    // EACH key (six values total). Three's cubic interpolant then consumed
    // the constant values as tangents and collapsed the torso chain onto the
    // hips. Every rewritten constant channel must be linear.
    channel.getSampler().setInterpolation('LINEAR');
    output.setArray(new Float32Array([...sampled, ...sampled]));
    restored += 1;
  }

  // Spine/Head are authored by Blender and intentionally preserved rather
  // than restored from the source clip, but they are frozen too. Normalize
  // their cubic tangent/value layout before the runtime retargeter copies the
  // track into a standard QuaternionKeyframeTrack (which is linear and cannot
  // consume glTF cubic tangent triplets).
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode();
    if (
      channel.getTargetPath() !== 'rotation'
      || !node
      || (node.getName() !== 'Spine' && node.getName() !== 'Head')
    ) continue;
    const sampled = node.getName() === 'Spine'
      ? UPRIGHT_SPINE_CORRECTION.clone()
          .multiply(new Quaternion().fromArray(BASE_SPINE_SAMPLE))
          .normalize()
          .toArray()
      : sampleSampler(channel.getSampler(), 0.02);
    const output = channel.getSampler().getOutput();
    if (!output) throw new Error(`${path}: ${node.getName()} has no sampler output`);
    channel.getSampler().setInterpolation('LINEAR');
    output.setArray(new Float32Array([...sampled, ...sampled]));
  }

  let replaced = 0;
  for (const channel of animation.listChannels()) {
    if (channel.getTargetPath() !== 'rotation') continue;
    const node = channel.getTargetNode();
    const desiredArray = node && rotations[node.getName()];
    if (!node || !desiredArray) continue;

    const parent = node.getParentNode();
    if (parent) {
      new Matrix4().fromArray(parent.getWorldMatrix()).decompose(translation, parentWorld, scale);
    } else {
      parentWorld.identity();
    }
    new Matrix4().fromArray(node.getWorldMatrix()).decompose(translation, restWorld, scale);
    desired.fromArray(desiredArray);
    trackValue.copy(parentWorld).invert().multiply(desired).multiply(restWorld).normalize();

    const output = channel.getSampler().getOutput();
    if (!output) throw new Error(`${path}: ${node.getName()} has no sampler output`);
    channel.getSampler().setInterpolation('LINEAR');
    output.setArray(new Float32Array([
      trackValue.x, trackValue.y, trackValue.z, trackValue.w,
      trackValue.x, trackValue.y, trackValue.z, trackValue.w,
    ]));
    replaced += 1;
  }

  if (replaced !== 8) throw new Error(`${path}: expected 8 arm rotations, replaced ${replaced}`);
  await io.write(path, document);
  console.log(`[cardpose-arm-patch] ${poseName}: ${restored} base channels, ${replaced} arm rotations`);
}
