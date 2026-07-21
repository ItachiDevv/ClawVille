/**
 * reef-race-config.ts
 *
 * All constants for the Reef Race activity scene.
 * Track path, checkpoint positions, camera, fog, lighting, pickups, ghost, boost.
 *
 * Performance budget: ≤70 draw calls / ≤220k tris / no shadow map / 1 half-resolution bloom pass.
 * Target GPU: Intel Iris Xe (integrated). Chase-cam model: one frustum per client.
 *
 * Mirror of bumper-shells-config.ts style — one import covers the entire scene.
 */

import * as THREE from 'three';

// ─── Track geometry ──────────────────────────────────────────────────────────

/**
 * CatmullRomCurve3 control points matching the SERVER-AUTHORITATIVE ellipse.
 *
 * Server sim (reef-race-config.ts in apps/api) defines the oval as:
 *   REEF_TRACK_A = 1100  (X half-axis, sim-X → Three.js X)
 *   REEF_TRACK_B = 700   (Y half-axis, sim-Y → Three.js Z)
 *   reefCenterlineAt(t) = { x: 1100*cos(π/2 + 2πt), y: 700*sin(π/2 + 2πt) }
 *   t=0 → (0, 700)  → Three.js (0, 0, 700)    ← start/finish
 *
 * CRITICAL: entity.x and entity.y from the server are in these sim coordinates.
 * The scene maps entity.x → THREE.x and entity.y → THREE.z (flat XZ plane).
 * If the visual track uses different coordinates the players float off-track.
 *
 * 16 points sampling the ellipse at equal t intervals, closed loop.
 */
function makeEllipseTrackPoints(): THREE.Vector3[] {
  const A = 1650; // MUST match REEF_TRACK_A on server (1.5× scale-up 2026-04-26)
  const B = 1050; // MUST match REEF_TRACK_B on server
  const N = 16;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const angle = Math.PI / 2 + 2 * Math.PI * t;
    pts.push(new THREE.Vector3(A * Math.cos(angle), 0, B * Math.sin(angle)));
  }
  return pts;
}

export const TRACK_CURVE_POINTS: THREE.Vector3[] = makeEllipseTrackPoints();

/** Number of curve samples for TubeGeometry. Higher = smoother track. */
export const TRACK_TUBE_SEGMENTS = 200;

/**
 * Track half-width in wu. Full track width = 600wu.
 * Used as the ribbon half-width in the flat track geometry.
 * Matches REEF_TRACK_HALF_WIDTH=300 on the server sim (doubled 2026-04-26).
 */
export const TRACK_TUBE_RADIUS = 300;

/**
 * @deprecated TubeGeometry removed — track is now a flat ribbon BufferGeometry.
 * Retained for backwards compatibility in case anything still imports it.
 */
export const TRACK_RADIAL_SEGMENTS = 4;

/** Track closed — true for a lap circuit. */
export const TRACK_CLOSED = true;

// ─── Guardrails ──────────────────────────────────────────────────────────────

/** Guardrail height in wu. */
export const GUARDRAIL_HEIGHT = 40;

/** Guardrail thickness in wu. */
export const GUARDRAIL_THICKNESS = 10;

// ─── Coral props ─────────────────────────────────────────────────────────────

/** Number of coral decorations along track edge (3 InstancedMesh by GLB type). */
export const CORAL_COUNT_PER_TYPE = 14; // 14×3 = 42 total

/** Coral scale range. Each instance gets a random scale in [min,max]. */
export const CORAL_SCALE_MIN = 12;
export const CORAL_SCALE_MAX = 22;

/** Radial offset from track center for coral placement (beyond guardrail). */
export const CORAL_OFFSET_FROM_TRACK = 210;

// ─── Checkpoints ─────────────────────────────────────────────────────────────

/** Total checkpoint gates including finish line. */
export const NUM_CHECKPOINTS = 12;

/**
 * T-values along the CatmullRomCurve3 for each checkpoint gate [0..1).
 * Distributed evenly + adjusted so one lands exactly at T=0 (finish line).
 */
export const CHECKPOINT_T_VALUES: number[] = Array.from(
  { length: NUM_CHECKPOINTS },
  (_, i) => i / NUM_CHECKPOINTS,
);

/** Index of the finish line checkpoint (T=0). */
export const FINISH_LINE_INDEX = 0;

/** Pillar geometry params (CylinderGeometry). */
export const PILLAR_RADIUS_TOP    = 8;
export const PILLAR_RADIUS_BOTTOM = 8;
export const PILLAR_HEIGHT        = 80;
export const PILLAR_RADIAL_SEGS   = 8;

/** Horizontal bar geometry (BoxGeometry). Width = track width + 2*pillar radius. */
export const GATE_BAR_WIDTH  = TRACK_TUBE_RADIUS * 2 + PILLAR_RADIUS_TOP * 2; // 316wu
export const GATE_BAR_HEIGHT = 8;
export const GATE_BAR_DEPTH  = 8;

/** Material colors for gates — green for checkpoints, gold for finish. */
export const CHECKPOINT_EMISSIVE = '#00e676'; // green
export const FINISH_EMISSIVE     = '#ffd600'; // gold

// ─── Start grid ──────────────────────────────────────────────────────────────

/** Number of start grid pads (1 per player slot). */
export const GRID_PAD_COUNT = 8;

/** Start pad dimensions. */
export const GRID_PAD_WIDTH  = 60;
export const GRID_PAD_HEIGHT = 2;
export const GRID_PAD_DEPTH  = 100;

/** Column stagger offset in X. Odd-numbered pads are offset by this amount. */
export const GRID_PAD_STAGGER_X = 80;

/** Column stagger offset in Z between pads. */
export const GRID_PAD_SPACING_Z = 120;

/** Y position of start grid surface (above track tube). */
export const GRID_PAD_Y = 2;

/** T-value for start grid position on the track curve. */
export const START_GRID_T = 0.04; // slightly past finish line

// ─── Countdown gantry ────────────────────────────────────────────────────────

/** Gantry light bulb radius. */
export const GANTRY_BULB_RADIUS = 12;

/** Gantry bulb radial segments — keep low. */
export const GANTRY_BULB_SEGS = 8;

/** Gantry crossbar dimensions. */
export const GANTRY_BAR_WIDTH  = TRACK_TUBE_RADIUS * 2 + 60;
export const GANTRY_BAR_HEIGHT = 12;
export const GANTRY_BAR_DEPTH  = 12;

/** Y offset of gantry above start grid. */
export const GANTRY_HEIGHT_ABOVE_TRACK = 120;

/** Light states for countdown gantry. */
export const GANTRY_COLORS = {
  off: '#111111',
  red: '#ff1744',
  green: '#00e676',
} as const;

// ─── Finish line flags ────────────────────────────────────────────────────────

/** Flag plane dimensions. */
export const FLAG_WIDTH  = 20;
export const FLAG_HEIGHT = 160;

/** Mast height above track surface. */
export const FLAG_MAST_HEIGHT = 200;

/** Wave animation amplitude in wu. */
export const FLAG_WAVE_AMP = 18;

/** Wave animation frequency (rad/s). */
export const FLAG_WAVE_FREQ = 3.0;

// ─── Player kart ─────────────────────────────────────────────────────────────

/**
 * Scale applied to sea_horse.glb clone.
 * sea_horse.glb native bbox.max.y needs verification at runtime;
 * if it differs significantly, computeKartScale() in ReefRacePlayer.tsx
 * corrects it. Default 20 targets ~40wu kart height.
 */
export const KART_SCALE = 20;

/** Maximum simultaneously-rendered player karts. */
export const MAX_PLAYERS = 8;

/** Height above track surface for kart spawn (so feet don't clip tube). */
export const KART_Y_ABOVE_TRACK = 5;

// ─── Reef Glider prop (Phase 1 §4) ───────────────────────────────────────────

/**
 * Glider board geometry in KART_SCALE-local space (before scale={[20,20,20]}).
 * World dimensions = these × KART_SCALE:
 *   2.5 × 0.25 × 5  →  50wu × 5wu × 100wu
 * Two gliders have 125wu clearance each side of a 300wu-wide track.
 */
export const GLIDER_WIDTH  = 2.5;
export const GLIDER_HEIGHT = 0.25;
export const GLIDER_LENGTH = 5;

/**
 * Rider mount offset in KART_SCALE-local space.
 *
 * Math (local space → world space via KART_SCALE=20):
 *   Glider board BoxGeometry height = GLIDER_HEIGHT = 0.25 local
 *   Glider board top in local space = GLIDER_LOCAL_Y + GLIDER_HEIGHT/2
 *                                   = 0.25 + 0.125 = 0.375 local
 *   Board top in world space        = 0.375 × 20   = 7.5 wu
 *
 *   Rider Y offset (local) = 1.2
 *   Rider Y in local space = GLIDER_LOCAL_Y + 1.2 = 0.25 + 1.2 = 1.45 local
 *   Rider Y in world space = 1.45 × 20 = 29 wu    (21.5 wu above board top)
 *
 *   BOB_AMP_LOCAL = 0.04 local = 0.8 wu — gentle float, never sinks below board
 *   Worst-case low  = (1.45 - 0.04) × 20 = 28.2 wu  (still 20.7 wu above board top)
 *
 * lobster.glb bbox: origin is not measured; assuming center-of-mass pivot.
 * The 21.5 wu static clearance above board top is sufficient for any origin
 * placement (feet, center, or head) at KART_SCALE=20.
 *
 * Previous values [0, 0.6, -0.5] placed the rider at 12 wu world — BELOW
 * board top at 7.5 wu + bob amplitude 40 wu → rider sank 28 wu underground.
 *
 * Single default for Phase 1 (species-specific offsets deferred to Phase 1.5).
 */
export const RIDER_MOUNT_OFFSET_DEFAULT: [number, number, number] = [0, 1.2, -0.3];

// ─── Ghost kart ──────────────────────────────────────────────────────────────

/** Ghost kart material opacity. */
export const GHOST_OPACITY = 0.45;

/**
 * Ghost kart path sample rate in Hz (matches backend replay rate).
 * Phase 4 (S-IMPL-3 fix 2026-04-25) — server now samples at 5 Hz to halve
 * ghost storage size. Client doesn't read this value at runtime — the
 * `findGhostFrames` lerp in `ReefRaceGhost.tsx` works for arbitrary sample
 * rates — but the constant is kept for documentation symmetry.
 */
export const GHOST_SAMPLE_HZ = 5;

/** Maximum ghost path frames to buffer (~60s at 5Hz). */
export const GHOST_MAX_FRAMES = 300;

// ─── Power-up pickup boxes ────────────────────────────────────────────────────

/** Maximum simultaneous pickup boxes (InstancedMesh pre-allocated). */
export const MAX_PICKUPS = 16;

/** Box geometry size in wu. */
export const PICKUP_BOX_SIZE = 60;

/** Pickup spin speed in radians per second. */
export const PICKUP_SPIN_SPEED = 0.8;

/** Pickup Y hover height above track surface. */
export const PICKUP_Y_ABOVE_TRACK = 50;
/**
 * Track-group base Y.
 *
 * SURF ROAD (2026-06-23): the floating ribbon's vertical datum is now the
 * render-only `reefTrackElevationAt(t)` profile (reef-race-elevation.ts), NOT a
 * flat plane. The ribbon vertices, the rider, and the chase camera all read
 * elevation(t) directly, so the wrapping track group sits at world Y=0 and the
 * per-t altitude lives in the geometry/transforms. Was -200 (the old flat water
 * plane); a flat offset here would DOUBLE-shift everything off the elevation
 * datum. Keep at 0.
 */
export const TRACK_SURFACE_Y = 0;

/** Canvas texture size for '?' face. */
export const PICKUP_TEXTURE_SIZE = 64;

// ─── Boost trail ─────────────────────────────────────────────────────────────

/** Maximum trail points in the ring buffer. */
export const TRAIL_MAX_POINTS = 30;

/** Trail tube radius (for BufferGeometry ribbon). */
export const TRAIL_WIDTH = 8;

/** Number of speed cone InstancedMesh instances. */
export const SPEED_CONE_COUNT = 12;

/** Speed cone geometry dimensions. */
export const SPEED_CONE_RADIUS_TOP    = 0;
export const SPEED_CONE_RADIUS_BOTTOM = 2;
export const SPEED_CONE_HEIGHT        = 200;
export const SPEED_CONE_RADIAL_SEGS   = 3;

/** Speed cone spread radius from camera forward. */
export const SPEED_CONE_SPREAD = 80;

// ─── Camera (chase-cam) ───────────────────────────────────────────────────────

/** Camera near clip plane; 1wu remains safely inside the closer 444wu chase arm. */
export const CAMERA_NEAR = 1;

/**
 * Camera far clip plane.
 * SURF ROAD (2026-06-23): the cosmic void dome has radius 30000wu and the ribbon
 * footprint is ~17687×16941wu, so the far plane must reach the dome from a chase
 * pull-back without clipping the void. 34000 gives headroom beyond the 30000
 * dome. Iris Xe rule: fog.far ≤ camera.far still holds (fog is pushed far out —
 * the void IS the backdrop, not fog).
 */
export const CAMERA_FAR = 34000;

/**
 * Chase-cam offset in player-local space (behind and above).
 * ROUND 5 (2026-07-16): 420/-560 → 260/-360 brings the rider about 1.58×
 * closer at unchanged fov 60. Runtime still adds reefTrackElevationAt(t), so
 * this remains a LOCAL offset; near=1/far=34000 still safely contain the closer
 * wave field, ribbon, and 30000wu void dome.
 */
// Founder knob: lower Y / less-negative Z makes the rider fill more of the frame.
export const CAMERA_OFFSET = new THREE.Vector3(0, 260, -360);

/**
 * Chase-cam look-at offset from player position (slightly above kart).
 * SURF ROAD: lookAt Y 130→180 — the look target also rides elevation(t) at
 * runtime; the higher local offset frames the rider + a little of the ribbon
 * ahead/below through crests so the surfer is never lost over a rise.
 */
export const CAMERA_LOOK_OFFSET = new THREE.Vector3(0, 180, 0);

/** Chase-cam lerp factor per second (0→1: instant, 1: no follow). */
export const CAMERA_LERP = 5.0;

// ─── Fog ─────────────────────────────────────────────────────────────────────

/**
 * Fog color — deep cosmic void (matches the CosmicVoid dome horizon band).
 * SURF ROAD (2026-06-23): was sky-blue '#a8d8ff'. The scene is now a deep void,
 * so distant karts/props fade INTO the void colour rather than a bright sky.
 */
export const FOG_COLOR = '#0c1a2e';

/**
 * Fog near distance.
 * SURF ROAD: pushed far out (2000 → 9000). The ribbon + rails are fog:false
 * (always crisp). Fog now only softens distant OPPOSING-side karts/props into
 * the void at the far reaches of the ~17687wu footprint, so it must not bite
 * until well past the chase framing (~560wu arm + a few thousand wu ahead).
 */
export const FOG_NEAR = 9000;

/**
 * Fog far distance. MUST be ≤ CAMERA_FAR (34000). Iris Xe rule: fog.far ≤
 * camera.far. SURF ROAD: 22000 fades the far side of the loop gently into the
 * void without reaching/colouring the 30000 dome. Keeps the cosmic depth.
 */
export const FOG_FAR = 22000;

// ─── Lighting ────────────────────────────────────────────────────────────────

// SURF ROAD (2026-06-23): hemisphere recoloured for the cosmic void — a cool
// cyan sky bounce + a deep-violet "ground" bounce (there is no ground; this is
// the ambient fill that tints the rider/karts to match the void mood). Was
// sky-blue / grass-green for the old land-disc scene.
export const HEMI_SKY_COLOR    = '#3fd0ff'; // cyan void glow (top fill)
export const HEMI_GROUND_COLOR = '#1a1640'; // deep indigo (bottom fill)
// RETUNED 2026-07-15 (founder playtest: rider rendered as a BLACK unlit
// silhouette): 0.65/1.25 was calibrated when everything visible was self-lit
// (ShaderMaterial water, textured sky dome) so nobody noticed the lights were
// far too weak for LIT meshes — the moment a MeshStandardMaterial rider/board
// or the canyon walls entered frame they read near-black. Verified live at the
// /preview racer harness (rider-material-probe / rider-light-bump 2026-07-15):
// textures were loaded fine (1024px maps, white base color) and hot-bumping
// ONLY these intensities turned the black silhouette into a fully-readable
// rider + orange board + green canyon with the water untouched (it ignores
// scene lights). 2.0/2.6 chosen over 3.0/4.0 — fully readable without
// flattening the key/fill contrast.
export const HEMI_INTENSITY    = 2.0;

// Cool key light from above-front so the riders read crisply against the void.
export const DIR_COLOR             = '#dff2ff';
export const DIR_INTENSITY         = 2.6;
export const DIR_POSITION          = [300, 800, 200] as const;
export const DIR_SHADOW_MAP_SIZE   = 512;
export const DIR_SHADOW_NEAR       = 1;
/**
 * Shadow camera far and bounds bumped 3000 → 4000 on 2026-04-26.
 * At 3000 the directional-light shadow frustum clips karts on the far side
 * of the 1.5× track (outer edge at 1950wu + 350wu cam offset = 2300wu worst-case
 * object; 3000 had headroom but the diagonal across the ellipse ~3000wu was
 * already at the limit). 4000 covers the full track diagonal with margin.
 */
export const DIR_SHADOW_FAR        = 4000;
export const DIR_SHADOW_CAM_BOUNDS = 4000;

// ─── Atmosphere (cosmic void backdrop) ────────────────────────────────────────

/** Number of TSL volumetric light rays (4, not 7 per spec §2.9). */
export const LIGHT_RAY_COUNT = 4;

/**
 * SURF ROAD (2026-06-23): the depth backdrop plane below the old flat water is
 * RETIRED — there is no land/water plane any more, the ribbon floats in the
 * CosmicVoid (cosmic-void.tsx: gradient dome + starfield + glow motes). These
 * constants are kept ONLY so the (now-removed) DepthBackdrop import in any stale
 * reference still type-checks; nothing renders them. The void dome (radius
 * 30000) is the true backdrop. Safe to delete once all references are gone.
 */
export const VOID_BACKDROP_Y    = -8000;
export const VOID_BACKDROP_SIZE = 60000;

// ─── Bloom (selective neon glow — Iris-Xe gated) ──────────────────────────────
//
// The neon rails + water crests are the bloom targets. Bloom is the single
// post-process pass for the SURF ROAD; it is CHEAP (UnrealBloomPass at low res)
// and gated so the Iris-Xe floor stays ≥60 FPS. See ReefRaceScene <SurfBloom>.
export const BLOOM_STRENGTH  = 0.75;  // glow intensity — reduced slightly (water no longer over-bloomed)
export const BLOOM_RADIUS    = 0.45;  // spread — tighter glow
// Raised threshold 0.65 → 0.80 so the darker water body (deep #052d4a ≈ 0.11,
// shallow #0e7a8a ≈ 0.43) stays BELOW the threshold and does not glow. The
// neon rails (#98f0ff ≈ 0.93) still bloom. Foam crests on the water tips may
// briefly bloom — acceptable (it reads as spray catching light, not solid glow).
export const BLOOM_THRESHOLD = 0.80;  // only the neon rails + crest-tip spray bloom

// ─── Laps ─────────────────────────────────────────────────────────────────────

/**
 * Total laps in a standard race — HUD fallback only.
 *
 * MUST equal the authoritative server sim constant `REEF_RACE_LAPS`
 * (apps/api/src/services/activity/sim/reef-race-config.ts, currently 2). The
 * server streams `totalLaps` on every per-body delta / keyframe and the HUD
 * prefers that; this constant is the value shown BEFORE the first delta for
 * the self body arrives (race start, or a body that hasn't moved yet). Keeping
 * it at the stale 3 made the HUD read "1/3" at the line while the sim only
 * runs 2 laps — a WORLD↔UI parity break. Bump this in lockstep with
 * `REEF_RACE_LAPS`.
 */
export const TOTAL_LAPS = 2;

// ─── Phase 2 — boost ribbons + hazard patches (client mirrors) ───────────────
//
// These builders MUST stay in sync with the server-side builders in
//   apps/api/src/services/activity/sim/reef-race-config.ts
// They are reproduced here (rather than imported from @clawville/shared) because
// the server config pulls DB + event-logger transitive deps the client can't load.
//
// The client ALSO receives these positions via RoomMeta.reefStaticZones from the
// server's snapshot.init. The local builders are used as a FALLBACK when the
// room snapshot is not yet available (e.g. spectator join before init).

/** Track half-axis values — must match server REEF_TRACK_A/B. */
const REEF_TRACK_A_CLIENT = 1650;
const REEF_TRACK_B_CLIENT = 1050;

/**
 * Centerline point at parameter t in [0,1).
 * t=0 → start/finish (+Y pole of the ellipse).
 * Mirrors server `reefCenterlineAt` exactly.
 */
export function reefCenterlineAtClient(t: number): { x: number; y: number } {
  const angle = Math.PI / 2 + 2 * Math.PI * t;
  return {
    x: REEF_TRACK_A_CLIENT * Math.cos(angle),
    y: REEF_TRACK_B_CLIENT * Math.sin(angle),
  };
}

/**
 * Tangent unit vector at parameter t.
 * Mirrors server `reefTangentAt` exactly.
 */
export function reefTangentAtClient(t: number): { x: number; y: number } {
  const angle = Math.PI / 2 + 2 * Math.PI * t;
  const tx = -REEF_TRACK_A_CLIENT * Math.sin(angle);
  const ty = REEF_TRACK_B_CLIENT * Math.cos(angle);
  const mag = Math.hypot(tx, ty) || 1;
  return { x: tx / mag, y: ty / mag };
}

export interface ReefBoostRibbonClient {
  id: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/**
 * Build the two boost ribbons from the ellipse parameterisation.
 *   - rib-top: t=0.92 → t=0.98  (top straight, before start/finish line)
 *   - rib-bot: t=0.46 → t=0.54  (bottom straight)
 * Matches server buildReefBoostRibbons() (audit S13 fix — rib-top stays
 * fully BEFORE t=0 so it never straddles the start/finish line).
 */
export function buildReefBoostRibbonsClient(): ReefBoostRibbonClient[] {
  return [
    {
      id: 'rib-top',
      a: reefCenterlineAtClient(0.92),
      b: reefCenterlineAtClient(0.98),
    },
    {
      id: 'rib-bot',
      a: reefCenterlineAtClient(0.46),
      b: reefCenterlineAtClient(0.54),
    },
  ];
}

export interface ReefHazardPatchClient {
  id: string;
  center: { x: number; y: number };
  radius: number;
}

/** Inward offset from centerline to hazard center (wu). Must match server HAZARD_INSIDE_OFFSET. */
const HAZARD_INSIDE_OFFSET_CLIENT = 300 * 0.40; // REEF_TRACK_HALF_WIDTH * 0.40 = 120wu

/** Hazard patch radius (wu). Must match server HAZARD_RADIUS. */
const HAZARD_RADIUS_CLIENT = 22 * 2.5; // REEF_BODY_RADIUS * 2.5 = 55wu

/** Hairpin checkpoint indices — must match server APEX_HAIRPIN_CHECKPOINT_INDICES. */
const APEX_HAIRPIN_CP_INDICES_CLIENT = [3, 9] as const;

/** Number of checkpoints — must match server REEF_CHECKPOINT_COUNT. */
const REEF_CHECKPOINT_COUNT_CLIENT = 12;

/**
 * Build the two hazard patches at the hairpin apexes.
 * Matches server buildReefHazardPatches() exactly.
 */
export function buildReefHazardPatchesClient(): ReefHazardPatchClient[] {
  return APEX_HAIRPIN_CP_INDICES_CLIENT.map(idx => {
    const t = idx / REEF_CHECKPOINT_COUNT_CLIENT;
    const center = reefCenterlineAtClient(t);
    const tangent = reefTangentAtClient(t);
    // Inward normal: 90° left turn on tangent (CCW travel → inside is left).
    let nx = -tangent.y;
    let ny = tangent.x;
    // Dot-check: ensure it points toward origin.
    if (nx * -center.x + ny * -center.y < 0) {
      nx = -nx;
      ny = -ny;
    }
    return {
      id: `hz-${idx}`,
      center: {
        x: center.x + nx * HAZARD_INSIDE_OFFSET_CLIENT,
        y: center.y + ny * HAZARD_INSIDE_OFFSET_CLIENT,
      },
      radius: HAZARD_RADIUS_CLIENT,
    };
  });
}

/** Apex inside offset (wu). Must match server APEX_INSIDE_OFFSET. */
const APEX_INSIDE_OFFSET_CLIENT = 300 * 0.55; // REEF_TRACK_HALF_WIDTH * 0.55 = 165wu

/** Apex outside offset (wu). Must match server APEX_OUTSIDE_OFFSET. */
const APEX_OUTSIDE_OFFSET_CLIENT = 300 * 0.55; // 165wu

export interface ReefApexZoneClient {
  hairpinIndex: number;
  innerCenter: { x: number; y: number };
  outerCenter: { x: number; y: number };
}

/**
 * Build the two apex zones at the hairpin checkpoints.
 * Matches server buildReefApexZones() exactly.
 */
export function buildReefApexZonesClient(): ReefApexZoneClient[] {
  return APEX_HAIRPIN_CP_INDICES_CLIENT.map(idx => {
    const t = idx / REEF_CHECKPOINT_COUNT_CLIENT;
    const center = reefCenterlineAtClient(t);
    const tangent = reefTangentAtClient(t);
    let nx = -tangent.y;
    let ny = tangent.x;
    if (nx * -center.x + ny * -center.y < 0) {
      nx = -nx;
      ny = -ny;
    }
    return {
      hairpinIndex: idx,
      innerCenter: {
        x: center.x + nx * APEX_INSIDE_OFFSET_CLIENT,
        y: center.y + ny * APEX_INSIDE_OFFSET_CLIENT,
      },
      outerCenter: {
        x: center.x - nx * APEX_OUTSIDE_OFFSET_CLIENT,
        y: center.y - ny * APEX_OUTSIDE_OFFSET_CLIENT,
      },
    };
  });
}

// ─── SPEC 3 — Spline ramp positions (client mirrors) ─────────────────────────
//
// Must stay in sync with buildSplineRamps() in
//   apps/api/src/services/activity/sim/reef-race-config.ts
// These are used by ramps.tsx to place visual wedge meshes at the correct
// spline positions. They're reproduced here (not shared) to avoid pulling
// API-side transitive deps into the client bundle.

export interface SplineRampClient {
  id: string;
  /** Arclength fraction along the client spline (0..1). */
  t: number;
  /** Lateral offset from centerline in wu (0 = centerline). */
  lateralOffset: number;
  /** Half-length of the visual wedge along the tangent (wu). */
  halfLength: number;
  /** Half-width of the visual wedge perpendicular to the tangent (wu). */
  halfWidth: number;
}

// ─── v2 mechanics — Boost pad positions (client mirrors) ─────────────────────
//
// Must stay in sync with buildSplineBoostPads() in
//   apps/api/src/services/activity/sim/reef-race-config.ts
// Mirrors the buildSplineRampsClient() pattern above: the client reproduces
// the server's static zone list (not shared via wire or package import) so
// ReefRaceBoostPads.tsx can place visual markers at the correct spline
// positions without waiting on a `reefSplineZones` snapshot.init payload.
// If the server DOES send `room.reefSplineZones.boostPads`, that takes
// priority (see ReefRaceBoostPads.tsx) — this is the fallback/bootstrap set.

export interface SplineBoostPadClient {
  id: string;
  /** Arclength fraction along the client spline (0..1). */
  t: number;
  /** Lateral offset from centerline in wu (0 = centerline, matches server sign). */
  lateralOffset: number;
  /** Trigger half-length along the spline tangent (wu). */
  halfLength: number;
  /** Trigger half-width perpendicular to the spline tangent (wu). */
  halfWidth: number;
}

/** Client prediction mirrors the server boost-pad trigger AABB exactly. */
export const BOOST_PAD_TRIGGER_HALF_LENGTH = 220;
export const BOOST_PAD_TRIGGER_HALF_WIDTH = 170;

/** Visual boost-pad marker footprint (wu). Smaller than the server's AABB
 *  (BOOST_PAD_HALF_LENGTH=130/HALF_WIDTH=170) so the glowing pad reads as a
 *  "stand on this" strip rather than filling the whole trigger volume. */
export const BOOST_PAD_VISUAL_LENGTH = 180;
export const BOOST_PAD_VISUAL_WIDTH  = 110;
/** Marker height above the ribbon surface (wu) — same order as PICKUP_Y_ABOVE_TRACK. */
export const BOOST_PAD_Y_ABOVE_TRACK = 6;
/** Max instances the ReefRaceBoostPads InstancedMesh allocates — headroom above
 *  the current 8-pad list so a server-side pad-count bump doesn't need a client
 *  code change (only a data change), matching MAX_PICKUPS-style over-allocation. */
export const MAX_BOOST_PADS = 10;

export function buildSplineBoostPadsClient(): SplineBoostPadClient[] {
  return [
    { id: 'pad-lagoon',      t: 0.055, lateralOffset:   0, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-kelp-entry',  t: 0.165, lateralOffset:  45, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-kelp-exit',   t: 0.285, lateralOffset: -45, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-wreck-entry', t: 0.405, lateralOffset:   0, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-wreck-core',  t: 0.535, lateralOffset:  45, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-wreck-exit',  t: 0.655, lateralOffset: -45, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-canyon',      t: 0.785, lateralOffset:   0, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
    { id: 'pad-home-stretch', t: 0.915, lateralOffset: 35, halfLength: BOOST_PAD_TRIGGER_HALF_LENGTH, halfWidth: BOOST_PAD_TRIGGER_HALF_WIDTH },
  ];
}

// ─── Reef Race v2 — surf board POSE (render-only) ────────────────────────────
//
// Baked 2026-06-27 from the founder-signed-off free-drive sandbox
// (REEF_PHYSICS_TUNING in reef-physics-tuning.ts). RENDER-ONLY — these make the
// real-race kart RIDE the banked + waving water surface and SURF-TILT (nose-up +
// wave-conform) exactly like the sandbox, instead of sitting flat on the centerline
// datum. Used by ReefRacePlayer (real race) + mirrored by the sandbox tuner. The
// SIM physics constants (speed/accel/turn) are NOT here — those live in
// reef-race-config.ts (both web CLIENT_SURF_PARAMS + the api server config) and a
// speed bump is a coordinated client+server change.
export const SURF_RIDE_HEIGHT     = 20;   // wu the board floats ABOVE the local surface
export const SURF_PITCH_TRIM_DEG  = 10;   // baseline nose-up plane angle
export const SURF_PITCH_WAVE_GAIN = 1.3;  // × the nose-vs-tail wave slope
export const SURF_TURN_LEAN_GAIN  = 0;    // optional lean-into-carve (× angVel rad/s); 0 = off
export const SURF_PITCH_HALF_LEN  = 120;  // wu — sample the wave at nose & tail
export const SURF_ROLL_HALF_WIDTH = 36;   // wu — sample the surface at left & right rail
export const SURF_PITCH_CLAMP     = 0.6;  // ±34°
export const SURF_ROLL_CLAMP      = 0.8;  // ±46°
// Speed-aware tilt response endpoints. The long-swell octave set stays fixed;
// only the tilt follower rate blends with planar speed.
// The 290–356wu/s run passed with the low-speed tilt rate; the 823–873wu/s run
// showed maxSpeed normalization reached the high-speed tilt rate too late.
export const SURF_CONFORM_PLANING_START_SPEED = 350;
export const SURF_CONFORM_PLANING_FULL_SPEED  = 800;
// k3.5 produced 3.2–3.4 Y flips/s with tiny median deltas but visible phase lag;
// constant k10 is the least-lag rate and follows the composite surface datum.
export const SURF_HEAVE_DAMPING = 10;
export const SURF_TILT_DAMPING_LOW_SPEED   = 6;  // Prior low-speed run was responsive and passed.
// Latest racing pass at k1.2: pitch RMS 0.58/1.05/0.84°, frequency 0.3/0.6/0.4Hz,
// flips 0.7/1.6/1.2 per second (one bot remains 0.1/s above the flip target).
export const SURF_TILT_DAMPING_HIGH_SPEED  = 1.2;
// Founder knob: higher values follow velocity-slip bank faster; k=8 smooths 30 Hz lean steps.
export const SURF_BANK_LEAN_DAMPING = 8;

// ─── Reef Race v2 — client-side surf prediction params ───────────────────────
//
// keep in sync with apps/api/src/services/activity/sim/reef-race-config.ts
//
// These feed `integrateSurfStep` (from @clawville/shared) for CLIENT-SIDE
// prediction of the SELF kart only. The server runs the identical pure step per
// tick with the same constants, so prediction + authority converge: the client
// re-baselines toward each server snapshot (see ReefRacePlayer) and the only
// per-input job here is to make steering feel instant.
//
// speedMod starts at 1 here, then ReefRacePlayer overwrites it from the latest
// server snapshot so visible self prediction matches authoritative turbo/pad/
// launch/slip speed. accelMult remains pinned to 1 because Phase-3 acceleration
// stats are still server-only; snapshot re-baselining corrects that residual.
export const CLIENT_SURF_PARAMS = {
  /** REEF_MAX_SPEED = 1300 (2026-07-15 2× cap; MUST match the server config) */
  maxSpeed: 1300,
  /** REEF_MAX_ACCEL = REEF_MAX_SPEED * 4 = 5200 */
  maxAccel: 5200,
  /** REEF_TURN_RATE = 2.6 */
  turnRate: 2.6,
  /** REEF_TURN_SPEED_FALLOFF = 0.45 */
  turnSpeedFalloff: 0.45,
  /** REEF_AIRBORNE_STEER_MULT = 0.30 */
  airborneSteerMult: 0.3,
  /** REEF_FORWARD_DRAG = 0.992 */
  forwardDrag: 0.992,
  /** REEF_LATERAL_GRIP = 0.90 */
  lateralGrip: 0.9,
  /** Snapshot-fed by ReefRacePlayer; 1 is the pre-snapshot/compat baseline. */
  speedMod: 1,
  /** Client can't know Phase-3 accel stat — baseline. Re-baseline corrects. */
  accelMult: 1,
} as const;

/** Max dt (s) fed to integrateSurfStep — clamps huge steps after a tab-out. */
export const CLIENT_SURF_MAX_DT = 0.05;

/**
 * Fixed prediction timestep (s) = 1 / REEF_TICK_HZ.
 *
 * keep in sync with REEF_TICK_HZ (30) in
 * apps/api/src/services/activity/sim/reef-race-config.ts
 *
 * integrateSurfStep applies forwardDrag (0.992) and lateralGrip (0.90) as
 * PER-CALL multipliers that assume the server's fixed 30 Hz tick. The client
 * MUST therefore advance prediction with a fixed-timestep accumulator at this
 * exact rate — NOT once per (variable, ~60 fps) render frame — or drag/grip
 * compound ~2× as often (e.g. forwardDrag 0.992^60=0.62/s instead of
 * 0.992^30=0.785/s), bleeding forward speed on coast and over-gripping the
 * carve. Every fixed step passes THIS dt, never the frame dt.
 */
export const CLIENT_SURF_TICK_DT = 1 / 30;

/**
 * Max accumulated prediction time (s) carried into the fixed-step loop in a
 * single frame. Caps the catch-up after a tab-out / long stall so we never run
 * dozens of steps in one frame (spiral-of-death guard). 0.1 s = at most ~3
 * fixed steps per frame.
 */
export const CLIENT_SURF_MAX_ACCUM = 0.1;

/** R18b vertical prediction mirrors the authoritative 30Hz spline sim. */
export const CLIENT_REEF_JUMP_IMPULSE_MANUAL = 720;
export const CLIENT_REEF_JUMP_IMPULSE_RAMP = 920;
export const CLIENT_REEF_GRAVITY = 1200;
export const CLIENT_REEF_TRICK_STEER_DEADZONE_RAD = 0.035;
/** Per-snapshot soft vertical correction and true-divergence hard snap. */
export const CLIENT_REBASE_HEIGHT = 0.35;
export const CLIENT_REBASE_HEIGHT_SNAP = 140;
/** Presentation-only inverse correction cap; decays with the XZ rebase offset. */
export const SURF_REBASE_HEIGHT_OFFSET_MAX = 90;

/**
 * Re-baseline blend factors applied per NEW server snapshot for the self kart.
 * Predicted state is pulled toward authority so server wall-clamp / collision
 * corrections land within a few snapshots while input stays instant between
 * them. Position blends slower (visual smoothness) than velocity/rotation.
 */
export const CLIENT_REBASE_POS = 0.4; // 40% of the position error per snapshot
export const CLIENT_REBASE_VEL = 0.5; // 50% of the velocity error per snapshot
export const CLIENT_REBASE_ROT = 0.5; // 50% of the (shortest-arc) heading error

/**
 * Founder knob for the self-kart's presentation-only reconciliation offset.
 * k=10 is a 100 ms time constant (~69 ms half-life): authority still rebases
 * prediction immediately, while the screen receives that correction smoothly.
 */
export const SURF_REBASE_RENDER_DAMPING = 10;

/**
 * Maximum accumulated self-kart XZ render offset (wu). Larger corrections keep
 * their residual as an immediate step instead of smearing a pathological error.
 */
export const SURF_REBASE_RENDER_OFFSET_MAX = 120;

/**
 * Hard-snap threshold (wu). When predicted vs server XZ error exceeds this, the
 * gap is a respawn / teleport / catastrophic desync — snap predicted straight
 * to the server pose instead of blending (which would visibly slide across the
 * track). Matches the wipeout teleport heuristic order of magnitude.
 */
export const CLIENT_REBASE_SNAP_DIST = 500;

// MUST match RAMP_HALF_LENGTH / RAMP_HALF_WIDTH in API reef-race-config.ts.
const RAMP_HALF_LENGTH_CLIENT = 150;
const RAMP_HALF_WIDTH_CLIENT  = 200;

/**
 * Build the 6 ramp definitions mirroring the server-side SPEC 3 ramp volumes.
 * Used by ramps.tsx to place wedge meshes at the correct spline positions.
 */
export function buildSplineRampsClient(): SplineRampClient[] {
  return [
    { id: 'ramp-lagoon',     t: 0.070, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH_CLIENT, halfWidth: RAMP_HALF_WIDTH_CLIENT },
    { id: 'ramp-kelp-1',    t: 0.135, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH_CLIENT, halfWidth: RAMP_HALF_WIDTH_CLIENT },
    { id: 'ramp-kelp-2',    t: 0.360, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH_CLIENT, halfWidth: RAMP_HALF_WIDTH_CLIENT },
    { id: 'ramp-shipwreck', t: 0.450, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH_CLIENT, halfWidth: RAMP_HALF_WIDTH_CLIENT },
    { id: 'ramp-canyon-1',  t: 0.775, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH_CLIENT, halfWidth: RAMP_HALF_WIDTH_CLIENT },
    { id: 'ramp-canyon-2',  t: 0.900, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH_CLIENT, halfWidth: RAMP_HALF_WIDTH_CLIENT },
  ];
}
