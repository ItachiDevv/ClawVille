/**
 * House-trader watch surface (wave A2). READ ONLY: it creates no pairing, arms
 * nothing, and touches no money path.
 *
 * There is no `is_house` column and this file deliberately does not add one.
 * An occupied slot is proved from data that only the operator pairing path can
 * produce. Four conditions, ALL required:
 *
 *   1. a `clawpump_agent_links` row carries the objective;
 *   2. its `clawpump_agent_id` is set (a ClawVille-custodial FLEET link inserts
 *      `null` there, an observed ClawPump pairing inserts the real id);
 *   3. a live `trading_wallets` row for the same avatar has
 *      `source = 'clawpump'` and the same pubkey as the link;
 *   4. the owning user's `identity_fingerprint` equals
 *      `identityFingerprint('clawpump-observed', clawpumpAgentId)`.
 *
 * Condition 4 is the real discriminator: it is the one an operator cannot
 * reproduce by accident, and it is the same check `resolveObservedSubject`
 * runs before it pairs. Conditions 1 to 3 are cheap pre-filters. Together they
 * exclude the stale staging SafeRebalancer custodial link (fails 2 and 3) and
 * any future user-owned ClawPump wallet from wave B (fails 1 and 4).
 */

import {
  and, avatars, clawpumpAgentLinks, db, desc, eq, inArray, isNull, sql, tradingWallets,
  users, verifiedTrades,
} from '@clawville/database';
import { identityFingerprint } from './identity-service';
import { CLAWPUMP_OBSERVED_IDENTITY_TYPE } from './trading-provisioning';
import { listPublicVerifiedTradesForAvatars, type PublicTradeDTO } from './trade-observer';
import { alertError } from './alert-error';
import { shouldAlertTradingLoop } from './trading-rpc';
import {
  HOUSE_TRADER_LINEUP, TRADE_MINTS,
  type HouseTraderRisk, type TradingObjective,
} from '@clawville/shared';

/** One `clawpump_agent_links` row joined to its wallet and its owner. */
export interface HouseTraderCandidate {
  avatarId: string;
  avatarName: string | null;
  objective: string;
  clawpumpAgentId: string | null;
  /** The ClawVille agent id. This, never the avatar UUID, is what the public
   *  tape publishes as `subject.id` for an observed pairing. */
  clawvilleAgentId: string | null;
  /** The pubkey recorded on the LINK. */
  linkWalletPubkey: string;
  /** The live (non-revoked) `trading_wallets` row for this avatar, if any. */
  wallet: { pubkey: string; source: string } | null;
  ownerIdentityFingerprint: string | null;
  createdAt: Date;
}

export type HouseTraderStatus = 'live-observed' | 'stopped' | 'not-yet-running';

export interface HouseTraderCounts {
  verified: number;
  scored: number;
  lastTradeAt: string | null;
}

/**
 * PUBLIC, LIVE realised P&L for one house trader (founder order, 2026-09-20).
 *
 * Basis, stated on the wire so nobody has to guess: every house swap has USDC
 * on one side, so a position is one non-USDC mint. `inputMint = USDC` is a BUY
 * (spend USDC), `outputMint = USDC` is a SELL (receive USDC), and a mint with
 * BOTH legs is a closed position worth `received - spent`. Partial exits are
 * just more sell legs on the same mint. This is the GROSS USDC leg: it excludes
 * network fees and rent, which is why `basis` and `note` ship with the numbers.
 *
 * Computed over the avatar's FULL verified history, never a recent window. A
 * 50-row window read Genesis as +8.87 when the true figure was -5.20, because
 * the window cut the buy legs off the front of older positions. The aggregation
 * therefore happens in SQL with no LIMIT, and `realised-truncation` in the unit
 * tests pins that a summary over all legs differs from one over a recent slice.
 */
export interface HouseTraderRealised {
  /** Completed round trips: a FIFO lot whose units reached zero, or one written
   *  off by the no-exit rule. NOT "mints with both legs". */
  closedPositions: number;
  /** Closed trips ending above / below zero. Exactly flat is neither. */
  wins: number;
  losses: number;
  /**
   * Realised USD as a NUMBER, not a preformatted string. Full precision from
   * integer micro-dollars; the CLIENT does the 2-decimal display rounding.
   */
  realisedUsd: number;
  /** Best and worst single closed trip, USD. `null` when none closed, which is
   *  NOT the same fact as 0.00 and must not render as one. */
  bestUsd: number | null;
  worstUsd: number | null;
  /** Open FIFO lots younger than the no-exit window: excluded from realised. */
  openPositions: number;
  /** Cost basis still tied up in those open lots, USD. */
  openCostUsd: number;
  basis: 'gross_usdc_leg';
  /** How lots are matched. Round trips in time order give FIFO by construction. */
  costBasis: 'round_trip_fifo';
  /** Hours after which an un-exited lot is written off as a total loss. */
  noExitHours: number;
  /** Lots written off by that rule (rug or abandoned). If Genesis reads
   *  positive on staging and this is 0, the rug rule is not firing. */
  noExitClosures: number;
  /** Sells with no matching prior buy. Counted, never booked as profit. */
  unmatchedSells: number;
  /** Mints skipped because a leg was quoted in something other than USDC
   *  (the tape treats WSOL as a quote too). Disclosed, not hidden. */
  excludedNonUsdc: number;
  /** Rows the figure was computed over. Publishing this makes a truncation
   *  regression DETECTABLE downstream: compare it with `counts.verified`.
   *  Suggested by tf3d-interior2, and it is the cheapest lie-detector here.
   *  The route makes that comparison itself and sets `partial`. */
  computedOverTrades: number;
  /**
   * Legs with no usable timestamp. They are EXCLUDED, never dated to epoch 0:
   * 1970 is older than the no-exit window, so a fallback of `0` would silently
   * write the position off as a total loss it never took. Failing toward a
   * fabricated loss is worse than failing toward "we do not know".
   */
  undatedLegs: number;
  /**
   * Legs whose notional was negative or zero. IMPOSSIBLE rather than unknown,
   * and it does not fail safe: a negative cost makes the no-exit write-off
   * book a gain. The mint is excluded whole.
   */
  invalidLegs: number;
  /**
   * TRUE when the headline figure does not cover everything: an unpriced or
   * undated leg, a non-USDC quote position, an unclassifiable swap, or
   * `computedOverTrades` disagreeing with the slot's verified count. A
   * consumer must not present a partial figure as final.
   */
  partial: boolean;
  note: string;
  /**
   * True when at least one row folded in was marked `pre_bind`. Those trades
   * really are the avatar's, so they are INCLUDED, and this field is how the
   * board says so rather than quietly mixing two eras. Genesis has pre-bind
   * history; the Runner does not.
   */
  preBindIncluded: boolean;
  /**
   * Legs that could NOT be folded in, surfaced instead of being silently
   * dropped or coerced to zero. `unpriced` is a USDC-side swap whose
   * `notional_usd` is NULL (the column is nullable and the observer writes
   * `?? null`); valuing it at 0 would understate a real position. `unclassified`
   * is a swap with USDC on NEITHER side, which this basis cannot express.
   * Both are normally 0; a non-zero value means the figure above is partial.
   */
  unpricedLegs: number;
  unclassifiedLegs: number;
  computedAt: string;
}

/**
 * ONE verified swap, as the driver really returns it. `inputAmount` and
 * `outputAmount` are `numeric(40,0)` and arrive as STRINGS; they are parsed to
 * BigInt and never through `Number()`, because a token amount in base units
 * routinely exceeds 2^53 and float-summing money is how totals drift.
 */
export interface RealisedTradeLeg {
  signature: string;
  inputMint: string;
  outputMint: string;
  /** Integer base units, as text. */
  inputAmount: string;
  outputAmount: string;
  /** `numeric(20,6)` as text, or null when the observer could not price it. */
  notionalUsd: string | null;
  /** Chain time where we have it, else verification time. Seconds. */
  atSec: number;
  preBind: boolean;
}

export const REALISED_NO_EXIT_HOURS = 24;

const REALISED_NOTE =
  'Gross realised on the USDC leg, excludes network fees. Round trips are matched FIFO by token units; '
  + `a position with no exit after ${REALISED_NO_EXIT_HOURS} hours counts as a total loss.`;

/** USD text (`numeric(20,6)`) to integer MICRO-dollars, exactly. No float:
 *  `parseFloat` on money then summing is precisely the drift this avoids. */
function usdToMicros(text: string | null): bigint | null {
  if (text === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!match) return null;
  const frac = (match[3] ?? '').slice(0, 6).padEnd(6, '0');
  const magnitude = BigInt(match[2]) * 1_000_000n + BigInt(frac);
  return match[1] === '-' ? -magnitude : magnitude;
}

/** Micro-dollars back to a USD number at the OUTPUT boundary only. */
function microsToUsd(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

function toBigInt(text: string): bigint {
  try {
    return BigInt(text.trim());
  } catch {
    return 0n;
  }
}

export function emptyRealised(computedAt = new Date().toISOString()): HouseTraderRealised {
  return {
    closedPositions: 0,
    wins: 0,
    losses: 0,
    realisedUsd: 0,
    bestUsd: null,
    worstUsd: null,
    openPositions: 0,
    openCostUsd: 0,
    basis: 'gross_usdc_leg',
    costBasis: 'round_trip_fifo',
    noExitHours: REALISED_NO_EXIT_HOURS,
    noExitClosures: 0,
    unmatchedSells: 0,
    excludedNonUsdc: 0,
    computedOverTrades: 0,
    undatedLegs: 0,
    invalidLegs: 0,
    partial: false,
    note: REALISED_NOTE,
    preBindIncluded: false,
    unpricedLegs: 0,
    unclassifiedLegs: 0,
    computedAt,
  };
}

/** One FIFO lot: a buy that is still being worked off by later sells. */
interface RealisedLot {
  unitsLeft: bigint;
  /** Cost still attached to `unitsLeft`. A write-off charges THIS, never the
   *  lot's gross original spend, or a partly-exited rug double-counts. */
  costLeft: bigint;
  /** Micro-dollars realised on this lot so far, across its partial sells. */
  realisedMicros: bigint;
  openedAtSec: number;
}

/**
 * Fold one trader's FULL, TIME-ORDERED leg history into the public figure.
 *
 * Pure on purpose: the SQL loader only shapes rows, so every rule that can be
 * wrong is unit-testable with no database (fixtures F1 to F8).
 *
 * THE RULES, and why each exists:
 *
 * 1. FIFO LOTS BY TOKEN UNITS, not by USDC and never by summing a mint.
 *    Genesis bought TIGRINO twice and exited over four sells: two separate
 *    round trips (+1.92 and +0.18). Per-mint summing mashes them into one and
 *    miscounts both the trip count and the extremes.
 * 2. A PARTIAL SELL realises only the matched quantity. The remainder stays an
 *    open lot carrying its own cost basis. This is the case that separates a
 *    correct implementation from per-mint netting: two buys at different prices
 *    and one partial sell reads +4 here and -20 under netting (fixture F2).
 * 3. NO EXIT IS A LOSS, PER LOT. A lot with no sell after
 *    `REALISED_NO_EXIT_HOURS` is a rug or an abandoned bag; it closes at minus
 *    its unmatched cost. Without this Genesis reads PROFITABLE, because its
 *    worst trade (FEELSGOOD, about -10.20) never produced a sell leg at all.
 *    The clock is per LOT: a later buy on the same mint does not reset an older
 *    lot's clock, or one re-entry would launder every stale bag behind it.
 * 4. AN OPEN LOT YOUNGER THAN THAT is excluded from realised and reported with
 *    its cost, because an unrealised position is not a result.
 * 5. A SELL WITH NO PRIOR BUY books NO profit. Proceeds with no cost basis are
 *    exactly the phantom gain a truncated window invents.
 * 6. A MINT WITH ANY NON-USDC QUOTE LEG is excluded whole and disclosed. The
 *    tape treats WSOL as a quote too, and mixing quote assets silently would
 *    price a SOL-funded entry against a USDC exit.
 */
export function summariseRealised(input: {
  /** MUST be the avatar's full history, ascending by time. */
  legs: readonly RealisedTradeLeg[];
  usdcMint: string;
  /** Quote assets the tape recognises. A position quoted in any of these OTHER
   *  than USDC is excluded rather than mispriced. */
  quoteMints?: readonly string[];
  nowSec?: number;
  computedAt?: string;
}): HouseTraderRealised {
  const out = emptyRealised(input.computedAt ?? new Date().toISOString());
  const usdc = input.usdcMint;
  const quotes = new Set(input.quoteMints ?? [usdc]);
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const noExitSec = REALISED_NO_EXIT_HOURS * 3600;
  out.computedOverTrades = input.legs.length;

  type Side = { mint: string; units: bigint; micros: bigint | null; buy: boolean };
  const byMint = new Map<string, Side[]>();
  const badQuote = new Set<string>();
  const unpricedMints = new Set<string>();
  const undatedMints = new Set<string>();
  const invalidMints = new Set<string>();
  const openedAt = new Map<string, number[]>();

  for (const leg of input.legs) {
    if (leg.preBind) out.preBindIncluded = true;
    const inIsQuote = quotes.has(leg.inputMint);
    const outIsQuote = quotes.has(leg.outputMint);
    // Neither side is a quote asset: this basis cannot express it.
    if (!inIsQuote && !outIsQuote) { out.unclassifiedLegs += 1; continue; }
    // Both sides quote (USDC<->SOL): not a position in a traded mint.
    if (inIsQuote && outIsQuote) { out.unclassifiedLegs += 1; continue; }
    const buy = inIsQuote;
    const mint = buy ? leg.outputMint : leg.inputMint;
    const quote = buy ? leg.inputMint : leg.outputMint;
    if (quote !== usdc) { badQuote.add(mint); continue; }
    const micros = usdToMicros(leg.notionalUsd);
    if (micros === null) { out.unpricedLegs += 1; unpricedMints.add(mint); continue; }
    // A notional that is negative or zero is IMPOSSIBLE, not merely unknown,
    // and it does not fail safe: a buy with a negative cost gives the lot a
    // negative `costLeft`, so the no-exit write-off (`realised -= costLeft`)
    // SUBTRACTS a negative and books a GAIN on a position that never sold.
    // Exclude the whole mint rather than let a bad row mint profit.
    if (micros <= 0n) { out.invalidLegs += 1; invalidMints.add(mint); continue; }
    // NEVER fall back to 0. Epoch 1970 is older than the no-exit window, so a
    // zero date would write a live position off as a total loss it never took.
    // The whole mint is excluded, matching the unpriced rule: a lot with an
    // unknown clock cannot be judged young OR stale, and guessing either way
    // invents a number.
    if (!Number.isFinite(leg.atSec) || leg.atSec <= 0) {
      out.undatedLegs += 1;
      undatedMints.add(mint);
      continue;
    }
    const units = buy ? toBigInt(leg.outputAmount) : toBigInt(leg.inputAmount);
    if (units <= 0n) { out.unclassifiedLegs += 1; continue; }
    const bucket = byMint.get(mint) ?? [];
    bucket.push({ mint, units, micros, buy });
    byMint.set(mint, bucket);
    const times = openedAt.get(mint) ?? [];
    times.push(leg.atSec);
    openedAt.set(mint, times);
  }

  let realisedMicros = 0n;
  let openCostMicros = 0n;
  const closeTrip = (tripMicros: bigint) => {
    out.closedPositions += 1;
    if (tripMicros > 0n) out.wins += 1;
    else if (tripMicros < 0n) out.losses += 1;
    const usd = microsToUsd(tripMicros);
    out.bestUsd = out.bestUsd === null ? usd : Math.max(out.bestUsd, usd);
    out.worstUsd = out.worstUsd === null ? usd : Math.min(out.worstUsd, usd);
  };

  for (const [mint, sides] of byMint) {
    // Excluded WHOLE, so a half-priced or half-SOL-quoted book never produces a
    // confident figure built on the half we happen to understand.
    if (badQuote.has(mint) || unpricedMints.has(mint) || undatedMints.has(mint)
      || invalidMints.has(mint)) continue;
    const times = openedAt.get(mint) ?? [];
    const lots: RealisedLot[] = [];
    sides.forEach((side, index) => {
      const atSec = times[index] ?? nowSec;
      if (side.buy) {
        lots.push({ unitsLeft: side.units, costLeft: side.micros!, realisedMicros: 0n, openedAtSec: atSec });
        return;
      }
      let toMatch = side.units;
      const sold = side.units;
      const proceeds = side.micros!;
      // RUNNING TOTAL, not a per-lot share. Allocating `proceeds * matched /
      // sold` independently to each lot TRUNCATES every allocation, so a sell split
      // across lots loses the integer remainder and invents a loss: two lots of
      // 500000 and 500001 units against 3 micro-dollars allocate 1 + 1 and drop
      // the third. Tracking the cumulative target and taking the difference
      // gives each lot its share AND puts the remainder on the final matched
      // allocation, so the allocations sum to `proceeds` exactly whenever the
      // sell is fully matched.
      let matchedUnits = 0n;
      let allocated = 0n;
      while (toMatch > 0n && lots.length > 0) {
        const lot = lots[0]!;
        const matched = lot.unitsLeft < toMatch ? lot.unitsLeft : toMatch;
        // Cost is already exact: a closing allocation takes whatever `costLeft`
        // remains, so the lot's total cost is conserved across partial sells.
        const costPortion = (lot.costLeft * matched) / lot.unitsLeft;
        matchedUnits += matched;
        const target = (proceeds * matchedUnits) / sold;
        const proceedsPortion = target - allocated;
        allocated = target;
        const net = proceedsPortion - costPortion;
        lot.realisedMicros += net;
        lot.costLeft -= costPortion;
        lot.unitsLeft -= matched;
        realisedMicros += net;
        toMatch -= matched;
        if (lot.unitsLeft === 0n) { closeTrip(lot.realisedMicros); lots.shift(); }
      }
      // Rule 5: proceeds with no cost basis are NOT profit.
      if (toMatch > 0n) out.unmatchedSells += 1;
    });
    for (const lot of lots) {
      if (nowSec - lot.openedAtSec >= noExitSec) {
        // Rule 3: write off the UNMATCHED basis only.
        realisedMicros -= lot.costLeft;
        out.noExitClosures += 1;
        closeTrip(lot.realisedMicros - lot.costLeft);
      } else {
        out.openPositions += 1;
        openCostMicros += lot.costLeft;
      }
    }
  }

  out.excludedNonUsdc = badQuote.size;
  // Converted to USD ONCE, at the boundary. The client does the 2dp display
  // rounding; sending a preformatted string would make the figure unusable.
  out.realisedUsd = microsToUsd(realisedMicros);
  out.openCostUsd = microsToUsd(openCostMicros);
  // Anything excluded makes the headline incomplete. The route adds the
  // truncation check on top, because only it knows the verified count.
  out.partial = out.unpricedLegs > 0
    || out.unclassifiedLegs > 0
    || out.undatedLegs > 0
    || out.invalidLegs > 0
    || out.excludedNonUsdc > 0;
  return out;
}

/**
 * The truncation alarm, read BY CODE rather than by a human.
 *
 * `computedOverTrades` is how many rows the figure covered; `counts.verified`
 * is how many the slot has. The realised loader reads the FULL history with no
 * LIMIT, so these must agree. If they ever diverge the figure was computed over
 * a partial read, which is the bug that flipped Genesis from -5.20 to +8.87, so
 * the slot is marked PARTIAL and the mismatch is logged with both numbers.
 */
export function applyTruncationCheck(
  realised: HouseTraderRealised,
  verified: number,
  slotName: string,
): HouseTraderRealised {
  if (realised.computedOverTrades === verified) return realised;
  if (shouldAlertTradingLoop(`house-traders:truncated:${slotName}`)) {
    console.warn(
      `[house-traders] realised P&L for "${slotName}" covered ${realised.computedOverTrades} rows `
      + `but the slot reports ${verified} verified trades. Marking the figure PARTIAL: a short read `
      + 'inflates realised P&L by keeping sell legs whose buy legs fell outside the read.',
    );
  }
  return { ...realised, partial: true };
}

export interface HouseTraderSlot {
  objective: TradingObjective;
  /** The lineup LABEL, not a profile name. */
  slotName: string;
  /** Plain-words strategy from the lineup. Deliberately NOT
   *  `TRADING_OBJECTIVE_BRIEFS`: a house trader runs the operator's own rule
   *  loop on ClawPump, so the profile brief and its allowed mints do not
   *  describe it, and printing them would be a false claim about a live
   *  trader. Genesis holds `momentum-board` but trades small-cap memecoins on
   *  any venue. */
  strategyNote: string;
  status: HouseTraderStatus;
  /** The SAME shape and the SAME identifier the public tape already publishes
   *  (`trade-observer.ts` `PublicTradeDTO.subject`). Deliberately not a second
   *  identifier: exposing the avatar UUID here would put a different public id
   *  on the same trader, and one identifier policy must govern both surfaces. */
  subject: { type: 'avatar' | 'agent'; id: string; avatarName: string | null } | null;
  counts: HouseTraderCounts;
  /** PUBLIC live realised P&L, server-computed. Always present, so the board
   *  never has to branch on a missing field; an unpaired slot carries zeros. */
  realised: HouseTraderRealised;
  recentTrades: PublicTradeDTO[];
}

/**
 * A slot plus the trading wallet bound to it. INTERNAL ONLY.
 *
 * `walletPubkey` must NEVER be serialised onto a response: two tests assert
 * that no wallet string and no `wallet` key appears in the public body, and the
 * served manual publishes "the public tape never includes wallet addresses".
 * It exists so the status route can answer "is this one of ours?" and so the
 * risk merge can find a slot's reported state, both of which key on the wallet
 * the runner knows itself by.
 */
export interface HouseTraderSlotBinding {
  slot: HouseTraderSlot;
  /** The pubkey recorded on the LINK, which is what the runner posts. `null`
   *  for an unpaired slot. Present for a `stopped` slot too: the link survives
   *  an unpaired wallet, and a stopped runner may still be reporting. */
  walletPubkey: string | null;
}

/** A slot as the PUBLIC route emits it: the slot plus the merged risk block.
 *  `risk` is merged per request, outside the 15 s slot cache, so a reported
 *  pause shows on the very next poll. */
export type PublicHouseTraderSlot = HouseTraderSlot & { risk: HouseTraderRisk | null };

/**
 * PAIRING WINS OVER RISK. Only a `live-observed` slot publishes a `risk` block.
 *
 * A `stopped` slot keeps its link pubkey, so its runner can and does keep
 * heartbeating: an operator revokes the trading wallet, the Python process does
 * not know it was unpaired, and it carries on posting `canEnter: false`. The
 * POST still ACCEPTS those reports, deliberately, so a re-pairing has current
 * state the instant it lands. What must not happen is PUBLISHING one. The board
 * and the panel both show STOPPED for that desk and suppress the pause, because
 * the card already says why it is idle, so emitting `risk.state: 'paused'` on
 * the wire would have an agent say "paused by a risk limit" while both human
 * surfaces say "stopped". Two public surfaces disagreeing about one desk is the
 * failure this file guards against everywhere else.
 *
 * Enforced HERE, on the wire, rather than only in the client, so every consumer
 * agrees by construction and the client resolver is defence in depth.
 */
export function slotPublishesRisk(status: HouseTraderStatus): boolean {
  return status === 'live-observed';
}

const EMPTY_COUNTS: HouseTraderCounts = { verified: 0, scored: 0, lastTradeAt: null };

/**
 * All four conditions. Pure, so the discriminator is testable without a
 * database and cannot drift from the route that depends on it.
 */
export function houseTraderState(
  candidate: HouseTraderCandidate,
): 'live-observed' | 'stopped' | null {
  // 2. A fleet link leaves this null; only an observed pairing sets it.
  if (!candidate.clawpumpAgentId) return null;
  // 4. The provisioning identity. The real discriminator, and the one an
  //    operator cannot reproduce by accident. Checked before the wallet so a
  //    non-house row can never reach the `stopped` branch below.
  if (!candidate.ownerIdentityFingerprint) return null;
  if (
    candidate.ownerIdentityFingerprint
    !== identityFingerprint(CLAWPUMP_OBSERVED_IDENTITY_TYPE, candidate.clawpumpAgentId)
  ) {
    return null;
  }
  // 3. A live ClawPump-sourced wallet whose pubkey matches the link.
  //
  // A revoked or missing wallet is `stopped`, NOT invisible. Unpair revokes the
  // wallet while its `verified_trades` rows survive and keep showing on the
  // public tape, so dropping the slot to "not running yet" with a zero count
  // would have two public surfaces disagreeing about the same trades.
  if (candidate.wallet === null) return 'stopped';
  // A live wallet that is not the link's ClawPump wallet is not an observed
  // pairing at all (this is the custodial fleet shape), so it is not a house
  // trader rather than a stopped one.
  if (candidate.wallet.source !== 'clawpump') return null;
  if (candidate.wallet.pubkey !== candidate.linkWalletPubkey) return null;
  return 'live-observed';
}

/** True when the row is a house trader at all, live or stopped. */
export function qualifiesAsHouseTrader(candidate: HouseTraderCandidate): boolean {
  return houseTraderState(candidate) !== null;
}

/**
 * Pick at most one qualifying candidate per objective. `objective` is a plain
 * varchar with a CHECK, NOT a unique column, so two rows can claim one slot.
 * The newest `created_at` wins and the duplicate is reported: choosing silently
 * would be a fail-invisible outcome.
 */
export function selectHouseTraders(
  candidates: readonly HouseTraderCandidate[],
  onDuplicate: (objective: string, count: number) => void = () => {},
): Map<string, HouseTraderCandidate> {
  const byObjective = new Map<string, HouseTraderCandidate[]>();
  for (const candidate of candidates) {
    if (!qualifiesAsHouseTrader(candidate)) continue;
    const bucket = byObjective.get(candidate.objective);
    if (bucket) bucket.push(candidate);
    else byObjective.set(candidate.objective, [candidate]);
  }
  const chosen = new Map<string, HouseTraderCandidate>();
  for (const [objective, rows] of byObjective) {
    if (rows.length > 1) onDuplicate(objective, rows.length);
    chosen.set(
      objective,
      [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!,
    );
  }
  return chosen;
}

/**
 * One slot per HOUSE_TRADER_LINEUP entry, in lineup order, so the response
 * shape never depends on the data. Only the lineup appears: the remaining
 * profiles are trader TEMPLATES a player can copy, not house traders, and
 * listing them here would claim the house runs traders it does not. The split
 * moved twice on 2026-09-19 — `sol-usdc-mean-reversion` became template-only
 * when Dip Hunter was dropped, then `intel-signal-follower` became a house slot
 * when ClawVille Runner was added — so derive the split from
 * `HOUSE_TRADER_OBJECTIVES`, never from a count written in prose.
 * An unpaired slot reads `not-yet-running` with zero counts and no rows: no
 * placeholder numbers, no sample trades.
 */
export function buildHouseTraderSlots(input: {
  chosen: Map<string, HouseTraderCandidate>;
  counts: Map<string, HouseTraderCounts>;
  recentByAvatar: Map<string, PublicTradeDTO[]>;
  /** Optional so existing callers and fixtures keep compiling; a missing entry
   *  yields the zero block, never a fabricated figure. */
  realisedByAvatar?: Map<string, HouseTraderRealised>;
}): HouseTraderSlot[] {
  return buildHouseTraderSlotBindings(input).map((binding) => binding.slot);
}

/**
 * The same build, keeping each slot's bound wallet beside it for the callers
 * that need to match a runner's report to a slot. See `HouseTraderSlotBinding`
 * for why the wallet may not cross the wire.
 */
export function buildHouseTraderSlotBindings(input: {
  chosen: Map<string, HouseTraderCandidate>;
  counts: Map<string, HouseTraderCounts>;
  recentByAvatar: Map<string, PublicTradeDTO[]>;
  realisedByAvatar?: Map<string, HouseTraderRealised>;
}): HouseTraderSlotBinding[] {
  return HOUSE_TRADER_LINEUP.map((entry) => {
    const objective = entry.objective;
    const candidate = input.chosen.get(objective);
    const base = {
      objective,
      slotName: entry.label,
      strategyNote: entry.strategyNote,
    };
    const state = candidate ? houseTraderState(candidate) : null;
    if (!candidate || state === null) {
      return {
        slot: { ...base, status: 'not-yet-running' as const, subject: null,
          counts: { ...EMPTY_COUNTS }, realised: emptyRealised(), recentTrades: [] },
        walletPubkey: null,
      };
    }
    const slot: HouseTraderSlot = {
      ...base,
      status: state,
      // NEVER the wallet pubkey, the user id or the identity fingerprint. The
      // served manual publishes "The public tape never includes wallet
      // addresses", and the fingerprint is the discriminator this surface is
      // gated on. The id below is the ClawVille agent id, exactly what the
      // public tape emits for the same trader.
      subject: {
        type: candidate.clawvilleAgentId ? ('agent' as const) : ('avatar' as const),
        id: candidate.clawvilleAgentId ?? candidate.avatarId,
        avatarName: candidate.avatarName,
      },
      // Counts and rows come from `verified_trades` either way, so a stopped
      // slot still agrees with the public tape above it.
      counts: input.counts.get(candidate.avatarId) ?? { ...EMPTY_COUNTS },
      // The figure and the verified count must agree on how many rows exist.
      // Compared HERE, where both are in hand, so the alarm is code-read.
      realised: applyTruncationCheck(
        input.realisedByAvatar?.get(candidate.avatarId) ?? emptyRealised(),
        (input.counts.get(candidate.avatarId) ?? EMPTY_COUNTS).verified,
        entry.label,
      ),
      recentTrades: input.recentByAvatar.get(candidate.avatarId) ?? [],
    };
    // The LINK pubkey, not `wallet.pubkey`: the two agree for a live pairing
    // (condition 3 requires it) and only the link survives a revoked wallet, so
    // a stopped runner can still report against the slot it used.
    return { slot, walletPubkey: candidate.linkWalletPubkey };
  });
}

/** Seam so the route can be exercised with no database. */
export interface HouseTraderDeps {
  loadCandidates(): Promise<HouseTraderCandidate[]>;
  loadCounts(avatarIds: readonly string[]): Promise<Map<string, HouseTraderCounts>>;
  loadRecent(avatarIds: readonly string[], perAvatar: number): Promise<Map<string, PublicTradeDTO[]>>;
  /** FULL-history realised P&L. Aggregated in SQL with no LIMIT: see
   *  `HouseTraderRealised` for why a recent window is not acceptable here. */
  loadRealised(avatarIds: readonly string[]): Promise<Map<string, HouseTraderRealised>>;
  onDuplicate(objective: string, count: number): void;
}

/**
 * Every `clawpump_agent_links` row joined LEFT to its live wallet and its
 * owner's fingerprint. The join is LEFT on purpose: a link whose wallet is
 * revoked or missing still arrives and is refused by the predicate, so the
 * whole rule lives in one readable place instead of half in SQL.
 */
async function loadCandidatesFromDb(): Promise<HouseTraderCandidate[]> {
  const rows = await db
    .select({
      avatarId: clawpumpAgentLinks.avatarId,
      avatarName: avatars.name,
      objective: clawpumpAgentLinks.objective,
      clawpumpAgentId: clawpumpAgentLinks.clawpumpAgentId,
      clawvilleAgentId: clawpumpAgentLinks.clawvilleAgentId,
      linkWalletPubkey: clawpumpAgentLinks.walletPubkey,
      walletPubkey: tradingWallets.pubkey,
      walletSource: tradingWallets.source,
      ownerIdentityFingerprint: users.identityFingerprint,
      createdAt: clawpumpAgentLinks.createdAt,
    })
    .from(clawpumpAgentLinks)
    .innerJoin(avatars, eq(avatars.id, clawpumpAgentLinks.avatarId))
    .innerJoin(users, eq(users.id, clawpumpAgentLinks.userId))
    .leftJoin(
      tradingWallets,
      and(
        eq(tradingWallets.avatarId, clawpumpAgentLinks.avatarId),
        eq(tradingWallets.pubkey, clawpumpAgentLinks.walletPubkey),
        isNull(tradingWallets.revokedAt),
      ),
    );
  return rows.map((row) => ({
    avatarId: row.avatarId,
    avatarName: row.avatarName,
    objective: row.objective,
    clawpumpAgentId: row.clawpumpAgentId,
    clawvilleAgentId: row.clawvilleAgentId,
    linkWalletPubkey: row.linkWalletPubkey,
    wallet: row.walletPubkey && row.walletSource
      ? { pubkey: row.walletPubkey, source: row.walletSource }
      : null,
    ownerIdentityFingerprint: row.ownerIdentityFingerprint,
    createdAt: row.createdAt,
  }));
}

/** One grouped read: total, scored total and the newest verification time.
 *  Covered by `verified_trades_avatar_time_idx` on (avatar_id, verified_at). */
async function loadCountsFromDb(
  avatarIds: readonly string[],
): Promise<Map<string, HouseTraderCounts>> {
  const counts = new Map<string, HouseTraderCounts>();
  if (avatarIds.length === 0) return counts;
  const rows = await db
    .select({
      avatarId: verifiedTrades.avatarId,
      verified: sql<string>`count(*)`,
      scored: sql<string>`count(*) filter (where ${verifiedTrades.scored})`,
      // Formatted to ISO 8601 UTC IN SQL. A raw `sql` aggregate bypasses the
      // column mapper, so the driver hands back the Postgres TEXT form, not a
      // Date: `.toISOString()` on it threw on staging (500 on the first live
      // read, 2026-09-19; the dependency-seam tests never touch the driver).
      // Parsing that text form in JS is engine dependent, so Postgres does it.
      lastTradeAt: sql<string | null>`to_char(max(${verifiedTrades.verifiedAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(verifiedTrades)
    .where(inArray(verifiedTrades.avatarId, [...avatarIds]))
    .groupBy(verifiedTrades.avatarId);
  for (const row of rows) {
    if (!row.avatarId) continue;
    counts.set(row.avatarId, {
      verified: Number(row.verified) || 0,
      scored: Number(row.scored) || 0,
      lastTradeAt: row.lastTradeAt ?? null,
    });
  }
  return counts;
}

/**
 * FULL-history realised P&L, aggregated in SQL. TWO grouped reads, no LIMIT and
 * no pagination, so a long history cannot truncate the figure.
 *
 * RECONCILIATION (clawPump baseline, 2026-09-20 04:30Z): Genesis 20 closed /
 * -5.20 USD, ClawVille Runner 7 closed / +4.05 USD. Those are the numbers this
 * aggregation must reproduce on staging; team-lead verifies after the push.
 * The same data read through a 50-row recent window gave Genesis +8.87, which
 * is the exact bug this query exists to avoid: the window kept sell legs whose
 * buy legs had already scrolled off, turning cost basis into apparent profit.
 *
 * Every raw aggregate is cast to text and parsed here on purpose. A bare
 * `sql<number>` aggregate bypasses the column mapper and the driver returns the
 * Postgres TEXT form; that exact mistake 500'd this route on staging once
 * already (`loadCountsFromDb` carries the same note).
 */
async function loadRealisedFromDb(
  avatarIds: readonly string[],
): Promise<Map<string, HouseTraderRealised>> {
  const out = new Map<string, HouseTraderRealised>();
  if (avatarIds.length === 0) return out;
  const ids = [...avatarIds];
  // ROW LEVEL, not aggregated: FIFO lot matching needs each leg in time order,
  // and no GROUP BY can express "pair sells against earlier buys by quantity".
  // NO LIMIT, NO slice, and deliberately NOT the windowed `recentByAvatar` map
  // the panel's tape uses: that one is capped and would flip the sign.
  const rows = await db
    .select({
      avatarId: verifiedTrades.avatarId,
      signature: verifiedTrades.signature,
      inputMint: verifiedTrades.inputMint,
      outputMint: verifiedTrades.outputMint,
      // numeric(40,0) and numeric(20,6): TEXT on the wire, BigInt in JS.
      inputAmount: sql<string>`${verifiedTrades.inputAmount}::text`,
      outputAmount: sql<string>`${verifiedTrades.outputAmount}::text`,
      notionalUsd: sql<string | null>`${verifiedTrades.notionalUsd}::text`,
      // Chain time where we have it, else verification time. Seconds.
      atSec: sql<string>`(coalesce(${verifiedTrades.blockTime}, extract(epoch from ${verifiedTrades.verifiedAt})::bigint))::text`,
      preBind: sql<string>`(case when ${verifiedTrades.unscoredReason} = 'pre_bind' then 1 else 0 end)::text`,
    })
    .from(verifiedTrades)
    .where(inArray(verifiedTrades.avatarId, ids))
    // Deterministic total order. `slot` breaks a block-time tie, the signature
    // breaks a slot tie, so two runs can never pair lots differently.
    .orderBy(
      sql`coalesce(${verifiedTrades.blockTime}, extract(epoch from ${verifiedTrades.verifiedAt})::bigint) asc`,
      sql`${verifiedTrades.slot} asc`,
      sql`${verifiedTrades.signature} asc`,
    );

  const legsByAvatar = new Map<string, RealisedTradeLeg[]>();
  for (const row of rows) {
    if (!row.avatarId) continue;
    const bucket = legsByAvatar.get(row.avatarId) ?? [];
    bucket.push({
      signature: row.signature,
      inputMint: row.inputMint,
      outputMint: row.outputMint,
      inputAmount: row.inputAmount,
      outputAmount: row.outputAmount,
      notionalUsd: row.notionalUsd,
      // NO `|| 0`: an unparseable timestamp must reach the summariser as NaN so
      // it is EXCLUDED and counted, not dated to 1970 and written off as a
      // total loss. Failing toward a fabricated loss is the worse direction.
      atSec: Number(row.atSec),
      preBind: row.preBind === '1',
    });
    legsByAvatar.set(row.avatarId, bucket);
  }
  const computedAt = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const avatarId of ids) {
    out.set(
      avatarId,
      summariseRealised({
        legs: legsByAvatar.get(avatarId) ?? [],
        usdcMint: TRADE_MINTS.USDC,
        // The tape treats WSOL as a quote too, so a SOL-funded entry is
        // recognised and EXCLUDED rather than silently mispriced against a
        // USDC exit.
        quoteMints: [TRADE_MINTS.USDC, TRADE_MINTS.WSOL],
        nowSec,
        computedAt,
      }),
    );
  }
  return out;
}

export function createHouseTraderDeps(overrides: Partial<HouseTraderDeps> = {}): HouseTraderDeps {
  return {
    loadCandidates: loadCandidatesFromDb,
    loadCounts: loadCountsFromDb,
    loadRecent: listPublicVerifiedTradesForAvatars,
    loadRealised: loadRealisedFromDb,
    onDuplicate: (objective, count) => {
      // One page per objective per hour. A duplicate is a real operator fault
      // and it repeats on every request until someone fixes it, so an
      // unthrottled alert here would be a pager storm.
      if (!shouldAlertTradingLoop(`house-traders:duplicate:${objective}`)) return;
      void alertError({
        severity: 'warning',
        source: 'house-traders',
        message: `Two or more qualifying house-trader links share objective ${objective} (${count} rows). Showing the newest.`,
        context: { objective, count },
      });
    },
    ...overrides,
  };
}

/** Read the lineup slots. Always returns every `HOUSE_TRADER_LINEUP` entry (TWO today: Genesis, then ClawVille Runner; Dip Hunter was dropped 2026-09-19), in lineup order, whatever the data says. An unpaired slot reports its REAL status, never an invented one. */
export async function readHouseTraderSlots(
  deps: HouseTraderDeps = createHouseTraderDeps(),
  recentPerSlot = 5,
): Promise<HouseTraderSlot[]> {
  return (await readHouseTraderSlotBindings(deps, recentPerSlot)).map((binding) => binding.slot);
}

/** The same read, keeping each slot's bound wallet for the risk merge. */
export async function readHouseTraderSlotBindings(
  deps: HouseTraderDeps = createHouseTraderDeps(),
  recentPerSlot = 5,
): Promise<HouseTraderSlotBinding[]> {
  const chosen = await chooseLineupCandidates(deps);
  const avatarIds = [...chosen.values()].map((candidate) => candidate.avatarId);
  const [counts, recentByAvatar, realisedByAvatar] = await Promise.all([
    deps.loadCounts(avatarIds),
    deps.loadRecent(avatarIds, recentPerSlot),
    deps.loadRealised(avatarIds),
  ]);
  return buildHouseTraderSlotBindings({ chosen, counts, recentByAvatar, realisedByAvatar });
}

/**
 * The bound wallets of the CURRENT lineup slots, and nothing else.
 *
 * Used by the status feed to decide whether a report belongs to a trader we
 * publish. It runs the discriminator and the lineup filter, so a wallet from a
 * dropped objective, a custodial fleet link or a user-owned ClawPump wallet is
 * not in the set, and only `loadCandidates` is read: counts, recent trades and
 * the realised aggregation are full-history reads that an identity check has no
 * use for.
 */
export async function readHouseTraderWallets(
  deps: HouseTraderDeps = createHouseTraderDeps(),
): Promise<Set<string>> {
  const chosen = await chooseLineupCandidates(deps);
  return new Set([...chosen.values()].map((candidate) => candidate.linkWalletPubkey));
}

async function chooseLineupCandidates(
  deps: HouseTraderDeps,
): Promise<Map<string, HouseTraderCandidate>> {
  const lineup = new Set<string>(HOUSE_TRADER_LINEUP.map((entry) => entry.objective));
  // Narrowed to the lineup BEFORE selection, so a duplicate on an objective the
  // surface does not publish cannot page anyone about a slot nobody can see.
  const candidates = (await deps.loadCandidates()).filter((row) => lineup.has(row.objective));
  return selectHouseTraders(candidates, deps.onDuplicate);
}
