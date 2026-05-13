#!/usr/bin/env bun
/**
 * Inspect the position tracks of a walk.glb file. Prints min/max/mean for
 * each axis of the hip / root translation track, plus a sample of the
 * keyframe values, so we can diagnose "shooting into the sky" bugs.
 *
 * Usage:
 *   bun scripts/mixamo/inspect-walk.ts <glb-path>
 *
 * Reads the GLB binary directly using @gltf-transform/core (no Three.js
 * runtime dependency — pure node-side parsing).
 */

import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { resolve } from "node:path";

const [path] = process.argv.slice(2);
if (!path) {
  console.error("Usage: bun scripts/mixamo/inspect-walk.ts <glb-path>");
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(resolve(process.cwd(), path));
const root = doc.getRoot();

console.log(`\n=== ${path} ===`);
console.log(`Scenes: ${root.listScenes().length}`);
console.log(`Animations: ${root.listAnimations().length}`);

for (const anim of root.listAnimations()) {
  console.log(`\nAnimation "${anim.getName()}"`);
  const channels = anim.listChannels();
  console.log(`  channels: ${channels.length}`);

  // Find every translation channel; print its target node + min/max/mean per axis.
  for (const ch of channels) {
    const targetPath = ch.getTargetPath();
    if (targetPath !== "translation") continue;
    const node = ch.getTargetNode();
    const sampler = ch.getSampler();
    if (!node || !sampler) continue;
    const output = sampler.getOutput();
    if (!output) continue;
    const arr = output.getArray();
    if (!arr) continue;

    const nodeName = node.getName();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let sumX = 0, sumY = 0, sumZ = 0;
    const frames = arr.length / 3;
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i] ?? 0, y = arr[i + 1] ?? 0, z = arr[i + 2] ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      sumX += x; sumY += y; sumZ += z;
    }
    const f = (n: number) => n.toFixed(4);
    console.log(
      `  translation: ${nodeName}` +
        `\n    X:  min=${f(minX)}  max=${f(maxX)}  mean=${f(sumX / frames)}  range=${f(maxX - minX)}` +
        `\n    Y:  min=${f(minY)}  max=${f(maxY)}  mean=${f(sumY / frames)}  range=${f(maxY - minY)}` +
        `\n    Z:  min=${f(minZ)}  max=${f(maxZ)}  mean=${f(sumZ / frames)}  range=${f(maxZ - minZ)}` +
        `\n    frames=${frames}`,
    );
    // Dump per-frame Y values for hips so we can spot pattern (oscillation vs drift).
    if (nodeName.toLowerCase().includes("hips")) {
      const ys: number[] = [];
      for (let i = 0; i < arr.length; i += 3) ys.push(arr[i + 1] ?? 0);
      console.log(`    Y per-frame: [${ys.map((y) => y.toFixed(3)).join(", ")}]`);
    }
  }
}
