/**
 * bumper-shells-config.ts
 *
 * All constants for the Bumper Shells activity scene.
 * Centralised here so BumperShellsArena, BumperShellsHazard, BumperShellsPlayer,
 * BumperShellsPickups, and BumperShellsParticles all read from one source.
 *
 * Performance budget: ≤60 draw calls / ≤180k tris / 1×512² shadow map / 0 post-processing.
 * Target GPU: Intel Iris Xe (integrated).
 */

// ─── Arena geometry ──────────────────────────────────────────────────────────

/** Flat disc radius in world-units (wu). */
export const ARENA_RADIUS = 500;

/** Platform cylinder height. */
export const ARENA_HEIGHT = 12;

/** Radial segments for the platform disc — 48 keeps the rim smooth at 500wu. */
export const ARENA_RADIAL_SEGMENTS = 48;

// ─── Boundary / rim ──────────────────────────────────────────────────────────

/** Rim glow torus outer-tube radius. */
export const RIM_TUBE_RADIUS = 8;

/** Rim glow torus radial segments (lower = fewer draw-call verts). */
export const RIM_RADIAL_SEGMENTS = 16;

/** Rim glow torus tubular segments. */
export const RIM_TUBULAR_SEGMENTS = 64;

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

// ─── Camera ──────────────────────────────────────────────────────────────────

/** Orthographic camera frustum half-width/height in wu. */
export const CAMERA_ORTHO_SIZE = 700;

/** Camera near clip plane. */
export const CAMERA_NEAR = 1;

/** Camera far clip plane. Must be > FOG_FAR. */
export const CAMERA_FAR = 1500;

/** Camera position — slight isometric tilt (not pure top-down). */
export const CAMERA_POSITION = [0, 1100, 300] as const;

/** Camera look-at target. */
export const CAMERA_LOOK_AT = [0, 0, 0] as const;

// ─── Fog ─────────────────────────────────────────────────────────────────────

/** Fog color hex — deep ocean dark blue. */
export const FOG_COLOR = '#050a14';

/** Fog near distance. Keep ≤ ARENA_RADIUS so center is always fog-free. */
export const FOG_NEAR = 200;

/**
 * Fog far distance. MUST be ≤ CAMERA_FAR.
 * Iris Xe rule: fog.far > camera.far → 90→50 FPS drop.
 * 900 < 1500 ✓
 */
export const FOG_FAR = 900;

// ─── Lighting ────────────────────────────────────────────────────────────────

export const HEMI_SKY_COLOR = '#1a3a5c';
export const HEMI_GROUND_COLOR = '#050a14';
export const HEMI_INTENSITY = 0.4;

export const DIR_COLOR = '#80d4ff';
export const DIR_INTENSITY = 1.1;
export const DIR_POSITION = [200, 600, 150] as const;
export const DIR_SHADOW_MAP_SIZE = 512;
export const DIR_SHADOW_NEAR = 1;
export const DIR_SHADOW_FAR = 1200;
export const DIR_SHADOW_CAM_BOUNDS = 600;

// ─── Player shells ───────────────────────────────────────────────────────────

/**
 * Scale applied to lobster.glb / crayfish.glb clones.
 * Matches AVATAR_SCALE=40 from player-avatar.tsx (lobster.glb bbox.max.y ≈ 1.12 native → 44.8 wu).
 */
export const SHELL_SCALE = 40;

/** Maximum simultaneously-rendered player shells. */
export const MAX_PLAYERS = 8;

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
export const PICKUP_BASE_Y = 40;

/**
 * Emissive colour per power-up kind.
 * Used on MeshStandardMaterial — never ShaderMaterial.
 */
export const PICKUP_EMISSIVE: Record<string, string> = {
  speed:       '#00e5ff',
  shield:      '#69f0ae',
  'sticky-bomb': '#ff6d00',
  whirlpool:   '#9c27b0',
  ghost:       '#e0e0e0',
  tractor:     '#f9a825',
};

/**
 * Emoji label per power-up kind, rendered via drei <Html>.
 * NO drei <Text> — Iris Xe crash.
 */
export const PICKUP_EMOJI: Record<string, string> = {
  speed:       '⚡',
  shield:      '🛡',
  'sticky-bomb': '💣',
  whirlpool:   '🌊',
  ghost:       '👻',
  tractor:     '🧜',
};

// ─── Particle bursts ─────────────────────────────────────────────────────────

/** Number of burst pool slots — max simultaneous bursts visible. */
export const BURST_POOL_SIZE = 4;

/** Points per burst instance. Keep ≤ 16 for Iris Xe fragment budget. */
export const BURST_POINT_COUNT = 16;

/** Burst radius in wu — how far points scatter from impact point. */
export const BURST_RADIUS = 80;

/** Burst lifetime in milliseconds. */
export const BURST_LIFETIME_MS = 400;

/** Burst point size in pixels. */
export const BURST_POINT_SIZE = 6;

// ─── Void backdrop ───────────────────────────────────────────────────────────

/** Y position of the infinite void plane below the arena. */
export const VOID_BACKDROP_Y = -2000;

/** Void backdrop quad size in wu — large enough to fill the view at CAMERA_FAR. */
export const VOID_BACKDROP_SIZE = 8000;
