#!/usr/bin/env node
// build-interior.mjs — assemble the Trading Floor interior hall GLB (v5).
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
// Only the kiosk remains a Meshy text-to-3d refine from the v1 run.
// It is copied through from a PROPS SOURCE GLB rather than re-slimmed:
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
import { prune, dedup, weldPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3d';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const RW = 3900;   // interior width  (X)
const RD = 3300;   // interior depth  (Z)
const RH = 1425;    // interior height (Y) ~= 5.3 avatar heights
const WT = 60;     // wall thickness
const DOOR_W = 360;
const DOOR_H = 500;
const hx = RW / 2, hz = RD / 2;

// ---- texture tiling ---------------------------------------------------------
// One wall texture repeat spans 475 wu horizontally and the full 950 wu height.
// Each repeat carries two walnut panels below the chair rail and navy above.
const WALL_TILE_WU = 712.5;
const CEIL_TILE_WU = 825;
// The floor carries a 2x2 grid too, so one panel is 190 wu — about 1.2 m, the
// size a raised access-floor tile reads at in a real dealing room. 95 wu (a
// true 600 mm panel) was tried first and shimmers: 27 panel rows across a 2600
// wu hall is noise from the chase camera, not architecture.
const FLOOR_TILE_WU = 570;
const WALL_TEX_PX = 512;
const CEIL_TEX_PX = 512;
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
const DAIS_POS = [0, 0, -90];
// The kiosk was 470 wu tall against a 270 wu avatar — 1.74x human height, about
// 2.95 m. That oversize, not its position, was the root cause of the board
// occlusion: no position exists that both clears the board's x-span from the
// spawn and stays outside the seat bands, because the seat rule wants
// |x| < 639 and the sightline wants |x| > 751. Cutting it to avatar height is
// the lever that fixed it, and it let the board stay 1700 wide.
const MONITOR_SCALE = 300 / 470;   // 0.638297...
const MONITOR_POS = [-1000, 0, 1570];
const MONITOR_ROT_Y = Math.PI;
// Desk row, mirrored in TRADING_FLOOR_CONSOLE_ROW. The authored console faces
// +Z, so a desk against the -X wall is yawed +pi/2 to face the aisle.
const CONSOLE_WALL_X = hx - 40 - 135 - 5;
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
// The shell and board scale together. Props retain their avatar-scale dimensions.
// Frame top is 540 + 780 + 102 = 1422, 3 wu below the 1425 ceiling.
// Keep these three screen literals plain: the screen-texture test reads them.
const SCREEN_W = 2550;
const SCREEN_H = 780;
const SCREEN_BOTTOM_Y = 540;
const SCREEN_Z = -hz + 6;
const FRAME_W = 102;

// The ceiling limit above is 3 wu from being violated, so it is a check, not a
// comment. A surround that punches through the ceiling would be invisible from
// inside the room and would only show up as a hole from outside.
{
  const surroundTop = SCREEN_BOTTOM_Y + SCREEN_H + FRAME_W;
  if (surroundTop > RH) {
    throw new Error(
      `screen surround top ${surroundTop} exceeds the ${RH} wu ceiling; ` +
        `max SCREEN_H at bottom ${SCREEN_BOTTOM_Y} is ${RH - SCREEN_BOTTOM_Y - FRAME_W}`
    );
  }
  console.log(`  surround top ${surroundTop} vs ceiling ${RH} -> clear by ${RH - surroundTop}`);
}

// Surround insets, as named constants because a clearance assertion below reads
// them. The glow must stay proud of the frame, so these two move TOGETHER.
const FRAME_INSET = 12, FRAME_DEPTH = 44;
const GLOW_INSET = 35.5, GLOW_DEPTH = 8;

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
  const tileU = typeof tile === 'number' ? tile : tile.u;
  const tileV = typeof tile === 'number' ? tile : tile.v;
  const pos = [], nrm = [], idx = [], uv = tileU > 0 ? [] : null;
  for (const [quad, n] of faces) {
    const base = pos.length / 3;
    for (const vi of quad) {
      const wx = c[vi][0] + cx, wy = c[vi][1] + cy, wz = c[vi][2] + cz;
      pos.push(wx, wy, wz);
      nrm.push(...n);
      if (uv) {
        // Pick the two axes that lie IN the face. glTF's V axis points down, so
        // vertical surfaces negate world Y to keep the panel upright.
        if (n[1] !== 0) uv.push(wx / tileU, wz / tileV);
        else if (n[0] !== 0) uv.push(wz / tileU, -wy / tileV);
        else uv.push(wx / tileU, -wy / tileV);
      }
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, idx, uv };
}

/** Flat annulus on the XZ plane for the textured Exchange seal. */
function ringGeo(cx, cy, cz, rInner, rOuter, seg = 48, polarUV = false) {
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
  const pos = [], nrm = [], idx = [], uv = polarUV ? [] : null;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const s = Math.sin(a), co = Math.cos(a);
    pos.push(cx + co * rInner, cy, cz + s * rInner, cx + co * rOuter, cy, cz + s * rOuter);
    nrm.push(0, 1, 0, 0, 1, 0);
    if (uv) {
      for (const r of [rInner, rOuter]) {
        // glTF V=0 samples the atlas top. +Z is the near, lower half of
        // the seal image, where CLAWVILLE EXCHANGE sits upright for spawn.
        uv.push(0.375 + co * r / 2400, 0.375 + s * r / 2400);
      }
    }
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
  return { pos, nrm, idx, uv };
}

function colored(geo, rgb) {
  geo.col = Array(geo.pos.length / 3).fill(rgb).flat();
  return geo;
}

/** Weld duplicate positions for angle-weighted normals, but split creases. */
function sculptClaw(geo) {
  const epsilon = 1e-4, crease = Math.cos(55 * Math.PI / 180);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const unit = (v) => { const length = Math.hypot(...v); return v.map((n) => n / length); };
  const groups = new Map(), faces = [];
  const keys = Array.from({length:geo.pos.length / 3}, (_, i) =>
    geo.pos.slice(i*3, i*3+3).map((v) => Math.round(v / epsilon)).join(','));
  for (let i = 0; i < geo.idx.length; i += 3) {
    const ids = geo.idx.slice(i, i+3), points = ids.map((v) => geo.pos.slice(v*3, v*3+3));
    const normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
    const face = {ids, points, normal, entries:[]};
    for (let corner = 0; corner < 3; corner++) {
      const a = unit(sub(points[(corner+1)%3], points[corner]));
      const b = unit(sub(points[(corner+2)%3], points[corner]));
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
      const key = keys[ids[corner]], entries = groups.get(key) ?? [];
      const entry = {normal, angle,
        edges:[keys[ids[(corner+1)%3]], keys[ids[(corner+2)%3]]]};
      face.entries.push(entry); entries.push(entry);
      groups.set(key, entries);
    }
    faces.push(face);
  }
  // Smooth connected face fans across shared edges. A per-face normal-angle
  // filter gives different averages at the same position and leaves seams.
  for (const adjacent of groups.values()) {
    const pending = new Set(adjacent);
    while (pending.size) {
      const fan = [pending.values().next().value]; pending.delete(fan[0]);
      for (let i = 0; i < fan.length; i++) for (const entry of pending) {
        if (dot(fan[i].normal, entry.normal) >= crease &&
            fan[i].edges.some((key) => entry.edges.includes(key))) {
          pending.delete(entry); fan.push(entry);
        }
      }
      const sum = [0,0,0];
      for (const entry of fan) for (let axis = 0; axis < 3; axis++)
        sum[axis] += entry.normal[axis] * entry.angle;
      const normal = unit(sum);
      // Meshy slivers can fold a fan behind one face. Keep those corners crisp.
      for (const entry of fan) entry.smooth = dot(normal, entry.normal) > .6 ? normal : entry.normal;
    }
  }
  const pos = [], nrm = [], idx = [];
  for (const face of faces) for (let corner = 0; corner < 3; corner++) {
    const point = face.points[corner];
    const normal = face.entries[corner].smooth;
    idx.push(pos.length / 3); pos.push(...point); nrm.push(...normal);
  }
  console.log(`  claw sculpt: position weld ${epsilon} wu, angle-weighted 55 deg crease; no COLOR_0`);
  return {pos, nrm, idx, uv:null};
}

/** Rounded cuboid, 108 triangles; chamfer-only mode costs 44 triangles.
 * Normals follow the bevel, while the broad faces stay flat. Both modes
 * register their complete bounds, including the rounded corners. */
function cushionGeo(cx, cy, cz, sx, sy, sz, radius, chamferOnly = false) {
  const centre = [cx, cy, cz], half = [sx / 2, sy / 2, sz / 2];
  if (radius <= 0 || half.some((h) => radius >= h)) throw new Error('invalid cushion radius');
  boxRegistry.push({ group: currentGroup.name, exempt: currentGroup.exempt,
    min: centre.map((c, i) => c - half[i]), max: centre.map((c, i) => c + half[i]) });
  const core = half.map((h) => h - radius), pos = [], nrm = [], idx = [];
  const face = (points) => {
    const a = points[0], b = points[1], c = points[2];
    const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
    const normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    const midpoint = points.reduce((sum, p) => sum.map((v, i) => v + p[i]), [0,0,0]);
    if (normal.reduce((sum, v, i) => sum + v * midpoint[i], 0) < 0) points.reverse();
    const base = pos.length / 3;
    for (const p of points) {
      pos.push(...p.map((v, i) => v + centre[i]));
      const delta = p.map((v, i) => v - Math.max(-core[i], Math.min(core[i], v)));
      const length = Math.hypot(...delta);
      nrm.push(...delta.map((v) => v / length));
    }
    for (let i = 1; i < points.length - 1; i++) idx.push(base, base+i, base+i+1);
  };
  if (chamferOnly) {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const axes = [0,1,2].filter((i) => i !== axis);
      face([[-1,-1],[1,-1],[1,1],[-1,1]].map(([u,v]) => {
        const p = [0,0,0]; p[axis] = sign*half[axis];
        p[axes[0]] = u*core[axes[0]]; p[axes[1]] = v*core[axes[1]]; return p;
      }));
    }
    for (let axis = 0; axis < 3; axis++) for (const sa of [-1,1]) for (const sb of [-1,1]) {
      const [a,b] = [0,1,2].filter((i) => i !== axis);
      face([[-1,0],[1,0],[1,1],[-1,1]].map(([end, side]) => {
        const p = [0,0,0]; p[axis] = end*core[axis];
        p[a] = sa*(side ? core[a] : half[a]); p[b] = sb*(side ? half[b] : core[b]); return p;
      }));
    }
    for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1])
      face([0,1,2].map((axis) => [x,y,z].map((s,i) => s*(i === axis ? half[i] : core[i]))));
  } else {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1,1]) {
      const [a,b] = [0,1,2].filter((i) => i !== axis);
      const grid = (i) => [-half[i], -core[i], core[i], half[i]];
      for (let u = 0; u < 3; u++) for (let v = 0; v < 3; v++) {
        face([[u,v],[u+1,v],[u+1,v+1],[u,v+1]].map(([iu,iv]) => {
          const p = [0,0,0]; p[axis] = sign*half[axis]; p[a] = grid(a)[iu]; p[b] = grid(b)[iv];
          const clamped = p.map((n,i) => Math.max(-core[i], Math.min(core[i], n)));
          const delta = p.map((n,i) => n-clamped[i]), length = Math.hypot(...delta);
          return clamped.map((n,i) => n+radius*delta[i]/length);
        }));
      }
    }
  }
  return { pos, nrm, idx, uv: null };
}

/** Capped 8–10 sided cylinder, along Y or X (casters); no centre-fan waste. */
function cylinderGeo(cx, cy, cz, radius, length, segments = 8, axis = 1) {
  const centre = [cx,cy,cz], radial = [0,1,2].filter((i) => i !== axis);
  const half = centre.map((_,i) => i === axis ? length/2 : radius);
  boxRegistry.push({ group: currentGroup.name, exempt: currentGroup.exempt,
    min: centre.map((v,i) => v-half[i]), max: centre.map((v,i) => v+half[i]) });
  const pos=[], nrm=[], idx=[];
  const emit = (points, normals) => {
    const base=pos.length/3;
    for(let i=0;i<points.length;i++) { pos.push(...points[i]); nrm.push(...normals[i]); }
    for(let i=1;i<points.length-1;i++) {
      const a=points[0], u=points[i].map((v,j)=>v-a[j]), v=points[i+1].map((v,j)=>v-a[j]);
      const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      const forward=cross.reduce((sum,v,j)=>sum+v*normals[0][j],0)>0;
      idx.push(base,base+(forward?i:i+1),base+(forward?i+1:i));
    }
  };
  const ring=(side) => Array.from({length:segments},(_,i)=> {
    const p=[...centre], a=i/segments*Math.PI*2;
    p[axis]+=side*length/2; p[radial[0]]+=radius*Math.cos(a); p[radial[1]]+=radius*Math.sin(a); return p;
  });
  const lo=ring(-1), hi=ring(1);
  const normal=(i) => {const n=[0,0,0],a=i/segments*Math.PI*2;
    n[radial[0]]=Math.cos(a); n[radial[1]]=Math.sin(a); return n;};
  for(let i=0;i<segments;i++) { const j=(i+1)%segments;
    emit([lo[i],lo[j],hi[j],hi[i]],[normal(i),normal(j),normal(j),normal(i)]); }
  for(const [side,points] of [[-1,lo],[1,hi]]) {
    const n=[0,0,0]; n[axis]=side; emit(points,points.map(()=>n));
  }
  return {pos,nrm,idx,uv:null};
}

/** Star-base spoke; register its rotated bounds rather than a second box. */
function spokeGeo(x, z) {
  const length=Math.hypot(x,z), co=z/length, si=x/length;
  const geo=boxGeo(0,15,length/2,9,6,length);
  const registered=boxRegistry[boxRegistry.length-1];
  for(let i=0;i<geo.pos.length;i+=3) {
    const px=geo.pos[i], pz=geo.pos[i+2], nx=geo.nrm[i], nz=geo.nrm[i+2];
    geo.pos[i]=co*px+si*pz; geo.pos[i+2]=-si*px+co*pz;
    geo.nrm[i]=co*nx+si*nz; geo.nrm[i+2]=-si*nx+co*nz;
  }
  for(let axis=0;axis<3;axis++) {
    const values=geo.pos.filter((_,i)=>i%3===axis);
    registered.min[axis]=Math.min(...values); registered.max[axis]=Math.max(...values);
  }
  return geo;
}

// Octagonal tiers keep the collider's exact 700 x 692 world-unit footprint.
function octagonGeo(cx, y0, cz, halfX, halfZ, height, chamfer, tile = 0, cap = true) {
  boxRegistry.push({ group: currentGroup.name, exempt: currentGroup.exempt,
    min: [cx - halfX, y0, cz - halfZ], max: [cx + halfX, y0 + height, cz + halfZ] });
  const corners = [[-halfX + chamfer,-halfZ],[halfX-chamfer,-halfZ],[halfX,-halfZ+chamfer],
    [halfX,halfZ-chamfer],[halfX-chamfer,halfZ],[-halfX+chamfer,halfZ],
    [-halfX,halfZ-chamfer],[-halfX,-halfZ+chamfer]];
  const pos=[], nrm=[], idx=[], uv=tile?[]:null;
  for (let k=0;k<8;k++) {
    const a=corners[k], b=corners[(k+1)%8];
    const nx=b[1]-a[1], nz=-(b[0]-a[0]);
    const len=Math.hypot(nx,nz), base=pos.length/3;
    pos.push(cx+a[0],y0,cz+a[1],cx+b[0],y0,cz+b[1],cx+b[0],y0+height,cz+b[1],cx+a[0],y0+height,cz+a[1]);
    if (uv) uv.push(a[0]/tile,y0/tile,b[0]/tile,y0/tile,b[0]/tile,(y0+height)/tile,a[0]/tile,(y0+height)/tile);
    for(let j=0;j<4;j++) nrm.push(nx/len,0,nz/len);
    idx.push(base,base+2,base+1,base,base+3,base+2);
  }
  if (cap) {
    const base=pos.length/3;
    for(const [x,z] of corners) { pos.push(cx+x,y0+height,cz+z); nrm.push(0,1,0); if(uv) uv.push(x/tile,z/tile); }
    for(let k=1;k<7;k++) idx.push(base,base+k+1,base+k);
  }
  return {pos,nrm,idx,uv};
}

function bannerGeo(x, y, z, w, h) {
  const side=x<0?1:-1;
  const atlasSize=1024, rect=bannerAtlasRect;
  if (Math.abs((rect.w / rect.h) / (w / h) - 1) > 0.01) {
    throw new Error(`banner atlas aspect ${rect.w}/${rect.h} differs from quad ${w}/${h} by over 1%`);
  }
  const u0=rect.x/atlasSize, u1=(rect.x+rect.w)/atlasSize;
  const v0=rect.y/atlasSize, v1=(rect.y+rect.h)/atlasSize;
  boxRegistry.push({group:currentGroup.name,exempt:currentGroup.exempt,
    min:[x,y-h/2,z-w/2],max:[x,y+h/2,z+w/2]});
  return {pos:[x,y-h/2,z-w/2,x,y-h/2,z+w/2,x,y+h/2,z+w/2,x,y+h/2,z-w/2],
    nrm:Array(4).fill([side,0,0]).flat(), idx:side>0?[0,2,1,0,3,2]:[0,1,2,0,2,3],
    uv:side>0?[u1,v1,u0,v1,u0,v0,u1,v0]:[u0,v1,u1,v1,u1,v0,u0,v0]};
}

/** The lintel label is the only caller and faces into the room (-Z). */
function labelGeo(rect, cx, cy, cz, width, faceZ) {
  const height = width * rect.h / rect.w;
  boxRegistry.push({group:currentGroup.name,exempt:currentGroup.exempt,
    min:[cx-width/2,cy-height/2,cz],max:[cx+width/2,cy+height/2,cz]});
  return {pos:[cx-width/2,cy-height/2,cz,cx+width/2,cy-height/2,cz,
    cx+width/2,cy+height/2,cz,cx-width/2,cy+height/2,cz],
    nrm:Array(4).fill([0,0,faceZ]).flat(),
    idx:faceZ>0?[0,1,2,0,2,3]:[0,2,1,0,3,2],
    uv:(faceZ>0?[[0,1],[1,1],[1,0],[0,0]]:[[1,1],[0,1],[0,0],[1,0]])
      .flatMap(([u,v])=>[(rect.x+u*rect.w)/1024,(rect.y+v*rect.h)/1024])};
}

function mergeGeos(geos) {
  const wantUV = geos.some((g) => g.uv);
  const wantColor = geos.some((g) => g.col);
  const pos = [], nrm = [], idx = [], uv = wantUV ? [] : null, col = wantColor ? [] : null;
  for (const g of geos) {
    const off = pos.length / 3;
    pos.push(...g.pos); nrm.push(...g.nrm);
    if (uv) {
      if (g.uv) uv.push(...g.uv);
      else for (let i = 0; i < g.pos.length / 3; i++) uv.push(0, 0);
    }
    if (col) {
      if (g.col) col.push(...g.col);
      else for (let i = 0; i < g.pos.length / 3; i++) col.push(1, 1, 1);
    }
    for (const i of g.idx) idx.push(i + off);
  }
  return { pos, nrm, idx, uv, col };
}

function addMesh(name, geo, material, translation = [0, 0, 0]) {
  for (let i = 0; i < geo.idx.length; i += 3) {
    const [a,b,c] = geo.idx.slice(i,i+3);
    const ax=geo.pos[a*3], ay=geo.pos[a*3+1], az=geo.pos[a*3+2];
    const ux=geo.pos[b*3]-ax, uy=geo.pos[b*3+1]-ay, uz=geo.pos[b*3+2]-az;
    const vx=geo.pos[c*3]-ax, vy=geo.pos[c*3+1]-ay, vz=geo.pos[c*3+2]-az;
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const dot=nx*geo.nrm[a*3]+ny*geo.nrm[a*3+1]+nz*geo.nrm[a*3+2];
    if (dot <= 1e-8) throw new Error(`${name} triangle ${i/3} has inverted or degenerate winding (${dot})`);
  }
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
  if (geo.col) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(new Float32Array(geo.col)).setBuffer(buffer));
  // Reuse identical corners without merging crease normals.
  if (name === 'TradingFloorBrass' || name === 'TradingFloorClaws') weldPrimitive(prim);
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
  // Negative wall V places the image's first rows at floor level. One repeat
  // now spans all 950 wu, so the walnut cannot restart halfway up a wall.
  const panels = [];
  for (let x = 0; x < 512; x += 256) {
    panels.push(`<rect x="${x+13}" y="34" width="230" height="250" rx="3" fill="#683619" stroke="#321908" stroke-width="9"/>
      <rect x="${x+25}" y="46" width="206" height="226" fill="url(#wood)" stroke="#bd7740" stroke-width="5"/>
      <path d="M${x+34} 52 V266 M${x+56} 52 V266 M${x+151} 52 V266 M${x+209} 52 V266" stroke="#47220f" stroke-width="5" opacity=".35"/>
      <path d="M${x+43} 52 V266 M${x+72} 52 V266 M${x+175} 52 V266" stroke="#c08047" stroke-width="4" opacity=".32"/>
      <rect x="${x+15}" y="343" width="226" height="545" fill="url(#navy)" stroke="#b49356" stroke-width="5"/>
      <rect x="${x+27}" y="355" width="202" height="521" fill="none" stroke="#665631" stroke-width="4"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="1024">
  <defs><linearGradient id="wood" x2="1" y2="0"><stop stop-color="#8A4A20"/><stop offset=".5" stop-color="#A9622F"/><stop offset="1" stop-color="#793c1c"/></linearGradient>
  <linearGradient id="navy" x2="1" y2="1"><stop stop-color="#0b1a3a"/><stop offset="1" stop-color="#001858"/></linearGradient></defs>
  <g transform="translate(0 1024) scale(1 -1)"><rect width="512" height="1024" fill="#08152d"/>
  <rect width="512" height="308" fill="#8A4A20"/>${panels.join('')}
  <rect y="0" width="512" height="25" fill="#27180f"/><rect y="23" width="512" height="6" fill="#b37e44"/>
  <rect y="306" width="512" height="26" fill="#32261b"/><rect y="306" width="512" height="6" fill="#dda960"/>
  <rect y="895" width="512" height="129" fill="#30291e"/>
  <rect y="901" width="512" height="9" fill="#c29b55"/><rect y="922" width="512" height="8" fill="#806037"/>
  <rect y="949" width="512" height="45" fill="#4b3720"/><rect y="997" width="512" height="8" fill="#d1a964"/></g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function ceilingPanelPng() {
  const S = CEIL_TEX_PX, CELL = S / 2, RIB = 14;
  const cells = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const x = gx * CELL + RIB, y = gy * CELL + RIB, W = CELL - RIB * 2;
      cells.push(`
    <rect x="${x}" y="${y}" width="${W}" height="${W}" fill="#0b1a3a" stroke="#8f7546" stroke-width="5"/>
    <rect x="${x + 10}" y="${y + 10}" width="${W - 20}" height="${W - 20}" fill="#132d50" stroke="#36476a" stroke-width="5"/>`);
    }
  }
  // Brighter than it looks right, on purpose. The ceiling's normal is -Y, so
  // it takes NO directional key and only the hemisphere's GROUND term; a
  // ceiling authored at wall brightness renders as a black void overhead.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <rect width="${S}" height="${S}" fill="#8e826d"/>
  <rect width="${S}" height="7" fill="#e0c070"/>
  <rect y="${CELL}" width="${S}" height="7" fill="#e0c070"/>
  <rect width="7" height="${S}" fill="#e0c070"/>
  <rect x="${CELL}" width="7" height="${S}" fill="#e0c070"/>
  ${cells.join('\n')}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Dark stone panels carry champagne inlay. The former mean was the LINEAR
// triple [0.052, 0.068, 0.086]. `normalizeMeanLinear` keeps the new target
// stable when the stone artwork changes.
// 69% of the old mean gives the hall darker stone without crushing it to black.
const FLOOR_TARGET_LINEAR = [0.036, 0.045, 0.056];

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
  const S = FLOOR_TEX_PX, CELL = S / 2, SEAM = 3;
  const panels = [];
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      const x = gx * CELL + SEAM, y = gy * CELL + SEAM, W = CELL - SEAM * 2;
      panels.push(`
    <rect x="${x}" y="${y}" width="${W}" height="${W}" fill="url(#deck)"/>
    <rect x="${x+8}" y="${y+8}" width="${W-16}" height="${W-16}" fill="none" stroke="#9a875c" stroke-width="2" opacity=".42"/>
    <path d="M${x+18} ${y+32} H${x+W-18}" stroke="#78859a" stroke-width="5" opacity=".18"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
  <defs>
    <linearGradient id="deck" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#263746"/>
      <stop offset="1" stop-color="#101f31"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="#6d6248"/>
  ${panels.join('\n')}
</svg>`;
  return normalizeMeanLinear(await sharp(Buffer.from(svg)).png().toBuffer(), FLOOR_TARGET_LINEAR);
}

async function granitePng() {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
    <defs>
      <radialGradient id="cloud"><stop stop-color="#6a6e78"/><stop offset="1" stop-color="#4a4d55" stop-opacity="0"/></radialGradient>
      <filter id="soft"><feGaussianBlur stdDeviation="2"/></filter>
    </defs>
    <rect width="256" height="256" fill="#4a4d55"/>
    <ellipse cx="47" cy="88" rx="112" ry="72" fill="url(#cloud)" opacity=".7"/>
    <ellipse cx="206" cy="207" rx="119" ry="83" fill="url(#cloud)" opacity=".55"/>
    <ellipse cx="172" cy="30" rx="90" ry="64" fill="#363941" opacity=".20" filter="url(#soft)"/>
    <g fill="none" stroke="#6a6e78" stroke-linecap="round" filter="url(#soft)" opacity=".65">
      <path d="M-8 185 C42 153 60 169 105 125 S175 92 264 34" stroke-width="6"/>
      <path d="M18 257 C57 218 79 232 121 194 S187 177 229 132" stroke-width="4"/>
      <path d="M87 -7 C108 34 134 39 151 68 S188 99 197 116" stroke-width="4"/>
    </g>
  </svg>`)).png().toBuffer();
}

// ------------------------------------------------------------- 1. shell -----
const WALL_M = texturedMat('TradingFloorWall', await wallPanelPng(), { rough: 0.82 });
const CEIL_M = texturedMat('TradingFloorCeiling', await ceilingPanelPng(), { rough: 0.86 });
// rough 0.55 is carried over from the factor-only v2 floor on purpose: it is
// what gives the deck its broad sheen under the directional key, and
// `texturedMat`'s 0.92 default would flatten it.
const FLOOR_M = texturedMat('TradingFloorFloor', await floorPanelPng(), { rough: 0.45 });
const TRIM = mat('TradingFloorTrim', [1, 1, 1], { unlit: true });
const BRASS = mat('TradingFloorBrass', [0.75, 0.53, 0.16], { rough: 0.32, metal: 0.25 })
  .setEmissiveFactor([0.13, 0.095, 0.032]);
const GRANITE = texturedMat('TradingFloorGranite', await granitePng(), { rough: 0.28, metal: 0.02 });
const atlasPath = resolve(dirname(output), 'lane-a-identity-atlas.png');
const bannerAtlasRect = JSON.parse(execFileSync('python', [
  resolve(REPO_ROOT, 'scripts/trading-floor/render-identity-atlas.py'), atlasPath,
], { encoding: 'utf8' }));
const IDENTITY = texturedMat('TradingFloorIdentity', await sharp(atlasPath).png().toBuffer(), { rough: 0.6 });
IDENTITY.setDoubleSided(true);
IDENTITY.setAlphaMode('MASK');
IDENTITY.setEmissiveTexture(IDENTITY.getBaseColorTexture()).setEmissiveFactor([0.3, 0.26, 0.14]);
// Lighter than a task chair really is. The first v2 pass used 0.085 and the
// chairs rendered as a stack of black slabs against a mid-grey floor — a dark
// prop in a room with no shadows has nothing to separate its own faces.
const CHAIR_M = mat('TradingFloorChair', [1, 1, 1], { rough: 0.48, metal: 0.18 });

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
const sidePilasterZ = [-1250, -750, -250, 250, 750, 1250];
const backPilasterX = [-1575, 1575];

addMesh(
  'TradingFloorWalls',
  group('walls', null, () => mergeGeos([
    boxGeo(0, RH / 2, -hz - WT / 2, RW + WT * 2, RH, WT, {u:WALL_TILE_WU,v:RH}),       // back (-Z)
    boxGeo(-hx - WT / 2, RH / 2, 0, WT, RH, RD, {u:WALL_TILE_WU,v:RH}),                // left
    boxGeo(hx + WT / 2, RH / 2, 0, WT, RH, RD, {u:WALL_TILE_WU,v:RH}),                 // right
    // front (+Z) wall, split around the entrance so the arch lines up with
    // the exterior doorway (both are centred on +Z). Include the outer-wall
    // thickness in each centre offset: the visible reveal stays at +/-180.
    boxGeo(-(DOOR_W / 2 + (RW - DOOR_W) / 4 + WT / 2), RH / 2, hz + WT / 2, (RW - DOOR_W) / 2 + WT, RH, WT, {u:WALL_TILE_WU,v:RH}),
    boxGeo(DOOR_W / 2 + (RW - DOOR_W) / 4 + WT / 2, RH / 2, hz + WT / 2, (RW - DOOR_W) / 2 + WT, RH, WT, {u:WALL_TILE_WU,v:RH}),
    boxGeo(0, DOOR_H + (RH - DOOR_H) / 2, hz + WT / 2, DOOR_W, RH - DOOR_H, WT, {u:WALL_TILE_WU,v:RH}),  // lintel
    // Four corner pillars. These DO stand in reachable floor, which is legal
    // only because they are colliders — see the pillar entries in
    // TRADING_FLOOR_SOLIDS. If that collider is ever removed, remove this
    // exemption in the same diff or the gate stops protecting the room.
    ...[[-hx + 217.5, -hz + 285], [hx - 217.5, -hz + 285], [-hx + 217.5, hz - 285], [hx - 217.5, hz - 285]].map(
      ([x, z]) => boxGeo(x, RH / 2, z, 165, RH, 165, {u:WALL_TILE_WU,v:RH}, {
        label: 'corner pillar',
        exempt: 'collider in TRADING_FLOOR_SOLIDS',
      })
    ),
    // side-wall pilasters
    ...sidePilasterZ.flatMap((z) => [
      boxGeo(-hx + PIL_D / 2, RH / 2, z, PIL_D, RH, PIL_W, {u:WALL_TILE_WU,v:RH}),
      boxGeo(hx - PIL_D / 2, RH / 2, z, PIL_D, RH, PIL_W, {u:WALL_TILE_WU,v:RH}),
    ]),
    // back-wall pilasters, outboard of the screen (screen half-width is 1275)
    // Inner face z=-1612; these outboard pilasters lie beyond the camera X margin band.
    ...backPilasterX.map((x) => boxGeo(x, RH / 2, -hz + 19, PIL_W, RH, 38, {u:WALL_TILE_WU,v:RH})),
    // The board surround now belongs to the single brass mesh below.
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
    // `-hz + 12` puts the frame face at -1066; the glow now ends at -1060.5.
    // The extra half-unit preserves the 6 wu camera margin after quantization.
    // The glow stands 5.5 wu proud of the frame, so they cannot z-fight. MOVE THEM
    // TOGETHER or that separation is what breaks. Found by tf3d-audit,
    // 2026-09-19; the pilaster 40/6 derivation below does NOT generalise to
    // wall detail, and the surround was the deepest protrusion in the room.
  ])),
  WALL_M
);

addMesh(
  'TradingFloorCeiling',
  group('ceiling', null, () => boxGeo(0, RH + WT / 2, 0, RW + WT * 2, WT, RD + WT * 2, CEIL_TILE_WU)),
  CEIL_M
);

const brassGeos = group('brass', null, () => [
  // Chair rail and crown stand proud of each inner wall. The entrance breaks
  // the front rail; the side-wall pilaster lips cover their own faces.
  boxGeo(0, 444, -hz + 7, RW, 27, 12),
  boxGeo(-hx + 7, 444, 0, 12, 27, RD), boxGeo(hx - 7, 444, 0, 12, 27, RD),
  boxGeo(-1066, 444, hz - 1, 1768, 27, 8), boxGeo(1066, 444, hz - 1, 1768, 27, 8),
  ...sidePilasterZ.flatMap((z) => [
    boxGeo(-hx + PIL_D + 7, 444, z, 12, 27, PIL_W),
    boxGeo(hx - PIL_D - 7, 444, z, 12, 27, PIL_W),
  ]),
  boxGeo(0, 1387.5, -hz + 7, RW, 30, 15),
  boxGeo(-hx + 7, 1387.5, 0, 15, 30, RD), boxGeo(hx - 7, 1387.5, 0, 15, 30, RD),
  boxGeo(0, 1387.5, hz - 7, RW, 30, 15),
  // Exact v2 board surround positions and sizes, now gilt.
  boxGeo(0, SCREEN_BOTTOM_Y + SCREEN_H + FRAME_W / 2, -hz + FRAME_INSET, SCREEN_W + FRAME_W * 2, FRAME_W, FRAME_DEPTH),
  boxGeo(0, SCREEN_BOTTOM_Y - FRAME_W / 2, -hz + FRAME_INSET, SCREEN_W + FRAME_W * 2, FRAME_W, FRAME_DEPTH),
  boxGeo(-(SCREEN_W / 2 + FRAME_W / 2), SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + FRAME_INSET, FRAME_W, SCREEN_H + FRAME_W * 2, FRAME_DEPTH),
  boxGeo(SCREEN_W / 2 + FRAME_W / 2, SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + FRAME_INSET, FRAME_W, SCREEN_H + FRAME_W * 2, FRAME_DEPTH),
  // Thin tier rims share the brass draw call with the room trim.
  ...[[32,350,346,65],[50,330,210,55],[70,310,160,35]].map(([y,x,z,c]) =>
    group('plinth rim', 'inside TradingFloorHoloDais collider', () =>
      octagonGeo(DAIS_POS[0], y, DAIS_POS[2], x, z, 3.5, c, 0, false))),
]);

// All portal faces stay outside the player/camera clamps. The door leaves
// sit inside the existing 60 wu wall thickness, behind its z=1100 inner face.
brassGeos.push(...group('door portal', null, () => [
  ...[-1,1].map((side) => boxGeo(side*(DOOR_W/2+11.5), DOOR_H/2, hz, 28, DOOR_H, 11)),
  boxGeo(0, DOOR_H+11.9, hz-4, DOOR_W+56, 28, 16),
  boxGeo(0, DOOR_H+42, hz-8, DOOR_W+84, 28, 24),
  boxGeo(0, DOOR_H+68, hz-5, DOOR_W+104, 12, 30),
  boxGeo(0, DOOR_H+100, hz-4, DOOR_W+40, 56, 16),
  // Keystone on the cornice, and the narrow frames of the two glass leaves.
  boxGeo(0, DOOR_H+40, hz-24, 30, 40, 12),
  ...[-DOOR_W/2+6,0,DOOR_W/2-6].map((x) => boxGeo(x, DOOR_H/2, hz+24, 12, DOOR_H, 12)),
  ...[6,DOOR_H-6].map((y) => boxGeo(0, y, hz+24, DOOR_W, 12, 12)),
  ...[-24,24].flatMap((x) => [
    boxGeo(x, 240, hz+15, 10, 130, 8),
    ...[180,300].map((y) => boxGeo(x, y, hz+22, 10, 10, 14)),
  ]),
]));
brassGeos.push(group('plinth plaque', 'front protrudes 2 wu beyond the dais collider face z=286; plate is 3 wu deep', () =>
  boxGeo(0,16,DAIS_POS[2]+346.5,260,24,3)));

const plinthTiers = [[0,350,346,32,65],[32,330,210,18,55],[50,310,160,20,35]];
addMesh('TradingFloorHoloDais', group('dais collider', 'collider in TRADING_FLOOR_SOLIDS', () =>
  // Recess the upper 5 wu by 1.5 wu. The lower faces retain the exact footprint.
  // The parallel inset also preserves the eight corner-face offsets.
  mergeGeos(plinthTiers.flatMap(([y,x,z,h,c]) => [
    octagonGeo(DAIS_POS[0], y, DAIS_POS[2], x, z, h-5, c, 180),
    octagonGeo(DAIS_POS[0], y+h-5, DAIS_POS[2], x-1.5, z-1.5, 5,
      c-(2-Math.SQRT2)*1.5, 180),
  ]))), GRANITE);

addMesh('TradingFloorIdentity', mergeGeos([
  group('floor seal', null, () => ringGeo(DAIS_POS[0], 1.5, DAIS_POS[2], 570, 900, 96, true)),
  ...[-1944,1944].map((x) => group('wall banners', null, () => bannerGeo(x, 810, -1462.5, 315, 630))),
  group('door label', null, () =>
    labelGeo(bannerAtlasRect.lintel,0,DOOR_H+100,hz-12.2,360,-1)),
]), IDENTITY);

addMesh(
  'TradingFloorTrimGlow',
  group('trim', null, () => mergeGeos([
    // 2.5 wu warm-gold bands stand 0.75 wu proud of the recessed granite faces,
    // below the brass rims and 0.75 wu inside the original collider footprint.
    ...group('plinth glow', 'inside TradingFloorHoloDais collider; faces recessed 1.5 wu, glow inset 0.75 wu', () =>
      plinthTiers.map(([y,x,z,h,c]) => colored(
        octagonGeo(DAIS_POS[0], y+h-4, DAIS_POS[2], x-.75, z-.75, 2.5,
          c-(2-Math.SQRT2)*.75, 0, false), [255,200,96].map(srgbToLinear)))),
    ...group('smoked doors', null, () => [-1,1].map((side) =>
      colored(boxGeo(side*DOOR_W/4,DOOR_H/2,hz+32,DOOR_W/2-12,DOOR_H-24,8), [.018,.038,.075]))),
    // Restrained vertical reflections make the opaque smoked panels read as
    // glass without transparency sorting, a new material or a new draw call.
    ...group('glass reflections', null, () => [-1,1].map((side) =>
      colored(boxGeo(side*126,275,hz+27.8,6,370,.2), [.038,.068,.105]))),
    colored(boxGeo(0, 39, -hz + 6, RW, 24, 10), [.08,.28,.94]),             // blue base strips
    colored(boxGeo(-hx + 6, 39, 0, 10, 24, RD), [.08,.28,.94]),
    colored(boxGeo(hx - 6, 39, 0, 10, 24, RD), [.08,.28,.94]),
    colored(boxGeo(0, RH - 60, -hz + 6, RW, 18, 10), [.08,.28,.94]),
    // ceiling light strips — three runs down the length of the hall. A lit
    // grid overhead is most of what makes an interior read as a ROOM rather
    // than a box, and it costs nothing: same unlit material, same mesh.
    ...[-1050, 0, 1050].map((z) => colored(boxGeo(0, RH - 21, z, RW - 360, 21, 96), [1,.81,.55])),
    // Screen surround glow, 5.5 wu proud of the frame. `-hz + 35.5` is paired with
    // the frame's `-hz + 12` above and the two MUST move together: this inner
    // face is the deepest protrusion in the room, and at the old `-hz + 46` it
    // sat 4 wu past the player-centre clamp. See the note on the frame.
    colored(boxGeo(0, SCREEN_BOTTOM_Y + SCREEN_H + 15, -hz + GLOW_INSET, SCREEN_W + 60, 18, 8), [.08,.28,.94]),
    colored(boxGeo(0, SCREEN_BOTTOM_Y - 15, -hz + GLOW_INSET, SCREEN_W + 60, 18, 8), [.08,.28,.94]),
    colored(boxGeo(-(SCREEN_W / 2 + 15), SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + GLOW_INSET, 18, SCREEN_H + 60, 8), [.08,.28,.94]),
    colored(boxGeo(SCREEN_W / 2 + 15, SCREEN_BOTTOM_Y + SCREEN_H / 2, -hz + GLOW_INSET, 18, SCREEN_H + 60, 8), [.08,.28,.94]),
  ])),
  TRIM
);

// ------------------------------------------------------------- 2. chair -----
// ONE authored chair at the origin with a base-centre pivot, exactly like the
// console module: the scene extracts it, draws the six-seat row as a single
// InstancedMesh and removes the original. Dimensions come from the avatar, not
// from the room. Cushion top remains 85 wu; the occupant faces +Z at rotY 0.
const LEATHER = [.24,.025,.035], LEATHER_PAD = [.30,.033,.046];
const CHROME = [.43,.49,.56], CHAIR_DARK = [.035,.044,.056];
addMesh(
  'TradingFloorChairModule',
  // Exempt as a whole: this authored copy sits at the ORIGIN, dead centre of
  // the room, and would trip the gate on every box. It never renders there —
  // `buildInstancedRow` extracts it, draws the six-seat row and removes the
  // original. The instanced copies stand at seat positions derived from the
  // desk constants, which the collider set covers.
  group('chair template', 'extracted at runtime; authored copy never renders', () => mergeGeos([
    colored(boxGeo(0, 65, 4, 94, 8, 86), CHAIR_DARK),
    colored(cushionGeo(0, 76, 4, 104, 18, 98, 6), LEATHER_PAD),
    colored(cushionGeo(0, 127, -44, 102, 94, 24, 9), LEATHER),
    // Three padded bands leave two recessed horizontal tuft seams. The back
    // shell closes the seams, so neither is a gap through the chair.
    ...[100.5,129.5,158.5].map((y) => colored(cushionGeo(0,y,-34,94,29,8,3,true), LEATHER_PAD)),
    ...[-57,57].flatMap((x) => [
      colored(cushionGeo(x,103,4,14,14,82,5), LEATHER_PAD),
      colored(boxGeo(Math.sign(x)*54,82,15,8,36,8), CHROME),
    ]),
    colored(cylinderGeo(0,40,0,8,44,10), CHROME),
    colored(cylinderGeo(0,22,0,12,14), CHAIR_DARK),
    // Five legs, with symmetric XZ extrema despite the odd spoke count:
    // casters end at x ±64 and z ±61. Quantization must not shift the anchor.
    ...[[0,54],[57,18],[35,-54],[-35,-54],[-57,18]].flatMap(([x,z]) => [
      colored(spokeGeo(x,z), CHROME),
      colored(cylinderGeo(x,7,z,7,14,8,0), CHAIR_DARK),
    ]),
  ])),
  CHAIR_M,
  [0, 0, 0]
);

// ------------------------------------------------------------- 2b. desk -----
// One 512 x 256 atlas replaces the Meshy console map. Wood uses planar UVs;
// lacquer/brass/plastic use constant swatches, so mipmaps cannot mix regions.
// Broad 4 px grain and 8 px keys survive ETC1S. No runtime shader is required.
let deskAtlas = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256">
  <defs><linearGradient id="walnut" x2="0" y2="1"><stop stop-color="#865538"/>
    <stop offset=".45" stop-color="#a4724a"/><stop offset="1" stop-color="#71422b"/></linearGradient></defs>
  <rect width="512" height="256" fill="#171c24"/>
  <rect width="320" height="256" fill="url(#walnut)"/>
  <g fill="none" stroke="#45291d" stroke-width="4" opacity=".27">
    ${[8,26,51,85,117,153,188,231].map((y,i)=>`<path d="M-8 ${y} C${60+i*9} ${y-12-(i%3)*9} ${170+i*11} ${y+17+(i%2)*12} 328 ${y+5}"/>`).join('')}
    <path d="M-8 128 C48 133 51 150 116 150 S178 115 328 122 M-8 166 C66 173 80 180 137 174 S200 144 328 158"/>
    <ellipse cx="110" cy="157" rx="32" ry="8"/>
  </g><g fill="none" stroke="#d49b66" stroke-width="4" opacity=".18">
    ${[34,68,105,182,218].map((y,i)=>`<path d="M-8 ${y} C92 ${y+12+i*2} 217 ${y-16-i*3} 328 ${y+8}"/>`).join('')}
  </g>
  <rect x="336" width="48" height="48" fill="#111820"/>
  <rect x="392" width="48" height="48" fill="#d0a050"/>
  <rect x="448" width="48" height="48" fill="#252d38"/>
  <rect x="336" y="64" width="160" height="88" rx="4" fill="#101720"/>
  ${Array.from({length:5},(_,row)=>Array.from({length:12},(_,col)=>
    `<rect x="${344+col*12}" y="${72+row*12}" width="8" height="8" fill="${row===0?'#8491a0':'#b8bcc2'}"/>`).join('')).join('')}
  <rect x="368" y="136" width="96" height="8" fill="#b8bcc2"/>
</svg>`)).png().toBuffer();
// Dedicated bottom-face tiles: black 336..416, drawer wood 424..504,
// both y168..248, with a 4 px inset. Existing constant swatches stay clean.
// V increases down the image: the last 12 px fade over 19 wu of cabinet
// height, or 14 wu above the drawer's y24 lower edge. No geometry is split.
const drawerCrop = await sharp(deskAtlas).extract({left:8,top:43,width:304,height:125}).png().toBuffer();
const drawerTile = await sharp(drawerCrop).flip().resize(72,72)
  .extend({top:4,bottom:4,left:4,right:4,extendWith:'copy'}).png().toBuffer();
deskAtlas = await sharp(deskAtlas).composite([
  {input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#111820"/></svg>`),left:336,top:168},
  {input:drawerTile,left:424,top:168},
  ...[336,424].map((left)=>({left,top:168,input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
    <defs><linearGradient id="algae" x1="0" y1="1" x2="0" y2="0">
      <stop stop-color="#45482b" stop-opacity=".68"/><stop offset=".5" stop-color="#4c5130" stop-opacity=".3"/>
      <stop offset="1" stop-color="#4c5130" stop-opacity="0"/></linearGradient></defs>
    <rect y="64" width="80" height="16" fill="url(#algae)"/>
    <g fill="#505433" opacity=".32">
      <path d="M4 80 V72 Q8 66 12 72 L16 80 Z M28 80 V76 Q32 68 36 72 L40 80 Z M56 80 V72 Q60 64 64 72 L68 80 Z"/>
    </g><g stroke="#59603a" stroke-width="4" opacity=".22" fill="none">
      <path d="M20 80 Q24 76 20 72 M48 80 Q44 72 48 68 M72 80 Q76 76 72 72"/>
    </g></svg>`)})),
]).png().toBuffer();
const DESK_M = texturedMat('TradingFloorConsoleModuleMtl', deskAtlas, {rough:.32,metal:.12});
DESK_M.getBaseColorTextureInfo().setWrapS(33071).setWrapT(33071);

function deskSurface(geo, finish) {
  const swatches = {black:[360,24], brass:[416,24], plastic:[472,24]};
  const bottomBlack = finish === 'blackBottom';
  const bottomWood = finish === 'woodBottom';
  const min = [0,2].map((axis)=>Math.min(...geo.pos.filter((_,i)=>i%3===axis)));
  const max = [0,2].map((axis)=>Math.max(...geo.pos.filter((_,i)=>i%3===axis)));
  geo.uv=[];
  for(let i=0;i<geo.pos.length;i+=3) {
    const [x,y,z]=geo.pos.slice(i,i+3), nx=geo.nrm[i], ny=geo.nrm[i+1];
    if((bottomBlack && ny < .5) || (bottomWood && geo.nrm[i+2] > .5)) {
      const axis=Math.abs(nx)>.5?1:0, coord=axis?z:x;
      const u=bottomWood?(x+182)/364:(coord-min[axis])/(max[axis]-min[axis]);
      const height=bottomWood?(y-24)/86:y/116;
      geo.uv.push(((bottomWood?428:340)+u*72)/512,(244-height*72)/256);
    } else if(finish==='wood' || bottomWood) {
      const u=Math.abs(nx)>.5?(z+135)/270:(x+182)/364, v=Math.abs(ny)>.5?(z+135)/270:y/166;
      geo.uv.push((8+u*304)/512,(8+v*240)/256);
    } else geo.uv.push(...swatches[bottomBlack?'black':finish].map((v,i)=>v/(i?256:512)));
  }
  return geo;
}

const deskGeo=group('console template', 'extracted at runtime; collider in TRADING_FLOOR_SOLIDS', () => {
  const surface=(geo,finish)=>deskSurface(geo,finish);
  const parts=[
    surface(cushionGeo(0,124,0,364,16,270,5), 'wood'),
    surface(cushionGeo(0,119,0,364,3,270,1), 'brass'),
    // Cabinet bases meet the floor; inset front faces form recessed toe kicks.
    ...[-132,132].flatMap((x)=>[
      surface(boxGeo(x,8,-18,80,16,182), 'blackBottom'),
      surface(boxGeo(x,66,-8,88,100,206), 'blackBottom'),
      surface(boxGeo(x,67,95.5,72,86,1), 'woodBottom'),
      ...[-34,34].map((dx)=>surface(boxGeo(x+dx,67,96.3,2,86,1), 'brass')),
      surface(boxGeo(x,95,97,26,3,3), 'brass'),
    ]),
    surface(boxGeo(0,66,-91,176,100,14), 'blackBottom'),
    surface(boxGeo(0,62,-82.5,164,72,1), 'wood'),
    // FLAT hood top covers the full mount band, including the back boundary.
    surface(boxGeo(0,149,-117.5,352,34,35), 'black'),
    surface(boxGeo(0,164,-99,352,4,2), 'brass'),
    surface(cushionGeo(-20,136,65,136,8,44,3), 'plastic'),
    surface(cushionGeo(80,137,72,22,10,33,4), 'plastic'),
    surface(boxGeo(80,142.2,77,1.5,.5,8), 'black'),
    // Turret phone: keypad base, cradle and a bridged handset with end pads.
    surface(cushionGeo(-133,139,18,68,14,57,5), 'plastic'),
    surface(boxGeo(-133,150,-2,54,8,10), 'black'),
    surface(cushionGeo(-133,156,-2,60,10,16,4), 'black'),
    ...[-23,23].map((dx)=>surface(cushionGeo(-133+dx,156,-2,16,16,23,5,true), 'plastic')),
    surface(boxGeo(125,134,79,48,3,15), 'brass'),
    surface(boxGeo(125,135.7,79,32,.3,2), 'black'),
  ];
  // Keyboard and phone keys share the atlas grid; both lie in front of the hood.
  for(const [x,y,z,w,d] of [[-20,140.2,65,126,34],[-133,146.2,28,42,26]]) {
    const geo={pos:[x-w/2,y,z-d/2,x-w/2,y,z+d/2,x+w/2,y,z+d/2,x+w/2,y,z-d/2],
      nrm:Array(4).fill([0,1,0]).flat(),idx:[0,1,2,0,2,3],
      uv:[336/512,64/256,336/512,152/256,496/512,152/256,496/512,64/256]};
    boxRegistry.push({group:currentGroup.name,exempt:currentGroup.exempt,
      min:[x-w/2,y,z-d/2],max:[x+w/2,y,z+d/2]});
    parts.push(geo);
  }
  return mergeGeos(parts);
});
addMesh('TradingFloorConsoleModule',deskGeo,DESK_M,[-CONSOLE_WALL_X,0,CONSOLE_ROW_Z[0]]);
console.log(`  procedural desk: ${deskGeo.idx.length/3} tris, base-centred 364 x 166 x 270; hood y166, x ±176, z -135..-100`);

// Run the gate after the sourced claw is registered below. Both template
// modules retain the existing exemption; the kiosk has collider protection.

// ------------------------------------------------------------- 3. props -----
// The kiosk is copied verbatim out of the v1 stage-1 build. It was decimated,
// scaled and re-centred on its base there; re-running that work needs the Meshy
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

await copyProp('TradingFloorMonitorStation', 'TradingFloorMonitorStation', MONITOR_POS, MONITOR_SCALE);
scene.listChildren().find((n) => n.getName() === 'TradingFloorMonitorStation')
  .setRotation([0, Math.sin(MONITOR_ROT_Y / 2), 0, Math.cos(MONITOR_ROT_Y / 2)]);

// Read the solid Meshy claw, including the quantizer's node transform.
// getElement decodes normalized integers; positions use the full world matrix
// and normals use its inverse transpose. Reject source textures and extensions.
const clawSource = await io.readAsJSON(resolve(REPO_ROOT,
  'apps/web/public/models/trading-floor/trading-floor-exterior-opt1-mo-ktx.glb'));
const clawDoc = await io.readJSON(clawSource);
const clawNode = clawDoc.getRoot().listNodes().find((n) => n.getName()==='TradingFloorClawProp');
if (!clawNode?.getMesh()) throw new Error('exterior has no TradingFloorClawProp mesh');
const exteriorClawMaterial = clawDoc.getRoot().listMaterials()
  .find((material) => material.getName() === 'TradingFloorClawMtl');
if (!exteriorClawMaterial) throw new Error('exterior has no TradingFloorClawMtl material');
const clawTextureCount = [
  exteriorClawMaterial.getBaseColorTexture(), exteriorClawMaterial.getEmissiveTexture(),
  exteriorClawMaterial.getMetallicRoughnessTexture(), exteriorClawMaterial.getNormalTexture(),
  exteriorClawMaterial.getOcclusionTexture(),
].filter((texture) => texture !== null).length;
// Read raw extension names too: the decoder can ignore unknown extensions.
const clawExtensions = Object.keys(clawSource.json.materials
  .find((material) => material.name === 'TradingFloorClawMtl').extensions ?? {});
const clawAlphaMode = exteriorClawMaterial.getAlphaMode();
if (clawTextureCount || clawExtensions.length || clawAlphaMode !== 'OPAQUE') {
  throw new Error(`exterior TradingFloorClawMtl must be texture-free, extension-free and OPAQUE: ${JSON.stringify({
    textures: clawTextureCount, extensions: clawExtensions, alphaMode: clawAlphaMode,
  })}`);
}
const CLAW = doc.createMaterial('TradingFloorClawMtl')
  .setBaseColorFactor(exteriorClawMaterial.getBaseColorFactor())
  .setEmissiveFactor(exteriorClawMaterial.getEmissiveFactor())
  .setRoughnessFactor(exteriorClawMaterial.getRoughnessFactor())
  .setMetallicFactor(exteriorClawMaterial.getMetallicFactor())
  .setDoubleSided(exteriorClawMaterial.getDoubleSided());
console.log(`  copied exterior TradingFloorClawMtl: ${JSON.stringify({
  baseColorFactor: CLAW.getBaseColorFactor(), emissiveFactor: CLAW.getEmissiveFactor(),
  roughnessFactor: CLAW.getRoughnessFactor(), metallicFactor: CLAW.getMetallicFactor(),
  doubleSided: CLAW.getDoubleSided(), alphaMode: clawAlphaMode,
  textures: clawTextureCount, extensions: clawExtensions,
})}`);
const world = clawNode.getWorldMatrix();
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const columns = [[world[0],world[1],world[2]],[world[4],world[5],world[6]],[world[8],world[9],world[10]]];
const cofactors = [cross(columns[1],columns[2]),cross(columns[2],columns[0]),cross(columns[0],columns[1])];
const determinant = columns[0].reduce((sum,v,i)=>sum+v*cofactors[0][i],0);
if (Math.abs(determinant)<1e-12) throw new Error('claw world transform is singular');
const clawBase = mergeGeos(clawNode.getMesh().listPrimitives().map((primitive) => {
  const positions=primitive.getAttribute('POSITION'), normals=primitive.getAttribute('NORMAL');
  if (!positions || !normals) throw new Error('solid claw needs positions and normals');
  const pos=[], nrm=[];
  for(let i=0;i<positions.getCount();i++) {
    const p=positions.getElement(i,[]), n=normals.getElement(i,[]);
    pos.push(...[0,1,2].map((axis)=>world[12+axis]+columns.reduce((sum,c,j)=>sum+c[axis]*p[j],0)));
    const transformed=[0,1,2].map((axis)=>cofactors.reduce((sum,c,j)=>sum+c[axis]*n[j],0)/determinant);
    const length=Math.hypot(...transformed);
    nrm.push(...transformed.map((v)=>v/length));
  }
  const idx=primitive.getIndices()?Array.from(primitive.getIndices().getArray()):Array.from({length:positions.getCount()},(_,i)=>i);
  if(determinant<0) for(let i=0;i<idx.length;i+=3) [idx[i+1],idx[i+2]]=[idx[i+2],idx[i+1]];
  return {pos,nrm,idx,uv:null};
}));
const sourceMin=[0,1,2].map((axis)=>Math.min(...clawBase.pos.filter((_,i)=>i%3===axis)));
const sourceMax=[0,1,2].map((axis)=>Math.max(...clawBase.pos.filter((_,i)=>i%3===axis)));
const clawScale=158/(sourceMax[1]-sourceMin[1]);
for(let i=0;i<clawBase.pos.length;i+=3) {
  clawBase.pos[i]=(clawBase.pos[i]-(sourceMin[0]+sourceMax[0])/2)*clawScale;
  clawBase.pos[i+1]=(clawBase.pos[i+1]-sourceMin[1])*clawScale;
  clawBase.pos[i+2]=(clawBase.pos[i+2]-(sourceMin[2]+sourceMax[2])/2)*clawScale;
}
const clawSculpt = sculptClaw(clawBase);
const clawBounds=[];
const clawGeos=[];
for (const [centreX, mirror] of [[-220, false], [220, true]]) {
  const geo={...clawSculpt,pos:[...clawSculpt.pos],nrm:[...clawSculpt.nrm],idx:[...clawSculpt.idx]};
  const yaw=(mirror?-1:1)*28*Math.PI/180, co=Math.cos(yaw), si=Math.sin(yaw);
  for(let i=0;i<geo.pos.length;i+=3) {
    const x=(mirror?-1:1)*geo.pos[i], z=geo.pos[i+2];
    const nx=(mirror?-1:1)*geo.nrm[i], nz=geo.nrm[i+2];
    geo.pos[i]=centreX+co*x+si*z;
    geo.pos[i+1]+=70;
    geo.pos[i+2]=DAIS_POS[2]-si*x+co*z;
    geo.nrm[i]=co*nx+si*nz; geo.nrm[i+2]=-si*nx+co*nz;
    // The chamfered tier excludes the four corners of its rectangular AABB.
    if(Math.abs(geo.pos[i])>310 || Math.abs(geo.pos[i+2]-DAIS_POS[2])>160 ||
       Math.abs(geo.pos[i])+Math.abs(geo.pos[i+2]-DAIS_POS[2])>310+160-35)
      throw new Error('claw vertex exceeds the top tier');
  }
  if(mirror) for(let i=0;i<geo.idx.length;i+=3) [geo.idx[i+1],geo.idx[i+2]]=[geo.idx[i+2],geo.idx[i+1]];
  const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  for(let i=0;i<geo.pos.length;i+=3) for(let axis=0;axis<3;axis++) {
    const v=geo.pos[i+axis];
    bounds.min[axis]=Math.min(bounds.min[axis],v);
    bounds.max[axis]=Math.max(bounds.max[axis],v);
  }
  if(bounds.max[1]>230) throw new Error(`claw top ${bounds.max[1]} exceeds 230 wu`);
  if(bounds.min[0]<-310 || bounds.max[0]>310 ||
     bounds.min[2]<DAIS_POS[2]-160 || bounds.max[2]>DAIS_POS[2]+160)
    throw new Error(`claw exceeds the top tier: ${JSON.stringify(bounds)}`);
  boxRegistry.push({group:'claw',exempt:'inside TradingFloorHoloDais collider',
    min:bounds.min,max:bounds.max});
  clawBounds.push(bounds);
  clawGeos.push(geo);
}
for(const [y,x,z] of [[32,350,346],[50,330,210],[70,310,160]])
  if(x>350 || z>346) throw new Error(`plinth rim at y ${y} exceeds the dais solid`);
addMesh('TradingFloorBrass', mergeGeos(brassGeos), BRASS);
addMesh('TradingFloorClaws', mergeGeos(clawGeos), CLAW);
console.log(`  claws: solid Meshy copies, yaw +28/-28 deg, 158 wu over 70 wu plinth = ${clawBounds[0].max[1].toFixed(2)} wu top; AABBs ${JSON.stringify(clawBounds)}`);
assertWallDetailClears();

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
    rotY: MONITOR_ROT_Y,
    halfX: Number(((kiosk.maxX - kiosk.minX) / 2).toFixed(2)),
    halfZ: Number(((kiosk.maxZ - kiosk.minZ) / 2).toFixed(2)),
    height: Number((kiosk.maxY - kiosk.minY).toFixed(2)),
  },
  room: { halfX: hx, halfZ: hz, height: RH },
  statue: {top:Math.max(...clawBounds.map((b)=>b.max[1])),claws:clawBounds},
});
console.log(`  extras: screen ${SCREEN_W}x${SCREEN_H}@${SCREEN_BOTTOM_Y} | kiosk half ${scene.getExtras().kiosk.halfX}/${scene.getExtras().kiosk.halfZ} h${scene.getExtras().kiosk.height} | room ${hx}/${hz}/${RH}`);

await doc.transform(dedup(), prune());

let tris = 0;
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices().getCount() / 3;
console.log(
  `interior v5: ${tris} tris | ${doc.getRoot().listMeshes().length} meshes | ` +
    `${doc.getRoot().listMaterials().length} materials (= draw calls) | ` +
    `${doc.getRoot().listTextures().length} textures | room ${RW}x${RH}x${RD} wu, door ${DOOR_W}x${DOOR_H} on +Z`
);
console.log(
  `  screen surround ${SCREEN_W}x${SCREEN_H} bottom y=${SCREEN_BOTTOM_Y} at z=${SCREEN_Z} | ` +
    `desks x=+-${CONSOLE_WALL_X} z=[${CONSOLE_ROW_Z}] | monitor [${MONITOR_POS}]`
);

await io.write(output, doc);
console.log(`wrote ${output}`);
