#!/usr/bin/env node
// Pure-Node VRM 1.0 injector for MESHY-rigged humanoid GLBs (bare bone names).
// Rewrites ONLY the GLB JSON chunk: adds VRMC_vrm with a humanoid bone->node
// map onto the EXISTING Meshy nodes. NO rename, NO reparent, NO IBM edit.
// BIN payload, skin, inverse-bind matrices, geometry, node TRS, animations:
// all copied through byte-unchanged (verified by BIN sha256 before/after).
//
// Usage:
//   node scripts/hermes-pipeline/inject-vrm-meshy.mjs <rigged.glb> <out.vrm> [--name Cronus]

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

// Meshy auto-rig bare bone name -> VRM 1.0 humanoid bone.
// Covers all 15 VRM-required bones + chest/upperChest/neck/shoulders/toes.
const MESHY_TO_VRM = Object.freeze({
  Hips: "hips",
  Spine: "spine",
  Spine01: "chest",
  Spine02: "upperChest",
  neck: "neck",
  Head: "head",
  LeftShoulder: "leftShoulder",
  LeftArm: "leftUpperArm",
  LeftForeArm: "leftLowerArm",
  LeftHand: "leftHand",
  RightShoulder: "rightShoulder",
  RightArm: "rightUpperArm",
  RightForeArm: "rightLowerArm",
  RightHand: "rightHand",
  LeftUpLeg: "leftUpperLeg",
  LeftLeg: "leftLowerLeg",
  LeftFoot: "leftFoot",
  LeftToeBase: "leftToes",
  RightUpLeg: "rightUpperLeg",
  RightLeg: "rightLowerLeg",
  RightFoot: "rightFoot",
  RightToeBase: "rightToes",
});

// VRM 1.0 hard-required humanoid bones — inject MUST find a node for each.
const VRM_REQUIRED = Object.freeze([
  "hips", "spine", "head",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot",
  "rightUpperLeg", "rightLowerLeg", "rightFoot",
]);

function parseGLB(buffer) {
  if (buffer.byteLength < 20) throw new Error("input too small to be a GLB");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB (bad magic)");
  if (view.getUint32(4, true) !== GLB_VERSION) throw new Error("only GLB v2 supported");
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end > buffer.byteLength) throw new Error("malformed GLB chunk length");
    chunks.push({ type, bytes: buffer.subarray(dataOffset, end) });
    offset = end;
  }
  if (offset !== buffer.byteLength) throw new Error("malformed GLB trailing bytes");
  if (!chunks.length || chunks[0].type !== CHUNK_TYPE_JSON) throw new Error("chunk 0 must be JSON");
  return { json: JSON.parse(chunks[0].bytes.toString("utf8")), chunks };
}

function encodeJsonChunk(json) {
  const bytes = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (bytes.length % 4)) % 4;
  return pad ? Buffer.concat([bytes, Buffer.alloc(pad, 0x20)]) : bytes;
}

function encodeGLB(json, chunks) {
  const jsonBytes = encodeJsonChunk(json);
  let totalLength = 12 + 8 + jsonBytes.length;
  for (let i = 1; i < chunks.length; i++) totalLength += 8 + chunks[i].bytes.length;
  const output = Buffer.alloc(totalLength);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  let offset = 12;
  view.setUint32(offset, jsonBytes.length, true);
  view.setUint32(offset + 4, CHUNK_TYPE_JSON, true);
  jsonBytes.copy(output, offset + 8);
  offset += 8 + jsonBytes.length;
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    view.setUint32(offset, chunk.bytes.length, true);
    view.setUint32(offset + 4, chunk.type, true);
    chunk.bytes.copy(output, offset + 8);
    offset += 8 + chunk.bytes.length;
  }
  return output;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function buildHumanBones(json) {
  const nodeByName = new Map((json.nodes || []).map((n, i) => [n.name, i]));
  const humanBones = {};
  const resolved = {};
  for (const [meshyName, vrmBone] of Object.entries(MESHY_TO_VRM)) {
    if (nodeByName.has(meshyName)) {
      humanBones[vrmBone] = { node: nodeByName.get(meshyName) };
      resolved[vrmBone] = meshyName;
    }
  }
  const missing = VRM_REQUIRED.filter((b) => !(b in humanBones));
  if (missing.length) throw new Error(`missing VRM-required bones (no Meshy node matched): ${missing.join(", ")}`);
  return { humanBones, resolved };
}

export function injectVRM(json, name = "Avatar") {
  const { humanBones, resolved } = buildHumanBones(json);
  json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []), "VRMC_vrm"]));
  json.extensions = {
    ...(json.extensions || {}),
    VRMC_vrm: {
      specVersion: "1.0",
      meta: {
        name,
        version: "1.0.0",
        authors: ["ClawVille"],
        licenseUrl: "https://vrm.dev/licenses/1.0/",
        avatarPermission: "everyone",
        commercialUsage: "personalNonProfit",
        creditNotation: "unnecessary",
        allowRedistribution: false,
        modification: "prohibited",
        allowExcessivelyViolentUsage: false,
        allowExcessivelySexualUsage: false,
        allowPoliticalOrReligiousUsage: false,
        allowAntisocialOrHateUsage: false,
      },
      humanoid: { humanBones },
    },
  };
  return { humanBones, resolved };
}

function main() {
  const argv = process.argv.slice(2);
  const inputPath = argv[0];
  const outputPath = argv[1];
  const nameFlag = argv.indexOf("--name");
  const name = nameFlag >= 0 ? argv[nameFlag + 1] : "Avatar";
  if (!inputPath || !outputPath) {
    console.error("usage: inject-vrm-meshy.mjs <rigged.glb> <out.vrm> [--name Cronus]");
    process.exit(1);
  }
  const input = readFileSync(inputPath);
  const { json, chunks } = parseGLB(input);
  const beforeBin = chunks.find((c) => c.type === CHUNK_TYPE_BIN);
  const beforeHash = beforeBin ? sha256(beforeBin.bytes) : null;
  const { humanBones, resolved } = injectVRM(json, name);
  const output = encodeGLB(json, chunks);
  const { chunks: outChunks } = parseGLB(output);
  const afterBin = outChunks.find((c) => c.type === CHUNK_TYPE_BIN);
  const afterHash = afterBin ? sha256(afterBin.bytes) : null;
  if (beforeHash !== afterHash) throw new Error("BIN chunk preservation check FAILED");
  writeFileSync(outputPath, output);
  console.log(`input:  ${inputPath}`);
  console.log(`output: ${outputPath}  (${(output.length / 1048576).toFixed(1)} MB)`);
  console.log(`VRMC_vrm 1.0 | humanoid bones mapped: ${Object.keys(humanBones).length}`);
  console.log(`BIN sha256 preserved: ${beforeHash ? "yes" : "(no BIN)"}`);
  console.log("mapping:");
  for (const [vrm, meshy] of Object.entries(resolved)) console.log(`  ${vrm.padEnd(14)} <- ${meshy}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
