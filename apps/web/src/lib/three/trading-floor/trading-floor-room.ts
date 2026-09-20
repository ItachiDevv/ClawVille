/**
 * trading-floor-room.ts
 *
 * Pure geometry + camera constants for the Trading Floor INTERIOR.
 *
 * Deliberately dependency-free (no `three`, no React, no tilemap): the stage
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
 * hall's 950 wu ceiling is ~3.5x avatar height — a trading hall, not a
 * crawlspace.
 */

/** Stage slot id. Must equal `TRADING_FLOOR_SCENE_ID` in stage-scene-id.ts. */
export const TRADING_FLOOR_SCENE_ID = 'trading-floor';

/**
 * Interior shell — the authored hall in `trading-floor-interior-opt1-mo-ktx.glb`.
 *
 * That GLB is authored at 1 unit = 1 wu and is ALREADY at final scale, so it
 * is mounted with no auto-fit (3dStructure.md §9g). These numbers mirror it:
 * hall 2600 (X) x 950 (Y) x 2200 (Z), wall thickness 60, doorway on the +Z
 * wall. Walls sit OUTSIDE these half-extents (inner face = halfX / halfZ).
 */
export const TRADING_FLOOR_ROOM = Object.freeze({
  halfX: 1300,
  halfZ: 1100,
  height: 950,
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
  z: TRADING_FLOOR_ROOM.halfZ - 320,
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
   * Inward margin for clampCameraToRoom so the camera never clips a wall.
   * Small on purpose: in a 2600 x 2200 hall the chase arm is longer than the
   * room's half-depth, so the camera lives clamped against the back wall most
   * of the time and every wu of margin costs framing distance.
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
 * The walk-up MONITOR — the founder's "a monitor almost to walk up to and
 * manage trades". `TradingFloorMonitorStation` in the interior GLB: a
 * 129 x 300 x 101 kiosk seated on the floor against the -Z wall. E (or a click)
 * opens the existing Exchange modal on its Trading Floor tab. It was authored at
 * 202 x 470 x 158 and rescaled by a uniform 300/470 in v3 — see below.
 *
 * Every number below is read off the GLB's own node transform
 * (`scripts/trading-floor/inspect-glb.mjs`), so the hotspot cannot drift away
 * from the prop it belongs to.
 *
 * The big board fills the middle of the -Z wall from y 360 up. The kiosk was
 * 470 wu and parked dead centre, which hid the board's lower band from a chase
 * camera at y 260; v2 moved it off-centre to x -300 and v3 cut it to 300 wu, so
 * its occlusion shadow on the board plane falls to 339 against a 360 sill and it
 * no longer covers the board at all. The off-centre x still earns its keep: it
 * keeps the kiosk's interact band disjoint from every seat band.
 *
 * v3 SHRANK it and pushed it back: 470 -> 300 wu tall at z -900 -> -980. Moving
 * it sideways was tried first and cannot work — the integrator measured that the
 * seat-band rule wants |kiosk x| < 639 while clearing the board's x-span from
 * the spawn wants |kiosk x| > 751, and those windows do not intersect. So the
 * kiosk got shorter instead. Its occlusion shadow on the board plane is
 * `cy + (470 - cy) * t`; at 300 wu and z -980 the worst case (the dais ring's
 * far side at full pitch-down) drops to 339, which is what let the board's
 * bottom edge come down to 360 and clear by 21 wu.
 *
 * EVERY NUMBER HERE IS THE ASSET'S OWN, not a product of that reasoning. The
 * GLB publishes its contract in the scene root's `extras.kiosk`, and these
 * constants are asserted EXACTLY against it by `trading-floor-asset.test.ts`.
 *
 * Note the two legitimately different half-X values, because the difference is
 * a trap rather than an error: `extras` says 64.49, computed from the build
 * script's pre-quantization float geometry, while measuring the shipped mesh
 * through dequantized accessors gives 64.478. The 0.01 is the
 * `KHR_mesh_quantization` round-trip. The AUTHORED number is the one that
 * belongs here, so extras-vs-constants is asserted exact and
 * extras-vs-measured-mesh gets a tolerance — an exact assert there would go red
 * on quantizer noise rather than on a defect.
 *
 * `screenY` is the old 330 carried through the same `MONITOR_SCALE = 300/470`
 * the build script applies to the whole prop. The node is
 * `t=[-300, 150, -980] s=150`; the 300/470 is baked into the POSITION stream
 * rather than the node scale, deliberately, so `authored.scale.x` keeps meaning
 * exactly one thing for `buildInstancedRow`.
 *
 * The second constraint on the position is the SEAT bands: every seat band must
 * stay disjoint from this one, so E is never ambiguous between "sit" and
 * "manage trades".
 *
 * NO WORKED EXAMPLE HERE ON PURPOSE. This sentence carried a hand-typed
 * "nearest seat is (x, z), N wu away" twice, and both times the literal was a
 * fossil of an earlier `TRADING_FLOOR_SEAT_OFFSET` (713 wu at offset 230, 738 wu
 * at offset 200) that nobody recomputed when the offset shipped at 205. A
 * comment that rots on every tuning pass is worse than no comment.
 * `trading-floor-monitor.test.ts` asserts the disjointness by COMPUTING
 * `interactRadius + TRADING_FLOOR_SEAT_INTERACT_RADIUS` from these constants, so
 * moving the kiosk or retuning a radius re-derives the bound instead of
 * invalidating a sentence.
 */
export const TRADING_FLOOR_MONITOR = Object.freeze({
  x: -300,
  z: -980,
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
 * 2026-09-19, FINAL after three revisions (650 at y 250 → 540 at y 340 → 520 at
 * y 360). The board keeps its full 1700 width; what moved is the height and the
 * sill. The kiosk was shortened from 470 to 300 wu — it was 1.74x a 270 wu
 * avatar, about 2.95 m — which drops its occlusion shadow on the board plane
 * from 595 to 339. A sill at 360 therefore clears the shadow by 21 wu, so the
 * board is no longer occluded from any ground viewpoint and the layout needs no
 * keep-out zone in its lower-left.
 *
 * The ceiling sets the ceiling: the surround's top edge is
 * `bottomY + height + 68` against a 950 inner face, so `bottomY + height <= 882`
 * and 360 + 520 = 880 spends all but 2 wu of it.
 *
 * `canvasWidth` / `canvasHeight` are the LOGICAL drawing space, and
 * `FLOOR_SCREEN_CANVAS` in `trading-floor-screen-texture.ts` is DERIVED from
 * them — one literal pair, not two. They were two hand-typed pairs until the
 * third drift this session (`325` here against `392` there, caught by a test
 * mid-round); deriving is what makes a fourth impossible. `SCREEN_*` in
 * `scripts/trading-floor/build-interior.mjs` is the one copy that CANNOT be
 * derived, because it runs in the asset pipeline: it must be re-exported to
 * frame a 520-tall rect at y 360 or the plane will not sit in its surround.
 */
export const TRADING_FLOOR_SCREEN = Object.freeze({
  width: 1700,
  height: 520,
  bottomY: 360,
  centerY: 360 + 520 / 2,
  /** 6 wu clear of the wall's inner face — enough to beat z-fighting. */
  z: -TRADING_FLOOR_ROOM.halfZ + 6,
  canvasWidth: 1024,
  canvasHeight: 313,
});

/**
 * The trading-desk row.
 *
 * The interior GLB ships ONE `TradingFloorConsoleModule` (364 × 166 × 270).
 * The scene extracts it and draws the row as a single `InstancedMesh` — six
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
 * `CONSOLE_WALL_X` is `halfX(1300) − pilaster depth(40) − desk halfX(135) − 5`.
 * The trailing 5 is a real gap, not rounding: at 1125 the desk's bbox face and
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
 * `inspect-glb.mjs` reports the node at scale 182.165 with a bbox half of 1.0
 * in X and 0.741 in Z, i.e. 182.165 × 135.0 exactly. The 0.165 wu rounded off X
 * is deliberate and harmless against a 46 wu player radius — it is recorded here
 * only so nobody "corrects" the collider to 182.165 and then wonders why the
 * seat-offset floor test moved.
 */
export const TRADING_FLOOR_CONSOLE_HALF_X = 182;
export const TRADING_FLOOR_CONSOLE_HALF_Z = 135;
/**
 * Desk height, read off the GLB (§9g: console 364 × 166 × 270, desk at hip
 * height against a 270 wu avatar). Load-bearing for the CAMERA, not just for
 * looks: the chase camera's own Y floor is `above + pitchMin` = 140, which is
 * BELOW this, so the camera has to be bounded in X by the desk face rather than
 * by the wall. `trading-floor-seats.test.ts` pins that relationship.
 */
export const TRADING_FLOOR_CONSOLE_HEIGHT = 166;

/**
 * The chair's CUSHION TOP, world Y. Measured off the shipped GLB by tf3d-shell
 * (`TradingFloorChairModule`, 128 x 175 x 122 wu, base-centre origin, sit
 * surface 85 wu, backrest top rail 173 wu) and independently confirmed by
 * Blender's importer at `min=[-64,-61,-2] max=[64,61,173]`.
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

const CONSOLE_WALL_X = 1120;
const CONSOLE_ROW_Z = [-500, 0, 500] as const;

export const TRADING_FLOOR_CONSOLE_ROW: readonly TradingFloorConsoleSlot[] =
  Object.freeze([
    ...CONSOLE_ROW_Z.map((z) =>
      Object.freeze({ x: -CONSOLE_WALL_X, z, rotY: Math.PI / 2 }),
    ),
    ...CONSOLE_ROW_Z.map((z) =>
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
 * `-1100 + 12 + 44/2 = -1066`. It protrudes 28 wu in front of the board plane
 * at `TRADING_FLOOR_SCREEN.z`, and it is the thing the chase camera must not
 * reverse into at the back wall.
 */
export const TRADING_FLOOR_SCREEN_SURROUND_FACE_Z = -1066;

/**
 * The chase camera's OWN Z limits — deliberately NOT the room's walls, and
 * deliberately ASYMMETRIC.
 *
 * THE BUG THIS FIXES. `clampCameraToRoom` permits `zMax - margin`, so a bound of
 * `halfZ` gave the camera ±1040 while the movement clamp lets the PLAYER reach
 * `halfZ - PLAYER_RADIUS` = ±1054. The camera therefore ended up 14 wu IN FRONT
 * of the avatar at either end wall: the rig inverts, the view faces away from
 * the wall the player walked to, and the avatar smears across the near plane.
 *
 * At the door that had a second, worse symptom. The exit label's anchor sits at
 * `DOOR.z - 40` = 1060, and the overlay culls any anchor at or behind the camera
 * plane in view space. With the camera pinned at 1040 the anchor was behind it
 * at EVERY distance, so the Exit prompt was never visible — not merely when
 * armed. The exit itself always worked, which is exactly why this survived: the
 * feature was reachable, only its prompt was gone, and an earlier label reader
 * matched hidden `display:none` DOM and reported it present.
 *
 * The general invariant, worth keeping when either number moves: **the camera's
 * Z bound must leave an arm BEHIND the player's own Z bound.** Same class as the
 * `halfX` desk-face bound, on the other axis, with a worse symptom.
 *
 * The two ends differ because the walls carry different things:
 *  - **+Z, the door wall.** Nothing protrudes, so the camera may run to 12 wu off
 *    the wall and sit 34 wu behind a player pressed into the doorway.
 *  - **-Z, the board wall.** The screen surround protrudes to
 *    `TRADING_FLOOR_SCREEN_SURROUND_FACE_Z`, so the camera stops at the player's
 *    own limit, which clears that face by 12 wu. That is zero arm rather than a
 *    negative one: it removes the inversion without reversing into the bezel.
 *    The real fix for the back wall is a collider on the surround so the player
 *    stops before it, which is an asset-side change and not in this diff.
 */
/**
 * How close to the door wall the PLAYER may walk.
 *
 * The camera-side bound above stops the rig inverting, but 34 wu of arm is not a
 * chase shot — the avatar fills the near plane. The honest fix is on the player
 * side: stop them 180 wu short of the door and the camera gets a real arm
 * (168 wu with the bound above) without any of it being taken from the room.
 *
 * 180 is chosen against `TRADING_FLOOR_DOOR.interactRadius` (240): the player's
 * closest legal approach is INSIDE the arm band, so E still fires at the wall.
 * The spawn at `halfZ - 320` = 780 is well short of this and is unchanged, and
 * the exit spawn and the walk-in path are world-side, so neither is touched.
 *
 * Only the +Z end moves. The board wall keeps the full `halfZ - PLAYER_RADIUS`
 * so the player can still walk up and read the board.
 */
export const TRADING_FLOOR_DOOR_APPROACH_Z = TRADING_FLOOR_ROOM.halfZ - 180;

/**
 * Standoff used when pushing the camera out of a prop.
 *
 * DELIBERATELY NOT `roomMargin` (60), and this is a change from what was asked.
 * The push-out exists to stop the camera being INSIDE geometry, which with
 * `near = 1` needs only a few world units. At 60 the desks would shove the
 * camera from the desk face at 985 out to 925, taking another 60 wu of framing
 * at the side walls — where the integrator has already flagged the framing as
 * tight and a founder call. 12 achieves the same visual result and costs 12.
 * The value is a parameter of `pushCameraOutOfSolids`, so raising it is a
 * one-line change if the founder wants more standoff.
 */
export const TRADING_FLOOR_CAMERA_SOLID_CLEARANCE = 12;

const CAMERA_WALL_CLEARANCE = 12;
export const TRADING_FLOOR_CAMERA_Z_MAX =
  TRADING_FLOOR_ROOM.halfZ - CAMERA_WALL_CLEARANCE;
export const TRADING_FLOOR_CAMERA_Z_MIN = -(
  TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS
);

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
  /** Avatar yaw while seated — looks at the desk. */
  readonly facing: number;
  /** Yaw of the chair prop. Same value: the chair model seats a +Z occupant. */
  readonly chairRotY: number;
}

/**
 * Half-extents of the authored chair, world units. Measured off the shipped GLB
 * (128 x 175 x 122; the armrests at x ±58 set the width, NOT the 122 wu base
 * spider). `TRADING_FLOOR_CHAIR_OFFSET` is derived from the 64.
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
 * rounding the constants already carry (the console measures 182.165 against a
 * stated 182).
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
 * does sit on the floor spanning y 0 to 165.77, yet its bbox centre Y still
 * reads 0 because the 82.88 went onto `node.translation.y`. So the detectable
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
    return Object.freeze({
      index,
      x: Math.round(slot.x + alongX * TRADING_FLOOR_SEAT_OFFSET),
      z: Math.round(slot.z + alongZ * TRADING_FLOOR_SEAT_OFFSET),
      chairX: Math.round(slot.x + alongX * TRADING_FLOOR_CHAIR_OFFSET),
      chairZ: Math.round(slot.z + alongZ * TRADING_FLOOR_CHAIR_OFFSET),
      facing,
      chairRotY: facing,
    });
  }),
);

/**
 * Axis-aligned solid volumes the player cannot walk through. Taken from the
 * GLB's placed props; the wall clamp is handled separately by the room bounds.
 *
 * The wall PILASTERS are deliberately absent. They are 40 wu deep, and the wall
 * clamp already stops the player's CENTRE at halfX − 46 = 1254, which is 6 wu
 * short of the rib's inner face at 1260 — so a rib can never block or trap
 * anyone, and giving each of the ten its own AABB would only add per-frame work
 * for a volume nobody can enter. Be precise about what that does and does not
 * buy: the 46 wu collision circle still overlaps the rib, so an avatar's
 * shoulders can visually clip one along either side wall. That is a render
 * artefact at the room's extreme edge, not a movement bug, and no collider
 * fixes it — only a wall margin wider than the player radius would.
 *
 * The six CHAIRS are absent too, and on purpose: a chair collider would block
 * its own seat, which is the one place the player has to be able to stand.
 *
 * The four corner PILLARS are present — they stand 190 wu clear of the walls,
 * so without a collider the player walks through them, which was a real
 * (pre-v2) defect rather than a v2 addition.
 */
export interface TradingFloorAABB {
  readonly centerX: number;
  readonly centerZ: number;
  readonly halfX: number;
  readonly halfZ: number;
}

/** Corner pillars: `boxGeo(±(halfX − 190), …, ±(halfZ − 190), 110, RH, 110)`. */
const PILLAR_INSET = 190;
const PILLAR_HALF = 55;

export const TRADING_FLOOR_SOLIDS: readonly TradingFloorAABB[] = Object.freeze([
  // The instanced console row — same source array the renderer uses, with the
  // footprint derived from each slot's own yaw.
  ...TRADING_FLOOR_CONSOLE_ROW.map((slot) => {
    const { halfX, halfZ } = consoleHalfExtents(slot.rotY);
    return Object.freeze({
      centerX: slot.x,
      centerZ: slot.z,
      halfX,
      halfZ,
    });
  }),
  // TradingFloorHoloDais — node (0, -60), 700 x 692 footprint, 206 tall.
  Object.freeze({ centerX: 0, centerZ: -60, halfX: 350, halfZ: 346 }),
  // TradingFloorMonitorStation — node (-300, -980), 129 x 101 footprint (v3).
  Object.freeze({
    centerX: TRADING_FLOOR_MONITOR.x,
    centerZ: TRADING_FLOOR_MONITOR.z,
    halfX: TRADING_FLOOR_MONITOR.halfX,
    halfZ: TRADING_FLOOR_MONITOR.halfZ,
  }),
  // Four corner pillars.
  ...[-1, 1].flatMap((sx) =>
    [-1, 1].map((sz) =>
      Object.freeze({
        centerX: sx * (TRADING_FLOOR_ROOM.halfX - PILLAR_INSET),
        centerZ: sz * (TRADING_FLOOR_ROOM.halfZ - PILLAR_INSET),
        halfX: PILLAR_HALF,
        halfZ: PILLAR_HALF,
      }),
    ),
  ),
]);

/**
 * Push a camera position out of any solid it has ended up inside, along the
 * axis of least penetration.
 *
 * `clampCameraToRoom` only knows the room's AABB, so it happily parks the chase
 * camera inside a prop: a player on the far side of the holo dais, pitched down,
 * put the camera INSIDE the dais mesh and dark geometry smeared across the whole
 * frame. This is the local fix. The shared `room-camera.ts` is NOT touched — the
 * cove and kelp use it and a per-solid push-out there would be their change too.
 *
 * Axis of least penetration is the right rule for an AABB: it moves the camera
 * the shortest distance that resolves the overlap, so the view shifts as little
 * as possible. Up to three passes, because resolving one solid can push the
 * point into a neighbour; the postcondition the tests assert is "outside every
 * solid", not "one pass happened".
 *
 * Zero allocation, scalar only — the caller owns `pos` and it is mutated in
 * place, so this is safe to call every frame.
 */
export function pushCameraOutOfSolids(
  pos: { x: number; z: number },
  solids: readonly TradingFloorAABB[],
  clearance: number,
): void {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let index = 0; index < solids.length; index++) {
      const solid = solids[index]!;
      const halfX = solid.halfX + clearance;
      const halfZ = solid.halfZ + clearance;
      const dx = pos.x - solid.centerX;
      const dz = pos.z - solid.centerZ;
      const penX = halfX - Math.abs(dx);
      const penZ = halfZ - Math.abs(dz);
      // Outside on either axis means outside the box.
      if (penX <= 0 || penZ <= 0) continue;
      if (penX <= penZ) {
        // `dx || 1` matters: dead centre gives dx = 0 and Math.sign(0) = 0,
        // which would "resolve" the overlap by leaving the camera inside.
        pos.x = solid.centerX + Math.sign(dx || 1) * halfX;
      } else {
        pos.z = solid.centerZ + Math.sign(dz || 1) * halfZ;
      }
      moved = true;
    }
    if (!moved) return;
  }
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
  const maxX = TRADING_FLOOR_ROOM.halfX - TRADING_FLOOR_PLAYER_RADIUS;
  const nextX = Math.max(-maxX, Math.min(maxX, desiredX));
  // Z is ASYMMETRIC: the door end stops early so the chase camera keeps a real
  // arm behind the player. See TRADING_FLOOR_DOOR_APPROACH_Z.
  const nextZ = Math.max(
    -(TRADING_FLOOR_ROOM.halfZ - TRADING_FLOOR_PLAYER_RADIUS),
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
