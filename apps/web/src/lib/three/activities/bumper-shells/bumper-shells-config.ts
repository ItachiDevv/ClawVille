/**
 * bumper-shells-config.ts
 *
 * All constants for the Bumper Shells activity scene.
 * Centralised here so BumperShellsArena, BumperShellsHazard, BumperShellsPlayer,
 * BumperShellsPickups, and BumperShellsParticles all read from one source.
 *
 * REBUILD 2026-04-24: Perspective chase camera, real arena geometry, VFX pipeline.
 *
 * Performance budget: ≤60 draw calls / ≤180k tris / 1×1024² shadow map / 0 post-processing.
 * Target GPU: Intel Iris Xe (integrated) @ 30fps mobile minimum, 60fps desktop target.
 */

// ─── Arena geometry ──────────────────────────────────────────────────────────

/** Flat disc radius in world-units (wu). Sim boundary unchanged. */
export const ARENA_RADIUS = 500;

/** Platform cylinder height — thicker for visual depth from perspective cam. */
export const ARENA_HEIGHT = 24;

/** Radial segments for the platform disc — 64 for smooth silhouette. */
export const ARENA_RADIAL_SEGMENTS = 64;

// ─── Boundary / rim ──────────────────────────────────────────────────────────

/** Rim glow torus outer-tube radius — thicker for perspective readability. */
export const RIM_TUBE_RADIUS = 14;

/** Rim glow torus radial segments. */
export const RIM_RADIAL_SEGMENTS = 16;

/** Rim glow torus tubular segments. */
export const RIM_TUBULAR_SEGMENTS = 80;

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
 * 55° gives a natural-feeling game view for competitive bumper gameplay.
 */
export const CAMERA_FOV = 55;

/** Camera near clip plane. */
export const CAMERA_NEAR = 1;

/**
 * Camera far clip plane.
 * Chase cam sits ~300wu above player at ~420wu back. The void is at -2000wu.
 * 2500wu gives margin. Fog dissolves before the clip plane.
 */
export const CAMERA_FAR = 2500;

/** Chase camera horizontal arm length in wu. */
export const CHASE_CAM_DISTANCE = 420;

/** Chase camera height above arena floor in wu. */
export const CHASE_CAM_HEIGHT = 280;

/** Look-ahead distance: the camera aims ahead of the player in their velocity direction. */
export const CHASE_CAM_LOOK_AHEAD = 60;

/** Camera position lerp alpha per second (frame-rate independent exp decay). */
export const CHASE_CAM_LERP_ALPHA = 5.0;

/** Spectator camera FOV in degrees (same as player for consistency). */
export const SPECTATOR_FOV = 55;

// ─── Fog ─────────────────────────────────────────────────────────────────────

/** Fog color hex — deep abyss. */
export const FOG_COLOR = '#020508';

/**
 * Fog near/far for the perspective chase camera.
 *
 * Chase cam is ~300wu above the disc, at ~420wu behind the player.
 * The arena disc is 500wu radius — fully visible within ~600wu of the player.
 * Fog starts at 900wu (beyond arena edge) and completes at 1800wu.
 * This preserves full arena visibility while hiding the void seam.
 *
 * Iris Xe perf: fog.far (1800) < camera.far (2500) — safe, no overdraw spike.
 * See performance/fog-density-iris-xe-regression.md.
 */
export const FOG_NEAR = 900;
export const FOG_FAR  = 1800;

// ─── Lighting ────────────────────────────────────────────────────────────────

/** Hemisphere sky color — deep ocean blue fill. */
export const HEMI_SKY_COLOR    = '#1a3a6a';

/** Hemisphere ground color — dark abyss. */
export const HEMI_GROUND_COLOR = '#050a14';

/** Hemisphere intensity — fills the shadow side of shells so they read clearly. */
export const HEMI_INTENSITY    = 1.2;

/** Key directional light color — warm white for PBR shell sheen. */
export const DIR_COLOR     = '#fff8f0';

/** Key directional light intensity — strong for lobster PBR shells. */
export const DIR_INTENSITY = 2.2;

/** Key light position — above and to side for dramatic angle + good shadow direction. */
export const DIR_POSITION  = [300, 500, 200] as const;

/** Shadow map size — 1024 for soft PCF shadows visible from chase cam. */
export const DIR_SHADOW_MAP_SIZE = 1024;

export const DIR_SHADOW_NEAR = 1;
export const DIR_SHADOW_FAR = 1200;

/** Shadow frustum covers the full arena disc + some margin. */
export const DIR_SHADOW_CAM_BOUNDS = 560;

/** Rim accent point light color — cyan underwater glow. */
export const RIM_LIGHT_COLOR = '#00ccff';

/** Rim accent light intensity. */
export const RIM_LIGHT_INTENSITY = 1.5;

/** Rim accent light decay distance in wu. */
export const RIM_LIGHT_DISTANCE = 800;

// ─── Player shells ───────────────────────────────────────────────────────────

/**
 * Scale applied to lobster.glb / crayfish.glb clones.
 * lobster.glb native height ≈ 1.12 → SHELL_SCALE=40 → 44.8wu.
 */
export const SHELL_SCALE = 40;

/** Maximum simultaneously-rendered player shells. */
export const MAX_PLAYERS = 8;

// ─── Player name labels ───────────────────────────────────────────────────────

/** Y offset of name label above player shell group origin (in wu). */
export const LABEL_Y_OFFSET = 72;

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

/** Number of stars in the void starfield (Points object, 1 draw call). */
export const STAR_COUNT = 300;

/** Starfield spawn radius in wu from arena center. */
export const STAR_RADIUS = 1800;

/** Y range of stars — scattered below the arena surface. */
export const STAR_Y_MIN = -2000;
export const STAR_Y_MAX = -100;
