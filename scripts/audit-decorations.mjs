#!/usr/bin/env node
/**
 * Replicate generateDecorations() to see where the N props actually land
 * and how far they end up from the camera/center. KEEP IN SYNC with the
 * constants in apps/web/src/lib/three/arena-terrain.tsx — otherwise this
 * script lies and the next agent trusts stale audit output.
 */

// Match constants from arena-terrain.tsx + tilemap-data.ts
const MAP_WIDTH = 5120;
const MAP_HEIGHT = 5120;
const EXTENT_X = MAP_WIDTH * 1.4; // 7168 — 2026-05-13 narrowed from 2.4 then 1.76
const EXTENT_Z = MAP_HEIGHT * 1.4;
const TARGET_COUNT = 60; // 2026-05-13 bumped 30 → 60 after exclusion radius cut
const N_CLUSTERS = 24;
const CLUSTER_RADIUS = 280;
const MIN_SPACING_SQ = 35 * 35;
const DECO_INNER_EXCLUSION_R = 1500; // 2026-05-13 cut 2700 → 1500
const MAX_VISIBLE_DIST = 3800; // 2026-05-13 cut 4500 → 3800
const TILE_SIZE = 32;

// Building zone exclusions — match buildingZones positions in tilemap-data
// 10 buildings on ring at radius ~2176 from center
const BUILDING_ZONES = [];
const ringR = 2176;
for (let i = 0; i < 10; i++) {
  const angle = -Math.PI / 2 + i * (Math.PI / 5);
  BUILDING_ZONES.push({
    cx: Math.cos(angle) * ringR,
    cz: Math.sin(angle) * ringR,
    radius: 10 * TILE_SIZE * 2.0, // 640 wu
  });
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function isNearBuilding(x, z) {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

const DECO_TYPES = [
  { name: 'coral-reef1', weight: 3, minScale: 4, maxScale: 15 },
  { name: 'coral-reef2', weight: 3, minScale: 3, maxScale: 13 },
  { name: 'coral-reef3', weight: 3, minScale: 3, maxScale: 12 },
  { name: 'kelp', weight: 3, minScale: 6, maxScale: 15 },
  { name: 'shell', weight: 5, minScale: 2, maxScale: 12 },
  { name: 'seashell', weight: 5, minScale: 2, maxScale: 12 },
  { name: 'anchor', weight: 4, minScale: 3, maxScale: 14 },
  { name: 'barrel', weight: 4, minScale: 3, maxScale: 10 },
  { name: 'chest', weight: 4, minScale: 3, maxScale: 12 },
  { name: 'lantern', weight: 3, minScale: 4, maxScale: 12 },
  { name: 'crayfish', weight: 3, minScale: 3, maxScale: 10 },
  { name: 'tower2', weight: 2, minScale: 4, maxScale: 14 },
];
const totalWeight = DECO_TYPES.reduce((s, d) => s + d.weight, 0);

const rng = seededRandom(12345);
const entries = [];

// Cluster centres
const clusters = [];
for (let i = 0; i < N_CLUSTERS; i++) {
  clusters.push({ x: (rng() - 0.5) * EXTENT_X, z: (rng() - 0.5) * EXTENT_Z });
}

function pickModel() {
  let r = rng() * totalWeight;
  for (const dt of DECO_TYPES) {
    r -= dt.weight;
    if (r <= 0) return dt;
  }
  return DECO_TYPES[0];
}

// Track rejection reasons
let rejOffMap = 0;
let rejInnerEx = 0;
let rejFarFog = 0;
let rejBuilding = 0;
let rejSpacing = 0;
let attempts = 0;

while (entries.length < TARGET_COUNT && attempts < 1200) {
  attempts++;
  const cluster = clusters[Math.floor(rng() * N_CLUSTERS)];
  const dist = (rng() + rng()) * CLUSTER_RADIUS;
  const angle = rng() * Math.PI * 2;
  const x = cluster.x + Math.cos(angle) * dist;
  const z = cluster.z + Math.sin(angle) * dist;
  if (Math.abs(x) > EXTENT_X * 0.5 || Math.abs(z) > EXTENT_Z * 0.5) { rejOffMap++; continue; }
  const dcx = x, dcz = z;
  const radSq = dcx * dcx + dcz * dcz;
  if (radSq < DECO_INNER_EXCLUSION_R * DECO_INNER_EXCLUSION_R) { rejInnerEx++; continue; }
  if (radSq > MAX_VISIBLE_DIST * MAX_VISIBLE_DIST) { rejFarFog++; continue; }
  if (isNearBuilding(x, z)) { rejBuilding++; continue; }
  const tooClose = entries.some(e => {
    const dx = e.x - x, dz = e.z - z;
    return dx * dx + dz * dz < MIN_SPACING_SQ;
  });
  if (tooClose) { rejSpacing++; continue; }
  const dt = pickModel();
  const scale = dt.minScale + rng() * (dt.maxScale - dt.minScale);
  entries.push({ model: dt.name, x, z, scale, dist: Math.sqrt(x*x + z*z) });
}

// Distance bins from origin (post 2026-05-13 scatter retune)
const bins = { '<1500(excluded)': 0, '1500-2500': 0, '2500-3500': 0, '3500-3800': 0, '>3800(rej)': 0 };
for (const e of entries) {
  if (e.dist < 1500) bins['<1500(excluded)']++;
  else if (e.dist < 2500) bins['1500-2500']++;
  else if (e.dist < 3500) bins['2500-3500']++;
  else if (e.dist < 3800) bins['3500-3800']++;
  else bins['>3800(rej)']++;
}

const byModel = {};
for (const e of entries) byModel[e.model] = (byModel[e.model] || 0) + 1;

console.log(`=== Decoration scatter audit ===`);
console.log(`Target: ${TARGET_COUNT}   Placed: ${entries.length}   Attempts: ${attempts}`);
console.log(`\nRejected (per attempt):`);
console.log(`  off-map (|xy| > ${(EXTENT_X*0.5).toFixed(0)}):  ${rejOffMap}`);
console.log(`  inner-exclusion (<${DECO_INNER_EXCLUSION_R}wu of center):  ${rejInnerEx}`);
console.log(`  far-fog (>${MAX_VISIBLE_DIST}wu of center):  ${rejFarFog}`);
console.log(`  near-building:  ${rejBuilding}`);
console.log(`  too-close-to-other-deco:  ${rejSpacing}`);
console.log(`\nDistance from origin (camera/town center):`);
for (const [k, v] of Object.entries(bins)) console.log(`  ${k.padEnd(18)} : ${v} props`);
console.log(`\nBy model:`);
for (const [k, v] of Object.entries(byModel).sort((a,b) => b[1]-a[1])) console.log(`  ${k.padEnd(14)} : ${v}`);

console.log(`\nClosest 8 props (you'd see these first):`);
[...entries].sort((a,b) => a.dist - b.dist).slice(0,8).forEach(e => {
  console.log(`  ${e.model.padEnd(14)} at (${e.x.toFixed(0).padStart(6)}, ${e.z.toFixed(0).padStart(6)})  dist=${e.dist.toFixed(0)}  scale=${e.scale.toFixed(1)}`);
});

console.log(`\nFog cutoff is 6400wu. Props beyond ~5500wu are fully fogged out.`);
const visible = entries.filter(e => e.dist < 5500).length;
const heavyFog = entries.filter(e => e.dist >= 5500).length;
console.log(`  Visible-ish props (<5500wu):  ${visible}`);
console.log(`  Heavily fogged props:         ${heavyFog}`);
