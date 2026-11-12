/** Pure interior contracts. One unit is one world unit; no renderer or DOM imports. */
export const BRAINCHAIN_ROOM = Object.freeze({ radius: 2200, height: 1300, playerRadius: 46 });
export const BRAINCHAIN_PLAYER_SPAWN: Readonly<{ x: number; z: number }> = Object.freeze({ x: 0, z: 1600 });
export const BRAINCHAIN_BACKGROUND = 0x0b0b0b;
export const BRAINCHAIN_CAMERA_FAR = Math.ceil(Math.hypot(4400, 4400, 1300) + 1180);
export const BRAINCHAIN_FOG = Object.freeze({ color: BRAINCHAIN_BACKGROUND, near: 4200, far: BRAINCHAIN_CAMERA_FAR });
export const BRAINCHAIN_EXIT = Object.freeze({ x: 0, z: 2140, radius: 185 });
export type BrainchainTab = 'learn' | 'setup' | 'work' | 'earnings';
export const BRAINCHAIN_STATIONS = Object.freeze([
  { id: 'desk', label: 'Cortex desk', x: -1140, z: 1000, tab: 'learn' },
  { id: 'pod-1', label: 'Worker setup', x: -1670, z: -330, tab: 'setup' },
  { id: 'pod-2', label: 'Worker setup', x: -1460, z: -900, tab: 'setup' },
  { id: 'pod-3', label: 'Worker setup', x: -1070, z: -1410, tab: 'setup' },
  { id: 'pod-4', label: 'Worker setup', x: -510, z: -1740, tab: 'setup' },
  { id: 'board', label: 'Task board', x: 1780, z: -180, tab: 'work' },
  { id: 'receipts', label: 'Receipts', x: 540, z: -1780, tab: 'earnings' },
] as const);
/** Hero model replacement envelope: bottom-centred origin, front +Z, world-unit fit. */
export const BRAINCHAIN_PROP_BOUNDS = Object.freeze({
  // 2026-11-12 staging look: the room read empty, so the centrepiece is ~1.85x and pods 1.3x.
  sculpture: { width: 1300, height: 1000, depth: 860 },
  pod: { width: 470, height: 500, depth: 420 },
  desk: { width: 820, height: 160, depth: 390 },
});
export const BRAINCHAIN_SOLIDS = Object.freeze([
  { x: 0, z: 0, halfX: 660, halfZ: 440 },
  { x: -1140, z: 1000, halfX: 410, halfZ: 195 },
  ...BRAINCHAIN_STATIONS.slice(1, 5).map(s => ({ x: s.x, z: s.z, halfX: 280, halfZ: 280 })),
  { x: 1990, z: -180, halfX: 100, halfZ: 500 },
  { x: 540, z: -1900, halfX: 500, halfZ: 100 },
]);
export function brainchainHitsSolid(x: number, z: number): boolean {
  for (let i = 0; i < BRAINCHAIN_SOLIDS.length; i++) {
    const s = BRAINCHAIN_SOLIDS[i]!;
    if (Math.abs(x - s.x) < s.halfX + 46 && Math.abs(z - s.z) < s.halfZ + 46) return true;
  }
  return false;
}
/** Axis sliding, bounded substeps, circular envelope. The caller owns out. */
export function clampBrainchainMovement(cx: number, cz: number, dx: number, dz: number, out: { x: number; z: number }): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx - cx, dz - cz) / 32));
  const sx = (dx - cx) / steps, sz = (dz - cz) / steps;
  out.x = cx; out.z = cz;
  const radius = BRAINCHAIN_ROOM.radius - BRAINCHAIN_ROOM.playerRadius;
  for (let i = 0; i < steps; i++) {
    const nx = out.x + sx, nz = out.z + sz;
    if (Math.hypot(nx, out.z) <= radius && !brainchainHitsSolid(nx, out.z)) out.x = nx;
    if (Math.hypot(out.x, nz) <= radius && !brainchainHitsSolid(out.x, nz)) out.z = nz;
  }
}
export function brainchainStationAt(x: number, z: number): number {
  let nearest = -1, distance = 460 * 460;
  for (let i = 0; i < BRAINCHAIN_STATIONS.length; i++) {
    const s = BRAINCHAIN_STATIONS[i]!;
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d < distance) { nearest = i; distance = d; }
  }
  return nearest;
}
export interface BrainchainExitEdge { initialized: boolean; inside: boolean; allowed: boolean }
export function stepBrainchainExit(edge: BrainchainExitEdge, x: number, z: number, allowed: boolean, localMove: boolean): boolean {
  const inside = Math.hypot(x - BRAINCHAIN_EXIT.x, z - BRAINCHAIN_EXIT.z) <= BRAINCHAIN_EXIT.radius;
  const fire = edge.initialized && edge.allowed && allowed && !edge.inside && inside && localMove;
  edge.initialized = true; edge.inside = inside; edge.allowed = allowed;
  return fire;
}
const CAMERA_AXES = ['x', 'z'] as const;
/** Shorten the camera arm on its ray; never push it in front of the player. */
export function placeBrainchainCamera(x: number, z: number, yaw: number, pitch: number, out: { x: number; y: number; z: number }): void {
  const vx = -Math.sin(yaw), vz = Math.cos(yaw), radius = BRAINCHAIN_ROOM.radius - 70;
  const dot = x * vx + z * vz;
  let arm = Math.min(520, Math.max(0, -dot + Math.sqrt(Math.max(0, dot * dot + radius * radius - x * x - z * z))));
  for (let i = 0; i < BRAINCHAIN_SOLIDS.length; i++) {
    const s = BRAINCHAIN_SOLIDS[i]!;
    let entry = 0, exit = arm;
    for (let axisIndex = 0; axisIndex < CAMERA_AXES.length; axisIndex++) {
      const axis = CAMERA_AXES[axisIndex]!;
      const origin = axis === 'x' ? x : z, direction = axis === 'x' ? vx : vz;
      const half = (axis === 'x' ? s.halfX : s.halfZ) + 30;
      if (Math.abs(direction) < 1e-8) { if (Math.abs(origin - s[axis]) > half) exit = -1; }
      else {
        const a = (s[axis] - half - origin) / direction, b = (s[axis] + half - origin) / direction;
        entry = Math.max(entry, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      }
    }
    if (entry > 0 && entry <= exit) arm = Math.min(arm, entry);
  }
  out.x = x + vx * arm; out.z = z + vz * arm;
  out.y = 300 + pitch + Math.max(0, 200 - arm) * 0.5;
}
