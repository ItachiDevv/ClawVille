#!/usr/bin/env node

/**
 * Dump the raw Mixamo hips translation tracks used by Reef Race riders.
 * Runs with plain Node; the fallback loader only exists for Bun installations
 * whose package junctions cannot be traversed by Node on Windows.
 */

import { createRequire } from 'node:module';
import Module from 'node:module';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bunStore = path.join(repoRoot, 'node_modules', '.bun');

function storedPackage(prefix, packageRelativePath) {
  const storeEntry = readdirSync(bunStore).find((name) => name.startsWith(prefix));
  if (!storeEntry) throw new Error(`Missing ${prefix} in ${bunStore}`);
  return path.join(bunStore, storeEntry, 'node_modules', packageRelativePath);
}

function loadTools() {
  try {
    const core = require('@gltf-transform/core');
    const extensions = require('@gltf-transform/extensions');
    const { MeshoptDecoder } = require('meshoptimizer');
    return {
      NodeIO: core.NodeIO,
      EXTMeshoptCompression: extensions.EXTMeshoptCompression,
      MeshoptDecoder,
    };
  } catch {
    const propertyGraphModules = storedPackage('property-graph@', '');
    const coreModules = storedPackage('@gltf-transform+core@', '');
    const ktxParseModules = storedPackage('ktx-parse@', '');
    process.env.NODE_PATH = [
      propertyGraphModules,
      coreModules,
      ktxParseModules,
      process.env.NODE_PATH,
    ]
      .filter(Boolean)
      .join(path.delimiter);
    Module._initPaths();
    const coreRoot = storedPackage('@gltf-transform+core@', '@gltf-transform/core');
    const extensionsRoot = storedPackage(
      '@gltf-transform+extensions@',
      '@gltf-transform/extensions',
    );
    const decoderRoot = storedPackage('meshoptimizer@', 'meshoptimizer');
    const core = require(path.join(coreRoot, 'dist', 'index.cjs'));
    const extensions = require(path.join(extensionsRoot, 'dist', 'index.cjs'));
    const MeshoptDecoder = require(path.join(decoderRoot, 'meshopt_decoder.cjs'));
    return {
      NodeIO: core.NodeIO,
      EXTMeshoptCompression: extensions.EXTMeshoptCompression,
      MeshoptDecoder,
    };
  }
}

function summarizeAxis(values, width, axis) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = axis; i < values.length; i += width) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  return { min, max, amplitude: max - min };
}

const { NodeIO, EXTMeshoptCompression, MeshoptDecoder } = loadTools();
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const animationRoot = path.join(repoRoot, 'apps/web/public/avatars/animations');
const variants = ['', 'chibi', 'tekk-male', 'hermes-male', 'hermes-female'];
const clipFiles = ['skateboarding.glb', 'wipeout.glb', 'cheering.glb'];

for (const variant of variants) {
  for (const clipFile of clipFiles) {
    const relative = path.join(variant, clipFile);
    const document = await io.read(path.join(animationRoot, relative));
    let found = false;

    for (const animation of document.getRoot().listAnimations()) {
      for (const channel of animation.listChannels()) {
        const node = channel.getTargetNode();
        if (channel.getTargetPath() !== 'translation' || !/hips/i.test(node?.getName() ?? '')) {
          continue;
        }
        const sampler = channel.getSampler();
        const times = sampler.getInput().getArray();
        const output = sampler.getOutput();
        const values = output.getArray();
        const width = output.getElementSize();
        console.log(JSON.stringify({
          file: relative.replaceAll('\\', '/'),
          animation: animation.getName() || '(unnamed)',
          node: node.getName(),
          keyframes: output.getCount(),
          durationSeconds: times[times.length - 1] - times[0],
          x: summarizeAxis(values, width, 0),
          y: summarizeAxis(values, width, 1),
          z: summarizeAxis(values, width, 2),
        }));
        found = true;
      }
    }

    if (!found) {
      console.log(JSON.stringify({
        file: relative.replaceAll('\\', '/'),
        hipsTranslation: null,
      }));
    }
  }
}
