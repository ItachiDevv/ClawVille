/**
 * bumper-shells-config.ts
 *
 * All constants for the Bumper Shells activity scene.
 * Centralised here so BumperShellsArena, BumperShellsHazard, BumperShellsPlayer,
 * BumperShellsPickups, and BumperShellsParticles all read from one source.
 *
 * PERF FIX 2026-04-24: Killed PCF shadows, neon point lights, and three/webgpu import
 * to cure GPU context loss on Iris Xe / mobile Safari. Rescaled shells + pulled
 * camera back so the full arena reads at neutral pose.
 *
 * Performance budget: ≤30 draw calls / 0 shadow maps / 0 post-processing.
 * Target GPU: Intel Iris Xe (integrated) @ 30fps mobile minimum, 60fps desktop target.
 */

// ─── Arena geometry ──────────────────────────────────────────────────────────

/**
 * Flat disc radius in world-units (wu).
 * MUST match server BUMPER_ARENA_RADIUS (apps/api/.../sim/bumper-shells-sim.ts = 500).
 * Do NOT change this value without changing the server constant.
 */
export const ARENA_RADIUS = 500;

/** Platform cylinder height — thicker for visual depth from perspective cam. */
export const ARENA_HEIGHT = 24;

/**
 * Radial segments for the platform disc.
 * 48 is smooth enough from chase cam distance; was 64 (saves ~25% cylinder verts).
 */
export const ARENA_RADIAL_SEGMENTS = 48;

// ─── Boundary / rim ──────────────────────────────────────────────────────────

/** Rim glow torus outer-tube radius — thicker for perspective readability. */
export const RIM_TUBE_RADIUS = 14;

/** Rim glow torus radial segments. */
export const RIM_RADIAL_SEGMENTS = 8;

/** Rim glow torus tubular segments — 64 was 80; lower saves verts at far dist. */
export const RIM_TUBULAR_SEGMENTS = 64;

/** Bumper wall height — knee-high guardrail at arena edge visible from chase cam. */
export const BUMPER_WALL_HEIGHT = 44;

/** Bumper wall tube radius — visual thickness of the guardrail. */
export const BUMPER_WALL_TUBE_RADIUS = 10;

/** Outer fraction of arena radius considered a "danger zone" (0–1). */
export const DANGER_ZONE_FRACTION = 0.15;

/** Inner edge of the danger ring in wu. */
export const DANGER_RING_INNER = ARENA_RADIUS * (1 - DANGER_ZONE_FRACTION); // ≈ 425

// ─── Hazard ──────────────────────────────────────────────────────────────────

/** Central spiked ball enabled by default — toggleable via prop. */
export const HAZARD_ENABLED = true;

/** Radius of the central spiked sphere. */
export const HAZARD_SPHERE_RADIUS = 60;

/** Number of cone spikes on the hazard (InstancedMesh count). */
export const HAZARD_SPIKE_COUNT = 8;

/** Hazard rotation speed in radians per second. */
export const HAZARD_SPIN_SPEED = 0.5;

// ─── Camera — perspective chase ───────────────────────────────────────────────

/**
 * Perspective camera FOV in degrees.
 * 60° gives a wider view so the full arena fits at neutral cam pose.
 */
export const CAMERA_FOV = 60;

/** Camera near clip plane. */
export const CAMERA_NEAR = 1;

/**
 * Camera far clip plane.
 * Chase cam sits ~380wu above player at ~600wu back. Fog dissolves before clip.
 * Kept at 2000wu (down from 2500) to reduce depth buffer precision waste.
 */
export const CAMERA_FAR = 2000;

/** Chase camera horizontal arm length in wu. Pulled back so 3 shells are visible. */
export const CHASE_CAM_DISTANCE = 620;

/** Chase camera height above arena floor in wu. Higher = more of arena visible. */
export const CHASE_CAM_HEIGHT = 400;

/** Look-ahead distance: the camera aims ahead of the player in their velocity direction. */
export const CHASE_CAM_LOOK_AHEAD = 60;

/** Camera position lerp alpha per second (frame-rate independent exp decay). */
export const CHASE_CAM_LERP_ALPHA = 5.0;

/** Spectator camera FOV in degrees. */
export const SPECTATOR_FOV = 60;

// ─── Fog ─────────────────────────────────────────────────────────────────────

/** Fog color hex — deep abyss. */
export const FOG_COLOR = '#020508';

/**
 * Fog near/far for the perspective chase camera.
 *
 * Chase cam is ~400wu above the disc, ~620wu behind the player.
 * Fog starts at 1000wu (past arena edge at 500wu radius) and completes at 1600wu.
 * This hides the void seam while keeping the full arena visible.
 *
 * Iris Xe perf: fog.far (1600) < camera.far (2000) — safe, no overdraw spike.
 * See performance/fog-density-iris-xe-regression.md.
 */
export const FOG_NEAR = 1000;
export const FOG_FAR  = 1600;

// ─── Lighting ────────────────────────────────────────────────────────────────
//
// PERF FIX 2026-04-24: Removed ALL point lights (rim accents × 4 in Arena +
// neon accents × 3 in Scene = 7 total). Each point light doubles the
// lighting shader pass per fragment — on Iris Xe at 1280×720 that is ~1.7M
// extra ALU ops per light per frame. With 7 lights on top of a shadow-casting
// directional light, the GPU saturates and loses context.
//
// Removed shadow map entirely (was 1024×1024 PCF). PCF shadow on a directional
// light covers 560wu×560wu, requires a full depth-prepass at 1024² every frame.
// On Iris Xe that is a ~4ms GPU cost per frame on top of the main pass.
//
// Current lighting: hemisphere (free, no pass) + 1 directional no-shadow (1 pass).
// Total GPU lighting passes: 1. Was: 1 (PCF shadow) + 1 (main) = 2 + 7 light bins.

/** Hemisphere sky color — deep ocean blue fill. */
export const HEMI_SKY_COLOR    = '#1a3a6a';

/** Hemisphere ground color — dark abyss. */
export const HEMI_GROUND_COLOR = '#050a14';

/**
 * Hemisphere intensity — raised slightly to compensate for removed fill lights.
 * Fills shadow side of shells so they read clearly without point lights.
 */
export const HEMI_INTENSITY    = 1.8;

/** Key directional light color — warm white for PBR shell sheen. */
export const DIR_COLOR     = '#fff8f0';

/** Key directional light intensity. */
export const DIR_INTENSITY = 2.5;

/** Key light position — above and to side for dramatic angle. */
export const DIR_POSITION  = [300, 500, 200] as const;

// ─── Player shells ───────────────────────────────────────────────────────────

/**
 * Scale applied to lobster-ktx.glb / crayfish-ktx.glb clones.
 *
 * lobster-ktx.glb native height ≈ 1.12wu.
 * SHELL_SCALE=22 → 22 × 1.12 = 24.6wu.
 * Arena radius = 500wu, diameter = 1000wu.
 * Shell diameter ≈ 25wu = 1/40 of diameter — correct ratio for bumper game.
 * (Was 40 → 44.8wu = 1/22 of diameter — too large, arena felt crowded.)
 *
 * Camera arm = 620wu, height = 400wu → at neutral pose, arena reads 900wu across.
 * Three shells at 25wu diameter each = 75wu total — about 8% of frame width: readable.
 */
export const SHELL_SCALE = 22;

/** Maximum simultaneously-rendered player shells. */
export const MAX_PLAYERS = 8;

// ─── Player name labels ───────────────────────────────────────────────────────

/** Y offset of name label above player shell group origin (in wu). */
export const LABEL_Y_OFFSET = 45;

// ─── Squash/stretch animation ────────────────────────────────────────────────

/** Frame schedule for squash/stretch on hit (scale applied to root group, NOT SkinnedMesh). */
export const HIT_ANIM_FRAMES = [
  { t: 0,    scale: [1.0,  0.6,  1.0]  },
  { t: 0.07, scale: [0.85, 1.3,  0.85] },
  { t: 0.2,  scale: [1.0,  1.0,  1.0]  },
] as const;

// ─── Power-up pickups ────────────────────────────────────────────────────────

/** Maximum simultaneous pickup slots — pre-allocated at scene init. */
export const MAX_PICKUPS = 6;

/** TorusKnot geometry params for pickup props. */
export const PICKUP_TORUS_RADIUS = 20;
export const PICKUP_TUBE_RADIUS = 6;
export const PICKUP_TUBULAR_SEGMENTS = 32;
export const PICKUP_RADIAL_SEGMENTS = 6;

/** Pickup float bob amplitude in wu. */
export const PICKUP_BOB_AMP = 8;

/** Pickup float bob frequency in Hz. */
export const PICKUP_BOB_FREQ = 2;

/** Pickup rotation speed in radians per second. */
export const PICKUP_SPIN_SPEED = 1.2;

/** Y position of pickups above arena surface. */
export const PICKUP_BASE_Y = 50;

/**
 * Emissive colour per power-up kind.
 * Used on MeshStandardMaterial — never ShaderMaterial.
 */
export const PICKUP_EMISSIVE: Record<string, string> = {
  speed:         '#00e5ff',
  shield:        '#69f0ae',
  'sticky-bomb': '#ff6d00',
  whirlpool:     '#9c27b0',
  ghost:         '#e0e0e0',
  tractor:       '#f9a825',
};

/**
 * Emoji label per power-up kind, rendered via drei <Html>.
 * NO drei <Text> — Iris Xe crash.
 */
export const PICKUP_EMOJI: Record<string, string> = {
  speed:         '⚡',
  shield:        '🛡',
  'sticky-bomb': '💣',
  whirlpool:     '🌊',
  ghost:         '👻',
  tractor:       '🧲',
};

// ─── Particle bursts ─────────────────────────────────────────────────────────

/** Number of burst pool slots — max simultaneous bursts visible. */
export const BURST_POOL_SIZE = 6;

/** Points per burst instance. Keep ≤ 16 for Iris Xe fragment budget. */
export const BURST_POINT_COUNT = 12;

/** Burst radius in wu — how far points scatter from impact. */
export const BURST_RADIUS = 100;

/** Burst lifetime in milliseconds. */
export const BURST_LIFETIME_MS = 500;

/** Burst point size in pixels. */
export const BURST_POINT_SIZE = 8;

// ─── Camera shake ─────────────────────────────────────────────────────────────

/** Maximum camera shake displacement in wu on a direct hit. */
export const SHAKE_MAX_DISPLACEMENT = 18;

/** Shake decay rate per second (exp). */
export const SHAKE_DECAY = 8.0;

/** Shake oscillation frequency in Hz. */
export const SHAKE_FREQ = 30;

// ─── Screen flash ─────────────────────────────────────────────────────────────

/** Red screen-edge flash duration on self-hit in seconds. */
export const FLASH_DURATION_S = 0.35;

// ─── Elimination drop ─────────────────────────────────────────────────────────

/** Gravitational acceleration for eliminated player drop in wu/s². */
export const DROP_GRAVITY = 980;

/** Time to full transparent fade after drop starts. */
export const DROP_FADE_DURATION = 1.0;

// ─── Void / starfield ─────────────────────────────────────────────────────────

/** Y position of the void plane below the arena. */
export const VOID_BACKDROP_Y = -2000;

/** Void backdrop quad size in wu. */
export const VOID_BACKDROP_SIZE = 10000;

/**
 * Number of stars in the void starfield (Points object, 1 draw call).
 * Reduced from 300 to 60 — 300 was 900 point sprites at 8px each: overdraw hog.
 * 60 is still visually "starfield" from chase cam distance.
 */
export const STAR_COUNT = 60;

/** Starfield spawn radius in wu from arena center. */
export const STAR_RADIUS = 1800;

/** Y range of stars — scattered below the arena surface. */
export const STAR_Y_MIN = -2000;
export const STAR_Y_MAX = -100;
