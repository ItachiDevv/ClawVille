/**
 * Seabed salvage — the shared contract (Land gamification P4b/P7a/P7b).
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR NODE TOPOLOGY.
 * The renderer, the claim service, the read model and the hosted-target
 * service all import `SALVAGE_NODES` from here. `KIT_CHUNKS` went the other
 * way — it is client-local — and that is exactly the drift this avoids: a
 * node the client draws but the server will not settle is a lie told in 3D.
 *
 * ── WHY A FIXED SERVER-AUTHORITATIVE TOPOLOGY ────────────────────────────────
 * The kelp maze supplies the pattern: a fixed node graph the server owns, with
 * the per-visit secret carried in an HMAC token rather than trusted from the
 * client. Salvage borrows the topology model and the signed-token model, NOT
 * kelp's persistence model — kelp's `sporeMask` is TTL'd and disposable, while
 * a salvage claim moves durable currency and therefore lives in Postgres.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Bumped whenever `SALVAGE_NODES` changes in a way that moves or removes a
 * node. It is a component of the receipt fingerprint, so a re-layout cannot
 * make an old idempotency key match a new node, and it is a column on
 * `salvage_node_claims` so per-node cooldown history stays attributable to the
 * layout it was earned under.
 *
 * ADDING a node is still a version bump: the read model and the renderer both
 * key their caches on it.
 */
export const SALVAGE_LAYOUT_VERSION = 1;

/** Which radial band a node sits in. Display + target-selection grouping only. */
export type SalvageNodeBand = 'shallows' | 'shelf' | 'deep';

export interface SalvageNode {
  /** Stable id. Never reused for a different position across layout versions. */
  readonly id: string;
  readonly band: SalvageNodeBand;
  /** World-space X in CENTERED coords (the Three.js / collider frame). */
  readonly x: number;
  /** World-space Z in CENTERED coords. */
  readonly z: number;
}

/**
 * 48 nodes on three square rings, matching the world's square block-frame
 * geometry rather than fighting it with circles.
 *
 * ── HOW THE BANDS WERE CHOSEN (measured, not guessed) ────────────────────────
 * The world is a 704-tile square (`MAP_HALF = 11264` wu). Chebyshev-radial
 * occupancy, in tiles:
 *
 *   building ring   ~[99, 161]      founder frame [171, 209]
 *   starter frame   [239, 277]      c frame       [279, 331]      world edge 352
 *
 * That leaves exactly three usable gaps wide enough to stand in:
 *
 *   shallows  h =  70 t (2,240 wu)  — inside the building ring
 *   shelf     h = 224 t (7,168 wu)  — the 30 t founder↔starter gap, dead centre
 *   deep      h = 341 t (10,912 wu) — the 21 t c↔edge gap, dead centre
 *
 * Every one of the 48 positions was validated against `getServerColliders()`
 * (17 building AABBs) and all 56 `LAND_PARCELS` footprint AABBs. Worst-case
 * clearances measured at layout freeze:
 *
 *   shallows: >= 498 wu from any building, >= 3,232 wu from any parcel
 *   shelf:    >= 2,318 wu from any building, >= 480 wu from any parcel
 *   deep:     >= 6,158 wu from any building, >= 320 wu from any parcel
 *
 * The global worst case is 320 wu — 6x an adult humanoid's collision half-width
 * (`ENTITY_HALF_HUMANOID = 50`), so no node is ever unreachable or embedded in
 * geometry. `land-salvage.test.ts` re-derives these clearances from the live
 * collider + parcel data, so MOVING A BUILDING OR A PARCEL FAILS THE SUITE
 * rather than silently burying a node.
 *
 * The three bands are a deliberate distance gradient: shallows is a short trip
 * from spawn, deep is a real expedition. Yield does NOT vary by band (founder
 * ruling: uniform 1-3), so the gradient buys variety, never a farming edge.
 */
export const SALVAGE_NODES: readonly SalvageNode[] = Object.freeze([
  { id: 'shallows-01', band: 'shallows', x: -1680, z: -2240 },
  { id: 'shallows-02', band: 'shallows', x: -560, z: -2240 },
  { id: 'shallows-03', band: 'shallows', x: 560, z: -2240 },
  { id: 'shallows-04', band: 'shallows', x: 1680, z: -2240 },
  { id: 'shallows-05', band: 'shallows', x: 2240, z: -1680 },
  { id: 'shallows-06', band: 'shallows', x: 2240, z: -560 },
  { id: 'shallows-07', band: 'shallows', x: 2240, z: 560 },
  { id: 'shallows-08', band: 'shallows', x: 2240, z: 1680 },
  { id: 'shallows-09', band: 'shallows', x: 1680, z: 2240 },
  { id: 'shallows-10', band: 'shallows', x: 560, z: 2240 },
  { id: 'shallows-11', band: 'shallows', x: -560, z: 2240 },
  { id: 'shallows-12', band: 'shallows', x: -1680, z: 2240 },
  { id: 'shallows-13', band: 'shallows', x: -2240, z: 1680 },
  { id: 'shallows-14', band: 'shallows', x: -2240, z: 560 },
  { id: 'shallows-15', band: 'shallows', x: -2240, z: -560 },
  { id: 'shallows-16', band: 'shallows', x: -2240, z: -1680 },
  { id: 'shelf-01', band: 'shelf', x: -5376, z: -7168 },
  { id: 'shelf-02', band: 'shelf', x: -1792, z: -7168 },
  { id: 'shelf-03', band: 'shelf', x: 1792, z: -7168 },
  { id: 'shelf-04', band: 'shelf', x: 5376, z: -7168 },
  { id: 'shelf-05', band: 'shelf', x: 7168, z: -5376 },
  { id: 'shelf-06', band: 'shelf', x: 7168, z: -1792 },
  { id: 'shelf-07', band: 'shelf', x: 7168, z: 1792 },
  { id: 'shelf-08', band: 'shelf', x: 7168, z: 5376 },
  { id: 'shelf-09', band: 'shelf', x: 5376, z: 7168 },
  { id: 'shelf-10', band: 'shelf', x: 1792, z: 7168 },
  { id: 'shelf-11', band: 'shelf', x: -1792, z: 7168 },
  { id: 'shelf-12', band: 'shelf', x: -5376, z: 7168 },
  { id: 'shelf-13', band: 'shelf', x: -7168, z: 5376 },
  { id: 'shelf-14', band: 'shelf', x: -7168, z: 1792 },
  { id: 'shelf-15', band: 'shelf', x: -7168, z: -1792 },
  { id: 'shelf-16', band: 'shelf', x: -7168, z: -5376 },
  { id: 'deep-01', band: 'deep', x: -8184, z: -10912 },
  { id: 'deep-02', band: 'deep', x: -2728, z: -10912 },
  { id: 'deep-03', band: 'deep', x: 2728, z: -10912 },
  { id: 'deep-04', band: 'deep', x: 8184, z: -10912 },
  { id: 'deep-05', band: 'deep', x: 10912, z: -8184 },
  { id: 'deep-06', band: 'deep', x: 10912, z: -2728 },
  { id: 'deep-07', band: 'deep', x: 10912, z: 2728 },
  { id: 'deep-08', band: 'deep', x: 10912, z: 8184 },
  { id: 'deep-09', band: 'deep', x: 8184, z: 10912 },
  { id: 'deep-10', band: 'deep', x: 2728, z: 10912 },
  { id: 'deep-11', band: 'deep', x: -2728, z: 10912 },
  { id: 'deep-12', band: 'deep', x: -8184, z: 10912 },
  { id: 'deep-13', band: 'deep', x: -10912, z: 8184 },
  { id: 'deep-14', band: 'deep', x: -10912, z: 2728 },
  { id: 'deep-15', band: 'deep', x: -10912, z: -2728 },
  { id: 'deep-16', band: 'deep', x: -10912, z: -8184 },
] as const);

/** Node count, derived. Do not hardcode 48 anywhere else. */
export const SALVAGE_NODE_COUNT = SALVAGE_NODES.length;

const NODE_BY_ID: ReadonlyMap<string, SalvageNode> = new Map(
  SALVAGE_NODES.map((node) => [node.id, node]),
);

/** Look up a node. Returns `null` for anything not in the frozen layout. */
export function getSalvageNode(nodeId: string): SalvageNode | null {
  return NODE_BY_ID.get(nodeId) ?? null;
}

export function isSalvageNodeId(nodeId: string): boolean {
  return NODE_BY_ID.has(nodeId);
}

// ---------------------------------------------------------------------------
// Caps and cadence
// ---------------------------------------------------------------------------

/** Per-`(avatar, node)` cooldown. Six hours — four claims per node per day. */
export const SALVAGE_NODE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Per-avatar claims admitted per UTC day. At 1-3 materials per claim this is a
 * 20-60 material band, expectation 40.
 */
export const SALVAGE_AVATAR_DAILY_CLAIM_CAP = 20;

/**
 * Per-OWNER claims admitted per UTC day, summed across every avatar the owner
 * controls. This is the anti-fleet-farm bound: at the 20-claim per-avatar rate
 * it admits six avatars at full rate, capping owner-day issuance at 360
 * materials. Humans are structurally one avatar (`avatars.user_id` is UNIQUE),
 * so it binds only on agent fleets.
 *
 * FOUNDER-TUNABLE (ruling Q2, 2026-08-09): the design proposed 60; the founder
 * chose 120 deliberately, to admit six full-rate avatars rather than three.
 * Changing this is an economy decision, not a code cleanup — re-derive the
 * owner-day material ceiling (`cap x 3`) whenever it moves.
 *
 * COUPLED TO THE SCHEMA: migration 0056 carries a CHECK constraint pinned to
 * this number. Raising the constant without a forward migration makes every
 * claim past the old bound fail as a check violation instead of a clean 429,
 * so `land-salvage.test.ts` asserts the constant and the DDL agree.
 */
export const SALVAGE_OWNER_DAILY_CLAIM_CAP = 120;

/** Inclusive yield band per claim. Uniform across nodes and bands. */
export const SALVAGE_YIELD_MIN = 1;
export const SALVAGE_YIELD_MAX = 3;

/** Materials issuable to one avatar in one UTC day, derived. */
export const SALVAGE_AVATAR_DAILY_MATERIAL_MAX =
  SALVAGE_AVATAR_DAILY_CLAIM_CAP * SALVAGE_YIELD_MAX;

/** Materials issuable across one owner's whole fleet in one UTC day, derived. */
export const SALVAGE_OWNER_DAILY_MATERIAL_MAX =
  SALVAGE_OWNER_DAILY_CLAIM_CAP * SALVAGE_YIELD_MAX;

/** Display flavour on the receipt. ONE pooled balance (Q4) — never a ledger split. */
export type SalvageFlavour = 'common' | 'uncommon' | 'rare';

/** Flavour is a pure function of the yield, so the receipt can never disagree. */
export function salvageFlavourForYield(materials: number): SalvageFlavour {
  if (materials >= 3) return 'rare';
  if (materials === 2) return 'uncommon';
  return 'common';
}

// ---------------------------------------------------------------------------
// Approach friction (design §2.5)
// ---------------------------------------------------------------------------

/**
 * FRICTION AND TELEMETRY, NOT PREVENTION — stated plainly because the design
 * states it plainly.
 *
 * Position updates are not authoritative today: `worldPositionSchema` accepts
 * any finite coordinate and `roomRegistry.updatePosition` assigns it with no
 * speed, path or collider validation. A determined client can therefore place
 * itself next to any node. These bounds raise the cost of doing so and make it
 * VISIBLE in telemetry; they do not make it impossible, and no part of the
 * economy's safety rests on them (the caps and the cooldown do that work).
 *
 * Founder ruling Q10 scoped server-authoritative movement as its own
 * world-presence pass. When it lands, this mechanism can be replaced by a real
 * arrival proof. Nothing here blocks on it.
 */
export const SALVAGE_APPROACH_RANGE_WU = 260;
/** Token lifetime. Short enough that a captured token is worth little. */
export const SALVAGE_APPROACH_TOKEN_TTL_MS = 20_000;
/** Minimum dwell inside range before a token issues. */
export const SALVAGE_APPROACH_DWELL_MS = 2_000;
/**
 * The speed bound the anchor advances under. Matches the movement system's
 * ceiling; a jump faster than this poisons eligibility until enough server time
 * has elapsed to have walked it from the stale anchor.
 */
export const SALVAGE_MAX_SPEED_WU_PER_S = 420;

// ---------------------------------------------------------------------------
// The salvage vCLAW bounty (design §2.10) — DARK
// ---------------------------------------------------------------------------

/**
 * FOUNDER RULING Q1: salvage pays MATERIALS ONLY; the vCLAW rail STAYS DARK.
 *
 * These constants exist so a future decision to light it has a specified path
 * rather than an improvised one. They are not a plan to turn it on. Nothing
 * reads them unless `SALVAGE_CT_BOUNTY_ENABLED` is explicitly `'true'`.
 *
 * If lit: 5 vCLAW on each of the first 12 claims of a UTC day, funded by the
 * RECIRCULATING treasury (founder ruling Q6) as a debit-then-credit TRANSFER.
 * Global vCLAW supply delta is therefore exactly ZERO — it moves money that
 * already exists, and it never mints.
 */
export const SALVAGE_CT_BOUNTY_VCLAW = 5;
/** Claims per UTC day that would carry the bounty, if it were ever lit. */
export const SALVAGE_CT_BOUNTY_DAILY_CLAIMS = 12;
