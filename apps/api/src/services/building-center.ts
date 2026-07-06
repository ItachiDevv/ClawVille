import { NPC_BUILDING_CENTERS, BUILDING_OPENCLAW_THEMES } from '@clawville/shared';

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

// ---------------------------------------------------------------------------
// resolveBuildingId — label-tolerant slug resolver for the [ACTION:] executor.
// ---------------------------------------------------------------------------
// The Hatcher/autonomy perception prompt lists each teaching building as
// "<label> [<slug>]" (e.g. "Chum Bucket [code-development]"). The LLM MOSTLY
// emits the bracketed slug, but occasionally echoes the human LABEL instead
// (`enter_building(buildingId=Chum Bucket)` — observed live on staging). A
// strict own-property slug check drops that as unknown → a wasted decide tick.
//
// This maps a raw buildingId to its canonical slug by, in order:
//   1. exact own-property slug match (the contract-correct input), then
//   2. a case/punctuation-insensitive match against the slug, then the label.
// Only ACTUAL teaching buildings (own-property of NPC_BUILDING_CENTERS) resolve;
// inherited prototype keys never do. The alias table is a Map (not a plain
// object) so a normalized "constructor"/"tostring"/etc. can NEVER hit
// Object.prototype and resolve to a truthy function (the same prototype-key
// CT-farm class `resolveBuildingCenter` guards against). Returns the canonical
// slug, or null if nothing matches. The SKILL.md contract still says "use the
// slug"; this is a lenient fallback, not a new/changed param — no wire change.
const normalizeBuildingKey = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

const BUILDING_ID_ALIASES: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const slug of Object.keys(NPC_BUILDING_CENTERS)) {
    map.set(normalizeBuildingKey(slug), slug);
    const label = BUILDING_OPENCLAW_THEMES[slug]?.label;
    if (label) map.set(normalizeBuildingKey(label), slug);
  }
  return map;
})();

export function resolveBuildingId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  if (Object.hasOwn(NPC_BUILDING_CENTERS, raw)) return raw;
  return BUILDING_ID_ALIASES.get(normalizeBuildingKey(raw)) ?? null;
}
