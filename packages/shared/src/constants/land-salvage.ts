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

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const TILE_WU = 32;

/**
 * The three radial bands, and how far a node may wander inside each.
 *
 * ── HOW THE BANDS WERE CHOSEN (measured, not guessed) ────────────────────────
 * The world is a 704-tile square. Chebyshev-radial occupancy, in tiles:
 *
 *   building ring   ~[99, 161]      founder frame [171, 209]
 *   starter frame   [239, 277]      c frame       [279, 331]      world edge 352
 *
 * That leaves exactly three gaps wide enough to stand in, and each band sits in
 * the middle of one. The jitter budgets are what is left over once the gap is
 * split: `deep` sits in a 21-tile gap so it may only wander 95 wu, while
 * `shallows` has the open water inside the building ring and may wander 300.
 */
const SALVAGE_BANDS: readonly {
  readonly band: SalvageNodeBand;
  readonly halfSideTiles: number;
  readonly count: number;
  /** Maximum inward/outward wander, world units. */
  readonly radialJitterWu: number;
  /** Maximum along-ring wander, as a fraction of the full perimeter. */
  readonly tangentialJitter: number;
}[] = [
  { band: 'shallows', halfSideTiles: 70, count: 16, radialJitterWu: 300, tangentialJitter: 0.022 },
  { band: 'shelf', halfSideTiles: 224, count: 16, radialJitterWu: 200, tangentialJitter: 0.020 },
  { band: 'deep', halfSideTiles: 341, count: 16, radialJitterWu: 95, tangentialJitter: 0.018 },
];

/**
 * FNV-1a over `<nodeId>|<salt>`, normalized to [0, 1).
 *
 * THE SCATTER MUST NOT BE RANDOM. `Math.random()` here would hand every process
 * a different world, which for a money path means the server would settle a
 * node the renderer never drew. Hashing the node's own id gives an irregular
 * but completely reproducible offset: the same id always lands in the same
 * place, on every machine, forever.
 */
function scatterHash(nodeId: string, salt: string): number {
  let hash = 0x811c9dc5;
  const input = `${nodeId}|${salt}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** Hash mapped to [-1, 1) so a node can wander either way. */
function signedScatter(nodeId: string, salt: string): number {
  return scatterHash(nodeId, salt) * 2 - 1;
}

/**
 * A point on a square ring of half-side `halfSideWu`, at perimeter fraction
 * `u`. Square rather than circular because the world's parcel frames are
 * squares — a circular ring would cut corners through them.
 */
function squareRingPoint(halfSideWu: number, u: number): { x: number; z: number } {
  const wrapped = (((u % 1) + 1) % 1) * 8 * halfSideWu;
  const h = halfSideWu;
  if (wrapped < 2 * h) return { x: -h + wrapped, z: -h };
  if (wrapped < 4 * h) return { x: h, z: -h + (wrapped - 2 * h) };
  if (wrapped < 6 * h) return { x: h - (wrapped - 4 * h), z: h };
  return { x: -h, z: h - (wrapped - 6 * h) };
}

/**
 * Derive the whole layout from the band table. PURE and DETERMINISTIC — no
 * `Math.random`, no clock, no environment. Calling it twice in any two
 * processes yields byte-identical output, which is what
 * `land-salvage.test.ts` asserts against the frozen array below.
 *
 * Exported so the test can re-run it; production code reads `SALVAGE_NODES`.
 */
export function generateSalvageNodes(): SalvageNode[] {
  const nodes: SalvageNode[] = [];
  for (const band of SALVAGE_BANDS) {
    for (let i = 0; i < band.count; i++) {
      const id = `${band.band}-${String(i + 1).padStart(2, '0')}`;
      // Wander in and out of the band...
      const halfSideWu =
        band.halfSideTiles * TILE_WU + signedScatter(id, 'radial') * band.radialJitterWu;
      // ...and along it, which is what breaks the even spacing that otherwise
      // reads as a grid.
      const u = (i + 0.5) / band.count + signedScatter(id, 'tangent') * band.tangentialJitter;
      const point = squareRingPoint(halfSideWu, u);
      nodes.push({ id, band: band.band, x: Math.round(point.x), z: Math.round(point.z) });
    }
  }
  return nodes;
}

/**
 * The 48 nodes, FROZEN.
 *
 * ── WHY THIS IS A LITERAL AND NOT `generateSalvageNodes()` AT MODULE LOAD ────
 * The generator above is the authority on how these were derived, and a test
 * asserts this array reproduces it exactly. But the exported value is a FROZEN
 * SNAPSHOT on purpose, because node positions are money-path state:
 * `salvage_node_claims` rows are keyed by `(avatar_id, node_id)` and stamped
 * with `layout_version`, and a live cooldown refers to a place in the world.
 *
 * If this were computed at module load, moving a building or re-tiering the
 * land ring would silently relocate nodes under players who are mid-cooldown,
 * WITHOUT bumping `SALVAGE_LAYOUT_VERSION` — the renderer and the settlement
 * service would agree with each other and both be wrong about where the player
 * had actually been. Freezing turns that into a failing test that says "the
 * world moved; decide whether to re-freeze and bump the layout version",
 * which is a decision a person should make rather than a side effect of an
 * unrelated diff.
 *
 * ── SCATTER, NOT A GRID ─────────────────────────────────────────────────────
 * Positions are hash-scattered along and across each band, so the field reads
 * as scattered salvage on the seabed rather than 48 markers on a lattice. The
 * scatter is derived from each node's own id, so it is irregular to look at
 * and exactly reproducible in code.
 *
 * ── VALIDATED, NOT ASSERTED ─────────────────────────────────────────────────
 * `land-salvage.test.ts` RE-DERIVES every clearance from the live collider map
 * (17 building AABBs) and all 56 `LAND_PARCELS` footprints, so MOVING A
 * BUILDING OR A PARCEL FAILS THE SUITE rather than silently burying a node.
 * Measured at freeze: >= 430 wu from any building, >= 261 wu from any parcel
 * (both well past an adult humanoid's 50 wu collision half-width), and no two
 * nodes closer than 670 wu — more than twice the 260 wu approach range, so one
 * dwell can never arm two nodes.
 *
 * The three bands are a deliberate distance gradient: shallows is a short trip
 * from spawn, deep is a real expedition. Yield does NOT vary by band (founder
 * ruling: uniform 1-3), so the gradient buys variety, never a farming edge.
 */
export const SALVAGE_NODES: readonly SalvageNode[] = Object.freeze([
  { id: 'shallows-01', band: 'shallows', x: -1844, z: -2164 },
  { id: 'shallows-02', band: 'shallows', x: -653, z: -2128 },
  { id: 'shallows-03', band: 'shallows', x: 426, z: -2389 },
  { id: 'shallows-04', band: 'shallows', x: 2183, z: -2418 },
  { id: 'shallows-05', band: 'shallows', x: 2050, z: -1548 },
  { id: 'shallows-06', band: 'shallows', x: 2183, z: -863 },
  { id: 'shallows-07', band: 'shallows', x: 2143, z: 693 },
  { id: 'shallows-08', band: 'shallows', x: 2308, z: 1598 },
  { id: 'shallows-09', band: 'shallows', x: 1501, z: 2407 },
  { id: 'shallows-10', band: 'shallows', x: 592, z: 2257 },
  { id: 'shallows-11', band: 'shallows', x: -368, z: 2291 },
  { id: 'shallows-12', band: 'shallows', x: -1166, z: 1964 },
  { id: 'shallows-13', band: 'shallows', x: -2280, z: 1545 },
  { id: 'shallows-14', band: 'shallows', x: -2023, z: 716 },
  { id: 'shallows-15', band: 'shallows', x: -2006, z: -646 },
  { id: 'shallows-16', band: 'shallows', x: -2153, z: -1300 },
  { id: 'shelf-01', band: 'shelf', x: -5178, z: -7166 },
  { id: 'shelf-02', band: 'shelf', x: -1632, z: -7252 },
  { id: 'shelf-03', band: 'shelf', x: 2886, z: -7091 },
  { id: 'shelf-04', band: 'shelf', x: 6050, z: -7165 },
  { id: 'shelf-05', band: 'shelf', x: 7138, z: -5315 },
  { id: 'shelf-06', band: 'shelf', x: 7077, z: -800 },
  { id: 'shelf-07', band: 'shelf', x: 7082, z: 2513 },
  { id: 'shelf-08', band: 'shelf', x: 7001, z: 5793 },
  { id: 'shelf-09', band: 'shelf', x: 5822, z: 6993 },
  { id: 'shelf-10', band: 'shelf', x: 2293, z: 7256 },
  { id: 'shelf-11', band: 'shelf', x: -2084, z: 7045 },
  { id: 'shelf-12', band: 'shelf', x: -6225, z: 7263 },
  { id: 'shelf-13', band: 'shelf', x: -7241, z: 6466 },
  { id: 'shelf-14', band: 'shelf', x: -7281, z: 825 },
  { id: 'shelf-15', band: 'shelf', x: -7171, z: -2189 },
  { id: 'shelf-16', band: 'shelf', x: -7073, z: -4836 },
  { id: 'deep-01', band: 'deep', x: -8237, z: -10858 },
  { id: 'deep-02', band: 'deep', x: -1508, z: -10975 },
  { id: 'deep-03', band: 'deep', x: 3569, z: -11000 },
  { id: 'deep-04', band: 'deep', x: 7778, z: -10898 },
  { id: 'deep-05', band: 'deep', x: 10894, z: -6997 },
  { id: 'deep-06', band: 'deep', x: 10972, z: -2319 },
  { id: 'deep-07', band: 'deep', x: 10951, z: 3995 },
  { id: 'deep-08', band: 'deep', x: 10976, z: 8000 },
  { id: 'deep-09', band: 'deep', x: 9332, z: 10963 },
  { id: 'deep-10', band: 'deep', x: 2897, z: 10837 },
  { id: 'deep-11', band: 'deep', x: -3546, z: 10818 },
  { id: 'deep-12', band: 'deep', x: -6813, z: 10872 },
  { id: 'deep-13', band: 'deep', x: -10856, z: 7028 },
  { id: 'deep-14', band: 'deep', x: -10853, z: 2384 },
  { id: 'deep-15', band: 'deep', x: -10960, z: -2831 },
  { id: 'deep-16', band: 'deep', x: -10950, z: -8878 },
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
