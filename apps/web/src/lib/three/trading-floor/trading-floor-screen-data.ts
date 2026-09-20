/**
 * trading-floor-screen-data.ts
 *
 * Turns the LIVE `GET /api/floor/house-traders` payload the Exchange panel
 * already consumes into the small, drawable shape the big board needs.
 *
 * Kept apart from `trading-floor-screen-texture.ts` so the drawing code stays
 * free of app types, and apart from the React component so both halves are
 * unit-testable. The only value imports are the `TRADE_MINTS` constant table
 * and the dependency-free `house-trader-risk` helpers; every app-shaped import
 * is an `import type`, so nothing from the hooks module (react-query, the
 * Solana wallet adapter) reaches the runtime bundle through this file. Keep it
 * that way: this module is pulled into the 3D scene chunk.
 *
 * WHAT IS DELIBERATELY NOT CARRIED ACROSS:
 *   - `strategyNote`. It is free server text on a public wall in the game
 *     world; the board has no room for a paragraph and no way to vouch for its
 *     wording. The Exchange panel renders it, which is the surface that should.
 *   - `subject.id` and `trade.wallet`. Identifiers never go on the board.
 *   - `notionalUsd`. The board shows realised P&L from the route's typed
 *     block; per-trade notional is not a figure it publishes.
 *   - Any mint address. The tape names only the two mints ClawVille lists and
 *     otherwise prints the venue, because the panel's `shortMint` fallback puts
 *     an 11-character chain identifier on the wall.
 */

import { TRADE_MINTS } from '@clawville/shared';

import { resolveHouseTraderRiskDisplay } from '@/components/game/trading-floor/house-trader-risk';
import type { FloorTrade } from '@/stores/trade-ticker';
import type { HouseTraderSlotView } from '@/hooks/use-trading-floor';
import { formatSignedUsd } from './trading-floor-screen-texture';
import type {
  FloorScreenData,
  FloorScreenRealisedState,
  FloorScreenSlot,
} from './trading-floor-screen-texture';

/** Newest N trades per slot that the REDRAW SIGNATURE considers. Wider than
 *  the tape's own 12 so the tape's newest 12 across all slots are always
 *  inside any one slot's slice. Named for the signature now that the sparkline
 *  it was originally sized for is gone. */
const TRADE_SLICE_LIMIT = 14;

/** Newest N trades on the bottom tape, across every slot. The row truncates at
 *  95 characters anyway; this only bounds the work. */
const TAPE_LIMIT = 12;

function ageLabel(iso: string | null, nowMs: number): string {
  if (!iso) return 'no trades yet';
  const atMs = Date.parse(iso);
  // BOTH ends, and the trade end is the reachable one. A bad `nowMs` yields
  // "NaNd ago"; a FUTURE `atMs` clamps to zero and yields "now", which claims a
  // trade that did not happen. See `isDatableTradeTime`.
  if (!isUsableClock(nowMs) || !isDatableTradeTime(atMs, nowMs)) {
    return 'time unavailable';
  }
  const ageMs = Math.max(0, nowMs - atMs);
  if (ageMs < 60_000) return 'now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

/**
 * The only times this board will reason about: after the epoch and before 2100.
 *
 * Deliberately PLAUSIBILITY, not representability. The ECMAScript max time
 * value (8.64e15) only stops `toISOString` from throwing and leaves two silent
 * wrongs behind it: the expanded `±YYYYYY` year form, whose extra three
 * characters shift `slice(11, 16)` to "13T00", and age arithmetic that reports
 * "99979284d ago" with a straight face. Neither is an error anywhere. Both
 * would be painted on a wall in the game world.
 *
 * It bounds the TRADE timestamps too, not just the clock, and that end is the
 * reachable one: `lastTradeAt` and `blockTime` come from the API, and
 * `Date.parse('+275760-09-13T00:00:00.000Z')` is finite. A future timestamp
 * clamps to zero age through `Math.max(0, …)`, so before this bound a trade
 * dated year 275760 rendered as **"now"** — the board asserting a house trader
 * had just traded. That is the exact class of unearned claim `house-trader-
 * lineup.ts` forbids, arrived at through arithmetic instead of wording.
 */
const MAX_PLAUSIBLE_TIME_MS = 4102444800000; // 2100-01-01T00:00:00.000Z, exclusive

function isPlausibleTime(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms < MAX_PLAUSIBLE_TIME_MS;
}

/**
 * ONE definition of "the clock is usable", read by the header clock and by both
 * age formatters.
 *
 * It exists because the three of them fail differently on the same bad input
 * and only one of those failures is loud: an unusable `nowMs` makes
 * `toISOString` throw, but it makes the age arithmetic produce `NaN`, and
 * `${Math.floor(NaN / 86_400_000)}d ago` is the string "NaNd ago" — which is
 * not an error anywhere, it is just painted on the wall. Three call sites, one
 * predicate, so a future fourth cannot quietly opt out.
 */
function isUsableClock(nowMs: number): boolean {
  return isPlausibleTime(nowMs);
}

/** Clock skew we will forgive on a trade timestamp. Chain time and our clock
 *  disagree by SECONDS, so 60 s is already generous; the bound is RELATIVE to
 *  the clock, which is the only way a plausible-looking 2099 is caught. */
const FUTURE_SKEW_MS = 60_000;

/**
 * A trade time we will DATE. Plausible, and not in the future.
 *
 * The future half is Codex round 3, and the plausibility bound did not cover
 * it: `2099-01-01` is inside 1970..2100, so it passed, and then
 * `Math.max(0, nowMs - atMs)` clamped the negative age to zero and the card
 * said **"now"**. Same defect as the year-275760 case and reachable the same
 * way — `lastTradeAt` and `blockTime` are server-supplied — but this one
 * survived the fix for that case, because it is implausible only RELATIVE to
 * the clock. A board claiming a house trader just traded is the unearned claim
 * `house-trader-lineup.ts` forbids, reached through arithmetic again.
 */
function isDatableTradeTime(atMs: number, nowMs: number): boolean {
  return isPlausibleTime(atMs) && atMs <= nowMs + FUTURE_SKEW_MS;
}
/** Length of the ordinary `YYYY-MM-DDTHH:mm:ss.sssZ` form. The expanded
 *  `±YYYYYY` year form is 27 and every index after the year moves. */
const ISO_LENGTH = 24;

/**
 * Header clock, UTC and minute-resolution.
 *
 * `toISOString` rather than `toLocaleTimeString`: the board is redrawn from the
 * scene's 30 s tick, so the reading is already minute-grained, and a locale
 * format would vary by machine — including between a test runner and a browser.
 */
export function floorClockLabel(nowMs: number): string {
  // `isUsableClock` already bounds this to 1970-2100, so the length check
  // below cannot fire today. It stays as an ASSERTION of that bound rather than
  // a second gate: the `slice(11, 16)` offsets are only correct for the
  // ordinary 24-character form, and if anyone ever widens the bound to the
  // looser ECMAScript max, `toISOString` returns the 27-character expanded
  // `±YYYYYY` form and this slice yields "13T00" — a string that reads as a
  // time and would be painted on a wall in the game world. One comparison buys
  // immunity from that.
  if (!isUsableClock(nowMs)) return 'CLOCK OFFLINE';
  const iso = new Date(nowMs).toISOString();
  return iso.length === ISO_LENGTH ? `${iso.slice(11, 16)} UTC` : 'CLOCK OFFLINE';
}

/** The two quote legs. A swap is memecoin-against-one-of-these, so the OTHER
 *  leg is the token the desk actually traded. */
const QUOTE_MINTS = new Set<string>([TRADE_MINTS.USDC, TRADE_MINTS.WSOL]);

/**
 * The only mints the tape may NAME.
 *
 * Deliberately not `symbolForMint` from the panel's `format.ts`: that one
 * prefixes "$" and falls back to `shortMint`, i.e. a truncated base58 mint. A
 * "$" is stripped by the draw-site sanitiser, but an 11-character mint fragment
 * is short enough to survive the address pass and would put raw chain
 * identifiers on a wall in the game world. USDC and SOL are omitted on purpose:
 * they are currency names, and the board prints no currency.
 */
const TAPE_SYMBOLS: Readonly<Record<string, string>> = {
  [TRADE_MINTS.ANSEM]: 'ANSEM',
  [TRADE_MINTS.CLAWVILLE]: 'CLAWVILLE',
};

const VENUE_LABEL: Readonly<Record<FloorTrade['dex'], string>> = {
  jupiter: 'JUPITER',
  pumpswap: 'PUMPSWAP',
  pumpfun: 'PUMP.FUN',
};

/** Tape-width age: "NOW", "4M", "2H", "3D". The cards carry the long form. */
function shortAge(atMs: number | null, nowMs: number): string {
  // THE RULE, because the asymmetry looks like an inconsistency and someone
  // will otherwise "fix" it: RECENT = we never had a time and the list vouches.
  // TIME UNKNOWN = we had inputs and could not produce a trustworthy reading.
  // The two cases differ in what we ATTEMPTED, not in what we know. Falling
  // back to RECENT after a failed reading would present a substitute for a
  // reading we could not make, which is a different act from stating the only
  // thing we ever knew.
  //
  // The rendering settles it on its own: on the tape this word sits in the same
  // column as "4M", "2H", "3D", so RECENT reads there as a time bucket meaning
  // "moments ago", not as a statement about provenance. Under a broken clock
  // that is exactly the unearned-recency claim the card already refuses.
  // TIME UNKNOWN cannot be misread that way. (tf3d-audit ruling, 2026-09-19.)
  if (atMs === null) return 'RECENT';
  if (!isUsableClock(nowMs) || !isDatableTradeTime(atMs, nowMs)) return 'TIME UNKNOWN';
  const ageMs = Math.max(0, nowMs - atMs);
  if (ageMs < 60_000) return 'NOW';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}M`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}H`;
  return `${Math.floor(ageMs / 86_400_000)}D`;
}

/**
 * One tape entry: the token (only when ClawVille lists it), the venue, the age.
 *
 * No size, no price, no signature, no wallet, no mint. The venue is a fixed
 * three-value enum from the verifier, not free server text, so it cannot carry
 * a surprise onto the wall — and the draw site sanitises it regardless.
 */
/**
 * The realised block, read defensively.
 *
 * The route may not carry it yet, a slot may have closed nothing, and a number
 * that arrives as a string or a NaN must not reach the board — the drawing
 * formats whatever it is given, so the type guard IS the correctness boundary.
 * All-or-nothing on purpose: a half-populated card would invite the reader to
 * compare a real figure against a default.
 */
function readRealised(slot: HouseTraderSlotView): FloorScreenRealisedState {
  const source = (slot as { realised?: unknown }).realised;
  if (!source || typeof source !== 'object') return UNAVAILABLE;
  const row = source as Record<string, unknown>;
  const num = (key: string): number | null => {
    const raw = row[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  };
  const closedPositions = num('closedPositions');
  const wins = num('wins');
  const losses = num('losses');
  const realisedUsd = num('realisedUsd');
  const openPositions = num('openPositions');
  // A field that is not a finite number means we could not READ this block.
  // That is a statement about our read, so it is UNAVAILABLE, never "nothing
  // closed" — which would be a false claim about the trader.
  if (
    closedPositions === null ||
    wins === null ||
    losses === null ||
    realisedUsd === null ||
    openPositions === null
  ) {
    return UNAVAILABLE;
  }
  // A VALID block reporting nothing closed. The route's own empty view sends
  // exactly this (`closedPositions: 0`, `realisedUsd: 0`), so this is the
  // normal path for a freshly paired desk and a real fact about it.
  if (closedPositions <= 0) return NONE;
  return {
    kind: 'ready',
    closedPositions,
    wins,
    losses,
    realisedUsd,
    // NULLABLE on the wire and nullable here. `num()` already returns null for
    // a non-number, which is the same answer the route means by null.
    bestUsd: num('bestUsd'),
    worstUsd: num('worstUsd'),
    openPositions,
    // The CODES are what the board composes its disclosure from; the prose is
    // only the fallback for a code the board does not recognise. Read as
    // strings with no default: an absent code must FALL BACK visibly rather
    // than be replaced by a guess about how the figure was computed.
    basisCode: typeof row.basis === 'string' ? row.basis : '',
    costBasis: typeof row.costBasis === 'string' ? row.costBasis : '',
    noExitHours: num('noExitHours') ?? Number.NaN,
    note:
      typeof row.note === 'string' && row.note.trim().length > 0
        ? row.note
        : DEFAULT_NOTE,
    // THREE causes now, all meaning "the headline does not cover every fill":
    // a USDC-side swap we could not value, a swap with USDC on neither side,
    // and a position skipped for a non-USDC quote leg (funded in SOL, exited
    // in USDC). `excludedNonUsdc` became a real field on the route, so it is
    // read directly rather than inferred from `unclassifiedLegs` as it was
    // when the board had to guess at the shape.
    // The SERVER's flag first. It knows things the counters cannot show: it is
    // also set when `computedOverTrades` disagrees with `counts.verified`,
    // i.e. the figure came from a truncated read — the exact failure that once
    // flipped Genesis from -5.20 to +8.87 USD, and one with every counter at
    // zero. `=== true` rather than truthy: a stringy "false" must not flip it.
    //
    // The derived condition stays as a FALLBACK for a payload from before the
    // flag existed. OR, never AND: either source saying "incomplete" is
    // enough, because the caption's job is to under-claim.
    partial:
      row.partial === true ||
      (num('unpricedLegs') ?? 0) > 0 ||
      (num('unclassifiedLegs') ?? 0) > 0 ||
      (num('excludedNonUsdc') ?? 0) > 0,
    excludedNonUsdc: num('excludedNonUsdc') ?? 0,
    // Rug write-offs. Drawn on its own line: a total loss booked by a TIMER
    // rather than by a sell is the least guessable part of the method.
    noExitClosures: num('noExitClosures') ?? 0,
  };
}

/** Used when the route omits `note`. The board must never show a money figure
 *  with no stated basis, so this is a floor, not a preference. */
const DEFAULT_NOTE = 'Gross realised on the USDC leg; excludes network fees and rent';

/** Frozen singletons: these two states carry no data, and sharing one object
 *  each keeps `buildFloorScreenData` allocation-free on the common paths. */
const UNAVAILABLE: FloorScreenRealisedState = Object.freeze({ kind: 'unavailable' });
const NONE: FloorScreenRealisedState = Object.freeze({ kind: 'none' });

/**
 * EVERYTHING `tapeEntry` reads off a trade. ONE list, consumed by the entry
 * that draws it and by the signature that decides when to redraw it.
 *
 * Codex round 5 found the same defect as round 4 one level down: the per-trade
 * part of the signature was hand-enumerated, so when the tape grew a
 * `realisedUsd` figure the trigger did not, and a trade whose only change was
 * its realised amount repainted nothing until the 30 s tick. Enumerating twice
 * is the defect; this projection is the fix, and the round-4 comment above
 * says so about the block above. `nowMs` is deliberately NOT here — the age
 * is refreshed by the clock tick, not by the data signature.
 */
function tapeInputs(trade: FloorTrade) {
  const perTrade = (trade as { realisedUsd?: unknown }).realisedUsd;
  return {
    inputMint: trade.inputMint,
    outputMint: trade.outputMint,
    dex: trade.dex,
    blockTime: trade.blockTime,
    // Normalised to null so an absent field and a non-number read alike, which
    // is how `tapeEntry` treats them.
    realisedUsd:
      typeof perTrade === 'number' && Number.isFinite(perTrade) ? perTrade : null,
  };
}

function tapeEntry(trade: FloorTrade, nowMs: number): string {
  const input = tapeInputs(trade);
  const traded = QUOTE_MINTS.has(input.outputMint)
    ? input.inputMint
    : input.outputMint;
  const symbol = TAPE_SYMBOLS[traded];
  const venue = VENUE_LABEL[input.dex] ?? 'ON CHAIN';
  const age = shortAge(
    input.blockTime === null ? null : input.blockTime * 1000,
    nowMs,
  );
  // Per-trade realised USD when the row carries it, from the TYPED field only.
  // `realisedUsd` is a closed-position figure, so most tape rows will not have
  // one and the entry simply omits it rather than printing a zero.
  const money =
    input.realisedUsd === null ? '' : ` ${formatSignedUsd(input.realisedUsd)}`;
  return symbol
    ? `${symbol} ${venue} ${age}${money}`
    : `${venue} ${age}${money}`;
}

function buildTape(
  slots: readonly HouseTraderSlotView[],
  nowMs: number,
): string[] {
  return slots
    // `flatMap` already returns a fresh array, so the sort below never touches
    // the query's cached rows.
    .flatMap((slot) => slot.recentTrades)
    // Newest first. `blockTime` is nullable, and an unknown time sorts last
    // rather than being dropped: the trade happened, it is just undated.
    .sort((a, b) => (b.blockTime ?? -1) - (a.blockTime ?? -1))
    .slice(0, TAPE_LIMIT)
    .map((trade) => tapeEntry(trade, nowMs));
}

export function buildFloorScreenData(
  slots: readonly HouseTraderSlotView[] | undefined,
  state: { isLoading: boolean; isError: boolean },
  nowMs: number,
): FloorScreenData {
  const clockLabel = floorClockLabel(nowMs);
  if (state.isError) {
    return { phase: 'error', slots: [], clockLabel, tape: [] };
  }
  if (state.isLoading || slots === undefined) {
    return { phase: 'connecting', slots: [], clockLabel, tape: [] };
  }

  const drawn: FloorScreenSlot[] = slots.map((slot) => ({
    label: slot.slotName,
    // The RISK VERDICT wins over `live`, and over nothing else. A stopped or
    // unpaired desk already states why it is idle, so the shared resolver
    // returns null for it and the pairing word stands. The resolver is the SAME
    // function the Exchange panel calls, so the wall and the panel cannot
    // disagree about one desk, and it never re-derives `state` — the server is
    // the only classifier; this only chooses which of two true facts the one
    // status row shows. With no readable block the board is pixel-for-pixel the
    // one that shipped before the field existed.
    status:
      readRiskForBoard(slot).display ??
      (slot.status === 'live-observed'
        ? 'live'
        : slot.status === 'stopped'
          ? 'stopped'
          : 'waiting'),
    verified: slot.counts.verified,
    scored: slot.counts.scored,
    lastTradeLabel: ageLabel(slot.counts.lastTradeAt, nowMs),
    // `recentTrades` arrives newest-first; the bars read oldest-to-newest.
    realised: readRealised(slot),
  }));

  return { phase: 'ready', slots: drawn, clockLabel, tape: buildTape(slots, nowMs) };
}

/**
 * EVERYTHING the board takes from the risk block. ONE projection, consumed by
 * the draw and by the redraw trigger.
 *
 * DERIVED, NOT ENUMERATED, for the same reason `readRealised` is: two places
 * listing "the risk fields we draw" is exactly how the realised block came to
 * repaint late in Codex round 4 and the tape in round 5. The signature below
 * stringifies this, so a field the board starts drawing cannot be one the
 * trigger forgot.
 *
 * WHAT IS DELIBERATELY NOT IN IT, and this is the load-bearing part:
 *
 *   `ageSeconds` — it counts UP on every poll. Stringifying the whole wire
 *     block would therefore change the signature every 15 s forever, and each
 *     change is a full canvas redraw plus a 1.28 MB texture upload (5.13 MB on
 *     the 2x backing store). That is a per-poll cost on the Iris Xe floor in
 *     exchange for pixels that are identical. `nowMs` is left out of the
 *     signature for precisely this reason and the clock tick handles ageing.
 *   `at`, `detail`, and the three USD figures — the BOARD does not draw them.
 *     The Exchange panel does, and the panel re-renders from react-query
 *     without a texture upload, so it needs no trigger.
 *
 * `reason` IS in it although nothing draws it: the brief asks for it, a desk
 * moving from one blocking cause to another is a real event on a public
 * surface, and unlike `ageSeconds` it only moves on a genuine transition.
 */
function readRiskForBoard(slot: HouseTraderSlotView): {
  display: 'paused' | 'fault' | null;
  reason: string | null;
} {
  const risk = slot.risk ?? null;
  return {
    display: resolveHouseTraderRiskDisplay(slot.status, risk),
    reason: risk ? risk.reason : null,
  };
}

/**
 * A stable string that changes exactly when something the board DRAWS changes.
 *
 * This is the redraw trigger, so it must not include anything the board does
 * not show — `lastTradeAt` is in it because the age label is derived from it,
 * but the wall-clock age is refreshed by the scene's 30 s tick instead, which
 * is why `nowMs` is not part of the signature.
 */
export function floorScreenSignature(
  slots: readonly HouseTraderSlotView[] | undefined,
  state: { isLoading: boolean; isError: boolean },
): string {
  if (state.isError) return 'error';
  if (state.isLoading || slots === undefined) return 'connecting';
  return slots
    .map(
      (slot) =>
        `${slot.objective}|${slot.slotName}|${slot.status}|${slot.counts.verified}|` +
        `${slot.counts.scored}|${slot.counts.lastTradeAt ?? '-'}|` +
        // The WHOLE realised projection, taken from `readRealised` rather than
        // hand-listed here.
        //
        // Codex round 4 found this omitted entirely: the board grew a P&L block
        // and the redraw trigger was never extended, so a refreshed response
        // that flipped `partial`, moved the headline or lost availability did
        // not repaint until the 30 s clock tick. A money board showing a stale
        // figure for half a minute while holding fresh data is the quiet kind
        // of wrong this surface exists to avoid.
        //
        // DERIVED, not enumerated, because enumerating is what failed: two
        // places listing "the fields we draw" is exactly how they drifted. The
        // signature now cannot omit a field the drawing shows, including one
        // added later, and `JSON.stringify` over a literal with fixed key order
        // is stable for this purpose.
        `${JSON.stringify(readRealised(slot))}|` +
        // The risk verdict, which changes the STATUS WORD and so must repaint
        // within one poll. Taken from `readRiskForBoard` rather than hand-listed
        // here, so the trigger cannot omit something the draw shows; read that
        // function for what it deliberately leaves out and why (`ageSeconds`
        // ticks, and stringifying it would repaint the board every poll).
        `${JSON.stringify(readRiskForBoard(slot))}|` +
        // Per trade: the sparkline bar height, the trade's identity, and the
        // WHOLE tape projection from `tapeInputs` — derived, not enumerated,
        // for the same reason as the realised block above. The 14-wide slice
        // covers the 12-wide tape because the tape's newest 12 across all
        // slots are inside any one slot's newest 14.
        slot.recentTrades
          .slice(0, TRADE_SLICE_LIMIT)
          .map(
            (trade) =>
              `${trade.multiplier}:${trade.signature}:${JSON.stringify(tapeInputs(trade))}`,
          )
          .join(','),
    )
    .join(';');
}
