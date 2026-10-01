/**
 * trading-floor-trade-tape.ts
 *
 * The arena's recent entries and exits as PHYSICAL objects in the hall — the
 * pure half. No `three`, no React, no DOM beyond a 2D context the caller hands
 * in, so every rule below (which trade, which lane, which colour, where it is
 * at time t, what its face says) is unit-testable with an injected clock.
 *
 * Founder order 2026-09-20: "your job was supposed to be displaying the trades
 * in 3d ... it's really just to showcase performance." The back-wall board
 * (`trading-floor-screen*.ts(x)`) prints the same trades as TEXT on its tape
 * row. This is the same trades as MOTION: a slab per trade, drifting from the
 * board wall toward the door in two lanes.
 *
 * DATA (2026-09-30): the Trading Arena paper tape, `GET /api/floor/arena/tape`,
 * through the SAME react-query key the board's tape row uses (`ARENA_TAPE_LIMIT`
 * is the one shared argument), so the two surfaces add one poll, not two. It
 * replaced the live house-trader swaps of `/api/floor/house-traders`.
 *
 * LANES: ENTRIES LEFT, EXITS RIGHT. The old tape had one lane per house desk;
 * the arena has five house agents plus every player, so a lane per agent is
 * impossible with two lanes. Splitting by side keeps both lanes busy (every
 * entry eventually becomes an exit) and makes the lane itself mean something:
 * cyan buys flow down the left, green and red results down the right.
 *
 * ONE DRAW CALL. Every chip is a quad in ONE `BufferGeometry` with ONE atlas
 * texture, not an `InstancedMesh` and not a mesh each. The reason is the text:
 * per-instance UVs need a shader, and `InstancedMesh` + `ShaderMaterial` is a
 * silent WebGPU crash on the Iris Xe floor. Writing 4 world-space corners per
 * chip into a dynamic position attribute costs 144 floats a frame at the
 * shipped chip count and needs no shader at all.
 *
 * THE LANE GEOMETRY IS NOT A TASTE DECISION. `TAPE_LANE_X` is bounded on BOTH
 * sides by things already in the room, and `trading-floor-trade-tape.test.ts`
 * pins both bounds by computing them:
 *   - OUTBOARD: the desk row's inner face (`TRADING_FLOOR_DESK_INNER_X`, 985).
 *     A chip may not reach it.
 *   - INBOARD: the big board must stay unoccluded FROM THE SPAWN. The chase
 *     camera at the spawn sits on the room's centre line at the back of its own
 *     Z clamp, so the ray through a chip's inner edge, continued to the board
 *     plane, must land outside the board's own x span. That is a projection,
 *     not a clearance: the innermost full-size corner projects by 1.088x.
 * The tests derive the lane window with 10 wu desk and 15 wu board margins.
 * Height does not change this horizontal projection.
 */

import { compactMagnitude, sanitiseScreenText } from './trading-floor-screen-texture';

// ---------------------------------------------------------------------------
// Geometry + timing constants
// ---------------------------------------------------------------------------

/** Lanes: 0 = left of the centre aisle (entries), 1 = right (exits). */
export const TAPE_LANES = 2;
export const TAPE_ENTRY_LANE = 0;
export const TAPE_EXIT_LANE = 1;
/** Chips per lane. 12 total quads, one atlas cell each. */
export const TAPE_PER_LANE = 6;
export const TAPE_MAX_CHIPS = TAPE_LANES * TAPE_PER_LANE;

/**
 * How many tape items BOTH arena surfaces request: the route's maximum.
 *
 * 24, not 12, because the lanes split by side. With only the newest 12, six
 * entries in a row would already push every exit off the tape. With 24, a run
 * of up to 18 entries still leaves the newest six exits on the right lane; a
 * longer run leaves that lane short until exits arrive, which is a true
 * picture of a floor that is only buying. Per-side limits would need a route
 * parameter; 24 is the route's maximum. ONE constant for the board's tape row
 * and the 3D tape, so they share one react-query key and one poll.
 */
export const ARENA_TAPE_LIMIT = 24;

/** Lane centre, |x|. Bounded on both sides — see the header. */
export const TAPE_LANE_X = 874;
/** Chip face, world units. 16:9 so one atlas cell maps 1:1 with no stretch. */
export const TAPE_CHIP_WIDTH = 160;
export const TAPE_CHIP_HEIGHT = 90;
/**
 * Flight height, lowered 100 wu. The conservative lowest corner is 352.75.
 * Above the avatar (270), the desks (166), the dais (206) and
 * the kiosk (300), so a chip can never intersect a prop or a walking player no
 * matter where either is — the tape needs no XZ keep-out at all.
 */
export const TAPE_Y = 420;
/** Where a chip enters (board end) and leaves (door end). */
export const TAPE_Z_START = -900;
export const TAPE_Z_END = 720;
/**
 * A chip stops 200 wu short of the player's own door limit (920) and 368 wu
 * short of the camera's Z clamp (1088), so the tape never flies into the lens.
 */
export const TAPE_LIFETIME_MS = 18_000;

/** Inward yaw, radians. The left lane turns right, the right lane turns left,
 *  so both faces angle toward the centre aisle the player walks up. */
export const TAPE_LANE_YAW = 0.22;

/** Fraction of a traverse spent fading in / out. */
export const TAPE_FADE_IN = 0.05;
export const TAPE_FADE_OUT = 0.22;
/** Fraction of a traverse spent on the entry pop. FIRST cycle only. */
export const TAPE_POP = 0.07;
/** Scale a popping chip grows FROM, and the height it rises THROUGH. */
export const TAPE_POP_MIN_SCALE = 0.25;
export const TAPE_POP_RISE = 40;
/** Idle vertical bob, world units. Two cycles per traverse. */
export const TAPE_BOB = 16;

/** Atlas: one cell per quad. 768 x 324 = 1.0 MB, redrawn only on a data change. */
export const TAPE_ATLAS_COLS = 4;
export const TAPE_ATLAS_ROWS = 3;
export const TAPE_CELL_WIDTH = 192;
export const TAPE_CELL_HEIGHT = 108;
export const TAPE_ATLAS_WIDTH = TAPE_ATLAS_COLS * TAPE_CELL_WIDTH;
export const TAPE_ATLAS_HEIGHT = TAPE_ATLAS_ROWS * TAPE_CELL_HEIGHT;

/**
 * Longest string each chip row may carry, in characters.
 *
 * These are a SUBSTITUTE for a clip path, not a style rule. Courier advances
 * ~0.6em, so the trader row at 26px is ~15.6 px/char against 160 px of usable
 * cell (192 less 16 px of padding each side) and the action and amount rows at
 * 20px are ~12.0. A longer string would not wrap or clip — it would run into
 * the next cell of the atlas and paint itself on a neighbouring chip. The
 * truncation is in the BUILDER so the test can see it, never at the draw site.
 */
export const TAPE_TRADER_MAX_CHARS = 10;
export const TAPE_ACTION_MAX_CHARS = 13;
export const TAPE_AMOUNT_MAX_CHARS = 13;

// ---------------------------------------------------------------------------
// The arena tape feed
// ---------------------------------------------------------------------------

/**
 * One arena tape row, read defensively.
 *
 * The wire row also carries `agentId`, `kind`, `mint`, `side`, `pnlMult` and
 * `reason`. They are deliberately NOT read: nothing on a chip or on the board
 * row shows them, and the MINT in particular is a chain identifier that has no
 * business on a wall in the game world. Only the route's `symbol` names a
 * token, and it passes the address strip before it is drawn.
 */
export interface ArenaTapeItem {
  readonly id: string;
  /** Epoch ms, or null when the route sent no readable time. */
  readonly atMs: number | null;
  readonly agentName: string;
  readonly type: 'entry' | 'exit';
  readonly symbol: string | null;
  /** Position size in USD. */
  readonly usd: number | null;
  /** Realised USD on an exit; null on an entry and on an unpriced exit. */
  readonly pnlUsd: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or null. A missing or NaN money field must never render as
 *  0, because 0 is a meaningful figure on a chip that shows P&L. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The route's items, newest first, deduplicated by id.
 *
 * Accepts the bare array or an `{ items }` / `{ tape }` envelope, so the board
 * does not go blank on an envelope change it did not need to care about. A row
 * with no id or an unknown `type` is dropped: without an id a chip has no
 * identity across polls, and without a side it has no lane and no colour.
 */
export function readArenaTape(data: unknown): ArenaTapeItem[] {
  const envelope = record(data);
  const list: unknown = Array.isArray(data)
    ? data
    : (envelope?.items ?? envelope?.tape);
  if (!Array.isArray(list)) return [];

  const seen = new Set<string>();
  const out: ArenaTapeItem[] = [];
  for (const raw of list) {
    const row = record(raw);
    if (!row) continue;
    const id = row.id;
    const type = row.type;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (type !== 'entry' && type !== 'exit') continue;
    seen.add(id);
    const atMs = typeof row.at === 'string' ? Date.parse(row.at) : Number.NaN;
    out.push({
      id,
      atMs: Number.isFinite(atMs) ? atMs : null,
      agentName: typeof row.agentName === 'string' ? row.agentName : '',
      type,
      symbol: typeof row.symbol === 'string' ? row.symbol : null,
      usd: finite(row.usd),
      pnlUsd: finite(row.pnlUsd),
    });
  }
  // Newest first. An undated row sorts last rather than being dropped: it
  // happened, we just cannot time it. `sort` is stable, so ties keep the
  // route's own order.
  return out.sort((a, b) => (b.atMs ?? -1) - (a.atMs ?? -1));
}

// ---------------------------------------------------------------------------
// Chip faces
// ---------------------------------------------------------------------------

/**
 * `buy` — an entry. Cyan: an entry has no realised figure yet.
 * `gain` / `loss` — an exit with a signed realised figure.
 * `flat` — an exit we cannot price, or a realised zero. Slate, and it never
 *          shows a figure it does not have.
 */
export type TapeChipKind = 'buy' | 'gain' | 'loss' | 'flat';

/** Saturated linear RGB per kind. The opaque white atlas body takes this tint;
 *  dark atlas text stays dark. Normal blending preserves contrast over props. */
export const TAPE_CHIP_COLOR: Readonly<
  Record<TapeChipKind, readonly [number, number, number]>
> = Object.freeze({
  buy: Object.freeze([0.015, 0.72, 1.0] as const),
  gain: Object.freeze([0.01, 0.85, 0.025] as const),
  loss: Object.freeze([1.0, 0.02, 0.035] as const),
  flat: Object.freeze([0.62, 0.72, 0.82] as const),
});

/** Short agent name for a chip, never an id. Sanitised BEFORE truncation so
 *  an address cannot become a printable prefix. */
export function tapeTraderName(agentName: string): string {
  // `$` goes too: a name is user-chosen at launch, and `sanitiseScreenText`
  // keeps `$` for the board's money labels, so "$500 Club" would otherwise
  // print "$500 CLUB BUY BONK $20.00" on the tape. The launch route's name
  // pattern rejects `$` today; this keeps the tape honest if that ever widens.
  const safe = sanitiseScreenText(agentName, Number.MAX_SAFE_INTEGER)
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^CLAWVILLE\s+/, '');
  return truncate(safe || 'TRADER', TAPE_TRADER_MAX_CHARS);
}

/**
 * `$1.24`, `$1,240.50`, `$1.2M` — magnitude only, and EXACT to the cent below
 * 100,000. It used to round to whole dollars from 1,000 up with no mark, and
 * the builder then cut anything past 13 characters, which turned
 * `+$1,000,000,000` into `+$1,000,000,0` — a different figure (Codex review,
 * 2026-09-30). Now the widest exact string is `+$99,999.99` (11), compact
 * notation takes over above that (at most `+$999.9T`, 8), and nothing is cut.
 */
export function formatTapeUsd(value: number): string {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude)) return 'N/A';
  // The ROUNDED cents decide: 99999.996 must go compact, not print as
  // "$100,000.00".
  const fixed = magnitude.toFixed(2);
  if (Number(fixed) < 100_000) {
    const [whole, cents] = fixed.split('.');
    return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
  }
  const compact = compactMagnitude(magnitude);
  return compact === null ? 'N/A' : `$${compact}`;
}

/** `+$1.24` / `-$0.87`. A realised zero is `$0.00`, unsigned: it is neither. */
export function formatTapeSignedUsd(value: number): string {
  if (value === 0) return '$0.00';
  const magnitude = formatTapeUsd(value);
  if (magnitude === 'N/A') return magnitude;
  return `${value > 0 ? '+' : '-'}${magnitude}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export interface TapeTradeFace {
  kind: TapeChipKind;
  /** Sanitised short agent name. Never an id or a mint. */
  trader: string;
  /** Side and token: "BUY BONK", "SELL WIF", or the side alone. */
  action: string;
  /** "$20.00" on an entry, the signed result on an exit, or "". Never a
   *  figure we do not have. */
  amount: string;
}

/**
 * A token symbol as the tape may print it, or '' for none.
 *
 * Symbols are ATTACKER-CHOSEN text: anyone can launch a memecoin, and the
 * route keeps `$ . _ -` in them (`sanitizeArenaSymbol`). `sanitiseScreenText`
 * then keeps `$ + - , .` and digits too, on purpose, because the board prints
 * money in its own labels. So a symbol could be a dollar figure: `+$4,200.00`
 * on an unpriced exit printed "SELL +$4,200." (cut at the action limit, which
 * also made it a DIFFERENT figure), on the board's tape row, on a 3D chip and
 * on the ribbon alike, all through `classifyArenaTapeItem`.
 *
 * The rule, after the shared sanitiser: every `$` goes, then a leading sign;
 * a symbol with no letter left, or with a decimal number in it, is no symbol
 * at all (the action becomes the bare side). `$PEPE` stays a token, `PEPE`;
 * `$500` and `1.5M` are prices, so they go.
 */
export function tapeSymbol(raw: string | null): string {
  if (raw === null) return '';
  const cleaned = sanitiseScreenText(raw, Number.MAX_SAFE_INTEGER)
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[+-]+\s*/, '');
  // A DECIMAL number reads as a price even with letters on it: `4200.00USD`
  // printed "SELL 4200.00U", and `1.5M` collides with the board's "12M" age
  // column. Integers with letters (`1INCH`, `W3`, `BONK2`) are real tickers.
  if (/\d[.,]\d/.test(cleaned)) return '';
  return /[A-Z]/.test(cleaned) ? cleaned : '';
}

/**
 * What one tape row's face says, and what colour it is.
 *
 * The symbol is sanitised BEFORE it is cut to fit, for the same reason as the
 * name: a truncated address is a printable fragment that the address strip no
 * longer recognises. It also goes through `tapeSymbol`, so a symbol can never
 * print as a dollar figure.
 */
export function classifyArenaTapeItem(
  item: ArenaTapeItem,
): Omit<TapeTradeFace, 'trader'> {
  const symbol = tapeSymbol(item.symbol);
  const side = item.type === 'entry' ? 'BUY' : 'SELL';
  const action = truncate(symbol ? `${side} ${symbol}` : side, TAPE_ACTION_MAX_CHARS);
  const size = item.usd !== null && item.usd > 0 ? formatTapeUsd(item.usd) : '';

  let kind: TapeChipKind;
  let amount: string;
  if (item.type === 'entry') {
    kind = 'buy';
    amount = size;
  } else if (item.pnlUsd === null) {
    // An exit the route could not price. It happened; it has no result to
    // show. NOT the size either: "SELL WIF $20.00" reads as "sold for $20",
    // which is a figure the route did not give us.
    kind = 'flat';
    amount = '';
  } else {
    kind = item.pnlUsd > 0 ? 'gain' : item.pnlUsd < 0 ? 'loss' : 'flat';
    amount = formatTapeSignedUsd(item.pnlUsd);
  }

  // NOT truncated: a cut figure is a different figure. `formatTapeUsd` bounds
  // the length instead, and the test sweeps magnitudes against the cap.
  return { kind, action, amount };
}

// ---------------------------------------------------------------------------
// Chip list
// ---------------------------------------------------------------------------

export interface TapeChipSource extends TapeTradeFace {
  /** The tape row's id. Identity across polls: a chip keeps its flight when
   *  the same row comes back in the next payload. */
  key: string;
  lane: number;
  /** 0..1, stable per key. Decorrelates the idle bob so the lane does not
   *  pulse in lockstep. */
  seed: number;
}

export interface TapeChip extends TapeChipSource {
  /** Wall-clock ms at which this chip's phase was 0 — the moment it entered at
   *  the board wall. Preserved across polls, which is what makes the flight
   *  continuous instead of restarting every 15 s. */
  releasedAtMs: number;
}

/** Stable 0..1 from a key. Not security, just decorrelation. */
function seedFromKey(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * The rows the tape will carry: the newest `TAPE_PER_LANE` entries on the
 * left lane and the newest `TAPE_PER_LANE` exits on the right, newest first.
 *
 * `readArenaTape` already dedupes by id, so one tape row can never become two
 * objects in the room.
 */
export function buildTapeSources(data: unknown): TapeChipSource[] {
  const taken = new Array<number>(TAPE_LANES).fill(0);
  const out: TapeChipSource[] = [];
  for (const item of readArenaTape(data)) {
    const lane = item.type === 'entry' ? TAPE_ENTRY_LANE : TAPE_EXIT_LANE;
    if (taken[lane]! >= TAPE_PER_LANE) continue;
    taken[lane] = taken[lane]! + 1;
    out.push({
      key: item.id,
      lane,
      seed: seedFromKey(item.id),
      trader: tapeTraderName(item.agentName),
      ...classifyArenaTapeItem(item),
    });
  }
  return out;
}

function sameSource(a: TapeChipSource, b: TapeChipSource): boolean {
  return (
    a.key === b.key &&
    a.lane === b.lane &&
    a.kind === b.kind &&
    a.trader === b.trader &&
    a.action === b.action &&
    a.amount === b.amount
  );
}

/**
 * Fold a fresh source list into the flying chips.
 *
 * THREE BEHAVIOURS, and the difference between the first two is the whole
 * feature:
 *
 *  1. **First fill (`prev` empty) SEEDS.** Chips are spread evenly along their
 *     lane and released one full lifetime in the PAST, so they are already in
 *     cycle 1 and none of them pops. A visitor walking in meets a tape that is
 *     already moving, rather than an empty hall that fills over 18 seconds.
 *  2. **A trade that arrives LATER pops.** Its release is now, so it enters at
 *     the board wall in cycle 0 and grows in. That is the only visual
 *     difference between "this happened while you were watching" and "this was
 *     already on the tape", and it is worth a branch.
 *  3. **A surviving trade keeps its release.** The flight is continuous across
 *     the 15 s poll; nothing restarts, nothing jumps.
 *
 * Returns `prev` UNCHANGED when nothing moved, so the caller's redraw effect
 * does not repaint the atlas on every poll that changed nothing.
 */
export function reconcileTapeChips(
  prev: readonly TapeChip[],
  sources: readonly TapeChipSource[],
  nowMs: number,
): TapeChip[] {
  if (sources.length === 0) return prev.length === 0 ? (prev as TapeChip[]) : [];

  const previousByKey = new Map<string, TapeChip>();
  for (const chip of prev) previousByKey.set(chip.key, chip);

  // Per-lane ordinal, used only by the seed path.
  const laneCounts = new Array<number>(TAPE_LANES).fill(0);
  for (const source of sources) {
    if (source.lane >= 0 && source.lane < TAPE_LANES) laneCounts[source.lane]!++;
  }
  const laneSeen = new Array<number>(TAPE_LANES).fill(0);
  const seeding = prev.length === 0;

  const next: TapeChip[] = [];
  let changed = prev.length !== sources.length;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]!;
    const existing = previousByKey.get(source.key);
    if (existing && sameSource(existing, source)) {
      next.push(existing);
      if (!changed && prev[index] !== existing) changed = true;
      continue;
    }
    changed = true;
    let releasedAtMs: number;
    if (seeding) {
      const lane = source.lane >= 0 && source.lane < TAPE_LANES ? source.lane : 0;
      const ordinal = laneSeen[lane]!;
      laneSeen[lane] = ordinal + 1;
      const count = Math.max(1, laneCounts[lane]!);
      // One lifetime in the past puts the chip in cycle 1, which is what
      // suppresses the pop; the ordinal term spreads the lane.
      releasedAtMs = nowMs - TAPE_LIFETIME_MS - (ordinal / count) * TAPE_LIFETIME_MS;
    } else {
      // A re-keyed chip whose FACE changed keeps flying; only a genuinely new
      // tape id enters at the wall.
      releasedAtMs = existing ? existing.releasedAtMs : nowMs;
    }
    next.push({ ...source, releasedAtMs });
  }
  return changed ? next : (prev as TapeChip[]);
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

/** Where one chip is, how big, how bright. Mutable: the frame loop owns one
 *  per quad and never allocates. */
export interface TapeChipTransform {
  visible: boolean;
  x: number;
  y: number;
  z: number;
  /** Half-extents AFTER the pop scale. */
  halfWidth: number;
  halfHeight: number;
  /** The quad's rotated RIGHT vector (unit, y = 0). */
  rightX: number;
  rightZ: number;
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export function createTapeChipTransform(): TapeChipTransform {
  return {
    visible: false,
    x: 0,
    y: 0,
    z: 0,
    halfWidth: 0,
    halfHeight: 0,
    rightX: 1,
    rightZ: 0,
    red: 0,
    green: 0,
    blue: 0,
    alpha: 0,
  };
}

/** Lane sign and the rotated right vector, precomputed. Left lane yaws +, so
 *  its right vector is `(cos, 0, -sin)`; the right lane mirrors it. */
const LANE_SIGN = [-1, 1] as const;
const LANE_RIGHT_X = Math.cos(TAPE_LANE_YAW);
const LANE_RIGHT_Z = [-Math.sin(TAPE_LANE_YAW), Math.sin(TAPE_LANE_YAW)] as const;

const TAU = Math.PI * 2;

/** Cubic ease-out without overshoot. Both clearance bounds assume scale <= 1;
 *  overshoot would invalidate those bounds during the entry animation. */
function easeOutCubic(t: number): number {
  const inverse = 1 - t;
  return 1 - inverse * inverse * inverse;
}

/** Phase within the current traverse, and how many traverses are done. */
export function tapeChipPhase(
  chip: TapeChip,
  nowMs: number,
): { cycle: number; phase: number } {
  const raw = (nowMs - chip.releasedAtMs) / TAPE_LIFETIME_MS;
  if (!Number.isFinite(raw) || raw < 0) return { cycle: -1, phase: 0 };
  const cycle = Math.floor(raw);
  return { cycle, phase: raw - cycle };
}

/**
 * Where the chip is at `nowMs`. Scalar, zero allocation — the caller owns
 * `out`, so the frame loop can ask every frame for every chip for free.
 */
export function writeTapeChipTransform(
  chip: TapeChip,
  nowMs: number,
  out: TapeChipTransform,
): void {
  // Keep the hot path scalar: tapeChipPhase returns a new record for callers.
  const raw = (nowMs - chip.releasedAtMs) / TAPE_LIFETIME_MS;
  if (!Number.isFinite(raw) || raw < 0) {
    out.visible = false;
    out.alpha = 0;
    return;
  }
  const cycle = Math.floor(raw);
  const phase = raw - cycle;

  const lane = chip.lane >= 0 && chip.lane < TAPE_LANES ? chip.lane : 0;
  const popping = cycle === 0 && phase < TAPE_POP;
  const popT = popping ? easeOutCubic(phase / TAPE_POP) : 1;
  const scale = TAPE_POP_MIN_SCALE + (1 - TAPE_POP_MIN_SCALE) * popT;

  const fadeIn = phase / TAPE_FADE_IN;
  const fadeOut = (1 - phase) / TAPE_FADE_OUT;
  const fade = Math.max(0, Math.min(1, Math.min(fadeIn, fadeOut)));

  const colour = TAPE_CHIP_COLOR[chip.kind];

  out.visible = true;
  out.x = LANE_SIGN[lane]! * TAPE_LANE_X;
  out.y =
    TAPE_Y +
    Math.sin(phase * TAU * 2 + chip.seed * TAU) * TAPE_BOB -
    (1 - popT) * TAPE_POP_RISE;
  out.z = TAPE_Z_START + (TAPE_Z_END - TAPE_Z_START) * phase;
  out.halfWidth = (TAPE_CHIP_WIDTH / 2) * scale;
  out.halfHeight = (TAPE_CHIP_HEIGHT / 2) * scale;
  out.rightX = LANE_RIGHT_X;
  out.rightZ = LANE_RIGHT_Z[lane]!;
  // Fade opacity only. The fill retains its saturation through the fade.
  out.red = colour[0];
  out.green = colour[1];
  out.blue = colour[2];
  out.alpha = fade;
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

/** The cell rect for quad `index`, in canvas pixels. */
export function tapeCellRect(index: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const column = index % TAPE_ATLAS_COLS;
  const row = Math.floor(index / TAPE_ATLAS_COLS) % TAPE_ATLAS_ROWS;
  return {
    x: column * TAPE_CELL_WIDTH,
    y: row * TAPE_CELL_HEIGHT,
    width: TAPE_CELL_WIDTH,
    height: TAPE_CELL_HEIGHT,
  };
}

/**
 * The cell's UV rect. `v` is flipped because a `CanvasTexture` carries
 * `flipY = true`: canvas row 0 is the TOP of the image and therefore `v = 1`.
 */
export function tapeCellUv(index: number): {
  u0: number;
  u1: number;
  vTop: number;
  vBottom: number;
} {
  const rect = tapeCellRect(index);
  return {
    u0: rect.x / TAPE_ATLAS_WIDTH,
    u1: (rect.x + rect.width) / TAPE_ATLAS_WIDTH,
    vTop: 1 - rect.y / TAPE_ATLAS_HEIGHT,
    vBottom: 1 - (rect.y + rect.height) / TAPE_ATLAS_HEIGHT,
  };
}


const CELL_PADDING = 16;
const TRADER_FONT = 'bold 26px "Courier New", monospace';
const ACTION_FONT = 'bold 20px "Courier New", monospace';
const AMOUNT_FONT = 'bold 20px "Courier New", monospace';
/**
 * Row baselines inside a 108 px cell whose slab spans 5..103. Three rows since
 * 2026-09-30 (the arena chip names the token): trader, action, amount. At the
 * test's 0.72 / 0.2 em glyph estimate the boxes are 14.3..38.2, 48.6..67 and
 * 77.6..96 — inside the slab and clear of each other.
 */
const TRADER_BASELINE = 33;
const ACTION_BASELINE = 63;
const AMOUNT_BASELINE = 92;

/**
 * Paint every cell. Called ONLY when the chip list changes — never per frame,
 * and never from `useFrame`: a full atlas upload is ~1.0 MB, which is the class
 * of per-frame cost the Iris Xe floor cannot absorb.
 *
 * White bodies take the saturated vertex tint; dark text retains contrast.
 * Transparent padding avoids black rectangles under normal blending. Unused
 * cells are cleared and their quads are degenerate.
 */
export function drawTapeAtlas(
  ctx: CanvasRenderingContext2D,
  chips: readonly TapeChip[],
): void {
  ctx.clearRect(0, 0, TAPE_ATLAS_WIDTH, TAPE_ATLAS_HEIGHT);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const count = Math.min(chips.length, TAPE_MAX_CHIPS);
  for (let index = 0; index < count; index++) {
    const chip = chips[index]!;
    const rect = tapeCellRect(index);

    // Opaque white takes the saturated vertex tint across the whole slab.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rect.x + 5, rect.y + 5, rect.width - 10, rect.height - 10);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#071018';
    ctx.strokeRect(rect.x + 5, rect.y + 5, rect.width - 10, rect.height - 10);

    ctx.fillStyle = '#071018';
    ctx.font = TRADER_FONT;
    ctx.fillText(chip.trader, rect.x + CELL_PADDING, rect.y + TRADER_BASELINE);
    ctx.font = ACTION_FONT;
    ctx.fillText(chip.action, rect.x + CELL_PADDING, rect.y + ACTION_BASELINE);
    if (chip.amount.length > 0) {
      ctx.font = AMOUNT_FONT;
      ctx.fillText(chip.amount, rect.x + CELL_PADDING, rect.y + AMOUNT_BASELINE);
    }
  }
}
