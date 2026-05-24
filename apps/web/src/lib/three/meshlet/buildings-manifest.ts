// @ts-nocheck
/**
 * ClawVille building manifest for the meshlet rasterizer path.
 *
 * Mirrors the 12-slot ring used by arena-buildings.tsx (BUILDING_MODELS), but
 * carries only the bits the meshlet path needs: building id, GLB URL, ring
 * slot position. The actual `arena-buildings.tsx` configuration also tracks
 * scale-overrides, body-anchor offsets, child-mesh tweaks etc. — those are
 * out-of-scope for the meshlet path which renders raw GLB geometry with a
 * single bbox-based scale per building (see use-merged-buildings-asset.ts).
 *
 * Slot 3 (sandy-treedome / messaging-channels) is DISABLED for the spike's
 * 11-building merge — see arena-buildings comment for context. When that GLB
 * is replaced with a lower-poly variant we can re-enable.
 *
 * Slot positions: ring radius 4160 wu, 12 slots × 30° starting North (0°).
 * theta = (-π/2) + slot × (π/6); posX = R × cos(theta); posZ = R × sin(theta).
 */

export interface BuildingSpec {
  /** Stable zone id — matches map-locations.ts. */
  id: string;
  /** URL of the -opt1.glb file (relative to public/). */
  model: string;
  /** World-space X position (centre of ring slot). */
  posX: number;
  /** World-space Z position (centre of ring slot). */
  posZ: number;
}

const R = 4160;

function ringPos(slot: number): [number, number] {
  const theta = (-Math.PI / 2) + slot * (Math.PI / 6);
  return [R * Math.cos(theta), R * Math.sin(theta)];
}

export const MESHLET_BUILDINGS: BuildingSpec[] = [
  { id: 'visual-creation',    model: '/models/pineapple-house-opt1.glb?v=2',                    posX: ringPos(0)[0],  posZ: ringPos(0)[1]  },
  { id: 'code-development',   model: '/models/chum-bucket-v2-opt1.glb?v=2',                     posX: ringPos(1)[0],  posZ: ringPos(1)[1]  },
  { id: 'mcp-tool-use',       model: '/models/krusty-krab-v2-opt1.glb?v=2',                     posX: ringPos(2)[0],  posZ: ringPos(2)[1]  },
  // Slot 3 (messaging-channels / sandy-treedome) — disabled, see header.
  { id: 'api-integrations',   model: '/models/salty-spitoon-opt1.glb?v=2',                      posX: ringPos(4)[0],  posZ: ringPos(4)[1]  },
  { id: 'app-publishing',     model: '/models/boating-school-opt1.glb?v=2',                     posX: ringPos(5)[0],  posZ: ringPos(5)[1]  },
  { id: 'cron-automation',    model: '/models/patty-building-opt1.glb?v=2',                     posX: ringPos(6)[0],  posZ: ringPos(6)[1]  },
  { id: 'deployment-ops',     model: '/models/building-lighthouse-opt1.glb?v=2',                posX: ringPos(7)[0],  posZ: ringPos(7)[1]  },
  { id: 'claw-arcade',        model: '/models/arcade/claw-arcade-exterior-opt1.glb?v=2',        posX: ringPos(8)[0],  posZ: ringPos(8)[1]  },
  { id: 'cove',               model: '/models/cove/cove-exterior-opt1.glb?v=2',                 posX: ringPos(9)[0],  posZ: ringPos(9)[1]  },
  { id: 'agent-security',     model: '/models/patricks-rock-v2-opt1.glb?v=3',                   posX: ringPos(10)[0], posZ: ringPos(10)[1] },
  { id: 'memory-rag',         model: '/models/squidward-house-opt1.glb?v=3',                    posX: ringPos(11)[0], posZ: ringPos(11)[1] },
];

/** World-space target max-dim for each building. Matches arena-buildings.tsx BUILDING_TARGET_HEIGHT. */
export const BUILDING_TARGET_HEIGHT = 1000;

/** World-space radius covering the entire ring + buildings. Used for the rasterizer's instance-frustum cull. */
export const RING_BOUNDING_RADIUS = R + BUILDING_TARGET_HEIGHT / 2;
