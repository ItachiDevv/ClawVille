/**
 * trading-floor-room.ts
 *
 * Pure geometry + camera constants for the Trading Floor INTERIOR.
 *
 * Renderer-independent (no `three`, no React, no tilemap): the stage
 * root imports `TRADING_FLOOR_CAMERA_FAR` / `TRADING_FLOOR_FOG` eagerly to
 * build its slot definition, and must not drag the interior chunk into the
 * boot bundle for a handful of numbers. Cove solved the same problem by
 * shipping a placeholder `far` in the root and raising it from the lazy chunk
 * after camera install; a constants-only module removes the two-value drift
 * risk that workaround carries.
 *
 * Coordinate space: interior-local world units, origin on the floor at the
 * room centre. +Z is the DOOR wall (the player walks in facing -Z); -Z is the
 * MONITOR wall. Same handedness as the cove interior.
 *
 * Scale reference: a VRM avatar renders at ~270 wu tall
 * (`AVATAR_TARGET_HEIGHT` in kelp-realm-player / computeVRMAvatarFit), so the
 * hall's 1425 wu ceiling is ~5.3x avatar height — a trading hall, not a
 * crawlspace.
 */

import { FLOOR_ARENA_TEMPLATES } from '@clawville/shared';

/** Stage slot id. Must equal `TRADING_FLOOR_SCENE_ID` in stage-scene-id.ts. */
export const TRADING_FLOOR_SCENE_ID = 'trading-floor';

/**
 * Interior shell — the authored hall in `trading-floor-interior-opt1-mo-ktx.glb`.
 *
 * That GLB is authored at 1 unit = 1 wu and is ALREADY at final scale, so it
 * is mounted with no auto-fit (3dStructure.md §9g). These numbers mirror it:
 * hall 3900 (X) x 1425 (Y) x 3300 (Z), wall thickness 60, doorway on the +Z
 * wall. Walls sit OUTSIDE these half-extents (inner face = halfX / halfZ).
 */
export const TRADING_FLOOR_ROOM = Object.freeze({
  halfX: 1950,
  halfZ: 1650,
  height: 1425,
  wallThickness: 60,
});

/** Avatar collision radius inside the room (world units). */
export const TRADING_FLOOR_PLAYER_RADIUS = 46;
/** Walk speed. Matches the cove's interior feel (a room is not a continent). */
export const TRADING_FLOOR_PLAYER_SPEED_WU_PER_SEC = 520;

/**
 * Spawn: inside the door wall, far enough that the exit hotspot is NOT armed
 * on arrival (otherwise the first E press walks the player straight back out).
 *
 * Annotated `number` rather than left to inference: `Object.freeze` on a
 * literal narrows `x: 0` to the literal type `0`, which then poisons every
 * mutable ref seeded from it.
 */
export const TRADING_FLOOR_PLAYER_SPAWN: {
  readonly x: number;
  readonly z: number;
} = Object.freeze({
  x: 0,
  z: TRADING_FLOOR_ROOM.halfZ - 480,
});

/**
 * Third-person chase camera. Mirrors the kelp rig, scaled to a room.
 *
 * `above` is deliberately LOW (260, vs kelp's 470): the chase arm is longer
 * than this room's half-depth, so the camera spends most of its time clamped
 * against the back wall. A high arm on a clamped camera just tips the view
 * down onto the top of the avatar's head — verified in the first local pass.
 */
export const TRADING_FLOOR_CAMERA = Object.freeze({
  fov: 60,
  near: 1,
  behind: 520,
  above: 260,
  lookY: 180,
  lookAhead: 140,
  yawSpeed: 1.25,
  pitchSpeed: 180,
  pitchMin: -120,
  pitchMax: 150,
  /**
   * Shared envelope margin. TRADING_FLOOR_CAMERA_BOUNDS pre-expands X/Z;
   * spring-arm placement subtracts this same margin on each axis.
   * This value does not change the effective wall limits.
   */
  roomMargin: 60,
});

/**
 * The room's 3D bounding-box diagonal — the number `camera.far` has to clear.
 *
 * Memory `feedback_threejs_far_plane_dark_void`: an interior far plane sized
 * against the room's WIDTH (or a flat guess) slices the far wall and reads as
 * a moving black void. Size it against the DIAGONAL, then add the chase arm.
 */
export const TRADING_FLOOR_ROOM_DIAGONAL_WU = Math.hypot(
  TRADING_FLOOR_ROOM.halfX * 2,
  TRADING_FLOOR_ROOM.height,
  TRADING_FLOOR_ROOM.halfZ * 2,
);

/**
 * `camera.far` for the slot: room diagonal + the full chase arm + headroom.
 * The camera is AABB-clamped inside the room, so diagonal + arm is already a
 * generous bound; the extra 400 covers any future prop that pokes past a wall.
 */
export const TRADING_FLOOR_CAMERA_FAR = Math.ceil(
  TRADING_FLOOR_ROOM_DIAGONAL_WU +
    TRADING_FLOOR_CAMERA.behind +
    TRADING_FLOOR_CAMERA.above +
    400,
);

export const TRADING_FLOOR_BACKGROUND = 0x05101d;

/**
 * Slot fog. INVARIANT (memory `performance/fog-density-iris-xe-regression`):
 * `fog.far <= camera.far`, always — fog past the far plane is pure wasted
 * fragment work on an Iris Xe.
 */
export const TRADING_FLOOR_FOG = Object.freeze({
  color: 0x05101d,
  near: Math.round(TRADING_FLOOR_ROOM_DIAGONAL_WU * 0.6),
  far: TRADING_FLOOR_CAMERA_FAR,
});

/**
 * Walk-up Trading Monitor: the original 129 x 300 x 101 wu Meshy kiosk.
 * It stays unscaled at the +Z door wall, off-centre, with its screens facing -Z.
 * E or a click opens the Exchange modal on its Trading Floor tab.
 *
 * The GLB publishes authored dimensions and yaw in extras.kiosk. Its authored
 * half-X 64.49 differs slightly from the decoded mesh after quantization;
 * contract comparisons are exact, while decoded geometry uses a tolerance.
 * screenY 211 retains the original 330 scaled by MONITOR_SCALE = 300/470.
 * Interaction radii remain avatar-scale and disjoint from all seat bands.
 */
export const TRADING_FLOOR_MONITOR = Object.freeze({
  x: -1000,
  z: 1570,
  /** Screens face into the room, toward -Z. */
  rotY: Math.PI,
  halfX: 64.49,
  halfZ: 50.45,
  /** Top of the kiosk. */
  height: 300,
  /** Label / screen-centre height. */
  screenY: 211,
  /** E arms inside this XZ radius of (x, z). */
  interactRadius: 380,
  /** The floating label appears inside this XZ radius. */
  nearHintRadius: 760,
});

/** Kiosk screen-side face, including its authored yaw. */
export const TRADING_FLOOR_MONITOR_FRONT_Z = TRADING_FLOOR_MONITOR.z +
  Math.cos(TRADING_FLOOR_MONITOR.rotY) * TRADING_FLOOR_MONITOR.halfZ;

/**
 * The DOOR back to the world — the authored 360 x 500 opening in the +Z wall.
 * E (or the DOM button on the page) leaves the room.
 */
export const TRADING_FLOOR_DOOR = Object.freeze({
  x: 0,
  z: TRADING_FLOOR_ROOM.halfZ,
  width: 360,
  height: 500,
  interactRadius: 240,
  nearHintRadius: 460,
});

/**
 * The BIG BOARD on the -Z wall.
 *
 * The plane itself is drawn by the scene (a `CanvasTexture` on a
 * `MeshBasicMaterial`), not by the GLB — its content is live house-trader data.
 * The GLB contributes only the recessed surround and its glow, so the board
 * reads as mounted IN the wall rather than stuck on it. These numbers and the
 * `SCREEN_*` constants in `scripts/trading-floor/build-interior.mjs` must agree
 * or the plane floats inside its own frame.
 *
 * The v5 board scales with the shell: 2550 x 780 wu, sill at y 540.
 * The surround spends 102 wu above the screen, ending at 1422 below the
 * 1425 ceiling. The 230 wu claw cap remains avatar-scale and clears the
 * board from spawn at every pitch and from reachable default-height poses.
 *
 * `canvasWidth` / `canvasHeight` are the LOGICAL drawing space, and
 * `FLOOR_SCREEN_CANVAS` in `trading-floor-screen-texture.ts` is DERIVED from
 * them — one literal pair, not two. They were two hand-typed pairs until the
 * third drift this session (`325` here against `392` there, caught by a test
 * mid-round); deriving is what makes a fourth impossible. `SCREEN_*` in
 * `scripts/trading-floor/build-interior.mjs` is the one copy that CANNOT be
 * derived, because it runs in the asset pipeline: it must be re-exported to
 * frame a 780-tall rect at y 540 or the plane will not sit in its surround.
 */
export const TRADING_FLOOR_SCREEN = Object.freeze({
  width: 2550,
  height: 780,
  bottomY: 540,
  centerY: 540 + 780 / 2,
  /** 6 wu clear of the wall's inner face — enough to beat z-fighting. */
  z: -TRADING_FLOOR_ROOM.halfZ + 6,
  canvasWidth: 1024,
  canvasHeight: 313,
});

/**
 * The trading-desk row.
 *
 * The interior GLB ships ONE `TradingFloorConsoleModule` (364 × 166 × 270).
 * The scene extracts it and draws the row as a single `InstancedMesh` — ten
 * desks for ONE draw call. Never an `InstancedMesh` with a `ShaderMaterial`:
 * that is a silent WebGPU crash on an Iris Xe, so the row keeps the GLB's own
 * `MeshStandardMaterial`.
 *
 * This is the SINGLE source for the instance matrices, the collision AABBs, the
 * chair instances AND the seats, so a desk can never be drawn somewhere the
 * player can walk through it and a seat can never be placed inside one.
 *
 * v2 (founder: "computers lined up against the side that an agent can go up and
 * sit at") turns the two free-standing aisles into two WALL ROWS. The authored
 * console faces **+Z**, and a model's facing at yaw θ is `(sin θ, 0, cos θ)`, so
 * a desk on the -X wall needs `rotY = +π/2` to face the aisle and one on the +X
 * wall needs `-π/2`. That yaw SWAPS the footprint to 270 × 364, which is why
 * the collider half-extents below are DERIVED from `rotY` by
 * `consoleHalfExtents` instead of being written out per slot: the previous
 * revision's comment warned that a ±π/2 yaw "would silently make every collider
 * wrong", and deriving them is the only way that warning cannot come true.
 *
 * `CONSOLE_WALL_X` is `halfX(1950) − pilaster depth(40) − desk halfX(135) − 5`.
 * The trailing 5 is a real gap, not rounding: at 1775 the desk's bbox face and
 * the rib face would be exactly coplanar, and two coplanar faces z-fight.
 */
export interface TradingFloorConsoleSlot {
  readonly x: number;
  readonly z: number;
  readonly rotY: number;
}

/**
 * Half-extents of one console footprint at `rotY = 0` (364 × 270 wu).
 *
 * The decoded v4 GLB measures half 182.00 × 135.0045 wu at node scale 182.
 * The 0.0045 wu quantization difference in Z is harmless against a 46 wu
 * player radius. Keep the authored collider dimensions and seat-offset floor.
 */
export const TRADING_FLOOR_CONSOLE_HALF_X = 182;
export const TRADING_FLOOR_CONSOLE_HALF_Z = 135;
/**
 * Desk height, read off the GLB (v4: height 165.99 wu, desk at hip
 * height against a 270 wu avatar). Load-bearing for the CAMERA, not just for
 * looks: the chase camera's own Y floor is `above + pitchMin` = 140, which is
 * BELOW this, so the camera has to be bounded in X by the desk face rather than
 * by the wall. `trading-floor-seats.test.ts` pins that relationship.
 */
export const TRADING_FLOOR_CONSOLE_HEIGHT = 166;

/**
 * The chair's CUSHION TOP, world Y. Measured off the decoded v4 GLB
 * (`TradingFloorChairModule`, 128 x 174 x 122 wu, base-centre origin, sit
 * surface 85 wu, backrest top 174 wu). World bounds round to
 * `min=[-64,0,-61] max=[64,174,61]`.
 *
 * This is the number the seated avatar's HIPS are pinned to. The cove's sit
 * clips carry their own authored hip descent, and that descent was calibrated
 * against the cove's chair, not ours — `holdem-table-room.tsx` already has to
 * pin its seated busts to a measured `cushionY` for exactly this reason. Ours
 * is the same fix, eased rather than snapped because our avatar is live.
 */
export const TRADING_FLOOR_CHAIR_SEAT_Y = 85;

/**
 * Exact AABB half-extents of the console footprint rotated by `rotY`. General
 * for any angle (`|cos|` and `|sin|` mix the two axes), so it stays correct if
 * a future slot is set to something other than a right angle.
 */
export function consoleHalfExtents(rotY: number): {
  halfX: number;
  halfZ: number;
} {
  const c = Math.abs(Math.cos(rotY));
  const s = Math.abs(Math.sin(rotY));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    halfX: round(TRADING_FLOOR_CONSOLE_HALF_X * c + TRADING_FLOOR_CONSOLE_HALF_Z * s),
    halfZ: round(TRADING_FLOOR_CONSOLE_HALF_X * s + TRADING_FLOOR_CONSOLE_HALF_Z * c),
  };
}

const CONSOLE_WALL_X = TRADING_FLOOR_ROOM.halfX - 40 - TRADING_FLOOR_CONSOLE_HALF_Z - 5;
const CONSOLE_ROW_Z = [-500, 0, 500] as const;

export const TRADING_FLOOR_CONSOLE_ROW: readonly TradingFloorConsoleSlot[] =
  Object.freeze([
    ...CONSOLE_ROW_Z.map((z) =>
      Object.freeze({ x: -CONSOLE_WALL_X, z, rotY: Math.PI / 2 }),
    ),
    ...CONSOLE_ROW_Z.map((z) =>
      Object.freeze({ x: CONSOLE_WALL_X, z, rotY: -Math.PI / 2 }),
    ),
    ...[-1000, 1000].map((z) =>
      Object.freeze({ x: -CONSOLE_WALL_X, z, rotY: Math.PI / 2 }),
    ),
    ...[-1000, 1000].map((z) =>
      Object.freeze({ x: CONSOLE_WALL_X, z, rotY: -Math.PI / 2 }),
    ),
  ]);

/**
 * The INNER face of the wall-side desk row, i.e. the smallest `|x|` any desk
 * occupies. Derived from the row and its own rotated footprint, never written
 * out, so moving `CONSOLE_WALL_X` carries it.
 *
 * This is the chase camera's X bound, NOT the room's `halfX`. The desks now hug
 * the side walls and stand 166 wu tall, while the camera's own Y floor is
 * `above + pitchMin` = 140 — so a camera clamped to the WALL passes straight
 * through a desk whenever the player pitches down near the side of the hall.
 * Clamping to the desk face costs framing distance the old layout had; passing
 * through a desk is a visible defect.
 */
export const TRADING_FLOOR_DESK_INNER_X = Math.min(
  ...TRADING_FLOOR_CONSOLE_ROW.map(
    (slot) => Math.abs(slot.x) - consoleHalfExtents(slot.rotY).halfX,
  ),
);

/**
 * The inner face of the big board's recessed surround, world Z.
 *
 * `build-interior.mjs` places the frame boxes at `-hz + FRAME_INSET` with
 * `FRAME_DEPTH` 44, so the face nearest the room is
 * `-1650 + 12 + 44/2 = -1616`. It protrudes 28 wu in front of the board plane
 * at `TRADING_FLOOR_SCREEN.z`, and it is the thing the chase camera must not
 * reverse into at the back wall.
 */
export const TRADING_FLOOR_SCREEN_SURROUND_FACE_Z = -TRADING_FLOOR_ROOM.halfZ + 34;

/** Brass surround width scales with the board rectangle. */
export const TRADING_FLOOR_SCREEN_FRAME_WIDTH = TRADING_FLOOR_SCREEN.width / 25;

/** Avatar-scale approach tuning, independent of the camera look target. */
export const TRADING_FLOOR_END_STANDOFF = 180;
/** Camera near-plane standoff; movement retains the larger player radius. */
export const TRADING_FLOOR_CAMERA_SOLID_CLEARANCE = 12;
/** The door remains armed within its 240 wu interaction radius. */
export const TRADING_FLOOR_DOOR_APPROACH_Z = Math.min(
  TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_END_STANDOFF,
  TRADING_FLOOR_MONITOR_FRONT_Z - 2.5 * TRADING_FLOOR_CAMERA_SOLID_CLEARANCE,
);
/** Board approach remains independent of the door-wall kiosk. */
export const TRADING_FLOOR_BOARD_APPROACH_Z =
  -(TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_END_STANDOFF);
/** All side gaps obey the same approach limit as a desk face. */
export const TRADING_FLOOR_SIDE_APPROACH_X =
  TRADING_FLOOR_DESK_INNER_X - TRADING_FLOOR_PLAYER_RADIUS;

/**
 * Door-wall clearance and board-surround clearance use separate Z limits.
 * The camera Z bound must leave an arm behind the player Z bound at both ends.
 * The spring-arm envelope preserves these limits. The approach clamps leave
 * positive arms at both ends instead of placing the camera ahead of the body.
 */
const CAMERA_WALL_CLEARANCE = TRADING_FLOOR_CAMERA_SOLID_CLEARANCE;
export const TRADING_FLOOR_CAMERA_Z_MAX =
  TRADING_FLOOR_ROOM.halfZ - CAMERA_WALL_CLEARANCE;
export const TRADING_FLOOR_CAMERA_Z_MIN = -(
  TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS
);

/** Shared envelope. The margin cancels the pre-expansion on each axis. */
export const TRADING_FLOOR_CAMERA_BOUNDS = Object.freeze({
  halfX: TRADING_FLOOR_DESK_INNER_X + TRADING_FLOOR_CAMERA.roomMargin,
  zMin: TRADING_FLOOR_CAMERA_Z_MIN - TRADING_FLOOR_CAMERA.roomMargin,
  zMax: TRADING_FLOOR_CAMERA_Z_MAX + TRADING_FLOOR_CAMERA.roomMargin,
  yMin: TRADING_FLOOR_CAMERA.roomMargin,
  yMax: TRADING_FLOOR_ROOM.height + TRADING_FLOOR_CAMERA.above,
  margin: TRADING_FLOOR_CAMERA.roomMargin,
});

/** Arm tuning is avatar-scale; shell resizing does not scale the avatar. */
export const TRADING_FLOOR_CAMERA_ARM = Object.freeze({
  originInset: TRADING_FLOOR_CAMERA_SOLID_CLEARANCE / 3,
  outRate: 4,
  boomStart: 160,
  boomRise: 1.2,
  boomRate: 6,
});

/**
 * One seat per desk: where the avatar stands when it takes the seat, where the
 * chair prop is drawn, and which way both face.
 *
 * Both offsets are measured along the desk's own facing axis, so everything
 * lands on the AISLE side whatever the desk's yaw is.
 *
 * **The avatar and the chair are NOT at the same point, and that is the fix for
 * a real defect.** The first v2 pass put both at 230. Because this change adds
 * no sit CLIP, the avatar holds its idle pose, and a 270 wu standing VRM at the
 * chair's own origin passes straight through the seat pan, the backrest and
 * both armrests. So the avatar stands at 205 — at the desk, where a person
 * working at one actually stands — and the chair sits 120 wu further out at
 * 325, behind them. 120 is the chair's 64 wu half-width plus the 46 wu player
 * radius plus clearance, so the two never intersect.
 *
 * 205 is also the floor for a LEGAL standing position: the desk's rotated
 * half-depth is 135 and the player radius is 46, so anything at or under 181
 * is inside the desk's own collider and `tradingFloorHitsSolid` would reject
 * it. 205 leaves 24 wu. `trading-floor-room.test.ts` pins both facts.
 *
 * `facing` is `rotY + π`: the desk looks at the aisle, the occupant looks back
 * at the desk.
 */
export const TRADING_FLOOR_SEAT_OFFSET = 205;
/** Chair prop offset from the desk centre — BEHIND the standing avatar. */
export const TRADING_FLOOR_CHAIR_OFFSET = 325;
/** E takes the seat inside this XZ radius. Half the 500 wu desk pitch, so two
 *  seats can never be armed at once. */
export const TRADING_FLOOR_SEAT_INTERACT_RADIUS = 200;
/** The floating "take a seat" label appears inside this XZ radius. */
export const TRADING_FLOOR_SEAT_HINT_RADIUS = 420;

export interface TradingFloorSeat {
  readonly index: number;
  /** Where the AVATAR stands. */
  readonly x: number;
  readonly z: number;
  /** Where the CHAIR prop is drawn — 120 wu further out, behind the avatar. */
  readonly chairX: number;
  readonly chairZ: number;
  /** Seated body over the measured cushion centre, separate from the stand point. */
  readonly sitX: number;
  readonly sitZ: number;
  /** Avatar yaw while seated — looks at the desk. */
  readonly facing: number;
  /** Yaw of the chair prop. Same value: the chair model seats a +Z occupant. */
  readonly chairRotY: number;
}

/**
 * Half-extents of the authored chair, world units. Measured off the shipped GLB
 * (v4: 128 x 174 x 122; casters at x ±64 and z ±61 set the footprint).
 * `TRADING_FLOOR_CHAIR_OFFSET` is derived from the 64.
 */
export const TRADING_FLOOR_CHAIR_HALF_X = 64;
export const TRADING_FLOOR_CHAIR_HALF_Z = 61;

/** One authored prop node, reduced to the numbers the row depends on. */
export interface AuthoredPropCheck {
  /** Node scale, all three axes — the row applies `scale.x` to all of them. */
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  /** Geometry bounding box in the node's LOCAL space, before scale. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** What `TRADING_FLOOR_SOLIDS` assumes the footprint is, in world units. */
  readonly expectedHalfX: number;
  readonly expectedHalfZ: number;
  /** The node's own translation — where the build script parked the one copy. */
  readonly nodeX: number;
  readonly nodeZ: number;
  /** Where this repo's constants say the build script parked it. */
  readonly expectedNodeX: number;
  readonly expectedNodeZ: number;
}

/**
 * Tolerance for both checks. 1 wu is far under the 46 wu player radius, so
 * nothing inside it can make a collider wrong, and it is wide enough for the
 * quantization the constants already carry (the console half-extents measure
 * 182.00 x 135.0045 against authored 182 x 135).
 */
export const AUTHORED_PROP_TOLERANCE_WU = 1;

/**
 * The three assumptions `buildInstancedRow` makes about an authored prop, as a
 * build-time check rather than a comment.
 *
 * The row and `TRADING_FLOOR_SOLIDS` are two consumers of ONE slot list, and the
 * colliders assume the slot IS the prop's footprint centre. Nothing in the
 * renderer notices if a re-export breaks that — the desks simply stop lining up
 * with the volumes the player collides against, which reads as "the collision is
 * slightly wrong here" and is nearly impossible to diagnose from the symptom.
 *
 *   1. UNIFORM SCALE. The row composes its instance matrices from `scale.x`
 *      alone, so a non-uniform node would render at the wrong size on two axes.
 *   2. NODE PLACEMENT. The node must still sit where the build script parked the
 *      single authored copy. This is the FATAL one — see below.
 *   3. FOOTPRINT MATCHES THE CONSTANTS the colliders are built from.
 *
 * **Why rule 2 reads the NODE and not the geometry.** An earlier revision of
 * this check measured the geometry's own bbox centre, reasoning that an
 * off-centre pivot is what would desynchronise a desk from its collider. That
 * check was a permanent no-op, and the adversarial review caught it:
 * `KHR_mesh_quantization` CENTRES every mesh into [-1, 1] and pushes the
 * centring term onto the node, so a quantized prop's geometry bbox centre is
 * structurally (0, 0, 0) on every axis. The console proves it — the mesh really
 * does sit on the floor spanning y 0.01 to 165.99, yet its bbox centre Y still
 * reads 0 because 83.00 went onto `node.translation.y`. So the detectable
 * quantity is the NODE translation: if a re-export makes a prop asymmetric, the
 * quantizer moves the node, and the node stops matching where the build script
 * put it.
 *
 * Rule 2 is FATAL (the caller drops the row) while 1 and 3 only warn. A row
 * whose placement anchor has moved cannot be trusted to line up with anything,
 * and a missing desk row is instantly visible in QA where a 30 wu offset is not.
 * The cost is honest and worth stating: the colliders come from constants, so a
 * dropped row leaves the player colliding with desks that are not drawn. That is
 * a loud, obviously-broken state, which is the point.
 *
 * Returns the problems and whether any of them is fatal. Pure, so every rule and
 * the tolerance are testable without parsing a GLB.
 */
export function validateAuthoredProp(
  name: string,
  check: AuthoredPropCheck,
): { problems: string[]; fatal: boolean } {
  const problems: string[] = [];
  const tolerance = AUTHORED_PROP_TOLERANCE_WU;
  let fatal = false;

  // 1. Uniform scale. Relative, because the scale itself is ~87 to ~182.
  const scaleSpread =
    Math.max(check.scaleX, check.scaleY, check.scaleZ) -
    Math.min(check.scaleX, check.scaleY, check.scaleZ);
  if (scaleSpread > Math.abs(check.scaleX) * 1e-4) {
    problems.push(
      `${name}: node scale is not uniform ` +
        `(${check.scaleX}, ${check.scaleY}, ${check.scaleZ}); the row applies ` +
        `scale.x to all three axes`,
    );
  }

  // 2. The node still sits where this repo thinks the build script parked it.
  const driftX = check.nodeX - check.expectedNodeX;
  const driftZ = check.nodeZ - check.expectedNodeZ;
  if (Math.abs(driftX) > tolerance || Math.abs(driftZ) > tolerance) {
    fatal = true;
    problems.push(
      `${name}: authored node is at (${check.nodeX}, ${check.nodeZ}) but this ` +
        `repo expects (${check.expectedNodeX}, ${check.expectedNodeZ}) — drift ` +
        `(${driftX.toFixed(2)}, ${driftZ.toFixed(2)}) wu. The asset moved without ` +
        `the constants; row DROPPED rather than drawn where the colliders are not`,
    );
  }

  // 3. Footprint matches what the colliders were built from.
  const halfX = ((check.maxX - check.minX) / 2) * check.scaleX;
  const halfZ = ((check.maxZ - check.minZ) / 2) * check.scaleX;
  if (Math.abs(halfX - check.expectedHalfX) > tolerance) {
    problems.push(
      `${name}: footprint halfX ${halfX.toFixed(2)} wu != the ` +
        `${check.expectedHalfX} wu the colliders assume`,
    );
  }
  if (Math.abs(halfZ - check.expectedHalfZ) > tolerance) {
    problems.push(
      `${name}: footprint halfZ ${halfZ.toFixed(2)} wu != the ` +
        `${check.expectedHalfZ} wu the colliders assume`,
    );
  }

  return { problems, fatal };
}

/** Fold an angle into (-π, π]. Exported so the camera can take the SHORT arc. */
export function wrapTradingFloorAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

/**
 * The chase-camera yaw that looks the SAME way a seated avatar does, i.e. over
 * its shoulder at the desk.
 *
 * The camera's forward at yaw θ is `(sin θ, 0, -cos θ)`; the avatar's forward at
 * yaw f is `(sin f, 0, cos f)`. The two agree at `θ = π - f`. Without easing to
 * this on sit, the player keeps whatever yaw they walked in with — and every
 * desk faces a side wall, so the default seated view is a wall.
 */
export function tradingFloorSeatedCameraYaw(facing: number): number {
  return wrapTradingFloorAngle(Math.PI - facing);
}

export const TRADING_FLOOR_SEATS: readonly TradingFloorSeat[] = Object.freeze(
  TRADING_FLOOR_CONSOLE_ROW.map((slot, index) => {
    const facing = wrapTradingFloorAngle(slot.rotY + Math.PI);
    const alongX = Math.sin(slot.rotY);
    const alongZ = Math.cos(slot.rotY);
    const chairX = Math.round(slot.x + alongX * TRADING_FLOOR_CHAIR_OFFSET);
    const chairZ = Math.round(slot.z + alongZ * TRADING_FLOOR_CHAIR_OFFSET);
    // Decoded TradingFloorChairModule cushion top: X +/-46.0024,
    // Z [-39.0009, 47.0008], Y 85.0034 wu (node Y/scale 87).
    // The backrest ends at local Z -30; the exposed cushion spans [-30, 47].
    // Its centre is (0, 8.5) wu; rotate it by the chair yaw.
    return Object.freeze({
      index,
      x: Math.round(slot.x + alongX * TRADING_FLOOR_SEAT_OFFSET),
      z: Math.round(slot.z + alongZ * TRADING_FLOOR_SEAT_OFFSET),
      chairX,
      chairZ,
      sitX: chairX + Math.sin(facing) * 8.5,
      sitZ: chairZ + Math.cos(facing) * 8.5,
      facing,
      chairRotY: facing,
    });
  }),
);

/** P15 stage: board half-width + 25 wu per side; 370 wu from the board approach. */
const HOUSE_AGENT_STAGE_BOARD_MARGIN = 25;
const HOUSE_AGENT_STAGE_DEPTH = 370;
const HOUSE_AGENT_WALL_STANDOFF = 300;
const HOUSE_AGENT_Z = -(TRADING_FLOOR_ROOM.halfZ - HOUSE_AGENT_WALL_STANDOFF);
const HOUSE_AGENT_STAGE_HALF_X = TRADING_FLOOR_SCREEN.width / 2 + HOUSE_AGENT_STAGE_BOARD_MARGIN;
export const TRADING_FLOOR_HOUSE_AGENT_STAGE = Object.freeze({
  minX: -HOUSE_AGENT_STAGE_HALF_X,
  maxX: HOUSE_AGENT_STAGE_HALF_X,
  minZ: TRADING_FLOOR_BOARD_APPROACH_Z,
  maxZ: TRADING_FLOOR_BOARD_APPROACH_Z + HOUSE_AGENT_STAGE_DEPTH,
});

/** Template order, centred at (count - 1)/2 with board width/count spacing. Facing 0 is +Z. */
export const TRADING_FLOOR_HOUSE_AGENT_SPOTS: readonly {
  readonly index: number; readonly x: number; readonly z: number; readonly facing: number;
}[] = Object.freeze(FLOOR_ARENA_TEMPLATES.map((_, index) => Object.freeze({
  index,
  x: (index - (FLOOR_ARENA_TEMPLATES.length - 1) / 2) *
    TRADING_FLOOR_SCREEN.width / FLOOR_ARENA_TEMPLATES.length,
  z: HOUSE_AGENT_Z,
  facing: 0,
})));
export const TRADING_FLOOR_HOUSE_AGENT_WALKUP_RADIUS = 250;
export const TRADING_FLOOR_HOUSE_AGENT_HEIGHT = 270;
export const TRADING_FLOOR_HOUSE_AGENT_LABEL_Y = 345;
export const TRADING_FLOOR_HOUSE_AGENT_HALF_X = 70;
/** Close the rear strip: spot Z - board approach - player radius + 2 wu. */
export const TRADING_FLOOR_HOUSE_AGENT_HALF_Z = HOUSE_AGENT_Z -
  TRADING_FLOOR_BOARD_APPROACH_Z - TRADING_FLOOR_PLAYER_RADIUS + 2;
/** Movement only: camera blockers here caused 9,516 near-stage jumps in the spec sweep. */
export const TRADING_FLOOR_HOUSE_AGENT_SOLIDS: readonly TradingFloorAABB[] = Object.freeze(
  TRADING_FLOOR_HOUSE_AGENT_SPOTS.map((spot) => Object.freeze({
    centerX: spot.x, centerZ: spot.z,
    halfX: TRADING_FLOOR_HOUSE_AGENT_HALF_X, halfZ: TRADING_FLOOR_HOUSE_AGENT_HALF_Z,
  })),
);

/** Hide the mesh near the camera or across the camera-to-body sightline. Zero allocation. */
export function tradingFloorHouseAgentHidden(
  index: number, camX: number, camY: number, camZ: number, bodyX: number, bodyZ: number,
): boolean {
  const spot = TRADING_FLOOR_HOUSE_AGENT_SPOTS[index];
  if (!spot) return false;
  const dx = spot.x - camX, dz = spot.z - camZ;
  const clearance = TRADING_FLOOR_CAMERA_SOLID_CLEARANCE;
  if (Math.abs(dx) < TRADING_FLOOR_HOUSE_AGENT_HALF_X + clearance &&
      Math.abs(dz) < TRADING_FLOOR_HOUSE_AGENT_HALF_Z + clearance &&
      camY < TRADING_FLOOR_HOUSE_AGENT_HEIGHT + clearance) return true;

  const segmentX = bodyX - camX, segmentZ = bodyZ - camZ;
  const lengthSq = segmentX * segmentX + segmentZ * segmentZ;
  // Restrict the segment to heights <= the agent, then find its closest XZ point.
  const minT = camY > TRADING_FLOOR_HOUSE_AGENT_HEIGHT ?
    (camY - TRADING_FLOOR_HOUSE_AGENT_HEIGHT) / (camY - TRADING_FLOOR_CAMERA.lookY) : 0;
  const t = Math.max(minT, Math.min(1,
    lengthSq > 0 ? (dx * segmentX + dz * segmentZ) / lengthSq : 0));
  const offsetX = dx - segmentX * t, offsetZ = dz - segmentZ * t;
  return offsetX * offsetX + offsetZ * offsetZ <= 45 * 45;
}

/**
 * Axis-aligned solid volumes the player cannot walk through. Taken from the
 * GLB's placed props; the wall clamp is handled separately by the room bounds.
 *
 * Wall pilasters are absent: the side approach stops the body at the desk
 * face minus its radius, well inside the wall ribs, including between desks.
 *
 * The ten CHAIRS are absent too, and on purpose: a chair collider would block
 * its own seat, which is the one place the player has to be able to stand.
 *
 * The four corner PILLARS are present — their insets follow the shell resize,
 * so without a collider the player walks through them, which was a real
 * (pre-v2) defect rather than a v2 addition.
 */
export interface TradingFloorAABB {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfX: number;
  readonly halfZ: number;
}

/** Corner pillars: 165 wu wide, with the shell-relative insets below. */
export const TRADING_FLOOR_PILLAR_INSET_X = 217.5;
export const TRADING_FLOOR_PILLAR_INSET_Z = 285;
export const TRADING_FLOOR_PILLAR_HALF = 82.5;

/** Plinth footprint, independent of any larger movement collider. */
export const TRADING_FLOOR_DAIS = Object.freeze({ x: 0, z: -90, halfX: 350, halfZ: 346 });

/** Desk boxes share the rendered row's rotated footprints. */
export const TRADING_FLOOR_DESK_SOLIDS: readonly TradingFloorAABB[] = Object.freeze(
  TRADING_FLOOR_CONSOLE_ROW.map((slot) => Object.freeze({
    centerX: slot.x, centerZ: slot.z, ...consoleHalfExtents(slot.rotY),
  })),
);
/** TradingFloorHoloDais: node (0, -90), 700 x 692 footprint. */
export const TRADING_FLOOR_DAIS_SOLID: TradingFloorAABB = Object.freeze({
  centerX: TRADING_FLOOR_DAIS.x, centerZ: TRADING_FLOOR_DAIS.z,
  halfX: TRADING_FLOOR_DAIS.halfX, halfZ: TRADING_FLOOR_DAIS.halfZ,
});
export const TRADING_FLOOR_KIOSK_SOLID: TradingFloorAABB = Object.freeze({
  centerX: TRADING_FLOOR_MONITOR.x, centerZ: TRADING_FLOOR_MONITOR.z,
  halfX: TRADING_FLOOR_MONITOR.halfX, halfZ: TRADING_FLOOR_MONITOR.halfZ,
});
export const TRADING_FLOOR_PILLAR_SOLIDS: readonly TradingFloorAABB[] = Object.freeze(
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => Object.freeze({
    centerX: sx * (TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PILLAR_INSET_X),
    centerZ: sz * (TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PILLAR_INSET_Z),
    halfX: TRADING_FLOOR_PILLAR_HALF, halfZ: TRADING_FLOOR_PILLAR_HALF,
  }))),
);
export const TRADING_FLOOR_SOLIDS: readonly TradingFloorAABB[] = Object.freeze([
  ...TRADING_FLOOR_DESK_SOLIDS,
  TRADING_FLOOR_DAIS_SOLID,
  TRADING_FLOOR_KIOSK_SOLID,
  ...TRADING_FLOOR_PILLAR_SOLIDS,
  ...TRADING_FLOOR_HOUSE_AGENT_SOLIDS,
]);

/** Extend the wall-backed kiosk through the door wall; exclude the low plinth. */
const CAMERA_KIOSK_FRONT_Z = TRADING_FLOOR_MONITOR_FRONT_Z;
const CAMERA_KIOSK_BACK_Z = TRADING_FLOOR_ROOM.halfZ + TRADING_FLOOR_ROOM.height;
export const TRADING_FLOOR_CAMERA_KIOSK_SOLID: TradingFloorAABB = Object.freeze({
  centerX: TRADING_FLOOR_MONITOR.x,
  centerZ: (CAMERA_KIOSK_FRONT_Z + CAMERA_KIOSK_BACK_Z) / 2,
  halfX: TRADING_FLOOR_MONITOR.halfX,
  halfZ: (CAMERA_KIOSK_BACK_Z - CAMERA_KIOSK_FRONT_Z) / 2,
});
// Chairs stay outside camera lists: they shorten the seated arm to about 47 wu,
// while camera overlap occurs only at extreme downward pitch (<= -87).
export const TRADING_FLOOR_CAMERA_SOLIDS_HIGH: readonly TradingFloorAABB[] = Object.freeze([
  ...TRADING_FLOOR_DESK_SOLIDS,
  ...TRADING_FLOOR_PILLAR_SOLIDS,
  TRADING_FLOOR_CAMERA_KIOSK_SOLID,
]);

/**
 * MEASURED v5 claws in room space: |x| 177.14..263.60, z -146.85..-32.41.
 * Round outwards around the dais centre (0, -90); extras.statue top is 228.
 * The 230 wu cap encloses the measured top; these extents do not scale with the avatar or room.
 */
export const TRADING_FLOOR_CLAW_EXTENTS = Object.freeze({
  halfX: 264,
  halfZ: 58,
  offsetZ: 0.35,
  topY: 230,
});
export const TRADING_FLOOR_CAMERA_CLAW_SOLID: TradingFloorAABB = Object.freeze({
  centerX: TRADING_FLOOR_DAIS.x,
  centerZ: TRADING_FLOOR_DAIS.z + TRADING_FLOOR_CLAW_EXTENTS.offsetZ,
  halfX: TRADING_FLOOR_CLAW_EXTENTS.halfX,
  halfZ: TRADING_FLOOR_CLAW_EXTENTS.halfZ,
});
export const TRADING_FLOOR_CAMERA_SOLIDS_LOW: readonly TradingFloorAABB[] = Object.freeze([
  ...TRADING_FLOOR_CAMERA_SOLIDS_HIGH,
  TRADING_FLOOR_CAMERA_CLAW_SOLID,
]);

/** Shrink immediately; only unobstructed extension receives exponential ease. */
export function smoothTradingFloorCameraArm(
  current: number, raw: number, delta: number, snap = false,
): number {
  return snap || raw < current ? raw :
    current + (raw - current) * (1 - Math.exp(-TRADING_FLOOR_CAMERA_ARM.outRate * delta));
}

/** The boom alone receives ease; live pitch remains an immediate height offset. */
export function tradingFloorCameraBoom(pitch: number, arm: number): number {
  return Math.min(
    TRADING_FLOOR_ROOM.height - TRADING_FLOOR_CAMERA_SOLID_CLEARANCE -
      TRADING_FLOOR_CAMERA.above - pitch,
    // Positive pitch already raises the camera. Fade the extra corner boom
    // to zero at maximum pitch so a kiosk-corner retraction keeps its view step.
    Math.max(0, TRADING_FLOOR_CAMERA_ARM.boomStart - arm) * TRADING_FLOOR_CAMERA_ARM.boomRise *
      (1 - Math.max(0, pitch) / TRADING_FLOOR_CAMERA.pitchMax),
  );
}

export function smoothTradingFloorCameraBoom(
  current: number, target: number, delta: number, snap = false,
): number {
  return snap ? target : current + (target - current) *
    (1 - Math.exp(-TRADING_FLOOR_CAMERA_ARM.boomRate * delta));
}

/** First slab entry along the backward arm, with no objects or vectors allocated. */
function clipTradingFloorCameraArm(
  ox: number, oz: number, dx: number, dz: number, arm: number,
  solids: readonly TradingFloorAABB[],
): number {
  const c = TRADING_FLOOR_CAMERA_SOLID_CLEARANCE;
  for (let index = 0; index < solids.length; index++) {
    const s = solids[index]!;
    const minX = s.centerX - s.halfX - c, maxX = s.centerX + s.halfX + c;
    const minZ = s.centerZ - s.halfZ - c, maxZ = s.centerZ + s.halfZ + c;
    let entry = -Infinity, exit = Infinity;
    if (Math.abs(dx) < 1e-9) {
      if (ox <= minX || ox >= maxX) continue;
    } else {
      const a = (minX - ox) / dx, b = (maxX - ox) / dx;
      entry = Math.max(entry, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
    if (Math.abs(dz) < 1e-9) {
      if (oz <= minZ || oz >= maxZ) continue;
    } else {
      const a = (minZ - oz) / dz, b = (maxZ - oz) / dz;
      entry = Math.max(entry, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
    if (exit <= 0 || entry > exit || entry < 0) continue;
    // Stay just before the face, including floating-point roundoff.
    arm = Math.min(arm, Math.max(0, entry - TRADING_FLOOR_CAMERA.near * 1e-6));
  }
  return arm;
}

/**
 * Cast the backward arm against the envelope and expanded camera solids.
 * Return the full raw limit. Optional armLength draws a shorter, smoothed arm
 * through the same placement path. Legal body positions need no origin inset.
 * boomFloor is the previously drawn boom; LOW blockers protect its height lag.
 * The inset protects a spawn/snap at an envelope plane without a sideways push.
 */
export function placeTradingFloorChaseCamera(
  bodyX: number, bodyZ: number, yaw: number, pitch: number,
  out: { x: number; y: number; z: number },
  armLength: number = TRADING_FLOOR_CAMERA.behind,
  boomFloor: number = Infinity,
): number {
  const w = TRADING_FLOOR_CAMERA_BOUNDS, inset = TRADING_FLOOR_CAMERA_ARM.originInset;
  const minX = -w.halfX + w.margin, maxX = w.halfX - w.margin;
  const minZ = w.zMin + w.margin, maxZ = w.zMax - w.margin;
  const ox = Math.max(minX + inset, Math.min(maxX - inset, bodyX));
  const oz = Math.max(minZ + inset, Math.min(maxZ - inset, bodyZ));
  const dx = -Math.sin(yaw), dz = Math.cos(yaw);
  let raw: number = TRADING_FLOOR_CAMERA.behind;
  if (dx > 1e-9) raw = Math.min(raw, (maxX - ox) / dx);
  else if (dx < -1e-9) raw = Math.min(raw, (minX - ox) / dx);
  if (dz > 1e-9) raw = Math.min(raw, (maxZ - oz) / dz);
  else if (dz < -1e-9) raw = Math.min(raw, (minZ - oz) / dz);
  raw = clipTradingFloorCameraArm(ox, oz, dx, dz, raw, TRADING_FLOOR_CAMERA_SOLIDS_HIGH);
  const boomTarget = tradingFloorCameraBoom(pitch, Math.min(raw, armLength));
  if (TRADING_FLOOR_CAMERA.above + pitch + Math.min(boomFloor, boomTarget) <
      TRADING_FLOOR_CLAW_EXTENTS.topY + TRADING_FLOOR_CAMERA_SOLID_CLEARANCE) {
    raw = clipTradingFloorCameraArm(ox, oz, dx, dz, raw, TRADING_FLOOR_CAMERA_SOLIDS_LOW);
  }
  const length = Math.max(0, Math.min(raw, armLength));
  out.x = ox + dx * length;
  out.y = TRADING_FLOOR_CAMERA.above + pitch + tradingFloorCameraBoom(pitch, length);
  out.z = oz + dz * length;
  return raw;
}

/** True when (x, z) is inside any solid, expanded by the player radius. */
export function tradingFloorHitsSolid(x: number, z: number): boolean {
  for (let index = 0; index < TRADING_FLOOR_SOLIDS.length; index++) {
    const solid = TRADING_FLOOR_SOLIDS[index]!;
    if (
      x > solid.centerX - solid.halfX - TRADING_FLOOR_PLAYER_RADIUS &&
      x < solid.centerX + solid.halfX + TRADING_FLOOR_PLAYER_RADIUS &&
      z > solid.centerZ - solid.halfZ - TRADING_FLOOR_PLAYER_RADIUS &&
      z < solid.centerZ + solid.halfZ + TRADING_FLOOR_PLAYER_RADIUS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Axis-separated interior movement clamp. Walls first, then per-axis solid
 * rejection so a player sliding along a desk keeps the free axis.
 * Zero allocation — the caller owns `out`.
 */
export function clampTradingFloorMovement2D(
  currentX: number,
  currentZ: number,
  desiredX: number,
  desiredZ: number,
  out: { x: number; z: number },
): void {
  const maxX = TRADING_FLOOR_SIDE_APPROACH_X;
  const nextX = Math.max(-maxX, Math.min(maxX, desiredX));
  // Both end approaches preserve an arm behind the body.
  const nextZ = Math.max(
    TRADING_FLOOR_BOARD_APPROACH_Z,
    Math.min(TRADING_FLOOR_DOOR_APPROACH_Z, desiredZ),
  );
  out.x = tradingFloorHitsSolid(nextX, currentZ) ? currentX : nextX;
  out.z = tradingFloorHitsSolid(out.x, nextZ) ? currentZ : nextZ;
}

/**
 * The seat closest to (x, z), with its squared XZ distance. Returns index -1
 * only if the seat list is empty. Zero allocation: the caller owns `out`, so
 * the frame loop can ask every frame without touching the GC.
 */
export function nearestTradingFloorSeat(
  x: number,
  z: number,
  out: { index: number; distanceSq: number },
): void {
  out.index = -1;
  out.distanceSq = Number.POSITIVE_INFINITY;
  for (let index = 0; index < TRADING_FLOOR_SEATS.length; index++) {
    const seat = TRADING_FLOOR_SEATS[index]!;
    const dx = x - seat.x;
    const dz = z - seat.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < out.distanceSq) {
      out.distanceSq = distanceSq;
      out.index = index;
    }
  }
}

/** Squared XZ distance helper — keeps the frame loop free of Math.sqrt. */
export function tradingFloorDistanceSq(
  x: number,
  z: number,
  targetX: number,
  targetZ: number,
): number {
  const dx = x - targetX;
  const dz = z - targetZ;
  return dx * dx + dz * dz;
}

/**
 * Movement clamp for ONE frame, seat-aware.
 *
 * A seated player is pinned to the seat: the step is refused, but the intent is
 * NOT swallowed. The scene reads `moving` on the same frame to stand the avatar
 * up, so the player is pinned on the frame they ask to leave and walking on the
 * next one. Freezing the whole controller instead (`isFrozen`) would eat the E
 * key as well, and then nothing could stand them back up again.
 *
 * `seatedIndex < 0` means walking, and the call is the plain wall + solid clamp.
 * Zero allocation — the caller owns `out`.
 */
export function clampTradingFloorMovementSeated(
  seatedIndex: number,
  currentX: number,
  currentZ: number,
  desiredX: number,
  desiredZ: number,
  out: { x: number; z: number },
): void {
  const seat = seatedIndex >= 0 ? TRADING_FLOOR_SEATS[seatedIndex] : undefined;
  if (seat) {
    out.x = seat.x;
    out.z = seat.z;
    return;
  }
  clampTradingFloorMovement2D(currentX, currentZ, desiredX, desiredZ, out);
}

// ---------------------------------------------------------------------------
// Hotspot arming + the interact ladder
//
// Both live HERE rather than in the scene file, and that is the point: they are
// pure functions of a position, so the priority order the founder's room depends
// on can be pinned by a real behavioural test instead of a source scan. The
// scene calls exactly these — there is no second copy to drift.
// ---------------------------------------------------------------------------

/** Which hotspots a position arms. Mutable: the frame loop reuses one. */
export interface TradingFloorArming {
  monitorArmed: boolean;
  monitorHint: boolean;
  doorArmed: boolean;
  doorHint: boolean;
  /** Seat whose interact band contains the position, or -1. */
  seatArmedIndex: number;
  /** Seat whose hint band contains the position, or -1. */
  seatHintIndex: number;
}

/** A disarmed arming record. One per scene mount, never per frame. */
export function createTradingFloorArming(): TradingFloorArming {
  return {
    monitorArmed: false,
    monitorHint: false,
    doorArmed: false,
    doorHint: false,
    seatArmedIndex: -1,
    seatHintIndex: -1,
  };
}

/** Reset an arming record in place — used on scene exit and re-entry. */
export function resetTradingFloorArming(out: TradingFloorArming): void {
  out.monitorArmed = false;
  out.monitorHint = false;
  out.doorArmed = false;
  out.doorHint = false;
  out.seatArmedIndex = -1;
  out.seatHintIndex = -1;
}

const MONITOR_ARM_SQ =
  TRADING_FLOOR_MONITOR.interactRadius * TRADING_FLOOR_MONITOR.interactRadius;
const MONITOR_HINT_SQ =
  TRADING_FLOOR_MONITOR.nearHintRadius * TRADING_FLOOR_MONITOR.nearHintRadius;
const DOOR_ARM_SQ =
  TRADING_FLOOR_DOOR.interactRadius * TRADING_FLOOR_DOOR.interactRadius;
const DOOR_HINT_SQ =
  TRADING_FLOOR_DOOR.nearHintRadius * TRADING_FLOOR_DOOR.nearHintRadius;
const SEAT_ARM_SQ =
  TRADING_FLOOR_SEAT_INTERACT_RADIUS * TRADING_FLOOR_SEAT_INTERACT_RADIUS;
const SEAT_HINT_SQ =
  TRADING_FLOOR_SEAT_HINT_RADIUS * TRADING_FLOOR_SEAT_HINT_RADIUS;

/** Module-scope scratch for the seat search. Never allocates per frame. */
const _armingNearestSeat = { index: -1, distanceSq: 0 };

/**
 * What the body position at (x, z) arms this frame. Scalar, zero allocation:
 * the caller owns `out`, so the frame loop can ask every frame for free.
 */
export function computeTradingFloorArming(
  x: number,
  z: number,
  out: TradingFloorArming,
): void {
  const monitorSq = tradingFloorDistanceSq(
    x,
    z,
    TRADING_FLOOR_MONITOR.x,
    TRADING_FLOOR_MONITOR.z,
  );
  const doorSq = tradingFloorDistanceSq(
    x,
    z,
    TRADING_FLOOR_DOOR.x,
    TRADING_FLOOR_DOOR.z,
  );
  out.monitorArmed = monitorSq <= MONITOR_ARM_SQ;
  out.monitorHint = monitorSq <= MONITOR_HINT_SQ;
  out.doorArmed = doorSq <= DOOR_ARM_SQ;
  out.doorHint = doorSq <= DOOR_HINT_SQ;

  nearestTradingFloorSeat(x, z, _armingNearestSeat);
  const seatIndex = _armingNearestSeat.index;
  out.seatArmedIndex =
    seatIndex >= 0 && _armingNearestSeat.distanceSq <= SEAT_ARM_SQ
      ? seatIndex
      : -1;
  out.seatHintIndex =
    seatIndex >= 0 && _armingNearestSeat.distanceSq <= SEAT_HINT_SQ
      ? seatIndex
      : -1;
}

/**
 * Whether the door's "Exit" capsule is shown.
 *
 * The capsule is an HTML world label anchored at head height just inside the
 * door approach. Its placement was proved on screen for a player FACING THE
 * BOARD near the door (camera clamped at `TRADING_FLOOR_CAMERA_Z_MAX`), and in
 * exactly that pose it projects onto the bottom edge of the big board: the
 * spawn is inside the 460 wu hint band, so it covered the board's basis line
 * and ticker on arrival (verifier B, staging 9dc59f73, shots b-01/b-02).
 *
 * The HINT therefore needs the camera to face the door half-space
 * (`forwardZ > 0`, forward = `(sin yaw, 0, -cos yaw)`): the board is then more
 * than 90° off the view axis and cannot sit behind the label. The ARMED prompt
 * is always shown, because E really leaves from there and a working action
 * with no visible prompt is the failure this label has had twice already;
 * backing into the door while facing the board is the one pose where it still
 * covers the board's footer, and only inside the 240 wu armed radius.
 */
export function tradingFloorDoorPromptVisible(
  armed: boolean,
  hint: boolean,
  cameraForwardZ: number,
): boolean {
  return armed || (hint && cameraForwardZ > 0);
}

/**
 * The ONE interact ladder. E on the keyboard and the USE button on a touch
 * device both resolve through this, so a new interaction cannot reach one input
 * and miss the other.
 *
 * Priority: stand > monitor > door > sit. Standing comes first because while
 * seated the other three are exactly the ones that must not fire. The geometry
 * already keeps monitor, door and seat bands disjoint
 * (`trading-floor-monitor.test.ts`), so the rest of the order resolves a tie the
 * room never presents — but it is the order the labels suppress by, and a future
 * prop move must not be able to change the answer by accident.
 */
export type TradingFloorInteraction =
  | 'stand'
  | 'monitor'
  | 'door'
  | 'sit'
  | 'none';

export function resolveTradingFloorInteraction(
  arming: TradingFloorArming,
  seatedIndex: number,
  frozen: boolean,
): TradingFloorInteraction {
  // The Exchange panel outranks the whole ladder, INCLUDING standing up. While
  // it is open the only way out is Escape or its close button.
  //
  // `frozen` is a REQUIRED parameter, not an optional one with a default. The
  // bug this closes was a caller that never consulted the freeze at all, and an
  // optional flag lets exactly that happen again silently — a new entry point
  // omits it, defaults to "not frozen", and walks straight past the panel.
  if (frozen) return 'none';
  if (seatedIndex >= 0) return 'stand';
  if (arming.monitorArmed) return 'monitor';
  if (arming.doorArmed) return 'door';
  if (arming.seatArmedIndex >= 0) return 'sit';
  return 'none';
}
