/**
 * land-tenure-doors.ts — the ONE derivation of which tenure doors a lot offers,
 * and of every sentence that describes them.
 *
 * WHY IT EXISTS
 * -------------
 * The claim card gated its rent door on a hand-written `tier === 'starter' ||
 * tier === 'c'`, while the in-world pill told EVERY non-founder tier to "choose
 * CLV hold or vCLAW rent". So a b or an a lot promised a rent door that does not
 * exist, and neither place agreed with `@clawville/shared`, which already owns
 * the answer in `LAND_TENURE_RENT_CT_WEEKLY` / `LAND_HOLD_THRESHOLDS_CLV`.
 *
 * ONE MODEL, EVERY SURFACE (2026-08-10). The first pass exported three separate
 * predicates, and the surfaces still disagreed:
 *   • the pill promised rent from the TIER table while the claim card also
 *     required a server quote on the row, so the two could say different things
 *     about the same lot;
 *   • the claim card rendered its hold section and its Claim button even for a
 *     tier with NO hold door;
 *   • the focused panel said "Open to claim. Pick a door below." for a tier
 *     with NO doors at all.
 *
 * So `LandTenureDoorModel` is now the single answer, built either from a tier
 * alone (`tierDoorModel`, what the in-world pill has) or from a parcel row
 * (`parcelDoorModel`, what the Land Office has). The pill caption, the focused
 * status line, the tier summary AND the rendered controls all read that one
 * model, so a door that does not exist cannot render a button.
 *
 * FOUNDER (corrected 2026-08-10). The pill used to caption Founders' Row as
 * "auction allocation" while the card rendered a working Claim-with-hold button
 * under it. Live code wins: `land-tenure-settlement.ts` accepts a HOLD claim on
 * a founder parcel (threshold 10,000,000 CLV) and refuses only the RENT door
 * (`founder_no_rent_door`), and there is no auction code path anywhere in the
 * repo. So founder is modelled as exactly what it is — a hold-only tier — and
 * every surface says the same thing.
 *
 * TOKEN NAMING: the token is NAMED "$CLAWVILLE" in prose; "CLV" is the unit
 * beside a FIGURE. vCLAW is the in-game currency and is never called CT.
 */

import {
  holdThresholdForTier,
  tenureRentCtWeeklyForTier,
  tierLabel,
  type LandTier,
} from '@clawville/shared';

/**
 * Which doors ONE lot actually offers, and at what price.
 *
 * `hasRentDoor` is the TIER rule; `rentWeeklyCt` is the price we can quote.
 * They come apart only when a parcel row is missing its server quote, and
 * `rentQuoteMissing` names that case so a surface can say "rent is unavailable
 * on this lot right now" instead of silently dropping a door the tier has.
 */
export interface LandTenureDoorModel {
  readonly tier: LandTier | null;
  /** True when the tier offers the rent-free $CLAWVILLE hold door. */
  readonly hasHoldDoor: boolean;
  /** CLV this lot's own hold needs (before stacking), or null. */
  readonly holdClv: number | null;
  /** True when the tier offers the weekly vCLAW rent door. */
  readonly hasRentDoor: boolean;
  /** The weekly vCLAW price we can quote, or null when we cannot. */
  readonly rentWeeklyCt: number | null;
  /** The tier offers rent but this row carries no quote. */
  readonly rentQuoteMissing: boolean;
  /** At least one door is both offered AND quotable. */
  readonly hasOpenDoor: boolean;
}

const NO_TIER_MODEL: LandTenureDoorModel = Object.freeze({
  tier: null,
  hasHoldDoor: false,
  holdClv: null,
  hasRentDoor: false,
  rentWeeklyCt: null,
  rentQuoteMissing: false,
  hasOpenDoor: false,
});

function build(
  tier: LandTier,
  rentWeeklyCt: number | null,
): LandTenureDoorModel {
  const holdClv = holdThresholdForTier(tier);
  const hasRentDoor = tenureRentCtWeeklyForTier(tier) !== null;
  const quotedRent = hasRentDoor ? rentWeeklyCt : null;
  return {
    tier,
    hasHoldDoor: holdClv !== null,
    holdClv,
    hasRentDoor,
    rentWeeklyCt: quotedRent,
    rentQuoteMissing: hasRentDoor && quotedRent === null,
    hasOpenDoor: holdClv !== null || quotedRent !== null,
  };
}

/**
 * The doors a TIER offers, priced from the shared tenure table. This is all the
 * in-world pill can know: it reads the rendered slot, not a parcel row.
 */
export function tierDoorModel(tier: LandTier | null): LandTenureDoorModel {
  if (tier === null) return NO_TIER_MODEL;
  return build(tier, tenureRentCtWeeklyForTier(tier));
}

/**
 * The doors ONE parcel row offers. Same tier rule, but the rent price is the
 * row's own server quote (`claimRentCtWeekly`), which is what the claim will
 * actually be charged at.
 */
export function parcelDoorModel(
  tier: LandTier,
  claimRentCtWeekly: number | null | undefined,
): LandTenureDoorModel {
  return build(tier, claimRentCtWeekly ?? null);
}

function whole(amount: number): string {
  return amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * One tier's doors in plain words, e.g.
 * "Starter Cove: hold 100,000 CLV rent free, or rent 1,000 vCLAW a week."
 *
 * Every figure is DERIVED from the model, never retyped. "CLV" is the unit
 * beside the figure; the section intro above the list is what NAMES the token
 * as $CLAWVILLE.
 */
export function tierDoorSentence(model: LandTenureDoorModel): string {
  if (model.tier === null) return 'This lot could not be identified.';
  const name = tierLabel(model.tier);
  const hold = model.holdClv;
  const rent = model.rentWeeklyCt;
  if (hold != null && rent != null) {
    return `${name}: hold ${whole(hold)} CLV rent free, or rent ${whole(rent)} vCLAW a week.`;
  }
  if (hold != null) {
    // A missing quote means the tier HAS a rent door whose price we could not
    // read, which is not the same thing as the tier having no rent door. Saying
    // "there is no rent door" here would be a false statement about money.
    return model.rentQuoteMissing
      ? `${name}: hold ${whole(hold)} CLV rent free, or rent by the week. The weekly price is unavailable right now.`
      : `${name}: hold ${whole(hold)} CLV rent free. There is no rent door.`;
  }
  if (rent != null) {
    return `${name}: rent ${whole(rent)} vCLAW a week. There is no hold door.`;
  }
  if (model.rentQuoteMissing) {
    return `${name}: rent by the week. The weekly price is unavailable right now.`;
  }
  return `${name}: not open to claim right now.`;
}

/**
 * The caption the in-world pill shows on an AVAILABLE lot. The pill has only a
 * tier, so it states the tier's doors and never a price.
 *
 * A null tier = a code the client cannot parse; say nothing about doors rather
 * than guess one way or the other.
 */
export function availableLotDoorCaption(model: LandTenureDoorModel): string {
  if (model.tier === null) return 'Open it in the Land Office';
  if (model.hasHoldDoor && model.hasRentDoor) {
    return 'Choose a $CLAWVILLE hold or vCLAW rent';
  }
  if (model.hasHoldDoor) return 'Hold $CLAWVILLE, rent free';
  if (model.hasRentDoor) return 'Rent by the week with vCLAW';
  return 'Not open to claim right now';
}

/**
 * The focused panel's one-line answer to "what can I do with this lot" while it
 * is open to claim. Never says "pick a door below" for a lot that has none.
 */
export function openLotStatusLine(model: LandTenureDoorModel): string {
  if (model.hasHoldDoor && model.rentWeeklyCt != null) {
    return 'Open to claim. Pick a door below.';
  }
  if (model.hasHoldDoor) {
    // Same trap as tierDoorSentence: a hold door plus an unreadable rent quote
    // is NOT a hold-only lot, so name the rent door we could not price.
    return model.rentQuoteMissing
      ? 'Open to claim with a $CLAWVILLE hold. The weekly rent price is unavailable right now.'
      : 'Open to claim with a $CLAWVILLE hold.';
  }
  if (model.rentWeeklyCt != null) return 'Open to claim on weekly vCLAW rent.';
  if (model.rentQuoteMissing) {
    return 'Open, but the weekly rent price is unavailable right now.';
  }
  return 'Not open to claim right now.';
}
