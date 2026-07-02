import { NPC_BUILDING_CENTERS } from '@clawville/shared';

// ---------------------------------------------------------------------------
// resolveBuildingCenter — the ONE own-property guard for a building's center.
// ---------------------------------------------------------------------------
// `NPC_BUILDING_CENTERS` is built with `Object.fromEntries(...)` so it inherits
// `Object.prototype`, and the `buildingId` that reaches the agent routes is an
// UNVALIDATED `z.string()` / URL / body param (no enum). A bare
// `NPC_BUILDING_CENTERS[key]` truthy check lets an inherited prototype key
// ("constructor" / "__proto__" / "toString" / "hasOwnProperty" / …) resolve to a
// truthy fn → a `!center` guard PASSES → `dx/dy` become NaN → `NaN > RADIUS` is
// FALSE → the proximity check is SKIPPED and the real-CT building credit can fire
// FROM ANYWHERE (a proximity-bypass CT farm). This own-property lookup (mirroring
// the `npc-simulation` executor gate) closes it for `/visit-building`,
// `/building/:buildingId/chat` AND `/move` alike — all three call this ONE guard.
//
// Lives in its own dependency-free module (only `@clawville/shared`) so the F1
// money-path test can import + exercise the REAL guard without dragging the whole
// agent-gateway route graph (which throws at module load without FINGERPRINT_SECRET)
// into the unit-test env.
export function resolveBuildingCenter(buildingId: string): { x: number; y: number } | null {
  return Object.hasOwn(NPC_BUILDING_CENTERS, buildingId) ? NPC_BUILDING_CENTERS[buildingId] : null;
}
