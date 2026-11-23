/** Keep the shorter viewport axis usable on touch screens. */
export function pixiWorldScale(width: number, height: number): number {
  return Math.max(0.28, Math.min(width, height) / 1400);
}
export function pixiHitSize(scale: number): number { return 44 / scale; }

export interface PixiSolidFootprint { id: string; x: number; y: number; width: number; height: number; kind: 'building' | 'prop'; }
/** Draw the authoritative solid AABB; never derive collisions from legacy art. */
export function pixiSolidFootprint(collider: { id: string; centerX: number; centerZ: number; halfX: number; halfZ: number; walkable?: boolean; kind: 'building' | 'prop' }, centerX: number, centerY: number): PixiSolidFootprint | null {
  if (collider.walkable) return null;
  return { id: collider.id, x: centerX + collider.centerX - collider.halfX, y: centerY + collider.centerZ - collider.halfZ, width: collider.halfX * 2, height: collider.halfZ * 2, kind: collider.kind };
}
