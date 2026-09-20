/**
 * trading-floor-trade-tape.ts
 *
 * The house traders' recent trades as PHYSICAL objects in the hall — the pure
 * half. No `three`, no React, no DOM beyond a 2D context the caller hands in,
 * so every rule below (which trade, which lane, which colour, where it is at
 * time t, what its face says) is unit-testable with an injected clock.
 *
 * Founder order 2026-09-20: "your job was supposed to be displaying the trades
 * in 3d ... it's really just to showcase performance." The back-wall board
 * (`trading-floor-screen*.ts(x)`) already prints the trades as TEXT. This is the
 * same trades as MOTION: a slab per trade, drifting from the board wall toward
 * the door in two lanes, one lane per desk.
 *
 * DATA: the SAME `useHouseTraders` react-query key both other public surfaces
 * use. No route, no second fetch, no poll of its own — react-query dedupes by
 * key, so the tape is free on the network.
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
 *     not a clearance: a chip 810 wu off-centre at the back of the lane throws
 *     a shadow 890 wu off-centre on a board that is only 850 wu wide.
 * Those two windows are 175 wu apart and the lane sits between them. Move the
 * desks or the board and the test says so.
 */

import { TRADE_MINTS } from '@clawville/shared';

import type { FloorTrade } from '@/stores/trade-ticker';
import type { HouseTraderSlotView } from '@/hooks/use-trading-floor';

// ---------------------------------------------------------------------------
// Geometry + timing constants
// ---------------------------------------------------------------------------

/** Lanes: 0 = left of the centre aisle, 1 = right. One desk per lane. */
export const TAPE_LANES = 2;
/** Chips per lane. 12 total quads, one atlas cell each. */
export const TAPE_PER_LANE = 6;
export const TAPE_MAX_CHIPS = TAPE_LANES * TAPE_PER_LANE;

/** Lane centre, |x|. Bounded on both sides — see the header. */
export const TAPE_LANE_X = 890;
/** Chip face, world units. 16:9 so one atlas cell maps 1:1 with no stretch. */
export const TAPE_CHIP_WIDTH = 160;
export const TAPE_CHIP_HEIGHT = 90;
/**
 * Flight height. Above the avatar (270), the desks (166), the dais (206) and
 * the kiosk (300), so a chip can never intersect a prop or a walking player no
 * matter where either is — the tape needs no XZ keep-out at all.
 */
export const TAPE_Y = 520;
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
 * Longest string each row may carry, in characters.
 *
 * These are a SUBSTITUTE for a clip path, not a style rule. Courier advances
 * ~0.6em, so the symbol row at 26px is ~15.6 px/char against 160 px of usable
 * cell (192 less 16 px of padding each side) and the amount row at 24px is
 * ~14.4. A longer string would not wrap or clip — it would run into the next
 * cell of the atlas and paint itself on a neighbouring chip. The truncation is
 * in the BUILDER so the test can see it, never at the draw site.
 */
export const TAPE_SYMBOL_MAX_CHARS = 10;
export const TAPE_AMOUNT_MAX_CHARS = 11;

// ---------------------------------------------------------------------------
// Trade classification
// ---------------------------------------------------------------------------

/**
 * `buy` — quote in, token out. Cyan: a buy has no realised figure yet.
 * `gain` / `loss` — token out, quote in, with a signed realised figure.
 * `flat` — a sell we cannot price, a realised zero, or a swap that is neither
 *          (both legs quote, or neither). Slate, and it never shows a figure it
 *          does not have.
 */
export type TapeChipKind = 'buy' | 'gain' | 'loss' | 'flat';

/** Linear RGB per kind. Additive blending in a dark hall, so these read as
 *  emissive without a light, a bloom pass or an unlit second material. */
export const TAPE_CHIP_COLOR: Readonly<
  Record<TapeChipKind, readonly [number, number, number]>
> = Object.freeze({
  buy: Object.freeze([0.22, 0.85, 0.95] as const),
  gain: Object.freeze([0.24, 0.94, 0.54] as const),
  loss: Object.freeze([1.0, 0.36, 0.42] as const),
  flat: Object.freeze([0.62, 0.72, 0.82] as const),
});

/** The two quote legs. A swap is token-against-one-of-these. */
const QUOTE_MINTS: ReadonlySet<string> = new Set<string>([
  TRADE_MINTS.USDC,
  TRADE_MINTS.WSOL,
]);

/**
 * The ONLY mints a chip may NAME, and deliberately the same policy the board's
 * `TAPE_SYMBOLS` applies: a listed token gets its name, everything else gets
 * its venue. Never `symbolForMint` from the panel's `format.ts`, which falls
 * back to a truncated base58 mint — an 11-character mint fragment is short
 * enough to survive an address filter and would put a raw chain identifier on a
 * floating object in the game world. USDC and SOL are omitted on purpose: they
 * are the currency, not the trade.
 *
 * `trading-floor-trade-tape.test.ts` reads the board's own map out of
 * `trading-floor-screen-data.ts` and asserts the two name the same mints, so
 * the second copy cannot drift into naming something the board will not.
 */
const TAPE_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  [TRADE_MINTS.ANSEM]: 'ANSEM',
  [TRADE_MINTS.CLAWVILLE]: 'CLAWVILLE',
});

const VENUE_LABEL: Readonly<Record<FloorTrade['dex'], string>> = Object.freeze({
  jupiter: 'JUPITER',
  pumpswap: 'PUMPSWAP',
  pumpfun: 'PUMP.FUN',
});

/** A finite number, or null. A missing or NaN money field must never render as
 *  0, because 0 is a meaningful figure on a chip that shows P&L. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `$1.24`, `$1,240` — magnitude only. Two decimals under 1000, none above, so
 *  the string cannot outgrow `TAPE_AMOUNT_MAX_CHARS` on a large trade. */
export function formatTapeUsd(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return `$${Math.round(magnitude).toLocaleString('en-US')}`;
  return `$${magnitude.toFixed(2)}`;
}

/** `+$1.24` / `-$0.87`. A realised zero is `$0.00`, unsigned: it is neither. */
export function formatTapeSignedUsd(value: number): string {
  if (value === 0) return '$0.00';
  return `${value > 0 ? '+' : '-'}${formatTapeUsd(value)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export interface TapeTradeFace {
  kind: TapeChipKind;
  /** Token name where we may name it, else the venue. Never a mint. */
  symbol: string;
  /** The signed figure, or the side, or both. Never a figure we do not have. */
  amount: string;
}

/**
 * What one trade's face says, and what colour it is.
 *
 * The realised figure is read off the row's OPTIONAL `realisedUsd`, exactly as
 * the board's tape reads it: the field is additive on the wire and absent from
 * the `FloorTrade` type, so it is read through a cast and normalised to null.
 */
export function classifyTapeTrade(trade: FloorTrade): TapeTradeFace {
  const inputIsQuote = QUOTE_MINTS.has(trade.inputMint);
  const outputIsQuote = QUOTE_MINTS.has(trade.outputMint);
  const isBuy = inputIsQuote && !outputIsQuote;
  const isSell = outputIsQuote && !inputIsQuote;

  const traded = isSell ? trade.inputMint : trade.outputMint;
  const symbol =
    TAPE_SYMBOLS[traded] ?? VENUE_LABEL[trade.dex] ?? 'ON CHAIN';

  const notional = finite(trade.notionalUsd);
  const realised = finite((trade as { realisedUsd?: unknown }).realisedUsd);

  let kind: TapeChipKind;
  let amount: string;
  if (isBuy) {
    kind = 'buy';
    amount = notional !== null && notional > 0 ? `BUY ${formatTapeUsd(notional)}` : 'BUY';
  } else if (isSell && realised !== null && realised > 0) {
    kind = 'gain';
    amount = formatTapeSignedUsd(realised);
  } else if (isSell && realised !== null && realised < 0) {
    kind = 'loss';
    amount = formatTapeSignedUsd(realised);
  } else if (isSell && realised !== null) {
    kind = 'flat';
    amount = formatTapeSignedUsd(realised);
  } else if (isSell) {
    kind = 'flat';
    amount = notional !== null && notional > 0 ? `SELL ${formatTapeUsd(notional)}` : 'SELL';
  } else {
    // Both legs quote, or neither. It happened, we just cannot call it a side.
    kind = 'flat';
    amount = 'SWAP';
  }

  return {
    kind,
    symbol: truncate(symbol, TAPE_SYMBOL_MAX_CHARS),
    amount: truncate(amount, TAPE_AMOUNT_MAX_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Chip list
// ---------------------------------------------------------------------------

export interface TapeChipSource extends TapeTradeFace {
  /** The trade signature. Identity across polls: a chip keeps its flight when
   *  the same trade comes back in the next payload. */
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

/** Stable 0..1 from a signature. Not security, just decorrelation. */
function seedFromKey(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * The trades the tape will carry, newest first within each lane.
 *
 * Lane comes from the slot's position in the lineup, so the two desks are
 * separated spatially and a viewer can tell which desk a trade came from
 * without reading anything. Slot 0 takes the left lane.
 *
 * Deduped by signature ACROSS lanes: the same on-chain trade must never become
 * two objects in the room. First slot wins, which is the same precedence the
 * lineup order already carries.
 */
export function buildTapeSources(
  slots: readonly HouseTraderSlotView[] | undefined,
): TapeChipSource[] {
  if (!slots || slots.length === 0) return [];
  const seen = new Set<string>();
  const out: TapeChipSource[] = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const slot = slots[slotIndex]!;
    const lane = slotIndex % TAPE_LANES;
    const trades = [...slot.recentTrades]
      // Newest first. An undated trade sorts last rather than being dropped:
      // it happened, we just cannot time it.
      .sort((a, b) => (b.blockTime ?? -1) - (a.blockTime ?? -1));
    let taken = 0;
    for (const trade of trades) {
      if (taken >= TAPE_PER_LANE) break;
      if (typeof trade.signature !== 'string' || trade.signature.length === 0) continue;
      if (seen.has(trade.signature)) continue;
      seen.add(trade.signature);
      taken++;
      out.push({
        key: trade.signature,
        lane,
        seed: seedFromKey(trade.signature),
        ...classifyTapeTrade(trade),
      });
    }
  }
  return out;
}

function sameSource(a: TapeChipSource, b: TapeChipSource): boolean {
  return (
    a.key === b.key &&
    a.lane === b.lane &&
    a.kind === b.kind &&
    a.symbol === b.symbol &&
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
      // signature enters at the wall.
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

/** Cubic ease-out. No overshoot ON PURPOSE: the lane's outboard clearance to
 *  the desk face is 15 wu at scale 1, so a back-eased pop would put the chip's
 *  corner through a desk for three frames. */
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
  const { cycle, phase } = tapeChipPhase(chip, nowMs);
  if (cycle < 0) {
    out.visible = false;
    out.alpha = 0;
    return;
  }

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
  // Fade the colour AS WELL as the alpha. Additive blending takes both, and a
  // chip that only loses alpha still lifts the wall behind it at the edges.
  out.red = colour[0] * fade;
  out.green = colour[1] * fade;
  out.blue = colour[2] * fade;
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
const SYMBOL_FONT = 'bold 26px "Courier New", monospace';
const AMOUNT_FONT = 'bold 24px "Courier New", monospace';

/**
 * Paint every cell. Called ONLY when the chip list changes — never per frame,
 * and never from `useFrame`: a full atlas upload is ~1.0 MB, which is the class
 * of per-frame cost the Iris Xe floor cannot absorb.
 *
 * Everything is drawn in WHITE and tinted by the per-chip vertex colour, so one
 * atlas serves all four kinds and a colour change costs no repaint at all.
 * Unused cells are cleared to black, which under additive blending is
 * invisible — the quad is degenerate as well, so it never reaches a fragment.
 */
export function drawTapeAtlas(
  ctx: CanvasRenderingContext2D,
  chips: readonly TapeChip[],
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, TAPE_ATLAS_WIDTH, TAPE_ATLAS_HEIGHT);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const count = Math.min(chips.length, TAPE_MAX_CHIPS);
  for (let index = 0; index < count; index++) {
    const chip = chips[index]!;
    const rect = tapeCellRect(index);

    // Slab body. Faint on purpose: additive, so this is the chip's own glow and
    // a heavier fill would wash the glyphs out rather than back them.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fillRect(rect.x + 5, rect.y + 5, rect.width - 10, rect.height - 10);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.strokeRect(rect.x + 5, rect.y + 5, rect.width - 10, rect.height - 10);

    ctx.font = SYMBOL_FONT;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(chip.symbol, rect.x + CELL_PADDING, rect.y + 46);

    ctx.font = AMOUNT_FONT;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    ctx.fillText(chip.amount, rect.x + CELL_PADDING, rect.y + 84);
  }
}
