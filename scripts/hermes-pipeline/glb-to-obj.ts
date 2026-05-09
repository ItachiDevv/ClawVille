#!/usr/bin/env bun
// Convert a static (non-skinned) GLB mesh to Wavefront OBJ.
// Mixamo's auto-rigger accepts FBX/OBJ/ZIP but not GLB. Our decimated meshes
// have only POSITION/NORMAL/TEXCOORD_0 (no skinning yet) so OBJ is sufficient.
//
// Usage: bun scripts/hermes-pipeline/glb-to-obj.ts <input.glb> <output.obj>

import { NodeIO } from "@gltf-transform/core";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("Usage: bun scripts/hermes-pipeline/glb-to-obj.ts <input.glb> <output.obj>");
  process.exit(1);
}

const io = new NodeIO();
const doc = await io.read(resolve(inPath));
const meshes = doc.getRoot().listMeshes();
if (meshes.length === 0) {
  console.error("No meshes in GLB");
  process.exit(1);
}

const lines: string[] = [`# Converted from ${inPath} via gltf-transform`, "o character"];
let vOffset = 0;

for (const mesh of meshes) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    const nor = prim.getAttribute("NORMAL");
    const uv  = prim.getAttribute("TEXCOORD_0");
    const idx = prim.getIndices();
    if (!pos || !idx) {
      console.error("Primitive missing POSITION or indices, skipping");
      continue;
    }
    const posArr = pos.getArray()!;
    const norArr = nor?.getArray();
    const uvArr  = uv?.getArray();
    const idxArr = idx.getArray()!;
    const vCount = pos.getCount();

    // v
    for (let i = 0; i < vCount; i++) {
      lines.push(`v ${posArr[i*3]} ${posArr[i*3+1]} ${posArr[i*3+2]}`);
    }
    // vt
    if (uvArr) {
      for (let i = 0; i < vCount; i++) {
        // OBJ V coord is flipped vs glTF
        lines.push(`vt ${uvArr[i*2]} ${1 - uvArr[i*2+1]}`);
      }
    }
    // vn
    if (norArr) {
      for (let i = 0; i < vCount; i++) {
        lines.push(`vn ${norArr[i*3]} ${norArr[i*3+1]} ${norArr[i*3+2]}`);
      }
    }
    // f (1-indexed, OBJ format: v/vt/vn)
    for (let i = 0; i < idxArr.length; i += 3) {
      const a = idxArr[i]   + 1 + vOffset;
      const b = idxArr[i+1] + 1 + vOffset;
      const c = idxArr[i+2] + 1 + vOffset;
      const fmt = (n: number) => {
        const parts = [String(n)];
        if (uvArr) parts.push(String(n));
        else if (norArr) parts.push("");
        if (norArr) parts.push(String(n));
        return parts.join("/");
      };
      lines.push(`f ${fmt(a)} ${fmt(b)} ${fmt(c)}`);
    }
    vOffset += vCount;
  }
}

writeFileSync(resolve(outPath), lines.join("\n") + "\n");
console.log(`Wrote ${outPath} (${lines.length} lines, ${vOffset} verts)`);
