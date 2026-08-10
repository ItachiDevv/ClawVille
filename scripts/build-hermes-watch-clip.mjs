#!/usr/bin/env node
/** Bake Hermes' known-good first seated key into a two-key frozen watch clip. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Euler, Quaternion } from '../apps/web/node_modules/three/build/three.module.js';
import { resolve } from 'node:path';

const [sourceArg, outputArg, forearmAxis = 'x', forearmDegreesArg = '55', mirrorArg = 'same'] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  throw new Error('usage: bun scripts/build-hermes-watch-clip.mjs <source.glb> <output.glb>');
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(resolve(sourceArg));
const animation = document.getRoot().listAnimations()[0];
if (!animation) throw new Error('Hermes source has no animation');
animation.setName('cove_watch');

const lean = new Quaternion().setFromEuler(new Euler(-25 * Math.PI / 180, 0, 0, 'XYZ'));
const headCounter = new Quaternion().setFromEuler(new Euler(17 * Math.PI / 180, 0, 0, 'XYZ'));
const forearmDegrees = Number(forearmDegreesArg);
let channels = 0;
for (const channel of animation.listChannels()) {
  const sampler = channel.getSampler();
  const input = sampler.getInput();
  const output = sampler.getOutput();
  const source = output?.getArray();
  if (!input || !output || !source) throw new Error('Hermes animation sampler is incomplete');
  const size = output.getElementSize();
  const value = Array.from(source.slice(0, size));
  const nodeName = channel.getTargetNode()?.getName();
  if (channel.getTargetPath() === 'rotation' && nodeName === 'Spine') {
    new Quaternion().fromArray(value).premultiply(lean).normalize().toArray(value);
  }
  if (channel.getTargetPath() === 'rotation' && nodeName === 'Head') {
    new Quaternion().fromArray(value).premultiply(headCounter).normalize().toArray(value);
  }
  if (
    channel.getTargetPath() === 'rotation'
    && (nodeName === 'LeftForeArm' || nodeName === 'RightForeArm')
    && ['x', 'y', 'z'].includes(forearmAxis)
    && Number.isFinite(forearmDegrees)
    && (mirrorArg !== 'left-only' || nodeName === 'LeftForeArm')
  ) {
    const sign = mirrorArg === 'same' || nodeName === 'LeftForeArm' ? 1 : -1;
    const radians = sign * forearmDegrees * Math.PI / 180;
    const euler = new Euler(
      forearmAxis === 'x' ? radians : 0,
      forearmAxis === 'y' ? radians : 0,
      forearmAxis === 'z' ? radians : 0,
      'XYZ',
    );
    new Quaternion().fromArray(value)
      .premultiply(new Quaternion().setFromEuler(euler))
      .normalize()
      .toArray(value);
  }
  input.setArray(new Float32Array([0, 1 / 24]));
  output.setArray(new Float32Array([...value, ...value]));
  channels += 1;
}

await io.write(resolve(outputArg), document);
console.log(`[hermes-watch] ${channels} channels, duration=${(1 / 24).toFixed(6)}s`);
