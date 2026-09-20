#!/usr/bin/env node
// build-interior.mjs — assemble the Trading Floor interior hall GLB (v2).
//
// The hall SHELL is authored here rather than generated: Meshy reliably returns
// a solid exterior blob when asked for a room, and the shell is the one piece
// whose exact numbers matter (door opening lined up with the exterior arch,
// ceiling height calibrated against the 270 wu avatar, wall thickness, and a
// floor plane at exactly y=0 so the walk-in code has a known datum). Authoring
// it costs ~700 triangles.
//
// v2 (2026-09-19, founder verdict "there are no walls really"). MEASURED root
// cause, not the guessed one: every shell surface rendered the SAME byte value.
// Sampling the local browser pass gave ceiling, back wall and both side walls
// at #3d627f exactly, and the floor at #375c7a — a 2.5% luminance difference
// across the whole room. Two reasons, both fixed here:
//   1. The shell materials were FACTOR-ONLY, so each box face is one flat
//      colour with no seam, no bevel and no rivet for the eye to land on.
//   2. The light rig was ambient-dominated, and ambient light is
//      direction-independent, so the floor normal, the wall normal and the
//      ceiling normal all received the same irradiance. The point light was
//      measurably irrelevant: decay 1 at r=1100 with cutoff 3400 gives a
//      falloff of 0.00089, i.e. 0.6% of one unit of intensity.
// The fog was NOT the cause. Fog colour is #05101d; the walls rendered #3d627f
// and were byte-identical at two different depths.
//
// So v2 gives the walls and the ceiling TILING baseColor textures with visible
// seams, adds pilasters and a screen surround for silhouette, splits the
// ceiling onto its own material, and ships an authored CHAIR module the scene
// instances once per desk. The light-rig half of the fix lives in
// `trading-floor-interior.tsx`.
//
// The three HERO PROPS are Meshy text-to-3d refines, slimmed on the v1 run.
// They are copied through from a PROPS SOURCE GLB rather than re-slimmed:
// re-running Meshy costs credits we do not have, and the v1 props are already
// decimated, base-centred and at final scale. Default source is the durable
// copy at ../.clawville-assets/trading-floor/interior-props-src.glb (kept out
// of the repo, like every raw Meshy output). Pass --props <glb> to override.
//
// EVERYTHING IS AUTHORED IN WORLD UNITS (1 unit = 1 wu at final scale), so the
// consumer must NOT auto-fit this GLB by max dimension the way cove-interior
// does. Avatar reference height is 270 wu (VRM_AVATAR_TARGET_HEIGHT_WU).
//
// Usage: node scripts/trading-floor/build-interior.mjs <out.glb> [--props <glb>]

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const output = argv[0];
if (!output) throw new Error('usage: build-interior.mjs <out.glb> [--props <glb>]');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_PROPS = resolve(
  REPO_ROOT,
  '..',
  '.clawville-assets',
  'trading-floor',
  'interior-props-src.glb',
);
const propsFlag = argv.indexOf('--props');
const PROPS_GLB =
  propsFlag >= 0 ? argv[propsFlag + 1] : process.env.TRADING_FLOOR_PROPS_GLB || DEFAULT_PROPS;
if (!existsSync(PROPS_GLB)) {
  throw new Error(
    `prop source GLB not found: ${PROPS_GLB}\n` +
      'Pass --props <glb>, or set TRADING_FLOOR_PROPS_GLB. The source is the v1 ' +
      'stage-1 build (uncompressed PNG textures); it is kept outside the repo.',
  );
}

// ---- hall dimensions (world units) -----------------------------------------
const RW = 2600;   // interior width  (X)
const RD = 2200;   // interior depth  (Z)
const RH = 950;    // interior height (Y) ~= 3.5 avatar heights
const WT = 60;     // wall thickness
const DOOR_W = 360;
const DOOR_H = 500;
const hx = RW / 2, hz = RD / 2;

// ---- texture tiling ---------------------------------------------------------
// One texture repeat every WALL_TILE_WU world units, and the texture carries a
// 2x2 panel grid, so one visible panel is 237.5 wu — about 88% of the 270 wu
// avatar's height, which is the size a wall panel has to be before the eye
// reads it as architecture instead of noise. 950 / 475 is exactly 2, so the
// wall is four whole panel rows with no cut at the cornice.
const WALL_TILE_WU = 475;
const CEIL_TILE_WU = 550;
// The floor carries a 2x2 grid too, so one panel is 190 wu — about 1.2 m, the
// size a raised access-floor tile reads at in a real dealing room. 95 wu (a
// true 600 mm panel) was tried first and shimmers: 27 panel rows across a 2600
// wu hall is noise from the chase camera, not architecture.
const FLOOR_TILE_WU = 380;
const WALL_TEX_PX = 512;
const CEIL_TEX_PX = 256;
const FLOOR_TEX_PX = 512;

// ---- prop placement (world units) ------------------------------------------
// The monitor kiosk moved off the room's centre line for v2: the big screen now
// occupies the middle of the -Z wall, and a 470 wu kiosk parked dead centre in
// front of it hid the screen's lower band from the chase camera. At x -300 it
// still reads as the podium in front of the board while covering only ~12% of
// the screen width.
//
// It also has to clear the seat interact bands, so that E is never ambiguous
// between "sit" and "manage trades". THE INVARIANT, not the arithmetic: the
// kiosk must sit further from EVERY seat than the sum of the two interact
// radii (`TRADING_FLOOR_MONITOR.interactRadius` + `SEAT_INTERACT_RADIUS`).
// Seats are not free parameters either — each one is `SEAT_OFFSET` inboard of
// its desk, so moving `CONSOLE_WALL_X`, `CONSOLE_ROW_Z`, `SEAT_OFFSET` or this
// kiosk all move the margin.
//
// Deliberately NO hand-typed distance here. The previous version of this
// comment quoted a seat position and a separation, both of which silently went
// stale when the desks moved to the side walls, while claiming in its own last
// sentence that a test stopped it going stale. The test DOES stop the geometry
// breaking; it never stopped the prose lying. `trading-floor-monitor.test.ts`
// is the source of truth for the margin — read it, do not restate it.
const DAIS_POS = [0, 0, -60];
// The kiosk was 470 wu tall against a 270 wu avatar — 1.74x human height, about
// 2.95 m. That oversize, not its position, was the root cause of the board
// occlusion: no position exists that both clears the board's x-span from the
// spawn and stays outside the seat bands, because the seat rule wants
// |x| < 639 and the sightline wants |x| > 751. Cutting it to avatar height is
// the lever that fixed it, and it let the board stay 1700 wide.
const MONITOR_SCALE = 300 / 470;   // 0.638297...
const MONITOR_POS = [-300, 0, -980];
// Desk row, mirrored in TRADING_FLOOR_CONSOLE_ROW. The authored console faces
// +Z, so a desk against the -X wall is yawed +pi/2 to face the aisle.
const CONSOLE_WALL_X = 1120;
const CONSOLE_ROW_Z = [-500, 0, 500];

// ---- the big screen ---------------------------------------------------------
// Drawn by the scene (a CanvasTexture plane), not by this script. The shell
// only contributes the surround, which is what makes it read as MOUNTED rather
// than as a poster floating in front of the wall.
// THESE MUST AGREE WITH `TRADING_FLOOR_SCREEN` IN `trading-floor-room.ts`.
// The scene draws the plane from those constants and this script recesses the
// bezel around it, so a mismatch leaves bare wall inside the frame. That is not
// hypothetical: one export shipped a 250..900 surround around a 340..880 plane.
//
// The rect is set by the KIOSK'S SHADOW, not by taste. With the kiosk cut to
// 300 wu and moved to z -980, the worst shadow on the board plane is ~339 (the
// dais ring's far side at full pitch-down), so a bottom at 360 clears it by 21.
// Ceiling limit: the top surround box centres at `bottom + height + 34` with
// half-height 34, so its top edge is `bottom + height + 68` = 948 against a 950
// inner face. DO NOT raise SCREEN_H past 522 without moving the ceiling.
const SCREEN_W = 1700;
const SCREEN_H = 520;
const SCREEN_BOTTOM_Y = 360;
const SCREEN_Z = -hz + 6;

// The ceiling limit above is 2 wu from being violated, so it is a check, not a
// comment. A surround that punches through the ceiling would be invisible from
// inside the room and would only show up as a hole from outside.
{
  const surroundTop = SCREEN_BOTTOM_Y + SCREEN_H + 68;
  if (surroundTop > RH) {
    throw new Error(
      `screen surround top ${surroundTop} exceeds the ${RH} wu ceiling; ` +
        `max SCREEN_H at bottom ${SCREEN_BOTTOM_Y} is ${RH - SCREEN_BOTTOM_Y - 68}`
    );
  }
  console.log(`  surround top ${surroundTop} vs ceiling ${RH} -> clear by ${RH - surroundTop}`);
}

// Surround insets, as named constants because a clearance assertion below reads
// them. The glow must stay proud of the frame, so these two move TOGETHER.
const FRAME_INSET = 12, FRAME_DEPTH = 44;
const GLOW_INSET = 36, GLOW_DEPTH = 8;

// ---- clearance gate ---------------------------------------------------------
// Mirrors TRADING_FLOOR_PLAYER_RADIUS / TRADING_FLOOR_ROOM in
// `trading-floor-room.ts`. The player's CENTRE clamps this far in.
const PLAYER_RADIUS = 46;
const CLAMP_X = hx - PLAYER_RADIUS;   // 1254
const CLAMP_Z = hz - PLAYER_RADIUS;   // 1054

// Avatar reference height (VRM_AVATAR_TARGET_HEIGHT_WU). Geometry entirely
// above this cannot be walked into, which is what lets the ceiling grid span
// the hall freely.
const AVATAR_H = 270;

// EVERY box this script emits registers itself here. The gate walks the
// REGISTRY, not a hand-written list, so it cannot fall behind the geometry —
// a new strip is checked the moment it is authored, with nobody remembering to
// list it. The first version of this gate WAS a hand list of four items and
// was already missing three trim strips on the day it was written.
const boxRegistry = [];
let currentGroup = { name: 'ungrouped', exempt: null };

/** Tag every box emitted inside `fn`. `exempt` is a REASON string, not a bool:
 *  an exemption you cannot justify in words is one you should not take. */
function group(name, exempt, fn) {
  const prev = currentGroup;
  currentGroup = { name, exempt };
  try {
    return fn();
  } finally {
    currentGroup = prev;
  }
}

/** Fail the build if any non-exempt box reaches the volume the player's CENTRE
 *  can occupy. Not "inner face past a clamp" per axis — a real AABB overlap,
 *  so a box is judged on where it actually is rather than on which axis
 *  somebody thought was interesting.
 *
 *  WHY: v2 shipped a screen-surround glow whose inner face sat 4 wu past
 *  CLAMP_Z, drawing a lit bar through the chest of anyone standing under the
 *  board to read it. A reviewer caught it by hand. The build catches it now.
 *
 *  Exemptions are per-box or per-group and each carries its reason. Colliders
 *  (corner pillars, desks) legitimately occupy reachable floor; the chair is a
 *  template the scene extracts and re-instances, so its authored copy at the
 *  origin never renders there. */
function assertWallDetailClears() {
  const fails = [];
  const cleared = [];
  for (const b of boxRegistry) {
    if (b.exempt) continue;
    const ox = Math.min(b.max[0], CLAMP_X) - Math.max(b.min[0], -CLAMP_X);
    const oy = Math.min(b.max[1], AVATAR_H) - Math.max(b.min[1], 0);
    const oz = Math.min(b.max[2], CLAMP_Z) - Math.max(b.min[2], -CLAMP_Z);
    if (ox > 0 && oy > 0 && oz > 0) {
      // Intrusion depth = the cheapest axis to retreat along.
      fails.push(`${b.group} box [${b.min.map(Math.round)}]..[${b.max.map(Math.round)}] intrudes ${Math.round(Math.min(ox, oz))} wu`);
    } else {
      // Report the axis the box escapes along. A floor slab clearing by 0 on Y
      // is the intended relationship (its top face IS the player's feet plane);
      // a wall detail clearing by a small margin on X or Z is the number a
      // future edit will break. Showing the axis keeps the two from reading
      // like the same kind of result.
      const byAxis = [
        [-ox, 'X'],
        [-oy, 'Y'],
        [-oz, 'Z'],
      ].filter(([m]) => m >= 0);
      const [margin, axis] = byAxis.sort((a, b) => a[0] - b[0])[0];
      cleared.push({ group: b.group, margin: Math.round(margin), axis });
    }
  }
  const exempt = boxRegistry.filter((b) => b.exempt).length;
  console.log(
    `  clearance gate: ${cleared.length} boxes clear, ${exempt} exempt, ${fails.length} intruding`
  );
  // TF_CLEARANCE_VERBOSE=1 dumps every registered box. An auditor should be
  // able to confirm coverage from the build's own output rather than take a
  // summary on trust, and "is my box actually in there?" is the question this
  // gate exists to answer.
  if (process.env.TF_CLEARANCE_VERBOSE) {
    for (const b of boxRegistry) {
      console.log(
        `    [${b.exempt ? 'EXEMPT' : ' check'}] ${b.group.padEnd(14)} ` +
          `[${b.min.map(Math.round).join(',')}]..[${b.max.map(Math.round).join(',')}]` +
          `${b.exempt ? `  (${b.exempt})` : ''}`
      );
    }
  }
  // Tightest per GROUP, so one group cannot crowd the others out of the report.
  const perGroup = new Map();
  for (const c of cleared) {
    const prev = perGroup.get(c.group);
    if (!prev || c.margin < prev.margin) perGroup.set(c.group, c);
  }
  for (const c of [...perGroup.values()].sort((a, b) => a.margin - b.margin)) {
    console.log(`    tightest ${c.group.padEnd(12)} clear by ${String(c.margin).padStart(4)} wu on ${c.axis}`);
  }
  if (fails.length) {
    throw new Error(`geometry intrudes into player space:\n  ${fails.join('\n  ')}`);
  }
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('TradingFloorInterior');
doc.getRoot().setDefaultScene(scene);
const unlitExt = doc.createExtension(KHRMaterialsUnlit);

// ---------------------------------------------------------------- helpers ---
function mat(name, rgb, { unlit = false, rough = 0.9, metal = 0 } = {}) {
  const m = doc
    .createMaterial(name)
    .setBaseColorFactor([...rgb, 1])
    .setMetallicFactor(metal)
    .setRoughnessFactor(rough);
  if (unlit) m.setExtension('KHR_materials_unlit', unlitExt.createUnlit());
  return m;
}

/** Tiling baseColor material. REPEAT wrap is set explicitly rather than left to
 *  the glTF default, because every UV in this file is > 1 by design. */
function texturedMat(name, png, { rough = 0.92, metal = 0 } = {}) {
  const tex = doc.createTexture(name + 'Tex').setImage(png).setMimeType('image/png');
  const m = doc
    .createMaterial(name)
    .setBaseColorTexture(tex)
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(metal)
    .setRoughnessFactor(rough);
  m.getBaseColorTextureInfo().setWrapS(10497).setWrapT(10497);
  return m;
}

/** Axis-aligned box given centre + size. Flat-shaded, 12 tris.
 *  `tile` (world units per texture repeat) turns on planar per-face UVs derived
 *  from WORLD coordinates, so two adjacent boxes tile continuously instead of
 *  each restarting the pattern at its own corner.
 *
 *  Every call REGISTERS itself for the clearance gate, inheriting the enclosing
 *  `group()`'s exemption unless `opts.exempt` overrides it with its own reason.
 *  Registration lives here, in the one funnel all box geometry passes through,
 *  so the gate can never fall behind what the script actually emits. */
function boxGeo(cx, cy, cz, sx, sy, sz, tile = 0, opts = {}) {
  const hxx = sx / 2, hyy = sy / 2, hzz = sz / 2;
  boxRegistry.push({
    group: opts.label ?? currentGroup.name,
    exempt: opts.exempt !== undefined ? opts.exempt : currentGroup.exempt,
    min: [cx - hxx, cy - hyy, cz - hzz],
    max: [cx + hxx, cy + hyy, cz + hzz],
  });
  const c = [
    [-hxx, -hyy, -hzz], [hxx, -hyy, -hzz], [hxx, hyy, -hzz], [-hxx, hyy, -hzz],
    [-hxx, -hyy, hzz], [hxx, -hyy, hzz], [hxx, hyy, hzz], [-hxx, hyy, hzz],
  ];
  const faces = [
    [[4, 5, 6, 7], [0, 0, 1]], [[1, 0, 3, 2], [0, 0, -1]],
    [[0, 4, 7, 3], [-1, 0, 0]], [[5, 1, 2, 6], [1, 0, 0]],
    [[3, 7, 6, 2], [0, 1, 0]], [[0, 1, 5, 4], [0, -1, 0]],
  ];
  const pos = [], nrm = [], idx = [], uv = tile > 0 ? [] : null;
  for (const [quad, n] of faces) {
    const base = pos.length / 3;
    for (const vi of quad) {
      const wx = c[vi][0] + cx, wy = c[vi][1] + cy, wz = c[vi][2] + cz;
      pos.push(wx, wy, wz);
      nrm.push(...n);
      if (uv) {
        // Pick the two axes that lie IN the face. glTF's V axis points down, so
        // vertical surfaces negate world Y to keep the panel upright.
        if (n[1] !== 0) uv.push(wx / tile, wz / tile);
        else if (n[0] !== 0) uv.push(wz / tile, -wy / tile);
        else uv.push(wx / tile, -wy / tile);
      }
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, idx, uv };
}

/** Flat annulus on the XZ plane — the glowing floor ring around the dais. */
function ringGeo(cx, cy, cz, rInner, rOuter, seg = 48) {
  // Registers like a box, so the clearance gate covers EVERY primitive this
  // script emits rather than only the box helper. A flat ring is the same
  // structural case as the floor slab: zero Y thickness means the overlap test
  // yields oy = 0 and it clears, but it is now checked rather than invisible.
  // Any future non-box helper must register here too or the gate's claim goes
  // back to being a subset claim.
  boxRegistry.push({
    group: currentGroup.name,
    exempt: currentGroup.exempt,
    min: [cx - rOuter, cy, cz - rOuter],
    max: [cx + rOuter, cy, cz + rOuter],
  });
  const pos = [], nrm = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const s = Math.sin(a), co = Math.cos(a);
    pos.push(cx + co * rInner, cy, cz + s * rInner, cx + co * rOuter, cy, cz + s * rOuter);
    nrm.push(0, 1, 0, 0, 1, 0);
  }
  // Winding matters here. With vertices laid out as (inner_i, outer_i) and the
  // angle advancing via (cos a, sin a) in XZ, the naive order (b, b+1, b+3)
  // gives (B-A)x(C-A) = -Y: the ring faces DOWN through the floor. Blender
  // renders it anyway (no backface culling by default) but three.js FrontSide
  // would drop it silently. Reversed so the normal agrees with the +Y declared
  // in `nrm`.
  for (let i = 0; i < seg; i++) {
    const b = i * 2;
    idx.push(b, b + 3, b + 1, b, b + 2, b + 3);
  }
  return { pos, nrm, idx, uv: null };
}

function mergeGeos(geos) {
  const wantUV = geos.some((g) => g.uv);
  const pos = [], nrm = [], idx = [], uv = wantUV ? [] : null;
  for (const g of geos) {
    const off = pos.length / 3;
    pos.push(...g.pos); nrm.push(...g.nrm);
    if (uv) {
      if (g.uv) uv.push(...g.uv);
      else for (let i = 0; i < g.pos.length / 3; i++) uv.push(0, 0);
    }
    for (const i of g.idx) idx.push(i + off);
  }
  return { pos, nrm, idx, uv };
}

function addMesh(name, geo, material, translation = [0, 0, 0]) {
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(geo.pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(geo.nrm)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(geo.idx)).setBuffer(buffer))
    .setMaterial(material);
  if (geo.uv) {
    prim.setAttribute(
      'TEXCOORD_0',
      doc.createAccessor().setType('VEC2').setArray(new Float32Array(geo.uv)).setBuffer(buffer),
    );
  }
  const m = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(m).setTranslation(translation);
  scene.addChild(node);
  return node;
}

// ------------------------------------------------------- 0. shell textures --
// Authored as SVG and rasterised through sharp: zero Meshy credits, and the
// seams are exact rather than sampled out of a photo. Feature sizes are kept at
// 4 px or more because ETC1S is a 4x4 block format and a 2 px bevel dissolves.
//
// The texel values look far too warm and too light on their own. They are not:
// the room's rig is a cool blue fill, and the MEASURED per-channel multiplier
// from base colour to rendered pixel on the v1 build was [0.30, 0.52, 0.74].
// A neutral grey texel therefore renders as the same blue the founder saw. The
// warmth is what survives the rig.
async function wallPanelPng() {
  const S = WALL_TEX_PX, CELL = S / 2, INSET = 7, P = CELL - INSET * 2;
  const panels = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const x = gx * CELL + INSET, y = gy * CELL + INSET;
      panels.push(`
    <rect x="${x}" y="${y}" width="${P}" height="${P}" fill="url(#face)"/>
    <rect x="${x}" y="${y}" width="${P}" height="5" fill="#a89b86" opacity="0.42"/>
    <rect x="${x}" y="${y}" width="5" height="${P}" fill="#93897b" opacity="0.28"/>
    <rect x="${x}" y="${y + P - 6}" width="${P}" height="6" fill="#0e0d0b" opacity="0.72"/>
    <rect x="${x + P - 5}" y="${y}" width="5" height="${P}" fill="#12110e" opacity="0.5"/>
    <circle cx="${x + 16}" cy="${y + 16}" r="4.5" fill="#b3a892" opacity="0.42"/>
    <circle cx="${x + P - 16}" cy="${y + 16}" r="4.5" fill="#b3a892" opacity="0.42"/>
    <circle cx="${x + 16}" cy="${y + P - 18}" r="4.5" fill="#9e9484" opacity="0.34"/>
    <circle cx="${x + P - 16}" cy="${y + P - 18}" r="4.5" fill="#9e9484" opacity="0.34"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <defs>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7c7468"/>
      <stop offset="0.55" stop-color="#6b6358"/>
      <stop offset="1" stop-color="#524b43"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="#1b1815"/>
  ${panels.join('\n')}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function ceilingPanelPng() {
  const S = CEIL_TEX_PX, CELL = S / 2, RIB = 16;
  const cells = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const x = gx * CELL + RIB, y = gy * CELL + RIB, W = CELL - RIB * 2;
      cells.push(`
    <rect x="${x}" y="${y}" width="${W}" height="${W}" fill="#2d3a45"/>
    <rect x="${x}" y="${y}" width="${W}" height="5" fill="#141c23" opacity="0.85"/>
    <rect x="${x + 10}" y="${y + 10}" width="${W - 20}" height="${W - 20}" fill="#3a4854"/>`);
    }
  }
  // Brighter than it looks right, on purpose. The ceiling's normal is -Y, so
  // it takes NO directional key and only the hemisphere's GROUND term; a
  // ceiling authored at wall brightness renders as a black void overhead.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <rect width="${S}" height="${S}" fill="#5e6e7c"/>
  <rect width="${S}" height="6" fill="#8399ab"/>
  <rect y="${CELL}" width="${S}" height="6" fill="#8399ab"/>
  <rect width="6" height="${S}" fill="#75899a"/>
  <rect x="${CELL}" width="6" height="${S}" fill="#75899a"/>
  ${cells.join('\n')}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// A RAISED ACCESS FLOOR — the bolted panel grid every real dealing room and
// server hall stands on, and the last flat surface left in the shell. The v1
// audit finding was that EVERY shell surface rendered one byte value; walls and
// ceiling got fixed first, which left the floor as the only untextured plane,
// and it is the single largest surface in the chase camera's frame.
//
// BRIGHTNESS IS MATCHED, NOT CHOSEN, AND IT IS MATCHED BY MEASUREMENT.
// The founder signed off "the lighting is good", so adding a texture here must
// not move the floor's tone. The outgoing factor was the LINEAR triple
// [0.052, 0.068, 0.086].
//
// Hand-picking hex codes to hit that does NOT work: the first attempt centred
// the panel gradient on srgb(0.052,0.068,0.086) = #404a53 and predicted a 2.5%
// drop, but the 8 px seams plus the gradient's dark half MEASURED -10.9, -13.3,
// -11.8 percent. So the art is authored freely and then normalised against the
// target by `normalizeMeanLinear`. Retune the art all you like; the tone is
// pinned by the measurement, not by the swatches.
const FLOOR_TARGET_LINEAR = [0.052, 0.068, 0.086];

const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** Scale a PNG so its MEAN colour in LINEAR light equals `target`.
 *  Works in linear space because that is where glTF multiplies; averaging sRGB
 *  bytes and scaling those would leave the rendered tone off by the gamma. */
async function normalizeMeanLinear(png, target) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const px = info.width * info.height;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += ch) {
    for (let k = 0; k < 3; k++) sum[k] += srgbToLinear(data[i + k]);
  }
  const gain = sum.map((s, k) => target[k] / (s / px));
  let clipped = 0;
  for (let i = 0; i < data.length; i += ch) {
    for (let k = 0; k < 3; k++) {
      const lit = srgbToLinear(data[i + k]) * gain[k];
      if (lit > 1) clipped++;
      data[i + k] = linearToSrgb(lit);
    }
  }
  // Clipping would silently pull the mean back below target, so it is an error
  // rather than a warning: the art is too bright for the tone it must hit.
  if (clipped > 0) throw new Error(`normalizeMeanLinear clipped ${clipped} channel samples`);
  return sharp(data, { raw: info }).png().toBuffer();
}
async function floorPanelPng() {
  const S = FLOOR_TEX_PX, CELL = S / 2, SEAM = 8, BOLT = 5;
  const panels = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const x = gx * CELL + SEAM, y = gy * CELL + SEAM, W = CELL - SEAM * 2;
      panels.push(`
    <rect x="${x}" y="${y}" width="${W}" height="${W}" fill="url(#deck)"/>
    <rect x="${x}" y="${y}" width="${W}" height="4" fill="#5b646e" opacity="0.5"/>
    <rect x="${x}" y="${y + W - 4}" width="${W}" height="4" fill="#1d2329" opacity="0.6"/>
    <circle cx="${x + 18}" cy="${y + 18}" r="${BOLT}" fill="#59626c" opacity="0.55"/>
    <circle cx="${x + W - 18}" cy="${y + 18}" r="${BOLT}" fill="#59626c" opacity="0.55"/>
    <circle cx="${x + 18}" cy="${y + W - 18}" r="${BOLT}" fill="#4c555e" opacity="0.45"/>
    <circle cx="${x + W - 18}" cy="${y + W - 18}" r="${BOLT}" fill="#4c555e" opacity="0.45"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <defs>
    <linearGradient id="deck" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#474f59"/>
      <stop offset="1" stop-color="#39414a"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="#262d34"/>
  ${panels.join('\n')}
</svg>`;
  return normalizeMeanLinear(await sharp(Buffer.from(svg)).png().toBuffer(), FLOOR_TARGET_LINEAR);
}

// ------------------------------------------------------------- 1. shell -----
const WALL_M = texturedMat('TradingFloorWall', await wallPanelPng(), { rough: 0.94 });
const CEIL_M = texturedMat('TradingFloorCeiling', await ceilingPanelPng(), { rough: 0.96 });
// rough 0.55 is carried over from the factor-only v2 floor on purpose: it is
// what gives the deck its broad sheen under the directional key, and
// `texturedMat`'s 0.92 default would flatten it.
const FLOOR_M = texturedMat('TradingFloorFloor', await floorPanelPng(), { rough: 0.55 });
const TRIM = mat('TradingFloorTrim', [0.22, 0.88, 0.58], { unlit: true });
// Lighter than a task chair really is. The first v2 pass used 0.085 and the
// chairs rendered as a stack of black slabs against a mid-grey floor — a dark
// prop in a room with no shadows has nothing to separate its own faces.
const CHAIR_M = mat('TradingFloorChair', [0.175, 0.168, 0.185], { rough: 0.58, metal: 0.2 });

addMesh(
  'TradingFloorFloorSlab',
  // NOT exempt. Its top face is at exactly y=0, so it clears by construction,
  // and if someone ever raises the deck the gate should say so.
  group('floor slab', null, () => boxGeo(0, -WT / 2, 0, RW + WT * 2, WT, RD + WT * 2, FLOOR_TILE_WU)),
  FLOOR_M
);

// Pilasters: vertical ribs that break the flat wall plane. They are what gives
// a corner its highlight/shadow pair under the directional key, and they set
// the rhythm the desk row sits between.
//
// Depth is 40 and not 70 ON PURPOSE. The movement clamp stops the player's
// CENTRE at halfX - 46 = 1254, six units short of the rib face at 1260, so a
// rib this shallow can never block or trap anyone and needs no collider of its
// own. (It does NOT mean the avatar cannot touch one — the 46 wu collision
// circle still overlaps it; see the note in `trading-floor-room.ts`.) It also
// sets CONSOLE_WALL_X: 1300 - 40 - 135 - 5, the 5 being a real gap so the
// desk's bbox face and the rib face are never coplanar.
//
// This 40/6 derivation is correct for the RIBS and does NOT generalise to the
// rest of the wall detail — the screen surround is deeper. `assertWallDetailClears`
// is what actually holds the line now.
const PIL_D = 40, PIL_W = 100;
const sidePilasterZ = [-825, -275, 275, 825];
const backPilasterX = [-1050, 1050];

addMesh(
  'TradingFloorWalls',
  group('walls', null, () => mergeGeos([
    boxGeo(0, RH / 2, -hz - WT / 2, RW + WT * 2, RH, WT, WALL_TILE_WU),                 // back (-Z)
    boxGeo(-hx - WT / 2, RH / 2, 0, WT, RH, RD, WALL_TILE_WU),                          // left
    boxGeo(hx + WT / 2, RH / 2, 0, WT, RH, RD, WALL_TILE_WU),                           // right
    // front (+Z) wall, split around the entrance so the arch lines up with
    // the exterior doorway (both are on +Z).
    boxGeo(-(DOOR_W / 2 + (RW - DOOR_W) / 4), RH / 2, hz + WT / 2, (RW - DOOR_W) / 2 + WT, RH, WT, WALL_TILE_WU),
    boxGeo(DOOR_W / 2 + (RW - DOOR_W) / 4, RH / 2, hz + WT / 2, (RW - DOOR_W) / 2 + WT, RH, WT, WALL_TILE_WU),
    boxGeo(0, DOOR_H + (RH - DOOR_H) / 2, hz + WT / 2, DOOR_W, RH - DOOR_H, WT, WALL_TILE_WU),  // lintel
    // Four corner pillars. These DO stand in reachable floor, which is legal
    // only because they are colliders — see the pillar entries in
    // TRADING_FLOOR_SOLIDS. If that collider is ever removed, remove this
    // exemption in the same diff or the gate stops protecting the room.
    ...[[-hx + 190, -hz + 190], [hx - 190, -hz + 190], [-hx + 190, hz - 190], [hx - 190, hz - 190]].map(
      ([x, z]) => boxGeo(x, RH / 2, z, 110, RH, 110, WALL_TILE_WU, {
        label: 'corner pillar',
        exempt: 'collider in TRADING_FLOOR_SOLIDS',
      })
    ),
    // side-wall pilasters
    ...sidePilasterZ.flatMap((z) => [
      boxGeo(-hx + PIL_D / 2, RH / 2, z, PIL_D, RH, PIL_W, WALL_TILE_WU),
      boxGeo(hx - PIL_D / 2, RH / 2, z, PIL_D, RH, PIL_W, WALL_TILE_WU),
    ]),
    // back-wall pilasters, outboard of the screen (screen half-width is 850)
    ...backPilasterX.map((x) => boxGeo(x, RH / 2, -hz + PIL_D / 2, PIL_W, RH, PIL_D, WALL_TILE_WU)),
    // Screen surround: a shallow recessed frame so the board is mounted IN the
    // wall rather than stuck on it.
    //
    // THE INSET IS A CLEARANCE NUMBER, NOT A STYLE CHOICE. The player's CENTRE
    // clamps at `halfZ - PLAYER_RADIUS` = 1100 - 46 = 1054, so anything whose
    // inner face sits past z = -1054 swallows the avatar's centre, not just its
    // shoulders. At the old `-hz + 22` the frame face landed at -1056 (clear by
    // 2) and the glow at `-hz + 46` landed at -1050 — 4 wu PAST the clamp. A
    // player standing dead centre under the board, which is exactly where they
    // go to read it, took a lit bar through the chest at y 234..246. Nothing
    // blocked that approach: the dais ends at z -406 and the kiosk collider
    // only spans x -447..-153.
    //
    // `-hz + 12` puts the frame face at -1066 and `-hz + 36` puts the glow face
    // at -1060, which is the same 6 wu margin the pilasters run and keeps the
    // glow 6 wu proud of the frame so the two cannot z-fight. MOVE THEM
    // TOGETHER or that separation is what breaks. Found by tf3d-audit,
    // 2026-09-19; the pilaster 40/6 derivation below does NOT generalise to
    // wall detail, and the surround was the deepest protrusion in the room.
    boxGeo(0, SCREEN_BOTTOM_Y + SCREEN_H + 34, -hz + FRAME_INSET, SCREEN_W + 136, 68, 44, WALL_TILE_WU),
    boxGeo(0, SCREEN_BOTTOM_Y - 34, -hz + FRAME_INSET, SCREEN_W + 136, 68, 44, WALL_TILE_WU),
    boxGeo(-(SCREEN_W / 2 + 34), SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + FRAME_INSET, 68, SCREEN_H + 136, 44, WALL_TILE_WU),
    boxGeo(SCREEN_W / 2 + 34, SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + FRAME_INSET, 68, SCREEN_H + 136, 44, WALL_TILE_WU),
  ])),
  WALL_M
);

addMesh(
  'TradingFloorCeiling',
  group('ceiling', null, () => boxGeo(0, RH + WT / 2, 0, RW + WT * 2, WT, RD + WT * 2, CEIL_TILE_WU)),
  CEIL_M
);

addMesh(
  'TradingFloorTrimGlow',
  group('trim', null, () => mergeGeos([
    ringGeo(DAIS_POS[0], 3, DAIS_POS[2], 504, 560),                        // dais floor ring
    boxGeo(0, 26, -hz + 6, RW, 16, 10),                                    // wall base strips
    boxGeo(-hx + 6, 26, 0, 10, 16, RD),
    boxGeo(hx - 6, 26, 0, 10, 16, RD),
    boxGeo(0, RH - 40, -hz + 6, RW, 12, 10),                               // cornice strip
    // ceiling light strips — three runs down the length of the hall. A lit
    // grid overhead is most of what makes an interior read as a ROOM rather
    // than a box, and it costs nothing: same unlit material, same mesh.
    ...[-700, 0, 700].map((z) => boxGeo(0, RH - 14, z, RW - 240, 14, 64)),
    // Screen surround glow, 6 wu proud of the frame. `-hz + 36` is paired with
    // the frame's `-hz + 12` above and the two MUST move together: this inner
    // face is the deepest protrusion in the room, and at the old `-hz + 46` it
    // sat 4 wu past the player-centre clamp. See the note on the frame.
    boxGeo(0, SCREEN_BOTTOM_Y + SCREEN_H + 10, -hz + GLOW_INSET, SCREEN_W + 40, 12, 8),
    boxGeo(0, SCREEN_BOTTOM_Y - 10, -hz + GLOW_INSET, SCREEN_W + 40, 12, 8),
    boxGeo(-(SCREEN_W / 2 + 10), SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + GLOW_INSET, 12, SCREEN_H + 40, 8),
    boxGeo(SCREEN_W / 2 + 10, SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + GLOW_INSET, 12, SCREEN_H + 40, 8),
  ])),
  TRIM
);

// ------------------------------------------------------------- 2. chair -----
// ONE authored chair at the origin with a base-centre pivot, exactly like the
// console module: the scene extracts it, draws the six-seat row as a single
// InstancedMesh and removes the original. Dimensions come from the avatar, not
// from the room — 270 wu is ~1.7 m, so 1 m is 159 wu and an office chair's
// 0.46 m seat is 73 wu. The occupant faces +Z at rotY 0, matching the console.
addMesh(
  'TradingFloorChairModule',
  // Exempt as a whole: this authored copy sits at the ORIGIN, dead centre of
  // the room, and would trip the gate on every box. It never renders there —
  // `buildInstancedRow` extracts it, draws the six-seat row and removes the
  // original. The instanced copies stand at seat positions derived from the
  // desk constants, which the collider set covers.
  group('chair template', 'extracted at runtime; authored copy never renders', () => mergeGeos([
    boxGeo(0, 70, 4, 108, 16, 98),           // seat pan
    boxGeo(0, 80, 4, 96, 10, 86),            // seat cushion, proud of the pan
    boxGeo(0, 120, -44, 98, 74, 16),         // backrest, lower pad
    boxGeo(0, 166, -44, 84, 14, 14),         // backrest, top rail
    boxGeo(0, 34, 0, 24, 72, 24),            // gas post
    boxGeo(0, 16, 0, 40, 18, 40),            // hub above the base
    boxGeo(0, 7, 0, 122, 12, 22),            // base spider, X arm
    boxGeo(0, 7, 0, 22, 12, 122),            // base spider, Z arm
    boxGeo(-58, 96, 6, 12, 10, 78),          // armrests
    boxGeo(58, 96, 6, 12, 10, 78),
    boxGeo(-58, 82, 36, 12, 28, 12),         // armrest posts
    boxGeo(58, 82, 36, 12, 28, 12),
  ])),
  CHAIR_M,
  [0, 0, 0]
);

// Every box is registered by now, so the gate can see the whole room. It runs
// BEFORE the props are copied and before export: the props come in as finished
// primitives rather than through `boxGeo`, and they are covered by the desk and
// kiosk colliders, so they are outside this gate's remit by construction.
assertWallDetailClears();

// ------------------------------------------------------------- 3. props -----
// Copied verbatim out of the v1 stage-1 build. They were decimated, scaled and
// re-centred on their base there; re-running that work would need the Meshy
// refines, which are not on disk and would cost credits to regenerate.
const propsDoc = await io.read(PROPS_GLB);
const propsRoot = propsDoc.getRoot();

/** `scale` bakes a uniform factor into the POSITION stream rather than setting
 *  it on the node. That is deliberate: the scene reads `authored.scale.x` off
 *  the node to size its instanced rows, and `KHR_mesh_quantization` rewrites
 *  node scale anyway, so a node-level scale here would be indistinguishable
 *  from the quantizer's and would corrupt that read. Baking keeps the node
 *  transform meaning exactly one thing. */
const propExtents = {};

async function copyProp(sourceName, outName, translation, scale = 1) {
  const srcMesh = propsRoot.listMeshes().find((m) => m.getName() === sourceName);
  if (!srcMesh) throw new Error(`prop "${sourceName}" not in ${PROPS_GLB}`);
  const sp = srcMesh.listPrimitives()[0];

  const srcTex = sp.getMaterial()?.getBaseColorTexture();
  if (!srcTex) throw new Error(`prop "${sourceName}" has no baseColor texture`);
  // Round-trip through sharp so the output is a plain PNG whatever the source
  // encoding was, and so a re-run against a different props GLB cannot smuggle
  // a 2048² map into the budget.
  const png = await sharp(Buffer.from(srcTex.getImage())).resize(512, 512, { fit: 'fill' }).png().toBuffer();
  const tex = doc.createTexture(outName + 'Tex').setImage(png).setMimeType('image/png');
  const m = doc
    .createMaterial(outName + 'Mtl')
    .setBaseColorTexture(tex)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.82);

  const srcPos = sp.getAttribute('POSITION').getArray();
  const pos = new Float32Array(srcPos.length);
  for (let i = 0; i < srcPos.length; i++) pos[i] = srcPos[i] * scale;
  // Measure what we actually produced, so the extents reported to the scene
  // (and into TRADING_FLOOR_MONITOR) come from the geometry, not from
  // multiplying the old numbers by hand.
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < mnx) mnx = pos[i];
    if (pos[i] > mxx) mxx = pos[i];
    if (pos[i + 1] < mny) mny = pos[i + 1];
    if (pos[i + 1] > mxy) mxy = pos[i + 1];
    if (pos[i + 2] < mnz) mnz = pos[i + 2];
    if (pos[i + 2] > mxz) mxz = pos[i + 2];
  }

  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(sp.getIndices().getArray())).setBuffer(buffer))
    .setMaterial(m);
  for (const sem of ['NORMAL', 'TEXCOORD_0']) {
    const a = sp.getAttribute(sem);
    if (a) prim.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(new Float32Array(a.getArray())).setBuffer(buffer));
  }

  const mesh = doc.createMesh(outName).addPrimitive(prim);
  scene.addChild(doc.createNode(outName).setMesh(mesh).setTranslation(translation));
  propExtents[outName] = {
    minX: mnx + translation[0], maxX: mxx + translation[0],
    minY: mny + translation[1], maxY: mxy + translation[1],
    minZ: mnz + translation[2], maxZ: mxz + translation[2],
  };
  console.log(
    `prop ${outName}: ${sp.getIndices().getCount() / 3} tris from ${sourceName} at [${translation}]` +
      (scale !== 1 ? ` scale ${scale.toFixed(6)}` : '') +
      ` | size ${(mxx - mnx).toFixed(1)} x ${(mxy - mny).toFixed(1)} x ${(mxz - mnz).toFixed(1)}` +
      ` | halfX ${((mxx - mnx) / 2).toFixed(1)} halfZ ${((mxz - mnz) / 2).toFixed(1)}`
  );
}

await copyProp('TradingFloorConsoleModule', 'TradingFloorConsoleModule', [-CONSOLE_WALL_X, 0, CONSOLE_ROW_Z[0]]);
await copyProp('TradingFloorHoloDais', 'TradingFloorHoloDais', DAIS_POS);
await copyProp('TradingFloorMonitorStation', 'TradingFloorMonitorStation', MONITOR_POS, MONITOR_SCALE);

// ---- the asset/scene contract, as DATA -------------------------------------
// `trading-floor-room.ts` has always carried the sentence "these numbers and
// the SCREEN_* constants in build-interior.mjs must agree or the plane floats
// inside its own frame". Prose did not hold it: one export shipped a 250..900
// surround around a 340..880 plane, and a later pair drifted 20 wu apart
// (script 520/360 vs scene 540/340) with every test still green — the aspect
// test compares canvas to canvas, and nothing compared the scene's rect to the
// GLB's opening.
//
// So the asset now STATES its own contract in scene `extras`, and tf3d-seats'
// real-GLB test asserts these against TRADING_FLOOR_SCREEN / _MONITOR / _ROOM.
// Two files with two owners cannot silently disagree when one of them publishes
// its numbers and the other is tested against them.
//
// Kiosk extents are MEASURED off the scaled geometry, never recomputed from the
// scale factor, so a future prop swap cannot make this lie.
const kiosk = propExtents.TradingFloorMonitorStation;
scene.setExtras({
  contract: 'scripts/trading-floor/build-interior.mjs — assert against trading-floor-room.ts',
  screen: { width: SCREEN_W, height: SCREEN_H, bottomY: SCREEN_BOTTOM_Y, z: SCREEN_Z },
  kiosk: {
    x: MONITOR_POS[0],
    y: MONITOR_POS[1],
    z: MONITOR_POS[2],
    halfX: Number(((kiosk.maxX - kiosk.minX) / 2).toFixed(2)),
    halfZ: Number(((kiosk.maxZ - kiosk.minZ) / 2).toFixed(2)),
    height: Number((kiosk.maxY - kiosk.minY).toFixed(2)),
  },
  room: { halfX: hx, halfZ: hz, height: RH },
});
console.log(`  extras: screen ${SCREEN_W}x${SCREEN_H}@${SCREEN_BOTTOM_Y} | kiosk half ${scene.getExtras().kiosk.halfX}/${scene.getExtras().kiosk.halfZ} h${scene.getExtras().kiosk.height} | room ${hx}/${hz}/${RH}`);

await doc.transform(dedup(), prune());

let tris = 0;
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices().getCount() / 3;
console.log(
  `interior v2: ${tris} tris | ${doc.getRoot().listMeshes().length} meshes | ` +
    `${doc.getRoot().listMaterials().length} materials (= draw calls) | ` +
    `${doc.getRoot().listTextures().length} textures | room ${RW}x${RH}x${RD} wu, door ${DOOR_W}x${DOOR_H} on +Z`
);
console.log(
  `  screen surround ${SCREEN_W}x${SCREEN_H} bottom y=${SCREEN_BOTTOM_Y} at z=${SCREEN_Z} | ` +
    `desks x=+-${CONSOLE_WALL_X} z=[${CONSOLE_ROW_Z}] | monitor [${MONITOR_POS}]`
);

await io.write(output, doc);
console.log(`wrote ${output}`);
