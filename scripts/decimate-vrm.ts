#!/usr/bin/env bun
/**
 * decimate-vrm.ts  —  Track-C VRM geometry decimation (now SHIPPING-capable)
 *
 * De-risks the "VRM geometry decimation" perf lever. Reads a VRM, runs
 * gltf-transform `simplify()` (meshoptimizer's MeshoptSimplifier) PER-PRIMITIVE
 * keeping the skeleton, re-applies meshopt + WebP if the source had them, and
 * preserves the VRMC_vrm extension block (humanoid bone map + expressions +
 * lookAt + firstPerson + meta) which gltf-transform otherwise STRIPS as an
 * unknown extension.
 *
 * ── Track E texture downscale (2026-06-13) ──────────────────────────────────
 * Optional `--tex1024` flag (or 4th positional arg `tex1024`): downscale every
 * texture to a 1024px max edge AND re-encode WebP. Used for the two chibi VRMs
 * whose source carries a 2048² PNG (~2.3 MB) — downscaling to 1024 WebP at q92
 * is perceptually lossless on a stylized chibi but cuts ~2 MB of wire weight.
 * Reuses the SAME textureCompress() call signature as compress-glb-targeted.ts /
 * assets-optimize.ts (encoder: sharp, targetFormat 'webp', resize [1024,1024]).
 * VRMC_vrm + UVs survive via the same raw-reinject pattern — texture compression
 * never touches the node graph, so node-index references stay stable.
 *
 * ── Shipping mode (2026-06-13) ──────────────────────────────────────────────
 * The NON-SHIPPING `lod-proto/`-only output guard is RELAXED: output may now be
 * written either under `/avatars/lod-proto/` (prototype) OR directly over a
 * canonical `/avatars/<name>.vrm` (ship). Any other path is still REFUSED. The
 * caller (orchestrator) owns cache-busting (`?v` bumps) on the ref sites; this
 * script only mutates the file bytes.
 *
 * It then VALIDATES the output structurally (the whole point of the prototype)
 * and prints a PASS/FAIL table. It does NOT judge visual quality — that's the
 * orchestrator's browser/screenshot job.
 *
 * ── Why this is safe for VRM skin binding ──────────────────────────────────
 * `simplify()` is per-primitive: it collapses POSITION/indices and carries the
 * matching JOINTS_0 / WEIGHTS_0 / morph-target deltas along. It does NOT add,
 * remove, or reorder nodes / skins / meshes / materials, so the node-index
 * references inside VRMC_vrm.humanoid.humanBones (head→nodeN, hips→nodeM, …)
 * stay valid. We therefore preserve VRMC_vrm by raw-GLB JSON surgery AFTER the
 * write (capture-before / re-inject-after — the proven assets-optimize.ts
 * technique), which is index-stable because simplify never touches the node
 * graph.
 *
 * We deliberately do NOT use VRMUtils.combineSkeletons (known T-pose regression
 * — NEVER per project rule) nor weld-then-merge that could fuse primitives and
 * break skin binding. simplify keeps one skin.
 *
 * Gotchas baked in:
 *   - `await MeshoptSimplifier.ready` BEFORE simplify() (WASM init), same as the
 *     encoder/decoder.
 *   - lockBorder:true so open-mesh silhouette edges (wing fins, hair card rims)
 *     don't peel inward — matters most for the hardest asset (tekk: wings).
 *   - error:0.01 is the meshoptimizer absolute error bound (fraction of mesh
 *     extent); the RATIO is the target index reduction. With cleanup the
 *     realised ratio floats above the request when the error bound bites first.
 *
 * SHIPPING vs PROTOTYPE: output path decides. `/avatars/lod-proto/<x>.vrm` =
 * prototype (no live refs). `/avatars/<x>.vrm` = ship-over-original (caller MUST
 * bump every ?v ref). Any other path is REFUSED.
 *
 * Usage (from monorepo root or worktree root):
 *   bun run scripts/decimate-vrm.ts <input.vrm> <ratio> <output.vrm> [tex1024|--tex1024]
 *   bun run scripts/decimate-vrm.ts apps/web/public/avatars/tekk.vrm 0.34 apps/web/public/avatars/lod-proto/tekk-lod.vrm
 *   bun run scripts/decimate-vrm.ts apps/web/public/avatars/milady-chibi.vrm 0.41 apps/web/public/avatars/milady-chibi.vrm --tex1024
 */

import { NodeIO } from '@gltf-transform/core';
import {
  KHRONOS_EXTENSIONS,
  EXTMeshoptCompression,
  EXTTextureWebP,
} from '@gltf-transform/extensions';
import { simplify, meshopt, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = process.cwd();

// ───────────────────────────────────────────────────────────────────────────
// GLB raw-JSON helpers (VRMC_vrm survives only via capture/re-inject)
// ───────────────────────────────────────────────────────────────────────────

/** Parse the JSON chunk of a GLB without instantiating gltf-transform. */
function readGlbJson(filePath: string): Record<string, any> {
  const buf = fs.readFileSync(filePath);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
}

/**
 * Capture the VRM root-extension blocks that gltf-transform drops on read.
 * VRM 1.0 → VRMC_vrm (+ VRMC_springBone / VRMC_node_constraint when present).
 * VRM 0.x → VRM. We grab whatever exists so the script is version-agnostic.
 */
function captureVrmExtensions(filePath: string): Record<string, unknown> {
  const json = readGlbJson(filePath);
  const ext = json.extensions ?? {};
  const vrmKeys = [
    'VRM',
    'VRMC_vrm',
    'VRMC_springBone',
    'VRMC_node_constraint',
    'VRMC_materials_mtoon',
  ];
  const captured: Record<string, unknown> = {};
  for (const key of vrmKeys) if (ext[key] !== undefined) captured[key] = ext[key];
  return captured;
}

/** Re-inject captured VRM extension blocks into an already-written GLB. */
function reinjectVrmExtensions(filePath: string, vrmExtensions: Record<string, unknown>): void {
  if (Object.keys(vrmExtensions).length === 0) return;
  const buf = fs.readFileSync(filePath);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8')) as {
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  json.extensions = json.extensions ?? {};
  for (const [k, v] of Object.entries(vrmExtensions)) json.extensions[k] = v;
  json.extensionsUsed = json.extensionsUsed ?? [];
  for (const k of Object.keys(vrmExtensions)) if (!json.extensionsUsed.includes(k)) json.extensionsUsed.push(k);

  const newJsonStr = JSON.stringify(json);
  const pad = (4 - (newJsonStr.length % 4)) % 4;
  const newJsonBuf = Buffer.from(newJsonStr + ' '.repeat(pad));
  const binaryChunk = buf.slice(20 + jsonLen);
  const newTotalLen = 12 + 8 + newJsonBuf.length + binaryChunk.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(newTotalLen, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(newJsonBuf.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  fs.writeFileSync(filePath, Buffer.concat([header, chunkHeader, newJsonBuf, binaryChunk]));
}

function hasExtensionUsed(filePath: string, name: string): boolean {
  const json = readGlbJson(filePath);
  return (json.extensionsUsed ?? []).includes(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

// ───────────────────────────────────────────────────────────────────────────
// Structural fingerprint (used by both the run + the validator)
// ───────────────────────────────────────────────────────────────────────────

interface VrmFingerprint {
  tris: number;
  verts: number;
  meshCount: number;
  skinCount: number;
  materialCount: number;
  skinJoints: number[]; // joint count per skin
  morphTargetCount: number; // total morph targets across all primitives
  primCount: number;
  primsWithJoints: number; // primitives that have BOTH JOINTS_0 + WEIGHTS_0
  textureCount: number;
  textureMimes: string[]; // mime type per texture
  textureMaxEdge: number; // largest texture edge (px) across all textures
  // VRMC_vrm (from raw JSON, since gltf-transform drops it)
  hasVrmcVrm: boolean;
  humanoidBoneCount: number;
  expressionPresetCount: number;
  expressionCustomCount: number;
  specVersion: string | null;
  vrmExtKeys: string[];
}

async function makeIO(): Promise<NodeIO> {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  return new NodeIO()
    .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP])
    .registerDependencies({
      'meshopt.encoder': MeshoptEncoder,
      'meshopt.decoder': MeshoptDecoder,
    });
}

/** Build a structural fingerprint of a VRM/GLB file. */
async function fingerprint(filePath: string, io: NodeIO): Promise<VrmFingerprint> {
  const doc = await io.read(filePath); // logs "Missing optional extension VRMC_vrm" — expected
  const root = doc.getRoot();

  let tris = 0;
  let verts = 0;
  let morphTargetCount = 0;
  let primCount = 0;
  let primsWithJoints = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primCount += 1;
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += idx ? idx.getCount() / 3 : pos ? pos.getCount() / 3 : 0;
      verts += pos ? pos.getCount() : 0;
      morphTargetCount += prim.listTargets().length;
      const hasJ = prim.getAttribute('JOINTS_0') != null;
      const hasW = prim.getAttribute('WEIGHTS_0') != null;
      if (hasJ && hasW) primsWithJoints += 1;
    }
  }

  // Texture inventory (mime + max edge) for the Track-E downscale validation.
  const textures = root.listTextures();
  const textureMimes: string[] = [];
  let textureMaxEdge = 0;
  for (const tex of textures) {
    textureMimes.push(tex.getMimeType() || 'unknown');
    const size = tex.getSize(); // [w, h] | null
    if (size) textureMaxEdge = Math.max(textureMaxEdge, size[0], size[1]);
  }

  // VRM block from raw JSON (gltf-transform drops it from the doc model).
  const rawJson = readGlbJson(filePath);
  const ext = rawJson.extensions ?? {};
  const vrmExtKeys = Object.keys(ext).filter((k) => k === 'VRM' || k.startsWith('VRMC_'));
  const vrmc = (ext.VRMC_vrm ?? ext.VRM) as any | undefined;
  let humanoidBoneCount = 0;
  let expressionPresetCount = 0;
  let expressionCustomCount = 0;
  let specVersion: string | null = null;
  if (vrmc) {
    specVersion = vrmc.specVersion ?? vrmc.exporterVersion ?? null;
    // VRM 1.0 humanoid.humanBones (object map) | VRM 0.x humanoid.humanBones (array)
    if (vrmc.humanoid?.humanBones) {
      humanoidBoneCount = Array.isArray(vrmc.humanoid.humanBones)
        ? vrmc.humanoid.humanBones.length
        : Object.keys(vrmc.humanoid.humanBones).length;
    }
    if (vrmc.expressions) {
      expressionPresetCount = vrmc.expressions.preset ? Object.keys(vrmc.expressions.preset).length : 0;
      expressionCustomCount = vrmc.expressions.custom ? Object.keys(vrmc.expressions.custom).length : 0;
    } else if (Array.isArray(vrmc.blendShapeMaster?.blendShapeGroups)) {
      // VRM 0.x face expressions live here
      expressionPresetCount = vrmc.blendShapeMaster.blendShapeGroups.length;
    }
  }

  return {
    tris: Math.round(tris),
    verts,
    meshCount: root.listMeshes().length,
    skinCount: root.listSkins().length,
    materialCount: root.listMaterials().length,
    skinJoints: root.listSkins().map((s) => s.listJoints().length),
    morphTargetCount,
    primCount,
    primsWithJoints,
    textureCount: textures.length,
    textureMimes,
    textureMaxEdge,
    hasVrmcVrm: vrmExtKeys.length > 0,
    humanoidBoneCount,
    expressionPresetCount,
    expressionCustomCount,
    specVersion,
    vrmExtKeys,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Validator (the point of the prototype)
// ───────────────────────────────────────────────────────────────────────────

interface Assertion {
  name: string;
  pass: boolean;
  detail: string;
}

function validate(
  src: VrmFingerprint,
  out: VrmFingerprint,
  srcBytes: number,
  outBytes: number,
  opts: { tex1024: boolean; minTris: number; maxTris: number },
): Assertion[] {
  const a: Assertion[] = [];

  a.push({
    name: 'VRMC_vrm present + parseable',
    pass: out.hasVrmcVrm && out.humanoidBoneCount > 0,
    detail: `extKeys=[${out.vrmExtKeys.join(',')}] specVersion=${out.specVersion} humanoidBones=${out.humanoidBoneCount}`,
  });

  a.push({
    name: 'humanoid bone map intact',
    pass: out.humanoidBoneCount === src.humanoidBoneCount && out.humanoidBoneCount > 0,
    detail: `${out.humanoidBoneCount} vs src ${src.humanoidBoneCount}`,
  });

  a.push({
    name: 'expression/blendshape block intact',
    pass:
      out.expressionPresetCount === src.expressionPresetCount &&
      out.expressionCustomCount === src.expressionCustomCount,
    detail: `presets ${out.expressionPresetCount} vs ${src.expressionPresetCount}, custom ${out.expressionCustomCount} vs ${src.expressionCustomCount}`,
  });

  a.push({
    name: 'exactly ONE skin',
    pass: out.skinCount === 1 && src.skinCount === 1,
    detail: `${out.skinCount} (src ${src.skinCount})`,
  });

  a.push({
    name: 'material count unchanged',
    pass: out.materialCount === src.materialCount,
    detail: `${out.materialCount} vs src ${src.materialCount}`,
  });

  a.push({
    name: 'morph-target count unchanged',
    pass: out.morphTargetCount === src.morphTargetCount,
    detail: `${out.morphTargetCount} vs src ${src.morphTargetCount}`,
  });

  const jointsEqual =
    out.skinJoints.length === src.skinJoints.length &&
    out.skinJoints.every((n, i) => n === src.skinJoints[i]);
  a.push({
    name: 'skin joint count unchanged',
    pass: jointsEqual,
    detail: `[${out.skinJoints.join(',')}] vs src [${src.skinJoints.join(',')}]`,
  });

  a.push({
    name: 'every primitive has JOINTS_0 + WEIGHTS_0',
    pass: out.primsWithJoints === out.primCount && out.primCount > 0,
    detail: `${out.primsWithJoints}/${out.primCount} skinned`,
  });

  a.push({
    name: 'triangle count reduced (decimation happened)',
    pass: out.tris < src.tris && out.tris > 0,
    detail: `${src.tris} → ${out.tris} tris (${((1 - out.tris / src.tris) * 100).toFixed(1)}% reduction)`,
  });

  a.push({
    name: `final tris in target band [${opts.minTris}-${opts.maxTris}]`,
    pass: out.tris >= opts.minTris && out.tris <= opts.maxTris,
    detail: `${out.tris} tris`,
  });

  a.push({
    name: 'texture count unchanged',
    pass: out.textureCount === src.textureCount,
    detail: `${out.textureCount} vs src ${src.textureCount}`,
  });

  a.push({
    name: 'file size reduced',
    pass: outBytes < srcBytes,
    detail: `${formatSize(srcBytes)} → ${formatSize(outBytes)} (${((1 - outBytes / srcBytes) * 100).toFixed(1)}% smaller)`,
  });

  // Track-E texture-downscale assertions (only when --tex1024 requested).
  if (opts.tex1024) {
    const allWebp = out.textureMimes.length > 0 && out.textureMimes.every((m) => m === 'image/webp');
    a.push({
      name: 'all textures re-encoded to image/webp',
      pass: allWebp,
      detail: `mimes=[${out.textureMimes.join(',')}] (src=[${src.textureMimes.join(',')}])`,
    });
    a.push({
      name: 'texture max edge ≤ 1024px',
      pass: out.textureMaxEdge > 0 && out.textureMaxEdge <= 1024,
      detail: `${out.textureMaxEdge}px (src ${src.textureMaxEdge}px)`,
    });
  }

  return a;
}

function printAssertions(label: string, asserts: Assertion[]): boolean {
  console.log(`\n  ── Validation: ${label} ─────────────────────────────`);
  let allPass = true;
  for (const x of asserts) {
    const mark = x.pass ? 'PASS' : 'FAIL';
    if (!x.pass) allPass = false;
    console.log(`   [${mark}] ${x.name.padEnd(42)} ${x.detail}`);
  }
  console.log(`  ── ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} ──`);
  return allPass;
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  // tex1024 may arrive as a positional `tex1024` token or a `--tex1024` flag.
  const tex1024 = rawArgs.some((a) => a === '--tex1024' || a === 'tex1024');
  const positional = rawArgs.filter((a) => a !== '--tex1024' && a !== 'tex1024');
  const [inRel, ratioStr, outRel] = positional;
  if (!inRel || !ratioStr || !outRel) {
    console.error('Usage: bun run scripts/decimate-vrm.ts <input.vrm> <ratio 0..1> <output.vrm> [tex1024|--tex1024]');
    process.exit(1);
  }
  const ratio = Number(ratioStr);
  if (!(ratio > 0 && ratio < 1)) {
    console.error(`ratio must be in (0,1); got ${ratioStr}`);
    process.exit(1);
  }
  const inFile = path.isAbsolute(inRel) ? inRel : path.join(REPO_ROOT, inRel);
  const outFile = path.isAbsolute(outRel) ? outRel : path.join(REPO_ROOT, outRel);
  if (!fs.existsSync(inFile)) {
    console.error(`input not found: ${inFile}`);
    process.exit(1);
  }
  // Path guard: output MUST be either an avatars/lod-proto/ prototype OR a
  // canonical apps/web/public/avatars/<name>.vrm ship target. Anything else is
  // REFUSED so we can never write a VRM somewhere unexpected.
  const outNorm = outFile.replace(/\\/g, '/');
  const isProto = outNorm.includes('/avatars/lod-proto/');
  const isShipAvatar = /\/apps\/web\/public\/avatars\/[^/]+\.vrm$/.test(outNorm);
  if (!isProto && !isShipAvatar) {
    console.error(
      `REFUSED: output must be under apps/web/public/avatars/lod-proto/ (prototype) ` +
        `or apps/web/public/avatars/<name>.vrm (ship) — got ${outFile}`,
    );
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const targetTris = 40000;
  const minTris = 38000;
  const maxTris = 42000;

  console.log(`\n=== decimate-vrm  ratio=${ratio}  tex1024=${tex1024}  ${isProto ? '(PROTOTYPE)' : '(SHIP over original)'} ===`);
  console.log(`  in : ${inRel}`);
  console.log(`  out: ${outRel}`);

  // WASM init — MeshoptSimplifier.ready is REQUIRED before simplify() or it
  // throws "simplifier not ready".
  await MeshoptSimplifier.ready;
  const io = await makeIO();

  // ── source fingerprint + flags ──
  const srcBytes = fs.statSync(inFile).size;
  const srcHadMeshopt = hasExtensionUsed(inFile, 'EXT_meshopt_compression');
  const srcHadWebp = hasExtensionUsed(inFile, 'EXT_texture_webp');
  const srcFp = await fingerprint(inFile, io);
  console.log(
    `  src: ${srcFp.tris} tris, ${srcFp.verts} verts, ${srcFp.meshCount} mesh, ${srcFp.skinCount} skin(${srcFp.skinJoints.join(',')} joints), ${srcFp.materialCount} mat, ${srcFp.morphTargetCount} morphs | meshopt=${srcHadMeshopt} webp=${srcHadWebp}`,
  );

  // ── capture VRM block, then transform ──
  const vrmExtensions = captureVrmExtensions(inFile);
  const doc = await io.read(inFile);

  // simplify: per-primitive, keeps skeleton + skin. lockBorder protects
  // silhouette/open edges (wings). error is meshoptimizer's absolute bound.
  const transforms: Array<Parameters<typeof doc.transform>[number]> = [
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true }),
  ];
  if (tex1024) {
    // Track-E: downscale every texture to a 1024px max edge + re-encode WebP.
    // `formats: /png|jpe?g|webp/i` so we catch the chibis' RAW PNG sources AND
    // any already-WebP texture (so the resize still applies). Same encoder
    // (sharp) + quality (92) as compress-glb-targeted.ts. resize is a
    // bounding-box cap — textures already ≤1024 are left at native size.
    transforms.push(
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        formats: /png|jpe?g|webp/i,
        quality: 92,
        resize: [1024, 1024],
      }),
    );
  } else if (srcHadWebp) {
    // Geometry-only path (hermes/tekk): re-apply textureCompress→WebP if the
    // source had it, WITHOUT resize (their textures are already 1024² WebP and
    // optimal). Keeps the wire format we read; never upscales/downscales.
    transforms.push(
      textureCompress({ encoder: sharp, targetFormat: 'webp', formats: /png|jpe?g/i, quality: 92 }),
    );
  }
  // re-apply meshopt if source had it (geometry was de-meshopt'd on read)
  if (srcHadMeshopt) {
    transforms.push(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  }
  await doc.transform(...transforms);

  const glbBytes = await io.writeBinary(doc);
  // Atomic write (review B2): write the bytes + re-inject VRMC_vrm on a TEMP
  // file, then rename it over the target as the LAST step. In ship mode `outFile`
  // is a canonical /avatars/<name>.vrm — if `reinjectVrmExtensions` threw mid-run
  // a direct write would leave the original decimated-but-VRMC-stripped (an
  // irrecoverably corrupt VRM with no backup). Temp+rename guarantees the target
  // is only ever the fully-finished file OR the untouched original.
  const tmpFile = outFile + '.tmp';
  fs.writeFileSync(tmpFile, Buffer.from(glbBytes));
  // re-inject VRMC_vrm (+ siblings) — index-stable because simplify never
  // touched the node graph.
  reinjectVrmExtensions(tmpFile, vrmExtensions);
  fs.renameSync(tmpFile, outFile);

  const outBytes = fs.statSync(outFile).size;
  const outFp = await fingerprint(outFile, io);
  console.log(
    `  out: ${outFp.tris} tris, ${outFp.verts} verts, ${outFp.meshCount} mesh, ${outFp.skinCount} skin(${outFp.skinJoints.join(',')} joints), ${outFp.materialCount} mat, ${outFp.morphTargetCount} morphs`,
  );
  console.log(
    `  tex: src=[${srcFp.textureMimes.join(',')}] maxEdge=${srcFp.textureMaxEdge}px → out=[${outFp.textureMimes.join(',')}] maxEdge=${outFp.textureMaxEdge}px`,
  );

  const asserts = validate(srcFp, outFp, srcBytes, outBytes, { tex1024, minTris, maxTris });
  const allPass = printAssertions(`${path.basename(outFile)} (ratio ${ratio})`, asserts);

  console.log(`\nRESULT ratio=${ratio}: ${allPass ? 'PASS' : 'FAIL'}  | ${srcFp.tris}→${outFp.tris} tris | ${formatSize(srcBytes)}→${formatSize(outBytes)} | targetTris=${targetTris}`);
  process.exit(allPass ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
