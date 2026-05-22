#!/usr/bin/env node
/**
 * Measure per-building GLB bounding boxes and derive AABB collider extents.
 *
 * Applies node world transforms (translation, rotation, scale) so the bbox
 * matches what Three.js sees after loading. This is critical for GLBs that
 * have non-identity root-node transforms (e.g. patty-building.glb has a
 * 90° quaternion rotation on the root node, cove-exterior.glb is authored far
 * off-origin with box3Recenter=true in arena-buildings.tsx).
 *
 * For box3Recenter buildings (cove): the tile-zone center IS the correct AABB
 * center because arena-buildings.tsx re-centers the GLB before placing it. We
 * use a centerOffset=0 override for those entries.
 *
 * Usage:
 *   node scripts/inspect-building-bboxes.mjs
 */

import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { MeshoptDecoder } from 'meshoptimizer';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

// ---------------------------------------------------------------------------
// Building manifest — matches BUILDING_MODELS in arena-buildings.tsx
// ---------------------------------------------------------------------------
const MAX_FOOTPRINT = 2000; // wu — matches arena-buildings.tsx MAX_FOOTPRINT
const TIGHTEN = 0.85;       // tighten AABB ~15% from raw bbox edge (exclude overhangs)

const BUILDINGS = [
  { id: 'visual-creation',    glb: 'apps/web/public/models/pineapple-house.glb',              targetMaxDim: 1100, box3Recenter: false },
  { id: 'code-development',   glb: 'apps/web/public/models/chum-bucket-v2.glb',               targetMaxDim: 1400, box3Recenter: false },
  { id: 'mcp-tool-use',       glb: 'apps/web/public/models/krusty-krab-v2.glb',               targetMaxDim: 1400, box3Recenter: false },
  { id: 'messaging-channels', glb: 'apps/web/public/models/sandy-treedome-v3.glb',            targetMaxDim: 2500, box3Recenter: false },
  { id: 'api-integrations',   glb: 'apps/web/public/models/salty-spitoon.glb',                targetMaxDim: 2500, box3Recenter: false },
  { id: 'app-publishing',     glb: 'apps/web/public/models/boating-school.glb',               targetMaxDim: 1000, box3Recenter: false },
  { id: 'cron-automation',    glb: 'apps/web/public/models/patty-building.glb',               targetMaxDim: 2200, box3Recenter: false },
  { id: 'deployment-ops',     glb: 'apps/web/public/models/building-lighthouse.glb',          targetMaxDim: 1400, box3Recenter: false },
  { id: 'claw-arcade',        glb: 'apps/web/public/models/arcade/claw-arcade-exterior.glb',  targetMaxDim: 1100, box3Recenter: false },
  { id: 'cove',               glb: 'apps/web/public/models/cove/cove-exterior.glb',           targetMaxDim: 1300, box3Recenter: true  },
  { id: 'agent-security',     glb: 'apps/web/public/models/patricks-rock-v2.glb',             targetMaxDim: 1100, box3Recenter: false },
  { id: 'memory-rag',         glb: 'apps/web/public/models/squidward-house.glb',              targetMaxDim: 1700, box3Recenter: false },
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
});

// ---------------------------------------------------------------------------
// Mat4 quaternion rotation helper (no three.js — plain math)
// Quaternion (qx, qy, qz, qw) to 3x3 rotation matrix, then apply to [x,y,z]
// ---------------------------------------------------------------------------
function applyQuat(qx, qy, qz, qw, x, y, z) {
  // Hamilton product: q * [0,x,y,z] * q^-1
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

// Apply TRS (translation, rotation-quat, scale) to a point [x,y,z]
function applyTRS(tx, ty, tz, rx, ry, rz, rw, sx, sy, sz, x, y, z) {
  // Scale first
  x *= sx; y *= sy; z *= sz;
  // Then rotate
  [x, y, z] = applyQuat(rx, ry, rz, rw, x, y, z);
  // Then translate
  return [x + tx, y + ty, z + tz];
}

// ---------------------------------------------------------------------------
// Walk all gltf-transform nodes recursively, accumulating world transforms,
// and compute a world-space bbox from all mesh primitive POSITION attributes.
// Returns { minX, minY, minZ, maxX, maxY, maxZ } or null if no geometry.
// ---------------------------------------------------------------------------
function computeWorldBbox(doc) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let primCount = 0;

  // Build mesh → primitives map for fast lookup
  const meshPrims = new Map();
  for (const mesh of doc.getRoot().listMeshes()) {
    meshPrims.set(mesh, mesh.listPrimitives());
  }

  // Recursive node walker with accumulated TRS
  function walkNode(node, parentTX, parentTY, parentTZ, parentRX, parentRY, parentRZ, parentRW, parentSX, parentSY, parentSZ) {
    const [tx, ty, tz] = node.getTranslation();
    const [rx, ry, rz, rw] = node.getRotation();
    const [sx, sy, sz] = node.getScale();

    // Compose: world = parent * local
    // Scale: parent_S * child_S  (component-wise)
    const wsx = parentSX * sx;
    const wsy = parentSY * sy;
    const wsz = parentSZ * sz;

    // Translate child origin via parent TRS: wt = applyTRS(parent, child_translation)
    const [wtx, wty, wtz] = applyTRS(parentTX, parentTY, parentTZ, parentRX, parentRY, parentRZ, parentRW, parentSX, parentSY, parentSZ, tx, ty, tz);

    // Rotation: parent_R * child_R (quaternion multiply)
    // q_result = parent_R × child_R
    const wrx = parentRW * rx + parentRX * rw + parentRY * rz - parentRZ * ry;
    const wry = parentRW * ry - parentRX * rz + parentRY * rw + parentRZ * rx;
    const wrz = parentRW * rz + parentRX * ry - parentRY * rx + parentRZ * rw;
    const wrw = parentRW * rw - parentRX * rx - parentRY * ry - parentRZ * rz;

    // If this node has a mesh, sample its vertices in world space
    const mesh = node.getMesh();
    if (mesh) {
      const prims = meshPrims.get(mesh) ?? [];
      for (const prim of prims) {
        const posAttr = prim.getAttribute('POSITION');
        if (!posAttr) continue;
        const arr = posAttr.getArray();
        primCount++;
        for (let i = 0; i < arr.length; i += 3) {
          const [wx, wy, wz] = applyTRS(wtx, wty, wtz, wrx, wry, wrz, wrw, wsx, wsy, wsz, arr[i], arr[i + 1], arr[i + 2]);
          if (wx < minX) minX = wx;
          if (wy < minY) minY = wy;
          if (wz < minZ) minZ = wz;
          if (wx > maxX) maxX = wx;
          if (wy > maxY) maxY = wy;
          if (wz > maxZ) maxZ = wz;
        }
      }
    }

    for (const child of node.listChildren()) {
      walkNode(child, wtx, wty, wtz, wrx, wry, wrz, wrw, wsx, wsy, wsz);
    }
  }

  // Walk from scene root(s)
  for (const scene of doc.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      walkNode(node, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1); // identity TRS
    }
  }

  if (primCount === 0) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ, primCount };
}

// ---------------------------------------------------------------------------
// Compute scale from bbox + targetMaxDim, applying MAX_FOOTPRINT cap.
// Mirrors computeBuildingScale() in arena-buildings.tsx.
// ---------------------------------------------------------------------------
function computeScale(bbox, targetMaxDim) {
  const sX = bbox.maxX - bbox.minX;
  const sY = bbox.maxY - bbox.minY;
  const sZ = bbox.maxZ - bbox.minZ;
  const maxDim = Math.max(sX, sY, sZ);
  if (maxDim === 0) return 0;

  let scale = targetMaxDim / maxDim;

  // Apply MAX_FOOTPRINT cap
  const worldX = sX * scale;
  const worldZ = sZ * scale;
  const maxFootprint = Math.max(worldX, worldZ);
  if (maxFootprint > MAX_FOOTPRINT) {
    scale *= MAX_FOOTPRINT / maxFootprint;
  }

  return scale;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('\n=== ClawVille Building AABB Measurement (world-transform-aware) ===');
console.log('All bbox values apply node TRS transforms before measuring.\n');

console.log(
  'ID'.padEnd(22),
  'worldX'.padStart(8),
  'worldY'.padStart(8),
  'worldZ'.padStart(8),
  'offX'.padStart(8),
  'offZ'.padStart(8),
  'halfX'.padStart(8),
  'halfZ'.padStart(8),
  'notes',
);
console.log('-'.repeat(110));

const results = [];

for (const building of BUILDINGS) {
  const { id, glb, targetMaxDim, box3Recenter } = building;

  if (!fs.existsSync(glb)) {
    console.log(`${id.padEnd(22)} MISSING: ${glb}`);
    continue;
  }

  let doc;
  try {
    doc = await io.read(glb);
  } catch (err) {
    console.log(`${id.padEnd(22)} READ ERROR: ${err.message}`);
    continue;
  }

  const bbox = computeWorldBbox(doc);
  if (!bbox) {
    console.log(`${id.padEnd(22)} NO GEOMETRY`);
    continue;
  }

  const sX = bbox.maxX - bbox.minX;
  const sY = bbox.maxY - bbox.minY;
  const sZ = bbox.maxZ - bbox.minZ;
  const scale = computeScale(bbox, targetMaxDim);

  const worldX = sX * scale;
  const worldY = sY * scale;
  const worldZ = sZ * scale;

  // For box3Recenter buildings: arena-buildings.tsx recenters after loading,
  // so the tile-zone center IS the AABB center — centerOffset is always 0.
  let centerOffX = 0, centerOffZ = 0;
  if (!box3Recenter) {
    centerOffX = ((bbox.minX + bbox.maxX) / 2) * scale;
    centerOffZ = ((bbox.minZ + bbox.maxZ) / 2) * scale;
  }

  const halfX = (worldX / 2) * TIGHTEN;
  const halfZ = (worldZ / 2) * TIGHTEN;

  const maxFootprint = Math.max(worldX, worldZ);
  const footprintCapped = maxFootprint >= MAX_FOOTPRINT - 10;
  const notes = [
    footprintCapped ? 'FOOTPRINT_CAP' : '',
    box3Recenter ? 'BOX3RECENTER(offset=0)' : '',
    `prims=${bbox.primCount}`,
  ].filter(Boolean).join(' ');

  results.push({ id, worldX, worldY, worldZ, centerOffX, centerOffZ, halfX, halfZ, scale, notes, box3Recenter });

  console.log(
    id.padEnd(22),
    worldX.toFixed(0).padStart(8),
    worldY.toFixed(0).padStart(8),
    worldZ.toFixed(0).padStart(8),
    centerOffX.toFixed(0).padStart(8),
    centerOffZ.toFixed(0).padStart(8),
    halfX.toFixed(0).padStart(8),
    halfZ.toFixed(0).padStart(8),
    notes,
  );
}

// ---------------------------------------------------------------------------
// Print TypeScript collider entries
// ---------------------------------------------------------------------------
console.log('\n\n=== Recommended per-building entries for world-colliders.ts ===');
console.log('// Replace the uniform buildingZones loop with per-building entries.');
console.log('// For buildings with centerOffset: add offset to tile-zone-derived worldX/Z.');
console.log('// The tile-zone world center is: centerTileX * TILE_SIZE - HALF_W / centerTileY * TILE_SIZE - HALF_H\n');

for (const r of results) {
  const hasOffset = !r.box3Recenter && (Math.abs(r.centerOffX) >= 20 || Math.abs(r.centerOffZ) >= 20);
  const centerNote = hasOffset
    ? `  // GLB centerOffset (${r.centerOffX.toFixed(0)}, ${r.centerOffZ.toFixed(0)}) wu — add to tileZone world XZ`
    : '';
  console.log(
    `  // ${r.id}: worldSize ${r.worldX.toFixed(0)}×${r.worldZ.toFixed(0)} wu`,
  );
  if (centerNote) console.log(centerNote);
  console.log(
    `  { id: '${r.id}', centerX: zone.centerX${hasOffset && r.centerOffX >= 20 ? ` + ${Math.round(r.centerOffX)}` : hasOffset && r.centerOffX <= -20 ? ` - ${Math.round(-r.centerOffX)}` : ''}, centerZ: zone.centerZ${hasOffset && r.centerOffZ >= 20 ? ` + ${Math.round(r.centerOffZ)}` : hasOffset && r.centerOffZ <= -20 ? ` - ${Math.round(-r.centerOffZ)}` : ''}, halfX: ${Math.round(r.halfX)}, halfZ: ${Math.round(r.halfZ)}, kind: 'building' },`,
  );
}

console.log('\n=== Done ===');
