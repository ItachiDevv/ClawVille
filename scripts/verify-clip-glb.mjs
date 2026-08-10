#!/usr/bin/env bun
/**
 * verify-clip-glb.mjs — runtime companion check for strip-clip-glb.mjs.
 *
 * strip-clip-glb.mjs proves the BYTES are correct. This proves the RESULT is
 * loadable and bindable by the same stack the browser runs:
 *
 *   1. each stripped clip parses in a real three.js GLTFLoader (Node-side,
 *      MeshoptDecoder wired) and yields >= 1 AnimationClip;
 *   2. every track in every clip resolves to a node NAME that exists in the
 *      stripped clip's own scene graph;
 *   3. that same name resolves against the BASE rig's scene graph via
 *      THREE.PropertyBinding.findNode — the exact lookup AnimationMixer does,
 *      i.e. the clip really can drive the base skeleton;
 *   4. the loaded clip is non-degenerate (duration > 0, tracks have values).
 *
 * The base rig is loaded through the same loader with a stub KTX2 loader (Node
 * has no Basis transcoder and we only care about the scene graph, not pixels).
 * Node names are ALSO cross-checked against the base GLB's raw JSON, so the
 * result does not depend on loader-side name handling alone.
 *
 * Usage:
 *   bun scripts/verify-clip-glb.mjs <base.glb> <clip.glb> [<clip.glb> ...]
 *
 * Exit: 0 all clips bind · 1 at least one failure
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { MeshoptDecoder } from 'meshoptimizer';

// `three` is a workspace dep of apps/web, not of the repo root, so a bare
// `import 'three'` from scripts/ does not resolve. Locate the package dir and
// import the ESM build by path — the SAME path GLTFLoader's own bare `three`
// import resolves to, so both share one module instance (instanceof-safe).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const threePkg = (() => {
  for (const paths of [undefined, [path.join(repoRoot, 'apps/web/node_modules')], [path.join(repoRoot, 'apps/web')]]) {
    try { return path.dirname(req.resolve('three/package.json', paths ? { paths } : undefined)); } catch { /* next */ }
  }
  console.error('error: cannot locate the `three` package (looked in repo root and apps/web)');
  process.exit(2);
})();
const THREE = await import(pathToFileURL(path.join(threePkg, 'build/three.module.js')).href);
const { GLTFLoader } = await import(pathToFileURL(path.join(threePkg, 'examples/jsm/loaders/GLTFLoader.js')).href);

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: bun scripts/verify-clip-glb.mjs <base.glb> <clip.glb> [...]');
  process.exit(2);
}
const [baseFile, ...clipFiles] = args;

/** Minimal KTX2 stand-in: the base rig declares KHR_texture_basisu as REQUIRED,
 *  so GLTFLoader throws without a loader. We never inspect pixels here. */
const stubKtx2 = {
  isKTX2Loader: true,
  load(_url, onLoad) { onLoad(new THREE.Texture()); },
  setTranscoderPath() { return this; },
  detectSupport() { return this; },
  dispose() {},
};

function makeLoader({ withKtx2 }) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (withKtx2) loader.setKTX2Loader(stubKtx2);
  return loader;
}

function parseGlbJson(file) {
  const buf = fs.readFileSync(file);
  const totalLen = buf.readUInt32LE(8);
  let off = 12;
  while (off + 8 <= totalLen) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) return JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len;
  }
  throw new Error(`${file}: no JSON chunk`);
}

function loadGlb(file, opts) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    makeLoader(opts).parse(ab, path.dirname(file) + '/', resolve, reject);
  });
}

const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`  FAIL ${msg}`); };

// --- base rig -------------------------------------------------------------
await MeshoptDecoder.ready;
const baseGltf = await loadGlb(baseFile, { withKtx2: true });
const baseNames = new Set();
baseGltf.scene.traverse((o) => { if (o.name) baseNames.add(o.name); });
const baseJsonNames = new Set((parseGlbJson(baseFile).nodes || []).map((n) => n.name).filter(Boolean));
console.log(`base  ${baseFile}`);
console.log(`      loaded scene graph: ${baseNames.size} named object(s); raw JSON: ${baseJsonNames.size} named node(s)`);

// --- clips ----------------------------------------------------------------
for (const clipFile of clipFiles) {
  console.log(`clip  ${clipFile} (${(fs.statSync(clipFile).size / 1024).toFixed(1)}KB)`);
  let gltf;
  try {
    gltf = await loadGlb(clipFile, { withKtx2: false });
  } catch (err) {
    fail(`${clipFile}: GLTFLoader threw: ${err?.message || err}`);
    continue;
  }

  if (!gltf.animations || gltf.animations.length < 1) { fail(`${clipFile}: gltf.animations.length = 0`); continue; }

  const clipNames = new Set();
  gltf.scene.traverse((o) => { if (o.name) clipNames.add(o.name); });

  for (const clip of gltf.animations) {
    if (!(clip.duration > 0)) fail(`${clipFile}: clip "${clip.name}" duration ${clip.duration} <= 0`);
    if (clip.tracks.length === 0) fail(`${clipFile}: clip "${clip.name}" has 0 tracks`);

    const targets = new Set();
    for (const track of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(track.name);
      const nodeName = parsed.nodeName;
      targets.add(nodeName);

      if (!track.values.length || !track.times.length) fail(`${clipFile}: track "${track.name}" has no keyframes`);
      if (!clipNames.has(nodeName)) fail(`${clipFile}: track "${track.name}" targets "${nodeName}" — absent from the stripped clip's own scene graph`);
      if (!baseNames.has(nodeName)) fail(`${clipFile}: track "${track.name}" targets "${nodeName}" — absent from base scene graph ${baseFile}`);
      if (!baseJsonNames.has(nodeName)) fail(`${clipFile}: track "${track.name}" targets "${nodeName}" — absent from base raw JSON nodes`);
      // The exact lookup THREE.AnimationMixer performs when binding an action.
      if (THREE.PropertyBinding.findNode(baseGltf.scene, nodeName) === undefined) {
        fail(`${clipFile}: PropertyBinding.findNode failed for "${nodeName}" on the base scene`);
      }
    }

    // Bind the clip for real against the base rig.
    const mixer = new THREE.AnimationMixer(baseGltf.scene);
    try {
      const action = mixer.clipAction(clip);
      action.play();
      mixer.update(0.016);
      mixer.stopAllAction();
      mixer.uncacheClip(clip);
    } catch (err) {
      fail(`${clipFile}: AnimationMixer failed to drive clip "${clip.name}" on the base rig: ${err?.message || err}`);
    }

    console.log(`      clip "${clip.name}": ${clip.tracks.length} track(s), ${targets.size} target node(s), duration ${clip.duration.toFixed(3)}s — bound to base rig OK`);
  }
  if (gltf.scene.children.length === 0) fail(`${clipFile}: empty scene`);
}

if (failures.length) {
  console.error(`\nVERIFY-FAIL: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(`\nverification: PASS — ${clipFiles.length} clip file(s) load, are non-degenerate, and bind by node name to ${baseFile}`);
