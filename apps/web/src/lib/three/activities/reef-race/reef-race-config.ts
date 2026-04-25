/**
 * reef-race-config.ts
 *
 * All constants for the Reef Race activity scene.
 * Track path, checkpoint positions, camera, fog, lighting, pickups, ghost, boost.
 *
 * Performance budget: ≤70 draw calls / ≤220k tris / 1×512² shadow map / 0 post-processing.
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
  const A = 1100; // matches REEF_TRACK_A on server
  const B = 700;  // matches REEF_TRACK_B on server
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
 * Track half-width in wu. Full track width = 300wu.
 * Used as the ribbon half-width in the flat track geometry.
 * Matches REEF_TRACK_HALF_WIDTH=150 on the server sim.
 */
export const TRACK_TUBE_RADIUS = 150;

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
 * World position = this × KART_SCALE = [0, 12wu, -10wu].
 * Single default for Phase 1 (species-specific offsets deferred to Phase 1.5).
 */
export const RIDER_MOUNT_OFFSET_DEFAULT: [number, number, number] = [0, 0.6, -0.5];

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

/** Camera near clip plane. */
export const CAMERA_NEAR = 1;

/**
 * Camera far clip plane.
 * Iris Xe rule: keep fog.far ≤ camera.far.
 * 1800 < 2000 ✓
 */
export const CAMERA_FAR = 2000;

/** Chase-cam offset in player-local space (behind and above). */
export const CAMERA_OFFSET = new THREE.Vector3(0, 200, -350);

/** Chase-cam look-at offset from player position (slightly above kart). */
export const CAMERA_LOOK_OFFSET = new THREE.Vector3(0, 80, 0);

/** Chase-cam lerp factor per second (0→1: instant, 1: no follow). */
export const CAMERA_LERP = 5.0;

// ─── Fog ─────────────────────────────────────────────────────────────────────

/** Fog color — bright tropical ocean blue. */
export const FOG_COLOR = '#0d2b5e';

/** Fog near distance. */
export const FOG_NEAR = 800;

/**
 * Fog far distance. MUST be ≤ CAMERA_FAR.
 * Iris Xe rule: fog.far > camera.far → FPS drop.
 * 1800 < 2000 ✓
 */
export const FOG_FAR = 1800;

// ─── Lighting ────────────────────────────────────────────────────────────────

export const HEMI_SKY_COLOR    = '#87ceeb';
export const HEMI_GROUND_COLOR = '#0d2b5e';
export const HEMI_INTENSITY    = 0.5;

export const DIR_COLOR             = '#fffbe6';
export const DIR_INTENSITY         = 1.2;
export const DIR_POSITION          = [300, 800, 200] as const;
export const DIR_SHADOW_MAP_SIZE   = 512;
export const DIR_SHADOW_NEAR       = 1;
export const DIR_SHADOW_FAR        = 2000;
export const DIR_SHADOW_CAM_BOUNDS = 2000;

// ─── Atmosphere (light rays + depth backdrop) ─────────────────────────────────

/** Number of TSL volumetric light rays (4, not 7 per spec §2.9). */
export const LIGHT_RAY_COUNT = 4;

/** Y position of the depth backdrop plane. */
export const VOID_BACKDROP_Y    = -1000;
export const VOID_BACKDROP_SIZE = 12000;

// ─── Laps ─────────────────────────────────────────────────────────────────────

/** Total laps in a standard race. */
export const TOTAL_LAPS = 3;

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
const REEF_TRACK_A_CLIENT = 1100;
const REEF_TRACK_B_CLIENT = 700;

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
const HAZARD_INSIDE_OFFSET_CLIENT = 150 * 0.40; // REEF_TRACK_HALF_WIDTH * 0.40 = 60wu

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
const APEX_INSIDE_OFFSET_CLIENT = 150 * 0.55; // REEF_TRACK_HALF_WIDTH * 0.55 = 82.5wu

/** Apex outside offset (wu). Must match server APEX_OUTSIDE_OFFSET. */
const APEX_OUTSIDE_OFFSET_CLIENT = 150 * 0.55; // 82.5wu

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
