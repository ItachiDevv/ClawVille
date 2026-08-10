/**
 * land-kit-admission.ts — the pure decision half of the §4.4 kit render budget.
 *
 * Extracted from `land-kit-pieces.tsx` deliberately: the farthest-first parcel
 * drop is a feedback loop (its output changes the snapshot its next input is
 * derived from), and a feedback loop that cannot be unit-tested is a loop that
 * gets shipped oscillating. Nothing here imports React or three, so the whole
 * mechanism is exercised directly in `land-kit-admission.test.ts`.
 *
 * THE OSCILLATION THIS FILE EXISTS TO PREVENT
 * -------------------------------------------
 * The first implementation decided drops from the CURRENT render snapshot,
 * which is already filtered by the drop set. That makes a successful drop erase
 * its own justification: frame N drops a parcel, the snapshot recomputes under
 * budget, frame N+1 reads "under budget" and un-drops it, frame N+2 is over
 * budget again. Each flip changes the chunk's content revision, which fails the
 * per-`(chunk, pieceKey)` merge memo and forces a full `mergeGeometries` rebuild
 * — exactly the per-frame re-merge the budget exists to avoid, plus visible
 * pop-in. Two rules kill it:
 *
 *   1. Decide from UNFILTERED costs. `computeChunkDrop` is given every parcel in
 *      the chunk with its full cost, never the post-drop residue, so dropping
 *      never changes the input that justified it.
 *   2. Hold the set within a data revision. Membership is recomputed only when
 *      the underlying data changes (placed pieces, GLB pricing, or which chunk
 *      is nearest), not on camera drift. Between those events the answer is
 *      returned unchanged, so no state write and no re-merge occur.
 *
 * The one thing that always overrides the hold is the retention floor: the
 * nearest parcel is never dropped, and is re-admitted immediately if the player
 * walks to a parcel that was dropped. That is a real change in what must be on
 * screen, not churn.
 */

// ---------------------------------------------------------------------------
// Source pricing — exact triangle cost per piece key, published asynchronously
// ---------------------------------------------------------------------------

/**
 * Triangle count per piece key, recorded as each GLB resolves. The merge is a
 * pure concatenation, so per-parcel and per-chunk totals built from this are
 * exact rather than estimated.
 *
 * PRICING ARRIVES LATE, AND THE BUDGET HAS TO NOTICE. A cold visit to a region
 * reaches the snapshot builder before any of its GLBs have resolved, so every
 * unpriced key costs 0 and the chunk looks free. If nothing recomputes when the
 * real weight lands, a player who walks around without editing sits in a
 * permanently mispriced admission state for the whole session, and the
 * farthest-first valve can never fire against an overage it never priced.
 *
 * The revision below is the fix: it bumps once per key per session, the
 * renderer subscribes to it, and one recompute picks up the real weight.
 */
const SOURCE_TRIANGLES = new Map<string, number>();
let sourcePricingRevision = 0;
const sourcePricingListeners = new Set<() => void>();

/** Record a piece key's exact triangle count and wake every subscriber. */
export function priceKitSource(pieceKey: string, triangles: number): void {
  if (SOURCE_TRIANGLES.get(pieceKey) === triangles) return;
  SOURCE_TRIANGLES.set(pieceKey, triangles);
  sourcePricingRevision += 1;
  for (const listener of sourcePricingListeners) listener();
}

/** Exact cost of one piece key, or 0 while its GLB is still resolving. */
export function triangleCostOf(pieceKey: string): number {
  return SOURCE_TRIANGLES.get(pieceKey) ?? 0;
}

export function subscribeSourcePricing(listener: () => void): () => void {
  sourcePricingListeners.add(listener);
  return () => {
    sourcePricingListeners.delete(listener);
  };
}

export function getSourcePricingRevision(): number {
  return sourcePricingRevision;
}

/** Test-only reset. Never called by the renderer. */
export function __resetSourcePricingForTest(): void {
  SOURCE_TRIANGLES.clear();
  sourcePricingRevision = 0;
  sourcePricingListeners.clear();
}

/** §4.4 budget (d): distinct merged draws the kit layer may submit globally. */
export const KIT_VISIBLE_DRAW_BUDGET = 60;

/** §4.4 budget (c): triangles the kit layer may submit globally. */
export const KIT_SUBMITTED_TRIANGLE_BUDGET = 250_000;

export const EMPTY_DROP_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

/** One parcel's UNFILTERED contribution to its chunk. */
export interface ParcelCost {
  readonly parcelCode: string;
  /** Exact submitted triangles for this parcel's pieces. */
  readonly triangles: number;
  /** Distinct piece keys this parcel contributes; each is one merged draw. */
  readonly pieceKeys: readonly string[];
  /** Squared distance from the camera. Orders the farthest-first drop. */
  readonly distanceSq: number;
}

export interface ChunkDropInput {
  /** EVERY parcel with pieces in the candidate chunk, at full cost. */
  readonly parcels: readonly ParcelCost[];
  /** The parcel the retention floor protects, or null when none is in range. */
  readonly nearestParcelCode: string | null;
  /** The set currently in force. */
  readonly previousDropped: ReadonlySet<string>;
  /**
   * True when the placed-piece data, the GLB pricing, or the identity of the
   * nearest chunk changed since the last decision. False means "same data, the
   * camera merely moved", which must NOT re-derive membership.
   */
  readonly basisChanged: boolean;
}

/** Residual cost of a chunk once `dropped` is excluded. */
export function residualCost(
  parcels: readonly ParcelCost[],
  dropped: ReadonlySet<string>,
): { readonly triangles: number; readonly distinctKeys: number } {
  let triangles = 0;
  const keys = new Set<string>();
  for (const parcel of parcels) {
    if (dropped.has(parcel.parcelCode)) continue;
    triangles += parcel.triangles;
    for (const key of parcel.pieceKeys) keys.add(key);
  }
  return { triangles, distinctKeys: keys.size };
}

function overBudget(cost: { triangles: number; distinctKeys: number }): boolean {
  return (
    cost.triangles > KIT_SUBMITTED_TRIANGLE_BUDGET
    || cost.distinctKeys > KIT_VISIBLE_DRAW_BUDGET
  );
}

/**
 * Which parcels of one chunk to drop so it fits the §4.4 budgets.
 *
 * Returns `previousDropped` BY REFERENCE whenever nothing should change, so the
 * caller's identity check is a cheap and reliable "no state write needed".
 */
export function computeChunkDrop(input: ChunkDropInput): ReadonlySet<string> {
  const { parcels, nearestParcelCode, previousDropped, basisChanged } = input;
  if (parcels.length === 0) return EMPTY_DROP_SET;

  const nearestIsDropped =
    nearestParcelCode !== null && previousDropped.has(nearestParcelCode);

  // Same data, camera merely moved: hold the current set. This is the clause
  // that makes the valve stable once it has fired.
  if (!basisChanged && !nearestIsDropped) return previousDropped;

  // The full chunk, as if nothing were dropped. Deciding from this rather than
  // from the post-drop snapshot is what stops a drop erasing its own reason.
  const unfiltered = residualCost(parcels, EMPTY_DROP_SET);
  if (!overBudget(unfiltered)) return EMPTY_DROP_SET;

  // Farthest from the camera goes first; the nearest parcel is never a
  // candidate, whatever the budget says.
  const candidates = parcels
    .filter((parcel) => parcel.parcelCode !== nearestParcelCode)
    .sort((a, b) => b.distanceSq - a.distanceSq || a.parcelCode.localeCompare(b.parcelCode));

  const dropped = new Set<string>();
  for (const candidate of candidates) {
    if (!overBudget(residualCost(parcels, dropped))) break;
    dropped.add(candidate.parcelCode);
  }

  if (dropped.size === 0) return EMPTY_DROP_SET;
  return sameMembers(dropped, previousDropped) ? previousDropped : dropped;
}

/** Member-wise equality; lets the caller skip a state write on an equal set. */
export function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export interface ChunkAdmissionCandidate {
  /** Distinct merged draws this chunk would submit. */
  readonly draws: number;
  /** Triangles this chunk would submit. */
  readonly triangles: number;
}

export interface AdmissionTotals {
  readonly draws: number;
  readonly triangles: number;
}

/**
 * Whether a chunk fits alongside what is already admitted.
 *
 * `rank === 0` is the nearest chunk and is admitted unconditionally — the
 * retention floor. §4.4's floor-and-ceiling proof is what makes that safe: a
 * chunk's key count is capped at `KIT_ACTIVE_KEY_CAP = 30` against a 60 draw
 * budget, and the worst single adversarial Lv3 yard is 47,810 triangles against
 * 250,000. A chunk that somehow still busts a budget on its own is what the
 * parcel drop above is for.
 */
export function admitsChunk(
  rank: number,
  candidate: ChunkAdmissionCandidate,
  admitted: AdmissionTotals,
): boolean {
  if (rank === 0) return true;
  return (
    admitted.draws + candidate.draws <= KIT_VISIBLE_DRAW_BUDGET
    && admitted.triangles + candidate.triangles <= KIT_SUBMITTED_TRIANGLE_BUDGET
  );
}
