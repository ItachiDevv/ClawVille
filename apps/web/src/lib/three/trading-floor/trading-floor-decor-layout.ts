/**
 * trading-floor-decor-layout.ts
 *
 * Pure layout for the Trading Floor's RUNTIME DECOR ("The Claw Exchange",
 * lane B, 2026-10-01): a trader rig on every desk, six big wall screens, the
 * LED ticker ribbon and the floor glow pools. No `three`, no React, no DOM.
 * Every builder returns plain typed arrays, so the clearance rules the room
 * depends on are tested against the SAME vertices the GPU draws, not against a
 * second description of them.
 *
 * THREE MESHES, THREE DRAW CALLS, and the split is by material, not by object:
 *   1. MONITORS. Every desk bank, its brass mount and the six wall screens share
 *      ONE atlas (`DECOR_ATLAS_SIZE` square, drawn once). Bezels and brass sample
 *      a solid swatch at a single UV point, so their derivatives are zero and the
 *      sampler stays on mip 0 at any distance: no swatch can bleed into a chart.
 *   2. RIBBON. One LED strip texture, crawled by UV.
 *   3. GLOW. One radial sprite, additive, tinted per pool by vertex colour.
 *
 * MOTION WITHOUT TEXTURE UPLOADS. Every chart band in the atlas is PERIODIC
 * along U (the art module builds each series on a closed loop), so a screen is
 * a U window into a band and moving the window is the animation. The scrolling
 * quads are emitted FIRST, so the per-frame upload is one contiguous range at
 * the start of the uv buffer. The atlas samples with `RepeatWrapping` on S: a
 * window that runs past u = 1 keeps sampling the band's own start, which is the
 * band's own continuation because the band is periodic. That is the same
 * sampler state on WebGPU and on the WebGL2 fallback (the atlas is a power of
 * two), and it is why no window ever has to be split at the seam.
 *
 * COORDINATES: interior world units, the frame `trading-floor-room.ts` uses.
 * Desk rigs are authored in the DESK'S OWN frame (the console faces local +Z,
 * the wall side is local -Z) and carried into the world through the slot's own
 * `rotY`, so the six rigs follow `TRADING_FLOOR_CONSOLE_ROW` and cannot drift
 * off their desks.
 */

import { TRADING_FLOOR_CONSOLE_ROW, TRADING_FLOOR_DESK_INNER_X, TRADING_FLOOR_ROOM, type TradingFloorConsoleSlot } from './trading-floor-room';

// ---------------------------------------------------------------------------
// Atlas map (canvas pixels). The art module draws INTO these rects; the layout
// samples OUT of them. One table, two readers.
// ---------------------------------------------------------------------------

/** The monitor atlas, square. Drawn once per mount, never redrawn. */
export const DECOR_ATLAS_SIZE = 1024;

export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DecorBand {
  readonly y: number;
  readonly height: number;
}

/**
 * The scrolling chart bands. Full atlas width, periodic along U, separated by
 * dark 8 px gutters so a mip level cannot smear one band into the next.
 */
export const DECOR_BANDS = Object.freeze({
  candleA: Object.freeze({ y: 0, height: 200 }),
  candleB: Object.freeze({ y: 208, height: 200 }),
  line: Object.freeze({ y: 416, height: 128 }),
  heat: Object.freeze({ y: 552, height: 128 }),
  bars: Object.freeze({ y: 688, height: 96 }),
});
export type DecorBandId = keyof typeof DECOR_BANDS;

/** A screen's V window stops this far inside its band, away from the gutter. */
export const DECOR_BAND_INSET = 4;

export const DECOR_DESK_HEADER_COUNT = 8;
export const DECOR_WALL_HEADER_COUNT = 2;
// Four panel slots are occupied; depth uses two UV orientations of one tile.
export const DECOR_DEPTH_PANEL_COUNT = 1;
export const DECOR_TERMINAL_PANEL_COUNT = 3;

function wrapIndex(index: number, count: number): number {
  return ((Math.trunc(index) % count) + count) % count;
}

/** Desk monitor header strip, with 8 px between rows. */
export function deskHeaderRect(variant: number): AtlasRect {
  const index = wrapIndex(variant, DECOR_DESK_HEADER_COUNT);
  return { x: 8 + (index % 4) * 256, y: 792 + Math.floor(index / 4) * 26, width: 240, height: 18 };
}

/** Wall screen header strip: 496 x 31. */
export function wallHeaderRect(variant: number): AtlasRect {
  const index = wrapIndex(variant, DECOR_WALL_HEADER_COUNT);
  return { x: 8 + index * 512, y: 844, width: 496, height: 31 };
}

/** Static depth and terminal panels: 240 x 113 for the 91 x 42.5 wu body. */
export function depthPanelRect(variant: number): AtlasRect {
  const index = wrapIndex(variant, DECOR_DEPTH_PANEL_COUNT);
  return { x: 8 + index * 256, y: 883, width: 240, height: 113 };
}

export function terminalPanelRect(variant: number): AtlasRect {
  const index = wrapIndex(variant, DECOR_TERMINAL_PANEL_COUNT);
  return { x: 264 + index * 256, y: 883, width: 240, height: 113 };
}

/** Alternate the unlabeled depth curves without consuming another atlas slot. */
export function depthPanelUv(variant: number): QuadUv {
  const uv = atlasRectUv(depthPanelRect(0));
  return wrapIndex(variant, 2) === 0 ? uv : { ...uv, u0: uv.u1, u1: uv.u0 };
}

/**
 * Solid colour swatches for everything that is not a screen. Unlit
 * (`MeshBasicMaterial`), so the face shading is baked by WHICH swatch a face
 * samples: fronts mid, sides dark, tops light.
 */
export const DECOR_SWATCH_IDS = [
  'bezelFront',
  'bezelSide',
  'bezelTop',
  'bezelBack',
  'screenBlack',
  'brassFront',
  'brassSide',
  'brassTop',
  'trimGold',
  'statusGreen',
  'statusAmber',
] as const;
export type DecorSwatchId = (typeof DECOR_SWATCH_IDS)[number];

export function swatchRect(id: DecorSwatchId): AtlasRect {
  const index = DECOR_SWATCH_IDS.indexOf(id);
  return { x: 8 + index * 32, y: 1008, width: 24, height: 12 };
}

// ---------------------------------------------------------------------------
// UVs
// ---------------------------------------------------------------------------

export interface QuadUv {
  readonly u0: number;
  readonly u1: number;
  readonly vTop: number;
  readonly vBottom: number;
}

/**
 * The UV rect of an atlas rect. `v` is flipped: a `CanvasTexture` carries
 * `flipY = true`, so canvas row 0 is the TOP of the image, `v = 1`.
 */
export function atlasRectUv(rect: AtlasRect, size: number = DECOR_ATLAS_SIZE): QuadUv {
  return {
    u0: rect.x / size,
    u1: (rect.x + rect.width) / size,
    vTop: 1 - rect.y / size,
    vBottom: 1 - (rect.y + rect.height) / size,
  };
}

/** All four corners on the swatch centre: a constant colour with zero UV
 *  derivatives, so it is sampled from mip 0 at every distance. */
export function swatchUv(id: DecorSwatchId): QuadUv {
  const rect = swatchRect(id);
  const u = (rect.x + rect.width / 2) / DECOR_ATLAS_SIZE;
  const v = 1 - (rect.y + rect.height / 2) / DECOR_ATLAS_SIZE;
  return { u0: u, u1: u, vTop: v, vBottom: v };
}

/** U width of a window into `band` for a quad of the given aspect, so the
 *  chart is never stretched: the window keeps the quad's width:height. */
export function bandWindowWidth(band: DecorBand, quadWidth: number, quadHeight: number): number {
  const texels = band.height - DECOR_BAND_INSET * 2;
  return ((quadWidth / quadHeight) * texels) / DECOR_ATLAS_SIZE;
}

function bandUv(band: DecorBand, u0: number, width: number): QuadUv {
  return {
    u0,
    u1: u0 + width,
    vTop: 1 - (band.y + DECOR_BAND_INSET) / DECOR_ATLAS_SIZE,
    vBottom: 1 - (band.y + band.height - DECOR_BAND_INSET) / DECOR_ATLAS_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Mesh data
// ---------------------------------------------------------------------------

export type DecorPart =
  | 'bank-screen'
  | 'bank-bezel'
  | 'bank-mount'
  | 'wall-screen'
  | 'wall-bezel'
  | 'ribbon-face'
  | 'ribbon-soffit'
  | 'glow-floor'
  | 'glow-desktop'
  | 'glow-wall';

export interface DecorQuadTag {
  readonly part: DecorPart;
  /** Desk index for bank parts, wall screen index for wall parts, segment
   *  index for the ribbon, pool index for the glow. */
  readonly owner: number;
}

/** Four vertices per quad in the order 0 bottom-left, 1 bottom-right,
 *  2 top-left, 3 top-right; two triangles (0,1,2) and (2,1,3), counter-
 *  clockwise from the quad's own normal. */
export interface DecorMeshData {
  readonly positions: Float32Array;
  readonly uvs: Float32Array;
  /** RGBA per vertex, itemSize 4 (three's `vertexColor()` node is a vec4). */
  readonly colors: Float32Array | null;
  readonly indices: Uint16Array;
  readonly tags: readonly DecorQuadTag[];
  readonly quadCount: number;
}

export const DECOR_VERTS_PER_QUAD = 4;
export const DECOR_UV_FLOATS_PER_QUAD = DECOR_VERTS_PER_QUAD * 2;

type Vec3 = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

const UP: Vec3 = [0, 1, 0];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function along(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  return [
    origin[0] + direction[0] * distance,
    origin[1] + direction[1] * distance,
    origin[2] + direction[2] * distance,
  ];
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

interface QuadSink {
  readonly positions: number[];
  readonly uvs: number[];
  readonly colors: number[];
  readonly tags: DecorQuadTag[];
}

function createSink(): QuadSink {
  return { positions: [], uvs: [], colors: [], tags: [] };
}

/**
 * Append one quad. `right` is DERIVED as `up x normal`, which makes
 * `right x up = normal` for any orthonormal pair, so every quad this module
 * emits is counter-clockwise when seen from the side its normal points at.
 */
function pushQuad(
  sink: QuadSink,
  center: Vec3,
  normal: Vec3,
  up: Vec3,
  halfRight: number,
  halfUp: number,
  uv: QuadUv,
  tag: DecorQuadTag,
  color?: Rgba,
): void {
  const right = cross(up, normal);
  for (const [sr, su] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    sink.positions.push(
      center[0] + right[0] * halfRight * sr + up[0] * halfUp * su,
      center[1] + right[1] * halfRight * sr + up[1] * halfUp * su,
      center[2] + right[2] * halfRight * sr + up[2] * halfUp * su,
    );
    sink.uvs.push(sr < 0 ? uv.u0 : uv.u1, su < 0 ? uv.vBottom : uv.vTop);
    if (color) sink.colors.push(color[0], color[1], color[2], color[3]);
  }
  sink.tags.push(tag);
}

interface BoxFaces {
  readonly front?: QuadUv;
  readonly back?: QuadUv;
  readonly side?: QuadUv;
  readonly top?: QuadUv;
  readonly bottom?: QuadUv;
}

/** A box with a horizontal `forward`. Faces with no UV are not emitted. */
function pushBox(
  sink: QuadSink,
  center: Vec3,
  forward: Vec3,
  halfWidth: number,
  halfHeight: number,
  halfDepth: number,
  faces: BoxFaces,
  tag: DecorQuadTag,
): void {
  const right = cross(UP, forward);
  if (faces.front) pushQuad(sink, along(center, forward, halfDepth), forward, UP, halfWidth, halfHeight, faces.front, tag);
  if (faces.back) pushQuad(sink, along(center, forward, -halfDepth), negate(forward), UP, halfWidth, halfHeight, faces.back, tag);
  if (faces.side) {
    pushQuad(sink, along(center, right, halfWidth), right, UP, halfDepth, halfHeight, faces.side, tag);
    pushQuad(sink, along(center, right, -halfWidth), negate(right), UP, halfDepth, halfHeight, faces.side, tag);
  }
  if (faces.top) pushQuad(sink, along(center, UP, halfHeight), UP, negate(forward), halfWidth, halfDepth, faces.top, tag);
  if (faces.bottom) pushQuad(sink, along(center, UP, -halfHeight), negate(UP), forward, halfWidth, halfDepth, faces.bottom, tag);
}

/** Tapered housing. Wall housings omit the unseen back cover. */
function pushMonitorHousing(
  sink: QuadSink,
  face: Vec3,
  forward: Vec3,
  halfWidth: number,
  halfHeight: number,
  depth: number,
  taper: number,
  tag: DecorQuadTag,
  includeBack = true,
): void {
  const right = cross(UP, forward);
  const corner = (x: number, y: number, z: number): Vec3 => along(along(along(face, right, x), UP, y), forward, z);
  const front = [corner(-halfWidth, -halfHeight, 0), corner(halfWidth, -halfHeight, 0),
    corner(-halfWidth, halfHeight, 0), corner(halfWidth, halfHeight, 0)] as const;
  const back = [corner(-halfWidth + taper, -halfHeight + taper, -depth), corner(halfWidth - taper, -halfHeight + taper, -depth),
    corner(-halfWidth + taper, halfHeight - taper, -depth), corner(halfWidth - taper, halfHeight - taper, -depth)] as const;
  const faces: readonly [readonly Vec3[], DecorSwatchId][] = [
    [front, 'bezelFront'],
    [[back[1], back[0], back[3], back[2]], 'bezelBack'],
    [[front[1], back[1], front[3], back[3]], 'bezelSide'],
    [[back[0], front[0], back[2], front[2]], 'bezelSide'],
    [[front[2], front[3], back[2], back[3]], 'bezelTop'],
    [[back[0], back[1], front[0], front[1]], 'bezelSide'],
  ];
  for (const [vertices, swatch] of faces) {
    if (swatch === 'bezelBack' && !includeBack) continue;
    const uv = swatchUv(swatch);
    for (const vertex of vertices) {
      sink.positions.push(...vertex);
      sink.uvs.push(uv.u0, uv.vTop);
    }
    sink.tags.push(tag);
  }
}

function finish(sinks: readonly QuadSink[], withColors: boolean): DecorMeshData {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const tags: DecorQuadTag[] = [];
  for (const sink of sinks) {
    positions.push(...sink.positions);
    uvs.push(...sink.uvs);
    colors.push(...sink.colors);
    tags.push(...sink.tags);
  }
  const quadCount = tags.length;
  const indices = new Uint16Array(quadCount * 6);
  for (let quad = 0; quad < quadCount; quad++) {
    const base = quad * DECOR_VERTS_PER_QUAD;
    const offset = quad * 6;
    indices[offset] = base;
    indices[offset + 1] = base + 1;
    indices[offset + 2] = base + 2;
    indices[offset + 3] = base + 2;
    indices[offset + 4] = base + 1;
    indices[offset + 5] = base + 3;
  }
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    colors: withColors ? new Float32Array(colors) : null,
    indices,
    tags,
    quadCount,
  };
}

/** Deterministic 0..1 sequence. Layout only: phases and speeds must be the
 *  same on every load so a screenshot pass is reproducible. */
export function decorRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. The trader rigs and the wall screens (the MONITORS mesh)
// ---------------------------------------------------------------------------

/**
 * One 3 x 2 bank per desk, in the DESK'S OWN frame (local +Z faces the aisle,
 * local -Z is the wall side, local +X is the operator's right).
 *
 * The v4 procedural walnut top is y132, 364 x 270. Its flat hood is y166,
 * x +/-176, z -135..-100 (`build-interior.mjs`, desk module). A weighted brass
 * plate beds into that hood, with a graphite column, full-width brass arms,
 * graphite reach links and VESA blocks meeting each tapered back cover.
 * Monitors are 100 x 62 with a 4.5 wu bezel, 8 wu chin and 7 wu header strip,
 * 4 wu apart; the outer columns turn 18 degrees toward the operator.
 *
 * Top of the bank: 204 + 62 + 4 + 62 = 332, under the 335 ceiling the room
 * leaves for it.
 */
export const DECOR_BANK = Object.freeze({
  monitorWidth: 100,
  monitorHeight: 62,
  monitorDepth: 12,
  backTaper: 5,
  bezel: 4.5,
  chin: 8,
  headerHeight: 7,
  columnGap: 4,
  rowGap: 4,
  outerYaw: (18 * Math.PI) / 180,
  /** Local z of the centre column's FRONT face. */
  frontZ: -108,
  /** Bottom edge of the lower row. */
  bottomY: 204,
  /** Screens sit this far proud of the bezel face (depth-precision margin). */
  screenLift: 1,
  /** Plate beds 2 wu into the measured flat hood. */
  footY: 164,
  plate: Object.freeze({ halfX: 48, centerZ: -119, halfZ: 14, topY: 172 }),
  post: Object.freeze({ halfX: 11, centerZ: -126, halfZ: 6, topY: 318 }),
  arm: Object.freeze({ halfX: 120, halfY: 5, centerZ: -128, halfZ: 4 }),
  vesa: Object.freeze({ halfX: 11, halfY: 11, halfZ: 3 }),
});

/** The hood band of the console, desk-local. Only the mount may go below the
 *  hood top, and only inside this band. */
export const DECOR_DESK_HOOD = Object.freeze({
  topY: 166,
  minLocalZ: -135,
  maxLocalZ: -100,
  flatHalfX: 176,
});

/** Measured v4 walnut desktop; the bevel occupies its outermost 5 wu. */
export const DECOR_DESKTOP = Object.freeze({ topY: 132, halfX: 182, halfZ: 135, bevel: 5 });

/** What each of the six monitors shows, by bank position, rotated per desk so
 *  neighbouring desks do not mirror each other. Row-major, bottom row first. */
export const DECOR_DESK_CONTENT = Object.freeze([
  'candleA',
  'terminal',
  'candleB',
  'line',
  'depth',
  'bars',
] as const);
export type DecorScreenContent = (typeof DECOR_DESK_CONTENT)[number];

/** A desk monitor's chart takes this long to cross the screen, seconds. */
export const DECOR_DESK_CROSS_SECONDS = Object.freeze({ min: 20, max: 60 });
/** The wall screens drift slower: they are big and in the corner of the eye. */
export const DECOR_WALL_CROSS_SECONDS = Object.freeze({ min: 30, max: 60 });

/**
 * The big wall screens: the three MIDDLE bays of each side wall. The bays are
 * bounded by the side pilasters (100 wide, 40 deep, faces at |x| 1260), so a
 * 410 wide screen centred on a bay clears both pilasters by 20 wu. The box
 * runs |x| 1284..1298, 2 wu off the wall's inner face at 1300.
 */
export const DECOR_WALL_SCREEN = Object.freeze({
  width: 410,
  height: 330,
  bottomY: 430,
  depth: 14,
  frontX: 1284,
  bezel: 8,
  trimWidth: 2.5,
  plateLift: 1,
  paneLift: 2,
  gap: 4,
  leftPaneWidth: 250,
  barsPaneHeight: 90,
  bayCentersZ: Object.freeze([-550, 0, 550] as const),
});

/** The side-wall pilasters, mirrored from `scripts/trading-floor/build-interior.mjs`
 *  (`sidePilasterZ`, `PIL_W`, `PIL_D`). */
export const DECOR_SIDE_PILASTERS = Object.freeze({
  z: Object.freeze([-825, -275, 275, 825] as const),
  halfWidth: 50,
  faceX: TRADING_FLOOR_ROOM.halfX - 40,
});

export interface DecorScrollTable {
  /** The FIRST `count` quads scroll. */
  readonly count: number;
  /** Window width in U, per scrolling quad. */
  readonly widths: Float32Array;
  /** U per second, per scrolling quad. */
  readonly speeds: Float32Array;
  /** Starting U offset in [0, 1), per scrolling quad. */
  readonly phases: Float32Array;
}

export interface MonitorDecorData {
  readonly mesh: DecorMeshData;
  readonly scroll: DecorScrollTable;
}

/** Desk-local point into the world, through the slot's own yaw. */
export function deskLocalToWorld(
  slot: TradingFloorConsoleSlot,
  localX: number,
  y: number,
  localZ: number,
): Vec3 {
  const c = Math.cos(slot.rotY);
  const s = Math.sin(slot.rotY);
  return [slot.x + localX * c + localZ * s, y, slot.z - localX * s + localZ * c];
}

/** World point back into a desk's frame. The tests use it to check the hood. */
export function worldToDeskLocal(
  slot: TradingFloorConsoleSlot,
  x: number,
  z: number,
): { localX: number; localZ: number } {
  const c = Math.cos(slot.rotY);
  const s = Math.sin(slot.rotY);
  const dx = x - slot.x;
  const dz = z - slot.z;
  return { localX: dx * c - dz * s, localZ: dx * s + dz * c };
}

function deskDirection(slot: TradingFloorConsoleSlot, localX: number, localZ: number): Vec3 {
  const c = Math.cos(slot.rotY);
  const s = Math.sin(slot.rotY);
  return [localX * c + localZ * s, 0, -localX * s + localZ * c];
}

const BEZEL_FACES: BoxFaces = Object.freeze({
  front: swatchUv('bezelFront'),
  back: swatchUv('bezelBack'),
  side: swatchUv('bezelSide'),
  top: swatchUv('bezelTop'),
  bottom: swatchUv('bezelSide'),
});

const BRASS_FACES: BoxFaces = Object.freeze({
  front: swatchUv('brassFront'),
  back: swatchUv('brassSide'),
  side: swatchUv('brassSide'),
  top: swatchUv('brassTop'),
});

interface ScrollSink {
  readonly quads: QuadSink;
  readonly widths: number[];
  readonly speeds: number[];
  readonly phases: number[];
}

function pushScrollingQuad(
  scroll: ScrollSink,
  center: Vec3,
  normal: Vec3,
  halfRight: number,
  halfUp: number,
  band: DecorBand,
  crossSeconds: number,
  phase: number,
  tag: DecorQuadTag,
): void {
  const width = bandWindowWidth(band, halfRight * 2, halfUp * 2);
  pushQuad(scroll.quads, center, normal, UP, halfRight, halfUp, bandUv(band, phase, width), tag);
  scroll.widths.push(width);
  // Speed in U per second = one window per `crossSeconds`.
  scroll.speeds.push(width / crossSeconds);
  scroll.phases.push(phase);
}

function crossSeconds(random: () => number, range: { min: number; max: number }): number {
  return range.min + (range.max - range.min) * random();
}

function pushDeskBank(
  scroll: ScrollSink,
  fixed: QuadSink,
  slot: TradingFloorConsoleSlot,
  deskIndex: number,
  random: () => number,
): void {
  const bank = DECOR_BANK;
  const mountTag: DecorQuadTag = { part: 'bank-mount', owner: deskIndex };
  const forwardLocal = deskDirection(slot, 0, 1);

  // Weighted brass foot, graphite column and full-width brass row arms.
  const plateHalfY = (bank.plate.topY - bank.footY) / 2;
  pushBox(
    fixed,
    deskLocalToWorld(slot, 0, bank.footY + plateHalfY, bank.plate.centerZ),
    forwardLocal,
    bank.plate.halfX,
    plateHalfY,
    bank.plate.halfZ,
    BRASS_FACES,
    mountTag,
  );
  const postHalfY = (bank.post.topY - bank.plate.topY) / 2;
  pushBox(
    fixed,
    deskLocalToWorld(slot, 0, bank.plate.topY + postHalfY, bank.post.centerZ),
    forwardLocal,
    bank.post.halfX,
    postHalfY,
    bank.post.halfZ,
    BEZEL_FACES,
    mountTag,
  );
  for (let row = 0; row < 2; row++) {
    const rowCenterY = bank.bottomY + bank.monitorHeight / 2 + row * (bank.monitorHeight + bank.rowGap);
    pushBox(
      fixed,
      deskLocalToWorld(slot, 0, rowCenterY, bank.arm.centerZ),
      forwardLocal,
      bank.arm.halfX,
      bank.arm.halfY,
      bank.arm.halfZ,
      { ...BRASS_FACES, bottom: swatchUv('brassSide') },
      mountTag,
    );
  }

  const halfW = bank.monitorWidth / 2;
  const halfH = bank.monitorHeight / 2;
  const screenHalfW = halfW - bank.bezel;
  const bodyHeight = bank.monitorHeight - bank.bezel - bank.chin - bank.headerHeight;
  const screenTag: DecorQuadTag = { part: 'bank-screen', owner: deskIndex };
  const bezelTag: DecorQuadTag = { part: 'bank-bezel', owner: deskIndex };

  for (let row = 0; row < 2; row++) {
    const centerY = bank.bottomY + halfH + row * (bank.monitorHeight + bank.rowGap);
    for (let column = -1; column <= 1; column++) {
      const monitor = row * 3 + (column + 1);
      // Front-face centre and facing, desk-local. The outer columns hinge on
      // their inner front edge and turn in toward the operator.
      let faceX = 0;
      let faceZ: number = bank.frontZ;
      let forwardX = 0;
      let forwardZ = 1;
      if (column !== 0) {
        const hingeX = column * (halfW + bank.columnGap);
        faceX = hingeX + column * Math.cos(bank.outerYaw) * halfW;
        faceZ = bank.frontZ + Math.sin(bank.outerYaw) * halfW;
        forwardX = -column * Math.sin(bank.outerYaw);
        forwardZ = Math.cos(bank.outerYaw);
      }
      const forward = deskDirection(slot, forwardX, forwardZ);
      const face = deskLocalToWorld(slot, faceX, centerY, faceZ);

      pushMonitorHousing(
        fixed,
        face,
        forward,
        halfW,
        halfH,
        bank.monitorDepth,
        bank.backTaper,
        bezelTag,
      );

      // The VESA block meets the back cover; the reach link meets the arm.
      const vesa = bank.vesa;
      pushBox(fixed, along(face, forward, -bank.monitorDepth - vesa.halfZ), forward,
        vesa.halfX, vesa.halfY, vesa.halfZ, BEZEL_FACES, mountTag);
      const linkDepth = (faceZ - bank.arm.centerZ) / forwardZ - bank.monitorDepth - vesa.halfZ * 2;
      pushBox(fixed, along(face, forward, -bank.monitorDepth - vesa.halfZ * 2 - linkDepth / 2), forward,
        5, 6, linkDepth / 2, BEZEL_FACES, mountTag);
      const led = along(along(along(face, forward, bank.screenLift), cross(UP, forward), halfW - 11), UP, -halfH + bank.chin / 2);
      pushQuad(fixed, led, forward, UP, 1.25, 1.25,
        swatchUv(monitor % 3 === 1 ? 'statusAmber' : 'statusGreen'), bezelTag);

      const lifted = along(face, forward, bank.screenLift);
      pushQuad(
        fixed,
        along(lifted, UP, halfH - bank.bezel - bank.headerHeight / 2),
        forward,
        UP,
        screenHalfW,
        bank.headerHeight / 2,
        atlasRectUv(deskHeaderRect(deskIndex * 6 + monitor)),
        screenTag,
      );

      const bodyCenter = along(lifted, UP, -halfH + bank.chin + bodyHeight / 2);
      const content = DECOR_DESK_CONTENT[(monitor + deskIndex) % DECOR_DESK_CONTENT.length]!;
      if (content === 'depth' || content === 'terminal') {
        pushQuad(
          fixed,
          bodyCenter,
          forward,
          UP,
          screenHalfW,
          bodyHeight / 2,
          content === 'terminal' ? atlasRectUv(terminalPanelRect(deskIndex + row)) : depthPanelUv(deskIndex),
          screenTag,
        );
      } else {
        pushScrollingQuad(
          scroll,
          bodyCenter,
          forward,
          screenHalfW,
          bodyHeight / 2,
          DECOR_BANDS[content],
          crossSeconds(random, DECOR_DESK_CROSS_SECONDS),
          random(),
          screenTag,
        );
      }
    }
  }
}

function pushWallScreen(
  scroll: ScrollSink,
  fixed: QuadSink,
  side: -1 | 1,
  bayZ: number,
  wallIndex: number,
  random: () => number,
): void {
  const screen = DECOR_WALL_SCREEN;
  const forward: Vec3 = [-side, 0, 0];
  const right = cross(UP, forward);
  const centerY = screen.bottomY + screen.height / 2;
  const face: Vec3 = [side * screen.frontX, centerY, bayZ];
  const bezelTag: DecorQuadTag = { part: 'wall-bezel', owner: wallIndex };
  const screenTag: DecorQuadTag = { part: 'wall-screen', owner: wallIndex };

  // Graphite cover tapers toward the back, which stays 2 wu off the wall.
  pushMonitorHousing(
    fixed,
    face,
    forward,
    screen.width / 2,
    screen.height / 2,
    screen.depth,
    4,
    bezelTag,
    false,
  );

  const areaHalfW = screen.width / 2 - screen.bezel;
  const areaHalfH = screen.height / 2 - screen.bezel;
  const plate = along(face, forward, screen.plateLift);
  pushQuad(fixed, plate, forward, UP, areaHalfW, areaHalfH, swatchUv('screenBlack'), screenTag);

  // Brass outer frame stays within the original wall-screen rectangle.
  const trim = swatchUv('trimGold');
  const trimHalf = screen.trimWidth / 2;
  pushQuad(fixed, along(plate, UP, screen.height / 2 - trimHalf), forward, UP, screen.width / 2, trimHalf, trim, bezelTag);
  pushQuad(fixed, along(plate, UP, -(screen.height / 2 - trimHalf)), forward, UP, screen.width / 2, trimHalf, trim, bezelTag);
  pushQuad(fixed, along(plate, right, screen.width / 2 - trimHalf), forward, UP, trimHalf, screen.height / 2 - screen.trimWidth, trim, bezelTag);
  pushQuad(fixed, along(plate, right, -(screen.width / 2 - trimHalf)), forward, UP, trimHalf, screen.height / 2 - screen.trimWidth, trim, bezelTag);

  // Panes, in screen-area coordinates (origin top-left, x right, y down).
  const areaW = areaHalfW * 2;
  const areaH = areaHalfH * 2;
  const header = wallHeaderRect(wallIndex);
  const headerH = (areaW * header.height) / header.width;
  const contentTop = headerH + screen.gap;
  const contentH = areaH - contentTop;
  const leftW = screen.leftPaneWidth;
  const rightX = leftW + screen.gap;
  const rightW = areaW - rightX;
  const chartH = contentH - screen.gap - screen.barsPaneHeight;
  const depth = depthPanelRect(wallIndex);
  const depthH = (rightW * depth.height) / depth.width;
  const upperRightH = contentH - screen.gap - depthH;

  const pane = (px: number, py: number, pw: number, ph: number): Vec3 =>
    along(
      along(along(face, forward, screen.paneLift), right, px + pw / 2 - areaHalfW),
      UP,
      areaHalfH - (py + ph / 2),
    );
  // Preserve terminal glyph aspect. Tall panes stack panels, with black gutters.
  const terminalPane = (px: number, py: number, pw: number, ph: number): void => {
    const rect = terminalPanelRect(wallIndex);
    const height = pw * rect.height / rect.width;
    const rows = Math.max(1, Math.floor((ph + screen.gap) / (height + screen.gap)));
    const padding = (ph - rows * height - (rows - 1) * screen.gap) / 2;
    for (let row = 0; row < rows; row++) {
      pushQuad(fixed, pane(px, py + padding + row * (height + screen.gap), pw, height), forward, UP,
        pw / 2, height / 2, atlasRectUv(terminalPanelRect(wallIndex + row)), screenTag);
    }
  };

  pushQuad(fixed, pane(0, 0, areaW, headerH), forward, UP, areaW / 2, headerH / 2, atlasRectUv(header), screenTag);
  pushQuad(
    fixed,
    pane(rightX, contentTop + upperRightH + screen.gap, rightW, depthH),
    forward,
    UP,
    rightW / 2,
    depthH / 2,
    depthPanelUv(wallIndex),
    screenTag,
  );
  const terminalOnLeft = wallIndex % 2 === 0;
  if (terminalOnLeft) {
    terminalPane(0, contentTop, leftW, chartH);
  } else {
    pushScrollingQuad(scroll, pane(0, contentTop, leftW, chartH), forward, leftW / 2, chartH / 2,
      DECOR_BANDS.candleB, crossSeconds(random, DECOR_WALL_CROSS_SECONDS), random(), screenTag);
  }
  pushScrollingQuad(
    scroll,
    pane(0, contentTop + chartH + screen.gap, leftW, screen.barsPaneHeight),
    forward,
    leftW / 2,
    screen.barsPaneHeight / 2,
    DECOR_BANDS.bars,
    crossSeconds(random, DECOR_WALL_CROSS_SECONDS),
    random(),
    screenTag,
  );
  if (terminalOnLeft) {
    pushScrollingQuad(scroll, pane(rightX, contentTop, rightW, upperRightH), forward, rightW / 2, upperRightH / 2,
      DECOR_BANDS.heat, crossSeconds(random, DECOR_WALL_CROSS_SECONDS), random(), screenTag);
  } else {
    terminalPane(rightX, contentTop, rightW, upperRightH);
  }
}

/** Wall screen order: left wall bays back to front, then the right wall. */
export function decorWallScreenSide(wallIndex: number): -1 | 1 {
  return wallIndex < DECOR_WALL_SCREEN.bayCentersZ.length ? -1 : 1;
}

export function buildMonitorDecor(): MonitorDecorData {
  const random = decorRandom(0xc1a3);
  const scroll: ScrollSink = { quads: createSink(), widths: [], speeds: [], phases: [] };
  const fixed = createSink();
  TRADING_FLOOR_CONSOLE_ROW.forEach((slot, deskIndex) => {
    pushDeskBank(scroll, fixed, slot, deskIndex, random);
  });
  const bays = DECOR_WALL_SCREEN.bayCentersZ;
  for (let wallIndex = 0; wallIndex < bays.length * 2; wallIndex++) {
    pushWallScreen(scroll, fixed, decorWallScreenSide(wallIndex), bays[wallIndex % bays.length]!, wallIndex, random);
  }
  // Scrolling quads FIRST: the per-frame upload is one range at the start.
  const mesh = finish([scroll.quads, fixed], false);
  return {
    mesh,
    scroll: {
      count: scroll.widths.length,
      widths: new Float32Array(scroll.widths),
      speeds: new Float32Array(scroll.speeds),
      phases: new Float32Array(scroll.phases),
    },
  };
}

/** Move every window on by `deltaSeconds`, wrapped into [0, 1). In place,
 *  scalar, zero allocation: called from the frame loop. */
export function advanceDecorScroll(
  offsets: Float32Array,
  speeds: Float32Array,
  count: number,
  deltaSeconds: number,
): void {
  for (let index = 0; index < count; index++) {
    const next = offsets[index]! + speeds[index]! * deltaSeconds;
    offsets[index] = next - Math.floor(next);
  }
}

/**
 * Write each scrolling quad's U pair from its offset. Only the U slots are
 * touched; V never changes. The window runs from `offset` to `offset + width`,
 * which may pass 1: the atlas wraps on S and the band is periodic, so the
 * sampler reads the band's own continuation there.
 */
export function writeDecorScrollUvs(
  uvs: Float32Array,
  widths: Float32Array,
  offsets: Float32Array,
  count: number,
): void {
  for (let quad = 0; quad < count; quad++) {
    const base = quad * DECOR_UV_FLOATS_PER_QUAD;
    const u0 = offsets[quad]!;
    const u1 = u0 + widths[quad]!;
    uvs[base] = u0;
    uvs[base + 2] = u1;
    uvs[base + 4] = u0;
    uvs[base + 6] = u1;
  }
}

// ---------------------------------------------------------------------------
// 2. The LED ticker ribbon (the RIBBON mesh)
// ---------------------------------------------------------------------------

export const RIBBON_CANVAS_WIDTH = 4096;
export const RIBBON_CANVAS_HEIGHT = 64;
/** Dark-gold rim rows at the top and the bottom of the strip. */
export const RIBBON_RIM_ROWS = 4;
/** The band fills lane B's whole 790..860 zone: every wu of height is glyph
 *  height at the distances the side runs are read from. */
export const RIBBON_BOTTOM_Y = 790;
export const RIBBON_TOP_Y = 860;
/**
 * |x| of the ribbon's face on the side walls: 6 wu in front of the pilaster
 * faces (1260), so the crawl runs past the ribs instead of behind them. It is
 * also exactly the player-centre clamp, which is legal because the ribbon
 * starts at y 795, far above anything that walks.
 */
export const RIBBON_SIDE_X = DECOR_SIDE_PILASTERS.faceX - 6;
/** z of the ribbon's face on the front (door) wall: 6 wu proud of it. */
export const RIBBON_FRONT_Z = TRADING_FLOOR_ROOM.halfZ - 6;
/** Where the side runs stop short of the back wall (the big board's wall). */
export const RIBBON_BACK_END_Z = -(TRADING_FLOOR_ROOM.halfZ - 20);
/** Soffits stop this far short of the wall, never coplanar with it. */
export const RIBBON_WALL_GAP = 1;
/** World length of one strip period: the strip's own aspect, no stretch. */
export const RIBBON_STRIP_WU =
  RIBBON_CANVAS_WIDTH * ((RIBBON_TOP_Y - RIBBON_BOTTOM_Y) / RIBBON_CANVAS_HEIGHT);
/** Crawl speed. One strip period (4480 wu) passes a point in ~41 s. */
export const RIBBON_SPEED_WU_PER_SEC = 110;

export interface RibbonSegment {
  /** Start of the face along the crawl path. */
  readonly start: Vec3;
  /** Unit direction of increasing U (the viewer's RIGHT on that wall). */
  readonly direction: Vec3;
  /** Face normal, into the room. */
  readonly normal: Vec3;
  readonly length: number;
  /** Arc length along the whole band where this segment starts. */
  readonly pathStart: number;
}

export interface RibbonDecorData {
  readonly mesh: DecorMeshData;
  /** The FIRST `segments.length` quads are the crawling faces, in order. */
  readonly segments: readonly RibbonSegment[];
  readonly pathStarts: Float32Array;
  readonly lengths: Float32Array;
}

/**
 * The crawl path, in the order U INCREASES: up the right wall toward the door,
 * across the door wall, back down the left wall. On every wall that is the
 * viewer's right-hand direction, so the text reads left to right everywhere and
 * the band is one continuous strip with no seam at either corner. The back wall
 * carries the big board and gets nothing.
 */
export function ribbonSegments(): RibbonSegment[] {
  const sideLength = RIBBON_FRONT_Z - RIBBON_BACK_END_Z;
  const frontLength = RIBBON_SIDE_X * 2;
  const y = RIBBON_BOTTOM_Y;
  return [
    {
      start: [RIBBON_SIDE_X, y, RIBBON_BACK_END_Z],
      direction: [0, 0, 1],
      normal: [-1, 0, 0],
      length: sideLength,
      pathStart: 0,
    },
    {
      start: [RIBBON_SIDE_X, y, RIBBON_FRONT_Z],
      direction: [-1, 0, 0],
      normal: [0, 0, -1],
      length: frontLength,
      pathStart: sideLength,
    },
    {
      start: [-RIBBON_SIDE_X, y, RIBBON_FRONT_Z],
      direction: [0, 0, -1],
      normal: [1, 0, 0],
      length: sideLength,
      pathStart: sideLength + frontLength,
    },
  ];
}

/** The strip's rim row centre, sampled at one point for the soffits. */
export function ribbonRimUv(): QuadUv {
  const u = 0.5;
  const v = 1 - RIBBON_RIM_ROWS / 2 / RIBBON_CANVAS_HEIGHT;
  return { u0: u, u1: u, vTop: v, vBottom: v };
}

export function buildRibbonDecor(): RibbonDecorData {
  const segments = ribbonSegments();
  const faces = createSink();
  const soffits = createSink();
  const halfHeight = (RIBBON_TOP_Y - RIBBON_BOTTOM_Y) / 2;
  const rim = ribbonRimUv();

  segments.forEach((segment, index) => {
    const mid = along(segment.start, segment.direction, segment.length / 2);
    const faceCenter: Vec3 = [mid[0], RIBBON_BOTTOM_Y + halfHeight, mid[2]];
    pushQuad(
      faces,
      faceCenter,
      segment.normal,
      UP,
      segment.length / 2,
      halfHeight,
      {
        u0: segment.pathStart / RIBBON_STRIP_WU,
        u1: (segment.pathStart + segment.length) / RIBBON_STRIP_WU,
        vTop: 1,
        vBottom: 0,
      },
      { part: 'ribbon-face', owner: index },
    );

    // The underside closes the box back to the wall, so the band reads as a
    // solid LED fascia from below instead of a strip floating off the wall.
    // The side runs reach on to the door wall so the corner has no open slot
    // overhead. No TOP face: the chase camera never rises above y 410, so a
    // face at the band's top looking up could never be drawn.
    const depth = index === 1
      ? TRADING_FLOOR_ROOM.halfZ - RIBBON_WALL_GAP - RIBBON_FRONT_Z
      : TRADING_FLOOR_ROOM.halfX - RIBBON_WALL_GAP - RIBBON_SIDE_X;
    const reach = index === 1 ? 0 : TRADING_FLOOR_ROOM.halfZ - RIBBON_WALL_GAP - RIBBON_FRONT_Z;
    // Side 0 runs toward the door from its start; side 2 runs away from it.
    const extendAtStart = index === 2 ? reach : 0;
    const extendAtEnd = index === 0 ? reach : 0;
    const runLength = segment.length + extendAtStart + extendAtEnd;
    const runMid = along(segment.start, segment.direction, (segment.length + extendAtEnd - extendAtStart) / 2);
    const inward = negate(segment.normal);
    const underside = along([runMid[0], RIBBON_BOTTOM_Y, runMid[2]], inward, depth / 2);
    pushQuad(
      soffits,
      underside,
      negate(UP),
      cross(segment.direction, UP),
      runLength / 2,
      depth / 2,
      rim,
      { part: 'ribbon-soffit', owner: index },
    );
  });

  return {
    mesh: finish([faces, soffits], false),
    segments,
    pathStarts: new Float32Array(segments.map((segment) => segment.pathStart)),
    lengths: new Float32Array(segments.map((segment) => segment.length)),
  };
}

/** Advance the crawl, wrapped into one strip period. */
export function advanceRibbonOffset(offsetWu: number, deltaSeconds: number): number {
  const next = offsetWu + RIBBON_SPEED_WU_PER_SEC * deltaSeconds;
  return next - Math.floor(next / RIBBON_STRIP_WU) * RIBBON_STRIP_WU;
}

/**
 * The crawling faces' U pairs at `offsetWu`. U = (path position + offset) /
 * strip period: as the offset grows, a fixed point on the wall shows text from
 * further along the strip, so the text moves toward the viewer's LEFT, the way
 * a ticker runs. Zero allocation.
 */
export function writeRibbonUvs(
  uvs: Float32Array,
  pathStarts: Float32Array,
  lengths: Float32Array,
  offsetWu: number,
): void {
  for (let quad = 0; quad < pathStarts.length; quad++) {
    const base = quad * DECOR_UV_FLOATS_PER_QUAD;
    const u0 = (pathStarts[quad]! + offsetWu) / RIBBON_STRIP_WU;
    const u1 = (pathStarts[quad]! + lengths[quad]! + offsetWu) / RIBBON_STRIP_WU;
    uvs[base] = u0;
    uvs[base + 2] = u1;
    uvs[base + 4] = u0;
    uvs[base + 6] = u1;
  }
}

// ---------------------------------------------------------------------------
// 3. Glow pools (the GLOW mesh)
// ---------------------------------------------------------------------------

export const GLOW_SPRITE_SIZE = 128;
/** Floor pools sit here; lane A's floor seal owns y 1..2. */
export const DECOR_GLOW_FLOOR_Y = 3;
/** The floor seal's annulus around the dais. No pool may overlap it. */
export const DECOR_SEAL = Object.freeze({ x: 0, z: -60, innerRadius: 380, outerRadius: 600 });

/** Linear RGBA. Alpha is the strength: additive blending adds `rgb * a`. */
export const DECOR_GLOW_COLOR = Object.freeze({
  desk: Object.freeze([0.05, 0.42, 1.0, 0.34] as const),
  desktop: Object.freeze([0.38, 0.64, 1.0, 0.13] as const),
  board: Object.freeze([0.03, 0.3, 1.0, 0.3] as const),
  deskWall: Object.freeze([0.04, 0.36, 1.0, 0.3] as const),
  screenHalo: Object.freeze([0.06, 0.5, 1.0, 0.4] as const),
});

export interface GlowPool {
  readonly kind: 'floor' | 'wall' | 'desktop';
  readonly center: Vec3;
  /** Floor: half-extent along X. Wall: half-extent along Z. */
  readonly halfA: number;
  /** Floor: half-extent along Z. Wall: half-extent along Y. */
  readonly halfB: number;
  readonly color: Rgba;
}

/**
 * Where the light goes. Floor pools in front of each desk (the screens' cool
 * spill), one wide wash under the big board, a wash on the wall behind each
 * monitor bank and a halo behind each wall screen. Wall glows sit 4..5 wu off
 * the wall face: far enough to beat depth precision from across the hall.
 */
export function glowPools(): GlowPool[] {
  const pools: GlowPool[] = [];
  const deskPoolX = TRADING_FLOOR_DESK_INNER_X - 35;
  for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
    const side = Math.sign(slot.x);
    pools.push({ kind: 'floor', center: [side * deskPoolX, DECOR_GLOW_FLOOR_Y, slot.z], halfA: 170, halfB: 240, color: DECOR_GLOW_COLOR.desk });
  }
  for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
    // Desk-local x +/-130, z -87..-15: ahead of the hood, behind phone and keyboard.
    // Desks face +/-X, so world X takes local depth and world Z local width.
    pools.push({ kind: 'desktop', center: deskLocalToWorld(slot, 0, DECOR_DESKTOP.topY + 3, -51),
      halfA: 36, halfB: 130, color: DECOR_GLOW_COLOR.desktop });
  }
  pools.push({ kind: 'floor', center: [0, DECOR_GLOW_FLOOR_Y, -962], halfA: 900, halfB: 133, color: DECOR_GLOW_COLOR.board });
  for (const slot of TRADING_FLOOR_CONSOLE_ROW) {
    const side = Math.sign(slot.x);
    pools.push({ kind: 'wall', center: [side * (TRADING_FLOOR_ROOM.halfX - 5), 290, slot.z], halfA: 230, halfB: 130, color: DECOR_GLOW_COLOR.deskWall });
  }
  const bays = DECOR_WALL_SCREEN.bayCentersZ;
  for (let wallIndex = 0; wallIndex < bays.length * 2; wallIndex++) {
    const side = decorWallScreenSide(wallIndex);
    pools.push({
      kind: 'wall',
      center: [side * (TRADING_FLOOR_ROOM.halfX - 4), DECOR_WALL_SCREEN.bottomY + DECOR_WALL_SCREEN.height / 2, bays[wallIndex % bays.length]!],
      halfA: 265,
      halfB: 195,
      color: DECOR_GLOW_COLOR.screenHalo,
    });
  }
  return pools;
}

const FULL_UV: QuadUv = Object.freeze({ u0: 0, u1: 1, vTop: 1, vBottom: 0 });

export function buildGlowDecor(): DecorMeshData {
  const sink = createSink();
  glowPools().forEach((pool, index) => {
    if (pool.kind === 'floor' || pool.kind === 'desktop') {
      // Normal +Y, up -Z, so right = up x normal = +X: halfA runs along X.
      pushQuad(sink, pool.center, UP, [0, 0, -1], pool.halfA, pool.halfB, FULL_UV,
        { part: pool.kind === 'desktop' ? 'glow-desktop' : 'glow-floor', owner: index }, pool.color);
    } else {
      const normal: Vec3 = [-Math.sign(pool.center[0]), 0, 0];
      pushQuad(sink, pool.center, normal, UP, pool.halfA, pool.halfB, FULL_UV, { part: 'glow-wall', owner: index }, pool.color);
    }
  });
  return finish([sink], true);
}

/** Longest frame step the decor integrates, so a tab switch does not jump. */
export const DECOR_MAX_FRAME_DELTA = 0.1;
