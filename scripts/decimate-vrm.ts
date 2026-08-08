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
 * ── UV-safe island welding (2026-08-08) ─────────────────────────────────────
 * Optional `--weld-islands` recovers topology hidden by Meshy triangle-corner
 * splits without welding across texture-atlas seams. Original triangles are
 * joined only across exact-position edges whose UVs are continuous; the
 * simplifier operates on one vertex per (position, UV-island), includes UVs in
 * its attribute error, and locks both endpoint variants of discontinuous edges.
 * A resolution-aware UV-area/edge-stretch gate rejects cross-island output or
 * any resolvable triangle above 4x its incident original-surface range.
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

import { type Accessor, type Document, NodeIO, Primitive } from '@gltf-transform/core';
import {
  KHRONOS_EXTENSIONS,
  EXTMeshoptCompression,
  EXTTextureWebP,
} from '@gltf-transform/extensions';
import { compactPrimitive, simplify, meshopt, textureCompress } from '@gltf-transform/functions';
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

// Two UNORM16 steps: large enough to ignore a quantization-rounding wobble,
// small enough to distinguish the authored atlas seams in the showpieces.
const UV_CONTINUITY_TOLERANCE = 2 / 65535;
// UV error participates in meshoptimizer's attribute quadric. Island topology
// and seam-edge locks provide the hard guarantee; this modest weight discourages
// avoidable stretch without letting UV scale dominate the positional budget.
const UV_ATTRIBUTE_WEIGHT = 1;
const UV_TEXEL_LENGTH_FLOOR = 1 / 1024;
const UV_TEXEL_AREA_FLOOR = UV_TEXEL_LENGTH_FLOOR ** 2;
// Every emitted triangle must remain within this factor of the source triangles
// incident to its three corners on the same UV island. See evaluateUvIntegrity().
const UV_INTEGRITY_FACTOR_LIMIT = 4;

interface PositionRemapStats {
  primitiveCount: number;
  sourceVertices: number;
  canonicalVertices: number;
  sourceTris: number;
  outputTris: number;
  uvIslands: number;
  uvSeamEdges: number;
  uvSeamLocks: number;
  maxError: number;
}

interface EdgeUse {
  triangle: number;
  lowSource: number;
  highSource: number;
}

interface UvRange {
  areaMin: number;
  areaMax: number;
  edgeMin: number;
  edgeMax: number;
}

interface UvIntegrityStats {
  triangles: number;
  islandMisses: number;
  stretchViolations: number;
  factors: number[];
  worst: Array<{ factor: number; detail: string }>;
  violatingVertices: Set<number>;
}

class DisjointSet {
  private readonly parent: Uint32Array;
  private readonly rank: Uint8Array;

  constructor(size: number) {
    this.parent = new Uint32Array(size);
    this.rank = new Uint8Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[value] !== value) {
      const next = this.parent[value];
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    let rootA = this.find(a);
    let rootB = this.find(b);
    if (rootA === rootB) return;
    if (this.rank[rootA] < this.rank[rootB]) [rootA, rootB] = [rootB, rootA];
    this.parent[rootB] = rootA;
    if (this.rank[rootA] === this.rank[rootB]) this.rank[rootA]++;
  }
}

/** Decode POSITION to the tightly-packed float32 layout meshoptimizer expects. */
function readFloatPositions(position: Accessor): Float32Array {
  const positions = new Float32Array(position.getCount() * 3);
  const element: number[] = [];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, element);
    positions[i * 3] = element[0];
    positions[i * 3 + 1] = element[1];
    positions[i * 3 + 2] = element[2];
  }
  return positions;
}

/** Decode any normalized/quantized accessor to a tightly-packed float stream. */
function readFloatAttribute(accessor: Accessor): Float32Array {
  const elementSize = accessor.getElementSize();
  const values = new Float32Array(accessor.getCount() * elementSize);
  const element: number[] = [];
  for (let i = 0; i < accessor.getCount(); i++) {
    accessor.getElement(i, element);
    for (let component = 0; component < elementSize; component++) {
      values[i * elementSize + component] = element[component];
    }
  }
  return values;
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function uvCornersAgree(a: number, b: number, uvValues: readonly Float32Array[], uvSizes: readonly number[]): boolean {
  for (let uvIndex = 0; uvIndex < uvValues.length; uvIndex++) {
    const values = uvValues[uvIndex];
    const size = uvSizes[uvIndex];
    for (let component = 0; component < size; component++) {
      if (Math.abs(values[a * size + component] - values[b * size + component]) > UV_CONTINUITY_TOLERANCE) {
        return false;
      }
    }
  }
  return true;
}

function edgeUsesAreUvContinuous(
  a: EdgeUse,
  b: EdgeUse,
  uvValues: readonly Float32Array[],
  uvSizes: readonly number[],
): boolean {
  return (
    uvCornersAgree(a.lowSource, b.lowSource, uvValues, uvSizes) &&
    uvCornersAgree(a.highSource, b.highSource, uvValues, uvSizes)
  );
}

function triangleArea3d(positions: Float32Array, a: number, b: number, c: number): number {
  const abx = positions[b * 3] - positions[a * 3];
  const aby = positions[b * 3 + 1] - positions[a * 3 + 1];
  const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
  const acx = positions[c * 3] - positions[a * 3];
  const acy = positions[c * 3 + 1] - positions[a * 3 + 1];
  const acz = positions[c * 3 + 2] - positions[a * 3 + 2];
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  return 0.5 * Math.hypot(crossX, crossY, crossZ);
}

function triangleAreaUv(values: Float32Array, size: number, a: number, b: number, c: number): number {
  if (size < 2) return 0;
  const abx = values[b * size] - values[a * size];
  const aby = values[b * size + 1] - values[a * size + 1];
  const acx = values[c * size] - values[a * size];
  const acy = values[c * size + 1] - values[a * size + 1];
  return 0.5 * Math.abs(abx * acy - aby * acx);
}

function edgeLength3d(positions: Float32Array, a: number, b: number): number {
  return Math.hypot(
    positions[b * 3] - positions[a * 3],
    positions[b * 3 + 1] - positions[a * 3 + 1],
    positions[b * 3 + 2] - positions[a * 3 + 2],
  );
}

function edgeLengthUv(values: Float32Array, size: number, a: number, b: number): number {
  let squared = 0;
  for (let component = 0; component < size; component++) {
    const delta = values[b * size + component] - values[a * size + component];
    squared += delta * delta;
  }
  return Math.sqrt(squared);
}

function updateUvRange(range: UvRange, areaStretch: number, edgeStretches: readonly number[]): void {
  if (Number.isFinite(areaStretch)) {
    range.areaMin = Math.min(range.areaMin, areaStretch);
    range.areaMax = Math.max(range.areaMax, areaStretch);
  }
  for (const edgeStretch of edgeStretches) {
    if (!Number.isFinite(edgeStretch)) continue;
    range.edgeMin = Math.min(range.edgeMin, edgeStretch);
    range.edgeMax = Math.max(range.edgeMax, edgeStretch);
  }
}

function regularizedRangeFactor(value: number, min: number, max: number, resolutionFloor: number): number {
  if (!Number.isFinite(value) || min === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (value >= min && value <= max) return 1;
  if (value < min) return (min + resolutionFloor) / (value + resolutionFloor);
  return (value + resolutionFloor) / (Math.max(max, 0) + resolutionFloor);
}

function mergeUvRanges(target: UvRange, source: UvRange): void {
  target.areaMin = Math.min(target.areaMin, source.areaMin);
  target.areaMax = Math.max(target.areaMax, source.areaMax);
  target.edgeMin = Math.min(target.edgeMin, source.edgeMin);
  target.edgeMax = Math.max(target.edgeMax, source.edgeMax);
}

function emptyUvRange(): UvRange {
  return {
    areaMin: Number.POSITIVE_INFINITY,
    areaMax: Number.NEGATIVE_INFINITY,
    edgeMin: Number.POSITIVE_INFINITY,
    edgeMax: Number.NEGATIVE_INFINITY,
  };
}

/**
 * UV-integrity proxy for the failure seen in v1.
 *
 * First, every emitted corner tuple must share at least one original UV island
 * with the other two corners. This directly catches atlas-variant substitution.
 * For each viable island, UV-area/3D-area and UV-edge/3D-edge stretch are then
 * compared with the range of original triangles incident to the same three
 * positions on that island. Ratios are regularized by one 1024px texel (or one
 * texel squared for area), so sub-texel slivers are not reported as infinite
 * while visible atlas jumps remain large. The most charitable common island is
 * used, so a failure means no plausible local source region explains the span.
 */
function evaluateUvIntegrity(opts: {
  simplifiedIslandIndices: Uint32Array;
  mappedSourceIndices: Uint32Array;
  canonicalByVertex: Uint32Array;
  canonicalPositions: Float32Array;
  sourceIslands: ReadonlyArray<ReadonlySet<number> | undefined>;
  islandVertexByKey: ReadonlyMap<number, number>;
  islandCount: number;
  referenceByIslandVertex: ReadonlyArray<ReadonlyArray<UvRange>>;
  uvValues: readonly Float32Array[];
  uvSizes: readonly number[];
}): UvIntegrityStats {
  const stats: UvIntegrityStats = {
    triangles: opts.mappedSourceIndices.length / 3,
    islandMisses: 0,
    stretchViolations: 0,
    factors: [],
    worst: [],
    violatingVertices: new Set(),
  };
  if (opts.uvValues.length === 0) {
    stats.factors = new Array(stats.triangles).fill(1);
    return stats;
  }

  for (let offset = 0; offset < opts.mappedSourceIndices.length; offset += 3) {
    const sourceVertices = [
      opts.mappedSourceIndices[offset],
      opts.mappedSourceIndices[offset + 1],
      opts.mappedSourceIndices[offset + 2],
    ];
    const canonicalVertices = sourceVertices.map((source) => opts.canonicalByVertex[source]);
    const firstIslands = opts.sourceIslands[sourceVertices[0]] ?? new Set<number>();
    const commonIslands: number[] = [];
    for (const island of firstIslands) {
      if (opts.sourceIslands[sourceVertices[1]]?.has(island) && opts.sourceIslands[sourceVertices[2]]?.has(island)) {
        commonIslands.push(island);
      }
    }

    if (commonIslands.length === 0) {
      stats.islandMisses++;
      stats.violatingVertices.add(opts.simplifiedIslandIndices[offset]);
      stats.violatingVertices.add(opts.simplifiedIslandIndices[offset + 1]);
      stats.violatingVertices.add(opts.simplifiedIslandIndices[offset + 2]);
      continue;
    }

    const geometryArea = triangleArea3d(
      opts.canonicalPositions,
      canonicalVertices[0],
      canonicalVertices[1],
      canonicalVertices[2],
    );
    let bestFactor = Number.POSITIVE_INFINITY;
    let bestDetail = '';

    for (const island of commonIslands) {
      const islandVertices = canonicalVertices.map((canonical) =>
        opts.islandVertexByKey.get(canonical * opts.islandCount + island),
      );
      if (islandVertices.some((vertex) => vertex === undefined)) continue;

      let triangleFactor = 1;
      let triangleDetail = 'within source range';
      for (let uvIndex = 0; uvIndex < opts.uvValues.length; uvIndex++) {
        const uv = opts.uvValues[uvIndex];
        const uvSize = opts.uvSizes[uvIndex];
        const areaRange = emptyUvRange();
        for (const islandVertex of islandVertices) {
          mergeUvRanges(areaRange, opts.referenceByIslandVertex[islandVertex!][uvIndex]);
        }
        const uvArea = triangleAreaUv(uv, uvSize, sourceVertices[0], sourceVertices[1], sourceVertices[2]);
        const areaStretch = geometryArea > 1e-12 ? uvArea / geometryArea : 0;
        const areaFactor = regularizedRangeFactor(
          uvArea,
          areaRange.areaMin * geometryArea,
          areaRange.areaMax * geometryArea,
          UV_TEXEL_AREA_FLOOR,
        );
        if (areaFactor > triangleFactor) {
          triangleFactor = areaFactor;
          triangleDetail =
            `uv${uvIndex} area=${areaStretch.toExponential(3)} geom=${geometryArea.toExponential(3)} ` +
            `ref=[${areaRange.areaMin.toExponential(3)},${areaRange.areaMax.toExponential(3)}] ` +
            `uvs=[${sourceVertices
              .map((source) =>
                Array.from(uv.subarray(source * uvSize, source * uvSize + uvSize))
                  .map((value) => value.toFixed(5))
                  .join(','),
              )
              .join('|')}]`;
        }

        const edgeCorners = [
          [0, 1],
          [1, 2],
          [2, 0],
        ] as const;
        for (const [cornerA, cornerB] of edgeCorners) {
          const edgeRange = emptyUvRange();
          mergeUvRanges(edgeRange, opts.referenceByIslandVertex[islandVertices[cornerA]!][uvIndex]);
          mergeUvRanges(edgeRange, opts.referenceByIslandVertex[islandVertices[cornerB]!][uvIndex]);
          const geometryLength = edgeLength3d(
            opts.canonicalPositions,
            canonicalVertices[cornerA],
            canonicalVertices[cornerB],
          );
          const uvLength = edgeLengthUv(uv, uvSize, sourceVertices[cornerA], sourceVertices[cornerB]);
          const edgeStretch = geometryLength > 1e-12 ? uvLength / geometryLength : 0;
          const edgeFactor = regularizedRangeFactor(
            uvLength,
            edgeRange.edgeMin * geometryLength,
            edgeRange.edgeMax * geometryLength,
            UV_TEXEL_LENGTH_FLOOR,
          );
          if (edgeFactor > triangleFactor) {
            triangleFactor = edgeFactor;
            triangleDetail = `uv${uvIndex} edge${cornerA}-${cornerB}=${edgeStretch.toExponential(3)} ref=[${edgeRange.edgeMin.toExponential(3)},${edgeRange.edgeMax.toExponential(3)}]`;
          }
        }
      }
      if (triangleFactor < bestFactor) {
        bestFactor = triangleFactor;
        bestDetail = `triangle=${offset / 3} island=${island} ${triangleDetail}`;
      }
    }

    stats.factors.push(bestFactor);
    if (!(bestFactor <= UV_INTEGRITY_FACTOR_LIMIT)) {
      stats.stretchViolations++;
      stats.worst.push({ factor: bestFactor, detail: bestDetail });
      stats.worst.sort((a, b) => b.factor - a.factor);
      stats.worst.length = Math.min(stats.worst.length, 5);
      stats.violatingVertices.add(opts.simplifiedIslandIndices[offset]);
      stats.violatingVertices.add(opts.simplifiedIslandIndices[offset + 1]);
      stats.violatingVertices.add(opts.simplifiedIslandIndices[offset + 2]);
    }
  }
  return stats;
}

function mergeUvIntegrity(target: UvIntegrityStats, source: UvIntegrityStats): void {
  target.triangles += source.triangles;
  target.islandMisses += source.islandMisses;
  target.stretchViolations += source.stretchViolations;
  target.factors.push(...source.factors);
  target.worst.push(...source.worst);
  target.worst.sort((a, b) => b.factor - a.factor);
  target.worst.length = Math.min(target.worst.length, 5);
  for (const vertex of source.violatingVertices) target.violatingVertices.add(vertex);
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

function formatUvIntegrity(label: string, stats: UvIntegrityStats): string {
  const factors = [...stats.factors].sort((a, b) => a - b);
  const fmt = (value: number): string => (Number.isFinite(value) ? `${value.toFixed(2)}x` : 'inf');
  const worst = stats.worst.map(({ factor, detail }) => `${fmt(factor)} ${detail}`).join('; ');
  return (
    `  UV-integrity ${label}: ${stats.triangles} tris, ` +
    `island-miss=${stats.islandMisses} (${((100 * stats.islandMisses) / Math.max(stats.triangles, 1)).toFixed(3)}%), ` +
    `factor(valid) p50=${fmt(quantile(factors, 0.5))} p95=${fmt(quantile(factors, 0.95))} ` +
    `p99=${fmt(quantile(factors, 0.99))} max=${fmt(factors.at(-1) ?? Number.POSITIVE_INFINITY)}, ` +
    `>${UV_INTEGRITY_FACTOR_LIMIT}x=${stats.stretchViolations}` +
    (worst ? `; worst: ${worst}` : '')
  );
}

/**
 * Simplify using topology reconstructed from exact POSITION + UV continuity.
 *
 * Meshy exported almost every triangle corner separately. We first recover exact
 * position topology, then union original triangles only across position-edges
 * whose UV tuples agree. The simplifier sees one vertex per (position, UV-island)
 * pair: interior normal/corner splits are welded, but atlas variants never are.
 * UV channels participate in the attribute error, and both endpoint variants of
 * every discontinuous seam edge are locked. Surviving vertices map back to an
 * untouched source tuple before compactPrimitive() copies base + morph data.
 */
function simplifyPositionRemap(document: Document, ratio: number, errorLimit: number): PositionRemapStats {
  const stats: PositionRemapStats = {
    primitiveCount: 0,
    sourceVertices: 0,
    canonicalVertices: 0,
    sourceTris: 0,
    outputTris: 0,
    uvIslands: 0,
    uvSeamEdges: 0,
    uvSeamLocks: 0,
    maxError: 0,
  };
  const v1Integrity: UvIntegrityStats = {
    triangles: 0,
    islandMisses: 0,
    stretchViolations: 0,
    factors: [],
    worst: [],
    violatingVertices: new Set(),
  };
  const v2Integrity: UvIntegrityStats = {
    triangles: 0,
    islandMisses: 0,
    stretchViolations: 0,
    factors: [],
    worst: [],
    violatingVertices: new Set(),
  };

  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) {
        throw new Error('--weld-islands currently requires TRIANGLES primitives');
      }

      const position = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      if (!position || !indices?.getArray()) {
        throw new Error('--weld-islands requires indexed primitives with POSITION');
      }

      const sourceIndices = indices.getArray()!;
      const sourceVertexCount = position.getCount();
      const floatPositions = readFloatPositions(position);

      // meshoptimizer performs an exact (bitwise float32 XYZ) remap. No epsilon
      // grid is used: both showpieces already recover the expected ~59k topology
      // through exact equality, avoiding accidental near-surface welding.
      const positionRepresentatives = MeshoptSimplifier.generatePositionRemap(floatPositions, 3);
      const canonicalByVertex = new Uint32Array(sourceVertexCount);
      const canonicalMembers: number[][] = [];
      const canonicalIdByRepresentative = new Map<number, number>();

      for (let vertex = 0; vertex < sourceVertexCount; vertex++) {
        const positionRepresentative = positionRepresentatives[vertex];
        let canonicalId = canonicalIdByRepresentative.get(positionRepresentative);
        if (canonicalId === undefined) {
          canonicalId = canonicalMembers.length;
          canonicalIdByRepresentative.set(positionRepresentative, canonicalId);
          canonicalMembers.push([]);
        }
        canonicalByVertex[vertex] = canonicalId;
        canonicalMembers[canonicalId].push(vertex);
      }

      const canonicalPositions = new Float32Array(canonicalMembers.length * 3);
      const referenceCounts = new Uint32Array(sourceVertexCount);
      for (let i = 0; i < sourceIndices.length; i++) referenceCounts[sourceIndices[i]]++;

      const representativeByCanonical = new Uint32Array(canonicalMembers.length);
      const uvAccessors = prim
        .listSemantics()
        .filter((semantic) => /^TEXCOORD_\d+$/.test(semantic))
        .map((semantic) => prim.getAttribute(semantic)!);
      const uvSizes = uvAccessors.map((uv) => uv.getElementSize());
      const uvValues = uvAccessors.map(readFloatAttribute);

      for (let canonicalId = 0; canonicalId < canonicalMembers.length; canonicalId++) {
        const members = canonicalMembers[canonicalId];
        const first = members[0];
        canonicalPositions[canonicalId * 3] = floatPositions[first * 3];
        canonicalPositions[canonicalId * 3 + 1] = floatPositions[first * 3 + 1];
        canonicalPositions[canonicalId * 3 + 2] = floatPositions[first * 3 + 2];

        // A modal-by-index-use representative minimizes changed triangle corners
        // at attribute seams while still returning an untouched source tuple.
        let representative = first;
        for (let memberIndex = 1; memberIndex < members.length; memberIndex++) {
          const member = members[memberIndex];
          if (referenceCounts[member] > referenceCounts[representative]) representative = member;
        }
        representativeByCanonical[canonicalId] = representative;
      }

      // Build original position-edge adjacency. UV-continuous edge pairs union
      // their triangles; disagreeing pairs define hard atlas seams.
      const triangleCount = sourceIndices.length / 3;
      const triangleSets = new DisjointSet(triangleCount);
      const edgeUses = new Map<string, EdgeUse[]>();
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const offset = triangle * 3;
        for (const [cornerA, cornerB] of [
          [0, 1],
          [1, 2],
          [2, 0],
        ] as const) {
          const sourceA = sourceIndices[offset + cornerA];
          const sourceB = sourceIndices[offset + cornerB];
          const canonicalA = canonicalByVertex[sourceA];
          const canonicalB = canonicalByVertex[sourceB];
          if (canonicalA === canonicalB) continue;
          const key = edgeKey(canonicalA, canonicalB);
          let uses = edgeUses.get(key);
          if (!uses) edgeUses.set(key, (uses = []));
          uses.push(
            canonicalA < canonicalB
              ? { triangle, lowSource: sourceA, highSource: sourceB }
              : { triangle, lowSource: sourceB, highSource: sourceA },
          );
        }
      }

      const seamCanonicalLocks = new Uint8Array(canonicalMembers.length);
      let primitiveSeamEdges = 0;
      for (const [key, uses] of edgeUses) {
        let discontinuous = false;
        for (let a = 0; a < uses.length; a++) {
          for (let b = a + 1; b < uses.length; b++) {
            if (edgeUsesAreUvContinuous(uses[a], uses[b], uvValues, uvSizes)) {
              triangleSets.union(uses[a].triangle, uses[b].triangle);
            } else {
              discontinuous = true;
            }
          }
        }
        if (discontinuous) {
          primitiveSeamEdges++;
          const separator = key.indexOf(':');
          seamCanonicalLocks[Number(key.slice(0, separator))] = 1;
          seamCanonicalLocks[Number(key.slice(separator + 1))] = 1;
        }
      }

      const islandByRoot = new Map<number, number>();
      const triangleIsland = new Uint32Array(triangleCount);
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const root = triangleSets.find(triangle);
        let island = islandByRoot.get(root);
        if (island === undefined) {
          island = islandByRoot.size;
          islandByRoot.set(root, island);
        }
        triangleIsland[triangle] = island;
      }
      const islandCount = islandByRoot.size;

      // Re-index source corners to dense (exact position, UV island) vertices.
      // The numeric key is collision-free here (<60k positions * <120k islands).
      const islandVertexByKey = new Map<number, number>();
      const islandVertexCanonical: number[] = [];
      const islandVertexCandidates: Array<Map<number, number>> = [];
      const sourceIslands: Array<Set<number> | undefined> = new Array(sourceVertexCount);
      const islandIndices = new Uint32Array(sourceIndices.length);
      for (let offset = 0; offset < sourceIndices.length; offset++) {
        const source = sourceIndices[offset];
        const canonical = canonicalByVertex[source];
        const island = triangleIsland[Math.floor(offset / 3)];
        const key = canonical * islandCount + island;
        let islandVertex = islandVertexByKey.get(key);
        if (islandVertex === undefined) {
          islandVertex = islandVertexCanonical.length;
          islandVertexByKey.set(key, islandVertex);
          islandVertexCanonical.push(canonical);
          islandVertexCandidates.push(new Map());
        }
        islandIndices[offset] = islandVertex;
        const candidates = islandVertexCandidates[islandVertex];
        candidates.set(source, (candidates.get(source) ?? 0) + 1);
        let islands = sourceIslands[source];
        if (!islands) sourceIslands[source] = islands = new Set();
        islands.add(island);
      }

      const islandVertexCount = islandVertexCanonical.length;
      const islandNeighbors: Array<Set<number>> = Array.from({ length: islandVertexCount }, () => new Set());
      for (let offset = 0; offset < islandIndices.length; offset += 3) {
        const corners = [islandIndices[offset], islandIndices[offset + 1], islandIndices[offset + 2]];
        for (const [a, b] of [
          [0, 1],
          [1, 2],
          [2, 0],
        ] as const) {
          islandNeighbors[corners[a]].add(corners[b]);
          islandNeighbors[corners[b]].add(corners[a]);
        }
      }
      const islandPositions = new Float32Array(islandVertexCount * 3);
      const islandRepresentatives = new Uint32Array(islandVertexCount);
      const islandLocks = new Uint8Array(islandVertexCount);
      const uvStride = uvSizes.reduce((sum, size) => sum + size, 0);
      const islandUvValues = new Float32Array(islandVertexCount * uvStride);
      let primitiveLocks = 0;

      for (let islandVertex = 0; islandVertex < islandVertexCount; islandVertex++) {
        const canonical = islandVertexCanonical[islandVertex];
        islandPositions[islandVertex * 3] = canonicalPositions[canonical * 3];
        islandPositions[islandVertex * 3 + 1] = canonicalPositions[canonical * 3 + 1];
        islandPositions[islandVertex * 3 + 2] = canonicalPositions[canonical * 3 + 2];

        let representative = -1;
        let bestUses = -1;
        for (const [source, uses] of islandVertexCandidates[islandVertex]) {
          if (uses > bestUses || (uses === bestUses && source < representative)) {
            representative = source;
            bestUses = uses;
          }
        }
        if (representative < 0) throw new Error('internal error: UV-island vertex has no source tuple');
        islandRepresentatives[islandVertex] = representative;

        let attributeOffset = 0;
        for (let uvIndex = 0; uvIndex < uvValues.length; uvIndex++) {
          const size = uvSizes[uvIndex];
          for (let component = 0; component < size; component++) {
            islandUvValues[islandVertex * uvStride + attributeOffset + component] =
              uvValues[uvIndex][representative * size + component];
          }
          attributeOffset += size;
        }

        if (seamCanonicalLocks[canonical]) {
          islandLocks[islandVertex] = 1;
          primitiveLocks++;
        }
      }

      const targetIndexCount = Math.floor((ratio * islandIndices.length) / 3) * 3;
      let [simplifiedIslandIndices, measuredError] = MeshoptSimplifier.simplifyWithAttributes(
        islandIndices,
        islandPositions,
        3,
        islandUvValues,
        uvStride,
        new Array(uvStride).fill(UV_ATTRIBUTE_WEIGHT),
        islandLocks,
        targetIndexCount,
        errorLimit,
        ['LockBorder'],
      );

      const mapSourceTuples = (useIslandVariant: boolean): Uint32Array => {
        const mapped = new Uint32Array(simplifiedIslandIndices.length);
        for (let i = 0; i < simplifiedIslandIndices.length; i++) {
          const islandVertex = simplifiedIslandIndices[i];
          mapped[i] = useIslandVariant
            ? islandRepresentatives[islandVertex]
            : representativeByCanonical[islandVertexCanonical[islandVertex]];
        }
        return mapped;
      };
      let survivingSourceIndices = mapSourceTuples(true);

      // Reference stretch ranges for original triangles incident to each dense
      // island vertex. These are the local source regions used by the gate.
      const referenceByIslandVertex: UvRange[][] = Array.from({ length: islandVertexCount }, () =>
        uvValues.map(() => emptyUvRange()),
      );
      for (let triangle = 0; triangle < triangleCount; triangle++) {
        const offset = triangle * 3;
        const sourceA = sourceIndices[offset];
        const sourceB = sourceIndices[offset + 1];
        const sourceC = sourceIndices[offset + 2];
        const canonicalA = canonicalByVertex[sourceA];
        const canonicalB = canonicalByVertex[sourceB];
        const canonicalC = canonicalByVertex[sourceC];
        const geometryArea = triangleArea3d(canonicalPositions, canonicalA, canonicalB, canonicalC);
        const geometryEdges = [
          edgeLength3d(canonicalPositions, canonicalA, canonicalB),
          edgeLength3d(canonicalPositions, canonicalB, canonicalC),
          edgeLength3d(canonicalPositions, canonicalC, canonicalA),
        ];
        const denseCorners = [islandIndices[offset], islandIndices[offset + 1], islandIndices[offset + 2]];
        for (let uvIndex = 0; uvIndex < uvValues.length; uvIndex++) {
          const uv = uvValues[uvIndex];
          const size = uvSizes[uvIndex];
          const areaStretch =
            geometryArea > 1e-12 ? triangleAreaUv(uv, size, sourceA, sourceB, sourceC) / geometryArea : 0;
          const edgeStretches = [
            geometryEdges[0] > 1e-12 ? edgeLengthUv(uv, size, sourceA, sourceB) / geometryEdges[0] : 0,
            geometryEdges[1] > 1e-12 ? edgeLengthUv(uv, size, sourceB, sourceC) / geometryEdges[1] : 0,
            geometryEdges[2] > 1e-12 ? edgeLengthUv(uv, size, sourceC, sourceA) / geometryEdges[2] : 0,
          ];
          for (const denseCorner of new Set(denseCorners)) {
            updateUvRange(referenceByIslandVertex[denseCorner][uvIndex], areaStretch, edgeStretches);
          }
        }
      }

      const integrityOptions = {
        canonicalByVertex,
        canonicalPositions,
        sourceIslands,
        islandVertexByKey,
        islandCount,
        referenceByIslandVertex,
        uvValues,
        uvSizes,
      };
      let primitiveV2Integrity = evaluateUvIntegrity({
        ...integrityOptions,
        simplifiedIslandIndices,
        mappedSourceIndices: survivingSourceIndices,
      });

      // Attribute quadrics reduce UV distortion but do not forbid a topology
      // flip whose surviving UVs happen to become collinear. Feed the measurable
      // failures back as locks and retry; each pass is deterministic and only
      // grows the lock set. In practice the showpieces converge in a few passes.
      const maxUvRepairPasses = 4;
      let uvRepairPasses = 0;
      while (
        (primitiveV2Integrity.islandMisses > 0 || primitiveV2Integrity.stretchViolations > 0) &&
        uvRepairPasses < maxUvRepairPasses
      ) {
        let addedLocks = 0;
        const repairVertices = new Set(primitiveV2Integrity.violatingVertices);
        let frontier = [...repairVertices];
        for (let depth = 0; depth <= uvRepairPasses; depth++) {
          const next: number[] = [];
          for (const islandVertex of frontier) {
            for (const neighbor of islandNeighbors[islandVertex]) {
              if (repairVertices.has(neighbor)) continue;
              repairVertices.add(neighbor);
              next.push(neighbor);
            }
          }
          frontier = next;
        }
        for (const islandVertex of repairVertices) {
          if (islandLocks[islandVertex]) continue;
          islandLocks[islandVertex] = 1;
          primitiveLocks++;
          addedLocks++;
        }
        if (addedLocks === 0) break;
        uvRepairPasses++;

        [simplifiedIslandIndices, measuredError] = MeshoptSimplifier.simplifyWithAttributes(
          islandIndices,
          islandPositions,
          3,
          islandUvValues,
          uvStride,
          new Array(uvStride).fill(UV_ATTRIBUTE_WEIGHT),
          islandLocks,
          targetIndexCount,
          errorLimit,
          ['LockBorder'],
        );
        survivingSourceIndices = mapSourceTuples(true);
        primitiveV2Integrity = evaluateUvIntegrity({
          ...integrityOptions,
          simplifiedIslandIndices,
          mappedSourceIndices: survivingSourceIndices,
        });
        console.log(
          `  UV repair pass ${uvRepairPasses}: +${addedLocks} locks; ` +
            `${primitiveV2Integrity.islandMisses} island misses, ` +
            `${primitiveV2Integrity.stretchViolations} stretch violations`,
        );
      }

      const primitiveV1Integrity = evaluateUvIntegrity({
        ...integrityOptions,
        simplifiedIslandIndices,
        mappedSourceIndices: mapSourceTuples(false),
      });
      mergeUvIntegrity(v1Integrity, primitiveV1Integrity);
      mergeUvIntegrity(v2Integrity, primitiveV2Integrity);
      console.log(formatUvIntegrity('representative-v1', primitiveV1Integrity));
      console.log(formatUvIntegrity('island-aware-v2', primitiveV2Integrity));

      if (primitiveV2Integrity.islandMisses > 0 || primitiveV2Integrity.stretchViolations > 0) {
        throw new Error(
          `--weld-islands UV-integrity failed: ${primitiveV2Integrity.islandMisses} triangles cross islands, ` +
            `${primitiveV2Integrity.stretchViolations} triangles exceed ${UV_INTEGRITY_FACTOR_LIMIT}x local source stretch`,
        );
      }

      // compactPrimitive clones every base + morph attribute with its original
      // typed-array representation, selecting only island-correct source tuples.
      indices.setArray(new Uint32Array(survivingSourceIndices));
      compactPrimitive(prim);

      stats.primitiveCount++;
      stats.sourceVertices += sourceVertexCount;
      stats.canonicalVertices += canonicalMembers.length;
      stats.sourceTris += sourceIndices.length / 3;
      stats.outputTris += simplifiedIslandIndices.length / 3;
      stats.uvIslands += islandCount;
      stats.uvSeamEdges += primitiveSeamEdges;
      stats.uvSeamLocks += primitiveLocks;
      stats.maxError = Math.max(stats.maxError, measuredError);

      console.log(
        `  weld-islands prim ${stats.primitiveCount}: ${sourceVertexCount} verts -> ${canonicalMembers.length} exact positions, ` +
          `${islandVertexCount} position/island verts across ${islandCount} islands, ` +
          `${sourceIndices.length / 3}->${simplifiedIslandIndices.length / 3} tris, ` +
          `${primitiveSeamEdges} seam edges / ${primitiveLocks} variant locks, error=${measuredError.toExponential(3)}`,
      );
    }
  }

  if (stats.primitiveCount === 0) throw new Error('--weld-islands found no mesh primitives');
  if (stats.primitiveCount > 1) {
    console.log(formatUvIntegrity('representative-v1 TOTAL', v1Integrity));
    console.log(formatUvIntegrity('island-aware-v2 TOTAL', v2Integrity));
  }
  return stats;
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
    out.skinJoints.length === src.skinJoints.length && out.skinJoints.every((n, i) => n === src.skinJoints[i]);
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
  // Rung-2 gate 3 (census 2026-08-07): target band + simplifier error budget
  // are CLI knobs so the RD ladder can probe rungs per asset. Defaults preserve
  // the original hermes-era behavior (40k band, error 0.01) exactly.
  //
  // ERROR SEMANTICS (Codex tooling review finding 7): meshoptimizer's simplify
  // error is RELATIVE TO MESH EXTENT (gltf-transform does not request
  // ErrorAbsolute) — 0.01 permits ~1% of the mesh's bounding extent in
  // positional deviation, 0.05 permits ~5%. Values above 0.05 are visually
  // hazardous on a character and require the explicit --unsafe-error flag.
  let cliTargetTris: number | null = null;
  let cliError: number | null = null;
  let unsafeError = false;
  let weldIslands = false;
  const positional: string[] = [];
  const seen = new Set<string>();
  const takeValue = (a: string, name: string, i: number): [number, number] => {
    if (seen.has(name)) {
      console.error(`duplicate ${name}`);
      process.exit(1);
    }
    seen.add(name);
    if (a.includes('=')) return [Number(a.slice(name.length + 1)), i];
    return [Number(rawArgs[i + 1]), i + 1];
  };
  const takeBool = (name: string): void => {
    if (seen.has(name)) {
      console.error(`duplicate ${name}`);
      process.exit(1);
    }
    seen.add(name);
  };
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--tex1024' || a === 'tex1024') {
      takeBool('--tex1024');
      continue;
    }
    if (a === '--unsafe-error') {
      takeBool('--unsafe-error');
      unsafeError = true;
      continue;
    }
    if (a === '--weld-islands') {
      takeBool('--weld-islands');
      weldIslands = true;
      continue;
    }
    if (a === '--target-tris' || a.startsWith('--target-tris=')) {
      [cliTargetTris, i] = takeValue(a, '--target-tris', i);
      continue;
    }
    if (a === '--error' || a.startsWith('--error=')) {
      [cliError, i] = takeValue(a, '--error', i);
      continue;
    }
    if (a.startsWith('-')) {
      console.error(`unknown flag ${a}`);
      process.exit(1);
    }
    positional.push(a);
  }
  if (positional.length > 3) {
    console.error(`unexpected extra arguments: ${positional.slice(3).join(' ')}`);
    process.exit(1);
  }
  if (cliTargetTris !== null && !(Number.isSafeInteger(cliTargetTris) && cliTargetTris >= 1000)) {
    console.error(`--target-tris must be an integer >= 1000; got ${cliTargetTris}`);
    process.exit(1);
  }
  const ERROR_SAFE_CAP = 0.05;
  if (cliError !== null && !(Number.isFinite(cliError) && cliError > 0 && cliError <= 0.2)) {
    console.error(`--error must be in (0, 0.2]; got ${cliError}`);
    process.exit(1);
  }
  if (cliError !== null && cliError > ERROR_SAFE_CAP && !unsafeError) {
    console.error(
      `--error ${cliError} exceeds the safe cap ${ERROR_SAFE_CAP} (~${cliError * 100}% of mesh extent). ` +
        `Pass --unsafe-error to override deliberately.`,
    );
    process.exit(1);
  }
  const [inRel, ratioStr, outRel] = positional;
  if (!inRel || !ratioStr || !outRel) {
    console.error(
      'Usage: bun run scripts/decimate-vrm.ts <input.vrm> <ratio 0..1> <output.vrm> [tex1024|--tex1024] [--target-tris N] [--error E] [--unsafe-error] [--weld-islands]',
    );
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

  const targetTris = cliTargetTris ?? 40000;
  const minTris = Math.round(targetTris * 0.95);
  const maxTris = Math.round(targetTris * 1.05);
  const simplifyError = cliError ?? 0.01;

  console.log(
    `\n=== decimate-vrm  ratio=${ratio}  tex1024=${tex1024}  weldIslands=${weldIslands}  band=[${minTris}-${maxTris}]  error=${simplifyError}  ${isProto ? '(PROTOTYPE)' : '(SHIP over original)'} ===`,
  );
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

  // Default path stays byte-for-byte behavior-compatible with the prior script.
  // The opt-in path reconstructs UV-continuous position topology, then maps
  // surviving island vertices back to untouched source attribute tuples.
  const transforms: Array<Parameters<typeof doc.transform>[number]> = [];
  if (weldIslands) {
    simplifyPositionRemap(doc, ratio, simplifyError);
  } else {
    // simplify: per-primitive, keeps skeleton + skin. lockBorder protects
    // silhouette/open edges (wings). error is meshoptimizer's relative bound.
    transforms.push(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio,
        error: simplifyError,
        lockBorder: true,
      }),
    );
  }
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
      textureCompress({
        encoder: sharp,
        targetFormat: 'webp',
        formats: /png|jpe?g/i,
        quality: 92,
      }),
    );
  }
  // re-apply meshopt if source had it (geometry was de-meshopt'd on read)
  if (srcHadMeshopt) {
    transforms.push(
      meshopt({
        encoder: MeshoptEncoder,
        level: 'medium',
        // The UV gate measures the decoded UNORM16 source tuples. Preserve that
        // precision on the opt-in path so the final encoded UVs retain the same
        // one-texel error bound; the default branch remains byte-identical.
        ...(weldIslands ? { quantizeTexcoord: 16 } : {}),
      }),
    );
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

  const asserts = validate(srcFp, outFp, srcBytes, outBytes, {
    tex1024,
    minTris,
    maxTris,
  });
  const allPass = printAssertions(`${path.basename(outFile)} (ratio ${ratio})`, asserts);

  console.log(
    `\nRESULT ratio=${ratio}: ${allPass ? 'PASS' : 'FAIL'}  | ${srcFp.tris}→${outFp.tris} tris | ${formatSize(srcBytes)}→${formatSize(outBytes)} | targetTris=${targetTris}`,
  );
  process.exit(allPass ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
