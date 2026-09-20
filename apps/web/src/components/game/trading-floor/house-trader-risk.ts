/**
 * house-trader-risk.ts
 *
 * WHY A HOUSE TRADER IS NOT OPENING POSITIONS, as the route states it.
 *
 * Founder decision, 2026-09-20: the public board and the Exchange panel must
 * both say "Paused by risk limit" when a house trader is blocked by one. The
 * `risk` block on `GET /api/floor/house-traders` is the ONLY source for that.
 * A pause is NEVER inferred from trade silence: a desk with no setup is silent
 * too, and Genesis sat cap-blocked for seven hours with `halted` reading false
 * while nothing on any surface said so. Silence is not evidence.
 *
 * PURE ON PURPOSE. No React, no three, no react-query, no fetch; the one import
 * is the shared wire contract, which both bundles already carry. Both public
 * surfaces import it, the panel (`house-traders.tsx`) and the 3D board's data
 * layer (`lib/three/trading-floor/trading-floor-screen-data.ts`), so the
 * precedence rule below exists ONCE. A duplicated three-line precedence is
 * exactly how the two surfaces would start disagreeing about the same desk, and
 * this file's dependency-free shape is what lets the 3D bundle import it
 * without dragging react-query and the Solana wallet adapter in behind it.
 */

import {
  HOUSE_TRADER_STATUS_DETAIL_MAX,
  HOUSE_TRADER_STATUS_REASONS,
  type HouseTraderRisk,
  type HouseTraderRiskState,
  type HouseTraderStatusReason,
} from '@clawville/shared';

export type { HouseTraderRiskState };

/** The pairing state of a slot, owned here so the risk precedence and the slot
 *  view cannot spell it differently. Mirrored by `HouseTraderSlotView.status`. */
export type HouseTraderPairingStatus =
  | 'live-observed'
  | 'stopped'
  | 'not-yet-running';

/**
 * THE VALIDATED BLOCK IS THE WIRE TYPE, not a re-declaration of it.
 *
 * The three surfaces and the enum could each have carried their own copy of
 * this shape; one aliased type is what makes a server-side field add a COMPILE
 * ERROR here rather than a field the client quietly never learned about. The
 * states are documented on `HouseTraderRiskState` in
 * `packages/shared/src/constants/house-trader-status.ts`: in short, `paused`
 * means a risk limit was evaluated AND hit, `fault` means it could not be
 * evaluated at all, and merging the two would be the same unearned claim as
 * reporting an unreadable P&L as a flat result.
 *
 * The three money fields are MAGNITUDES, never signed: they compose the
 * sentence "Day loss A + next position B is over the cap C", which reads
 * backwards the moment one of them is negative.
 */
export type HouseTraderRiskView = HouseTraderRisk;
export type HouseTraderRiskReason = HouseTraderStatusReason;

/**
 * A RECORD, not a Set, and the type annotation is the point: `HouseTraderRisk`
 * comes from the shared contract, so a state added there without a decision
 * here would otherwise be validated away in silence. A missing key is a compile
 * error, which is the only form of "remember to update this" that works.
 */
const RISK_STATE_KEYS: Record<HouseTraderRiskState, true> = {
  paused: true,
  live: true,
  fault: true,
};

function isRiskState(value: unknown): value is HouseTraderRiskState {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(RISK_STATE_KEYS, value)
  );
}

const RISK_REASONS = new Set<string>(HOUSE_TRADER_STATUS_REASONS);

/**
 * Invisible characters, as CODE-POINT RANGES rather than a regex literal.
 *
 * The class has to cover U+2028, and a raw U+2028 inside a regex literal ENDS
 * THE LINE and makes the file a syntax error. An escape in source survives only
 * until something normalises the file, which happened once while this very
 * constant was being written, so the ranges are data and the matching is a loop.
 *
 * `detail` is free operator prose rendered verbatim in a public panel. The
 * server sanitises and caps it too, and this pass is deliberately a SECOND one:
 * the client cannot verify that the server did it, React escapes markup but not
 * a right-to-left override re-ordering the sentence around it, and a 4 kB
 * string would push the card off the screen.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x0300, 0x036f], // combining marks
  [0x200b, 0x200f], // zero-width characters and directional marks
  [0x2028, 0x202e], // line/paragraph separators and the bidi overrides
  [0x2060, 0x206f], // word joiner and the invisible operators
  [0xfeff, 0xfeff], // byte-order mark
];

function stripInvisible(raw: string): string {
  let out = '';
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    let blocked = false;
    for (const [low, high] of INVISIBLE_RANGES) {
      if (code >= low && code <= high) {
        blocked = true;
        break;
      }
    }
    if (!blocked) out += character;
  }
  return out;
}

/**
 * `detail` CAN NEVER NULL THE BLOCK. Every unusable input lands on `null` and
 * the pause keeps its pill.
 *
 * That is the whole rule, and it is a correction: an earlier revision rejected
 * the block for a non-string `detail`. tfs-audit called it, and the reason is
 * worth keeping. A content guard on an optional elaboration has one failure
 * direction far worse than the thing it guards against: dislike the prose and a
 * REAL pause vanishes from a public money board, which then reads as if nothing
 * were wrong. An unshowable sentence costs a sentence.
 *
 * NO CONTENT INSPECTION either: no address check, no case folding, no judgement
 * about what the text says. The API strips addresses at ingest, which is the one
 * choke point both surfaces share; a second opinion here could only disagree
 * with it. What is left is not inspection but bounding: drop characters that
 * are invisible (a bidi override re-orders the sentence around it and React
 * does not stop that) and refuse a length the contract says cannot occur.
 */
function readDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = stripInvisible(value).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  // The SERVER's own cap, read from the contract rather than re-typed. Over it
  // is a payload that is not the contract, so the sentence is dropped rather
  // than truncated: a cut-off sentence reads as a complete one that says less.
  return text.length > HOUSE_TRADER_STATUS_DETAIL_MAX ? null : text;
}

/**
 * The wire block, validated. `null` means WE COULD NOT READ IT, which the
 * surfaces render as today's card: never as a pause and never as a fault.
 *
 * ADDITIVE AND NULL-SAFE: the route on staging does not carry `risk` yet, so
 * an absent block must change nothing at all. That is pinned by a test that
 * compares the board's signature and its whole draw with and without the field.
 *
 * THE TEST FOR NULLING THE BLOCK is "would we be reporting something that is
 * not a report the server produced", NOT "is every figure one we like". Getting
 * that backwards hides pauses, which is the failure this feature exists to end.
 *
 *   `state`      must name one of the three. There is no safe default: `live`
 *                would claim a paused desk is trading and `paused` would accuse
 *                a running one. NULLS THE BLOCK.
 *   `ageSeconds` must be a non-negative safe integer. The SERVER computes it as
 *                a count of seconds since it received the report, so a value
 *                that cannot be one means this is not that server's block.
 *                NULLS THE BLOCK.
 *   `at`         must be a non-empty string. A verdict with no time of issue
 *                has no provenance. NULLS THE BLOCK.
 *
 *   the three    must be FINITE, and SIGNED IS LEGAL: a desk can be up on the
 *   USD figures  day and still be blocked by something that is not its loss
 *                floor, so a negative `dayLossUsd` is a real reading, not a
 *                broken one. Implausible COMBINATIONS never null the block
 *                either; they suppress the arithmetic sentence instead, which
 *                is what `formatRiskArithmetic` is for. A pause we can name but
 *                cannot do arithmetic about is still a pause worth showing.
 *   `detail`     degrades to null, always. See `readDetail`.
 *   `reason`     folds to `other` when unrecognised. A code shipped after this
 *                build is a vocabulary extension, not a broken payload, and
 *                dropping the block over one would show LIVE for a desk that
 *                cannot trade. Nothing renders the code, so the fold costs only
 *                signature granularity between two states that paint the same
 *                pixels. (tfs-audit made this argument independently while
 *                assuming the opposite behaviour was in here.)
 *
 *                ONE TRAP IN THAT FOLD: it can produce `{state:'paused',
 *                reason:'other'}`, a pair THE SERVER CAN NEVER EMIT, because
 *                server-side `other` classifies as `fault`. Do NOT "repair"
 *                that by branching `reason === 'other'` into a fault: the
 *                state is the server's classification of a real block and the
 *                reason is only our failure to recognise its code, so trusting
 *                the state is right. It is also the safe direction, since
 *                `other` is not `daily_loss_floor` and therefore never carries
 *                the cap sentence.
 */
export function normaliseHouseTraderRisk(value: unknown): HouseTraderRiskView | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;

  if (!isRiskState(row.state)) return null;
  const state = row.state;

  // MONEY: finite, and that is the whole test. See the header for why signed is
  // legal and why an implausible figure does not null a pause.
  for (const key of ['dayLossUsd', 'dayLossCapUsd', 'roomNeededUsd'] as const) {
    const candidate = row[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return null;
  }
  // AGE: a count, so `isSafeInteger` rather than `isFinite`. Past 2^53-1 a JSON
  // integer has already lost precision in transit, so it is not the number the
  // server sent.
  if (
    typeof row.ageSeconds !== 'number' ||
    !Number.isSafeInteger(row.ageSeconds) ||
    row.ageSeconds < 0
  ) {
    return null;
  }

  if (typeof row.at !== 'string' || row.at.length === 0) return null;

  const reason: HouseTraderRiskReason =
    typeof row.reason === 'string' && RISK_REASONS.has(row.reason)
      ? (row.reason as HouseTraderRiskReason)
      : 'other';

  return {
    state,
    reason,
    detail: readDetail(row.detail),
    dayLossUsd: row.dayLossUsd as number,
    dayLossCapUsd: row.dayLossCapUsd as number,
    roomNeededUsd: row.roomNeededUsd as number,
    at: row.at,
    ageSeconds: row.ageSeconds as number,
  };
}

/**
 * What the two public surfaces say about a slot's risk, or `null` for "nothing
 * new to say": which is today's card, unchanged.
 *
 * PAIRING FIRST, deliberately. A stopped or unpaired desk already cannot open a
 * position, and the card already states why in its own words. Painting "paused
 * by risk limit" over that would swap a true statement about the pairing for a
 * narrower one about a limit that is not the reason it is idle. So a risk
 * verdict only speaks for a desk that is otherwise LIVE.
 */
export function resolveHouseTraderRiskDisplay(
  pairing: HouseTraderPairingStatus,
  risk: HouseTraderRiskView | null | undefined,
): 'paused' | 'fault' | null {
  if (pairing !== 'live-observed') return null;
  if (!risk || risk.state === 'live') return null;
  return risk.state;
}

/**
 * The arithmetic, in the HONEST form, or `null` when the figures do not support
 * the claim.
 *
 * TWO honesty rules, and they pull in opposite directions.
 *
 * FIRST, state all three figures. "Day loss 9.99 against a cap of 20.00" reads
 * as a desk with room to spare; what actually blocks it is the NEXT position
 * not fitting under that cap. Only the three-figure sentence lets the reader
 * reach the conclusion from what is on screen.
 *
 * SECOND, do not make the claim unless it is true in BOTH senses, and the two
 * gates below are not the same gate. `paused` covers four reasons and only ONE
 * of them is about the cap.
 *
 *   THE REASON GATE. `halted`, `insufficient_usdc` and `gas_reserve` block the
 *   desk for causes that are not its loss floor: an operator, the USDC balance,
 *   the SOL reserve. For those, cap arithmetic can be perfectly TRUE and still
 *   assert a false CAUSE. "Day loss 20.00 + next position 10.00 is over the
 *   cap 25.00" beside a desk that is actually halted by hand tells the reader
 *   the wrong thing about a real trader. An arithmetic gate alone does not
 *   catch that, because the arithmetic holds.
 *
 *   THE FIGURES GATE. Even on `daily_loss_floor`, the words "is over the cap"
 *   are arithmetic the reader can check against the three numbers printed
 *   beside them, so a body where `dayLoss + roomNeeded <= cap` must not carry
 *   the sentence. Exactly equal is NOT over. The server's schema has no
 *   cross-field refine tying the figures to the reason, so a runner CAN post a
 *   contradictory body and this is what stops it reaching the wall.
 *
 * Both, therefore, and in that order. The caller still shows the pill and the
 * route's detail line in every case: only the sentence goes, and the two facts
 * that survive are both still true. (tfs-audit trap 9 and its P1; the reason
 * half was the half an inequality-only gate missed.)
 *
 * Every number comes from the route and is finite by the guard above; this
 * formats and never derives. Two decimals because these are money figures, and
 * no currency mark because the three share one unit the surrounding copy
 * already establishes.
 */
export function formatRiskArithmetic(risk: HouseTraderRiskView): string | null {
  if (risk.reason !== 'daily_loss_floor') return null;
  if (risk.dayLossUsd + risk.roomNeededUsd <= risk.dayLossCapUsd) return null;
  return (
    `Day loss ${risk.dayLossUsd.toFixed(2)}` +
    ` + next position ${risk.roomNeededUsd.toFixed(2)}` +
    ` is over the cap ${risk.dayLossCapUsd.toFixed(2)}`
  );
}
