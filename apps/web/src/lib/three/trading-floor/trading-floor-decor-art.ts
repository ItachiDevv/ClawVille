/**
 * trading-floor-decor-art.ts
 *
 * Canvas art for the Trading Floor runtime decor, plus the ribbon's text. Pure:
 * no `three`, no React, and the only DOM is the 2D context the caller hands in,
 * so the tests drive every function with a recording context.
 *
 * THREE SURFACES, three redraw budgets:
 *   - The MONITOR ATLAS (`drawDecorAtlas`) is drawn ONCE per mount. It holds
 *     abstract terminal art only: candles, depth curves, an order-book heatmap,
 *     volume bars, header bars made of blocks. NO text, NO digits, NO tickers
 *     and NO prices anywhere on it: a decorative screen that printed a number
 *     would be a claim nobody made. The life comes from the layout scrolling
 *     U windows across bands that are PERIODIC along U: every series below is
 *     built on a closed loop (zero-sum steps, circular averages, integer-cycle
 *     waves), so the band's last column runs straight into its first.
 *   - The RIBBON STRIP (`drawRibbonStrip`) is redrawn only when its segment
 *     list changes (`ribbonSignature`), never from a frame loop.
 *   - The GLOW SPRITE (`drawGlowSprite`) is drawn once.
 *
 * RECORDED DEVIATION (accepted by the lead, 2026-10-01): the ribbon strip is
 * 4096 x 64, outside the brief's "every runtime CanvasTexture <= 1024 x 1024"
 * cap by shape, not by size. It is 262k px (1 MB RGBA, a quarter of a 1024²
 * upload), it uploads only when the tape text changes, and a crawl needs one
 * long strip: a 1024-wide strip would repeat the same few words four times
 * round the room. It keeps its mip chain because the text is moving and
 * minified; the mips are regenerated on each of those rare uploads.
 *
 * Fonts (deviation, accepted): the LED text uses bold Courier New, the board's
 * own face. The brand kit names Barlow / Inter for HUD text, but the web app
 * loads neither (`app/layout.tsx` loads Orbitron, Oxanium, Space Mono and
 * Fraunces), and a canvas silently falls back for a face the document does not
 * have, then never redraws. Courier New needs no load and cannot fall back.
 */

import {
  DECOR_ATLAS_SIZE,
  DECOR_BANDS,
  DECOR_DEPTH_PANEL_COUNT,
  DECOR_DESK_HEADER_COUNT,
  DECOR_SWATCH_IDS,
  DECOR_WALL_HEADER_COUNT,
  GLOW_SPRITE_SIZE,
  RIBBON_CANVAS_HEIGHT,
  RIBBON_CANVAS_WIDTH,
  RIBBON_RIM_ROWS,
  decorRandom,
  depthPanelRect,
  deskHeaderRect,
  swatchRect,
  wallHeaderRect,
  type AtlasRect,
  type DecorBand,
  type DecorSwatchId,
} from './trading-floor-decor-layout';
import {
  classifyArenaTapeItem,
  readArenaTape,
  tapeTraderName,
  type TapeChipKind,
} from './trading-floor-trade-tape';

/** The 2D context members the art uses. A recording fake satisfies it. */
export type DecorContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'globalAlpha'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'shadowBlur'
  | 'shadowColor'
  | 'fillRect'
  | 'strokeRect'
  | 'clearRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'quadraticCurveTo'
  | 'bezierCurveTo'
  | 'closePath'
  | 'stroke'
  | 'fill'
  | 'fillText'
  | 'measureText'
  | 'createLinearGradient'
  | 'createRadialGradient'
>;

// ---------------------------------------------------------------------------
// Palette (branding/BRAND.md §3 plus the terminal colours the brief names)
// ---------------------------------------------------------------------------

export const DECOR_PALETTE = Object.freeze({
  screenBg: '#03070b',
  grid: '#0c1822',
  gridStrong: '#12273a',
  up: '#22c55e',
  down: '#ef4444',
  upDim: '#14743a',
  downDim: '#8c2626',
  amber: '#ff9f1a',
  amberDim: '#a8650a',
  electricBlue: '#2890f8',
  blueDim: '#174f8c',
  neonLime: '#b8f800',
  champagneGold: '#e0c070',
  panelNavy: '#001858',
  signalWhite: '#f8f8f8',
  headerBar: '#0f151c',
  headerBlock: '#3b4654',
});

/** Solid swatches. Unlit material, so each face's shading is baked here. */
export const DECOR_SWATCH_COLORS: Readonly<Record<DecorSwatchId, string>> = Object.freeze({
  bezelFront: '#171c24',
  bezelSide: '#0d1116',
  bezelTop: '#262e39',
  bezelBack: '#0a0d11',
  screenBlack: '#020407',
  brassFront: '#a88a4e',
  brassSide: '#6e5a32',
  brassTop: '#d9bd7c',
  trimGold: '#e0c070',
});

// ---------------------------------------------------------------------------
// Periodic series (pure, testable)
// ---------------------------------------------------------------------------

export interface CandleSeries {
  readonly open: number[];
  readonly high: number[];
  readonly low: number[];
  readonly close: number[];
  readonly volume: number[];
}

/**
 * `count` candles on a CLOSED loop: the steps sum to zero, so the last close
 * equals the price before the first open and candle 0 opens where candle
 * `count - 1` closed. Two integer-cycle waves give it trends and pullbacks
 * instead of pure noise.
 */
export function periodicCandles(seed: number, count: number, volatility: number): CandleSeries {
  const random = decorRandom(seed);
  const phaseA = random() * Math.PI * 2;
  const phaseB = random() * Math.PI * 2;
  const steps: number[] = [];
  for (let index = 0; index < count; index++) {
    const t = (index / count) * Math.PI * 2;
    const drift = Math.sin(t * 2 + phaseA) * 0.55 + Math.sin(t * 5 + phaseB) * 0.3;
    steps.push((random() - 0.5) * volatility + drift * volatility * 0.45);
  }
  const mean = steps.reduce((sum, step) => sum + step, 0) / count;
  const close: number[] = [];
  let level = 0;
  for (const step of steps) {
    level += step - mean;
    close.push(level);
  }
  // Exact closure: the float sum leaves ~1e-15, and the seam is the point.
  close[count - 1] = 0;
  const open = close.map((_, index) => (index === 0 ? close[count - 1]! : close[index - 1]!));
  const high: number[] = [];
  const low: number[] = [];
  const volume: number[] = [];
  for (let index = 0; index < count; index++) {
    const top = Math.max(open[index]!, close[index]!);
    const bottom = Math.min(open[index]!, close[index]!);
    high.push(top + random() * volatility * 0.7);
    low.push(bottom - random() * volatility * 0.7);
    volume.push(0.25 + Math.min(1, Math.abs(close[index]! - open[index]!) / volatility) * 0.55 + random() * 0.2);
  }
  return { open, high, low, close, volume };
}

/** Circular moving average: the window wraps, so the line is periodic too. */
export function circularAverage(values: readonly number[], window: number): number[] {
  const count = values.length;
  return values.map((_, index) => {
    let sum = 0;
    for (let k = 0; k < window; k++) sum += values[(index - k + count * window) % count]!;
    return sum / window;
  });
}

/** A smooth loop: integer-cycle waves plus a zero-sum random walk smoothed on
 *  the circle. `samples` points; value at `samples` equals value at 0. */
export function periodicWave(seed: number, samples: number): number[] {
  const random = decorRandom(seed);
  const harmonics = [1, 2, 3, 5, 8].map((cycles) => ({
    cycles,
    amplitude: (random() * 0.8 + 0.2) / Math.sqrt(cycles),
    phase: random() * Math.PI * 2,
  }));
  const steps = Array.from({ length: samples }, () => random() - 0.5);
  const mean = steps.reduce((sum, step) => sum + step, 0) / samples;
  const walk: number[] = [];
  let level = 0;
  for (const step of steps) {
    level += step - mean;
    walk.push(level);
  }
  const smooth = circularAverage(walk, 6);
  return smooth.map((value, index) => {
    const t = (index / samples) * Math.PI * 2;
    let wave = 0;
    for (const harmonic of harmonics) wave += harmonic.amplitude * Math.sin(t * harmonic.cycles + harmonic.phase);
    return wave + value * 0.18;
  });
}

function normaliser(values: readonly number[], top: number, bottom: number): (value: number) => number {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min || 1;
  return (value) => bottom - ((value - min) / span) * (bottom - top);
}

// ---------------------------------------------------------------------------
// Atlas bands
// ---------------------------------------------------------------------------

const ATLAS = DECOR_ATLAS_SIZE;

function fillBand(ctx: DecorContext, band: DecorBand): void {
  ctx.fillStyle = DECOR_PALETTE.screenBg;
  ctx.fillRect(0, band.y, ATLAS, band.height);
}

/** Faint terminal grid. Pitches divide the atlas width, so it tiles on U. */
function drawGrid(ctx: DecorContext, top: number, height: number, columnPitch: number, rowPitch: number): void {
  ctx.fillStyle = DECOR_PALETTE.grid;
  for (let x = 0; x < ATLAS; x += columnPitch) ctx.fillRect(x, top, 1, height);
  for (let y = top + rowPitch; y < top + height; y += rowPitch) ctx.fillRect(0, y, ATLAS, 1);
}

/**
 * Stroke a periodic polyline across the whole width, starting and ending one
 * step OUTSIDE the canvas so the stroke has no cap at either edge: the seam is
 * drawn by the same continuous line on both sides.
 */
function strokePeriodic(
  ctx: DecorContext,
  values: readonly number[],
  pitch: number,
  offset: number,
  toY: (value: number) => number,
  colour: string,
  width: number,
): void {
  const count = values.length;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let index = -2; index <= count + 2; index++) {
    const value = values[((index % count) + count) % count]!;
    const x = index * pitch + offset;
    if (index === -2) ctx.moveTo(x, toY(value));
    else ctx.lineTo(x, toY(value));
  }
  ctx.stroke();
}

const CANDLE_PITCH = 8;

function drawCandleBand(ctx: DecorContext, band: DecorBand, seed: number, hollow: boolean): void {
  fillBand(ctx, band);
  drawGrid(ctx, band.y, band.height, 64, 32);
  const count = ATLAS / CANDLE_PITCH;
  const series = periodicCandles(seed, count, 1);
  const chartTop = band.y + 14;
  const chartBottom = band.y + band.height - 58;
  const volumeBottom = band.y + band.height - 8;
  const volumeHeight = 40;
  const toY = normaliser([...series.high, ...series.low], chartTop, chartBottom);

  // Bollinger-style envelope on the hollow variant: a soft blue channel.
  const fast = circularAverage(series.close, 9);
  const slow = circularAverage(series.close, 24);
  if (hollow) {
    ctx.globalAlpha = 0.5;
    strokePeriodic(ctx, slow.map((v) => v + 0.9), CANDLE_PITCH, 4, toY, DECOR_PALETTE.blueDim, 1.5);
    strokePeriodic(ctx, slow.map((v) => v - 0.9), CANDLE_PITCH, 4, toY, DECOR_PALETTE.blueDim, 1.5);
    ctx.globalAlpha = 1;
  }

  for (let index = 0; index < count; index++) {
    const x = index * CANDLE_PITCH;
    const open = series.open[index]!;
    const close = series.close[index]!;
    const rising = close >= open;
    const colour = rising ? DECOR_PALETTE.up : DECOR_PALETTE.down;
    const top = toY(Math.max(open, close));
    const bottom = toY(Math.min(open, close));
    ctx.fillStyle = colour;
    ctx.fillRect(x + 3, toY(series.high[index]!), 2, toY(series.low[index]!) - toY(series.high[index]!));
    if (hollow && rising) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1.5, top, 5, Math.max(2, bottom - top));
    } else {
      ctx.fillRect(x + 1, top, 6, Math.max(2, bottom - top));
    }
    const volume = series.volume[index]! * volumeHeight;
    ctx.fillStyle = rising ? DECOR_PALETTE.upDim : DECOR_PALETTE.downDim;
    ctx.fillRect(x + 1, volumeBottom - volume, 6, volume);
  }

  strokePeriodic(ctx, fast, CANDLE_PITCH, 4, toY, DECOR_PALETTE.electricBlue, 2);
  strokePeriodic(ctx, slow, CANDLE_PITCH, 4, toY, DECOR_PALETTE.amber, 1.5);
  // Divider between price and volume panes.
  ctx.fillStyle = DECOR_PALETTE.gridStrong;
  ctx.fillRect(0, chartBottom + 6, ATLAS, 1);
}

const LINE_PITCH = 4;

function drawLineBand(ctx: DecorContext, band: DecorBand, seed: number): void {
  fillBand(ctx, band);
  drawGrid(ctx, band.y, band.height, 128, 32);
  const samples = ATLAS / LINE_PITCH;
  const main = periodicWave(seed, samples);
  const second = periodicWave(seed + 1, samples);
  const third = periodicWave(seed + 2, samples);
  const top = band.y + 12;
  const bottom = band.y + band.height - 10;
  const toY = normaliser(main, top + 10, bottom - 14);

  // Area under the main line, fading to the floor of the band.
  const gradient = ctx.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, 'rgba(40, 144, 248, 0.45)');
  gradient.addColorStop(1, 'rgba(40, 144, 248, 0.02)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(-2 * LINE_PITCH, bottom);
  for (let index = -2; index <= samples + 2; index++) {
    ctx.lineTo(index * LINE_PITCH, toY(main[((index % samples) + samples) % samples]!));
  }
  ctx.lineTo((samples + 2) * LINE_PITCH, bottom);
  ctx.closePath();
  ctx.fill();

  strokePeriodic(ctx, third, LINE_PITCH, 0, normaliser(third, top, bottom), DECOR_PALETTE.neonLime, 1);
  strokePeriodic(ctx, second, LINE_PITCH, 0, normaliser(second, top + 20, bottom), DECOR_PALETTE.amber, 1.5);
  strokePeriodic(ctx, main, LINE_PITCH, 0, toY, DECOR_PALETTE.electricBlue, 2.5);
}

/** Order-book heatmap ramp: dark navy, blue, cyan, amber, red. */
export function heatColour(value: number): string {
  const v = Math.max(0, Math.min(1, value));
  const stops: readonly (readonly [number, number, number, number])[] = [
    [0, 2, 8, 24],
    [0.35, 0, 40, 120],
    [0.6, 40, 144, 248],
    [0.78, 90, 230, 255],
    [0.9, 255, 170, 30],
    [1, 255, 70, 50],
  ];
  for (let index = 1; index < stops.length; index++) {
    const [p1, r1, g1, b1] = stops[index]!;
    const [p0, r0, g0, b0] = stops[index - 1]!;
    if (v <= p1) {
      const t = (v - p0) / (p1 - p0);
      const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
      return `rgb(${mix(r0, r1)}, ${mix(g0, g1)}, ${mix(b0, b1)})`;
    }
  }
  return 'rgb(255, 70, 50)';
}

const HEAT_CELL = 8;

function drawHeatBand(ctx: DecorContext, band: DecorBand, seed: number): void {
  fillBand(ctx, band);
  const columns = ATLAS / HEAT_CELL;
  const rows = Math.floor(band.height / HEAT_CELL);
  const random = decorRandom(seed);
  const price = periodicWave(seed + 7, columns);
  const toRow = normaliser(price, 3, rows - 4);
  // Resting liquidity "walls": rows that stay bright across time, breathing on
  // integer cycles so they tile.
  const walls = Array.from({ length: 4 }, () => ({
    row: Math.floor(random() * rows),
    strength: 0.55 + random() * 0.4,
    cycles: 1 + Math.floor(random() * 3),
    phase: random() * Math.PI * 2,
  }));
  for (let column = 0; column < columns; column++) {
    const t = (column / columns) * Math.PI * 2;
    const priceRow = toRow(price[column]!);
    for (let row = 0; row < rows; row++) {
      let value = random() * 0.22;
      const distance = Math.abs(row - priceRow);
      value += Math.max(0, 0.75 - distance * 0.16);
      for (const wall of walls) {
        if (wall.row === row) value += wall.strength * (0.65 + 0.35 * Math.sin(t * wall.cycles + wall.phase));
      }
      ctx.fillStyle = heatColour(value);
      ctx.fillRect(column * HEAT_CELL, band.y + row * HEAT_CELL, HEAT_CELL - 1, HEAT_CELL - 1);
    }
  }
  // The traded price threads through the book.
  strokePeriodic(
    ctx,
    price,
    HEAT_CELL,
    HEAT_CELL / 2,
    (value) => band.y + toRow(value) * HEAT_CELL + HEAT_CELL / 2,
    DECOR_PALETTE.signalWhite,
    2,
  );
}

const BAR_PITCH = 8;

function drawBarsBand(ctx: DecorContext, band: DecorBand, seed: number): void {
  fillBand(ctx, band);
  drawGrid(ctx, band.y, band.height, 64, 24);
  const count = ATLAS / BAR_PITCH;
  const random = decorRandom(seed);
  const flow = periodicWave(seed + 3, count);
  const mid = band.y + band.height / 2;
  ctx.fillStyle = DECOR_PALETTE.gridStrong;
  ctx.fillRect(0, mid, ATLAS, 1);
  for (let index = 0; index < count; index++) {
    const delta = flow[index]! * 0.6 + (random() - 0.5) * 0.9;
    const height = Math.min(band.height / 2 - 6, Math.abs(delta) * 26 + 2);
    ctx.fillStyle = delta >= 0 ? DECOR_PALETTE.up : DECOR_PALETTE.down;
    ctx.fillRect(index * BAR_PITCH + 1, delta >= 0 ? mid - height : mid + 1, 6, height);
  }
  // Cumulative flow, amber, on its own loop.
  strokePeriodic(ctx, flow, BAR_PITCH, 4, normaliser(flow, band.y + 8, band.y + band.height - 8), DECOR_PALETTE.amber, 2);
}

// ---------------------------------------------------------------------------
// Static atlas pieces: headers (blocks, never text), depth panels, swatches
// ---------------------------------------------------------------------------

/** A Bloomberg-style header bar with BLOCKS where the words would be. */
function drawDeskHeader(ctx: DecorContext, rect: AtlasRect, variant: number): void {
  const random = decorRandom(0x4ead + variant * 97);
  ctx.fillStyle = variant % 3 === 0 ? '#1a1206' : DECOR_PALETTE.headerBar;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  const blockY = rect.y + 5;
  const blockH = rect.height - 10;
  let x = rect.x + 6;
  ctx.fillStyle = DECOR_PALETTE.amber;
  const title = 34 + Math.floor(random() * 30);
  ctx.fillRect(x, blockY, title, blockH);
  x += title + 10;
  const blocks = 3 + Math.floor(random() * 3);
  for (let index = 0; index < blocks && x < rect.x + rect.width - 40; index++) {
    const width = 10 + Math.floor(random() * 22);
    ctx.fillStyle = index % 2 === 0 ? DECOR_PALETTE.headerBlock : DECOR_PALETTE.amberDim;
    ctx.fillRect(x, blockY, width, blockH);
    x += width + 6;
  }
  const status = [DECOR_PALETTE.up, DECOR_PALETTE.down, DECOR_PALETTE.electricBlue][variant % 3]!;
  ctx.fillStyle = status;
  ctx.fillRect(rect.x + rect.width - 22, blockY, 14, blockH);
  ctx.fillStyle = DECOR_PALETTE.amberDim;
  ctx.fillRect(rect.x, rect.y + rect.height - 1, rect.width, 1);
}

/**
 * A three-slash claw mark: tapered, curved scratches filled as crescents, the
 * middle one longest. A generic motif, NOT the brand logo (BRAND.md §5 forbids
 * retyping or recolouring the official marks; this is neither). Drawn as fills
 * rather than strokes so it reads as a claw at LED size, not as "///".
 */
export function drawClawMark(ctx: DecorContext, x: number, y: number, size: number, colour: string): void {
  ctx.fillStyle = colour;
  const belly = Math.max(1.5, size * 0.12);
  for (let slash = 0; slash < 3; slash++) {
    const inset = slash === 1 ? 0 : size * 0.1;
    const sx = x + slash * size * 0.32;
    const topX = sx + size * 0.34;
    const topY = y + inset;
    const bottomX = sx;
    const bottomY = y + size - inset;
    const midY = (topY + bottomY) / 2;
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.quadraticCurveTo(sx + size * 0.06 - belly, midY, bottomX, bottomY);
    ctx.quadraticCurveTo(sx + size * 0.06 + belly, midY, topX, topY);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * A lobster CLAW, the ribbon's separator: two curved pincer fingers forming an
 * open V on a short segmented wrist, after the brand claw art
 * (`public/assets/slot-symbols/claw.png`) but drawn with paths, never loaded.
 * The big finger carries two small spikes on its outer edge, the detail that
 * makes it read as a claw rather than a "V" at LED size. `size` is the height;
 * the mark is ~0.9 x size wide, its box starting at (x, y).
 */
export function drawClawIcon(ctx: DecorContext, x: number, y: number, size: number, colour: string, shade: string): void {
  const px = (u: number) => x + u * size;
  const py = (v: number) => y + v * size;
  ctx.fillStyle = colour;

  // Big finger (right): a fat horn, bulging outward, curling in to its tip.
  ctx.beginPath();
  ctx.moveTo(px(0.82), py(0.76));
  ctx.bezierCurveTo(px(1.04), py(0.52), px(0.98), py(0.1), px(0.62), py(0.0));
  // The inner edge runs nearly straight down to the crotch: that straight
  // edge is what makes the gap a V and not a round hole.
  ctx.quadraticCurveTo(px(0.66), py(0.34), px(0.52), py(0.64));
  ctx.closePath();
  ctx.fill();
  // Two small spikes on its outer edge, pointing out.
  for (const [u, v] of [[0.96, 0.46], [0.94, 0.26]] as const) {
    ctx.beginPath();
    ctx.moveTo(px(u - 0.06), py(v - 0.05));
    ctx.lineTo(px(u + 0.08), py(v));
    ctx.lineTo(px(u - 0.06), py(v + 0.06));
    ctx.closePath();
    ctx.fill();
  }

  // Small finger (left): shorter and slimmer, curving up and in. The gap
  // between the two tips is the open V.
  ctx.beginPath();
  ctx.moveTo(px(0.22), py(0.76));
  ctx.bezierCurveTo(px(-0.02), py(0.56), px(0.02), py(0.16), px(0.24), py(0.06));
  ctx.quadraticCurveTo(px(0.3), py(0.36), px(0.46), py(0.64));
  ctx.closePath();
  ctx.fill();

  // Wrist: a short block under the V, two segment lines like the brand art.
  ctx.fillRect(px(0.24), py(0.66), size * 0.56, size * 0.34);
  ctx.fillStyle = shade;
  const line = Math.max(1, size * 0.045);
  ctx.fillRect(px(0.24), py(0.76), size * 0.56, line);
  ctx.fillRect(px(0.24), py(0.88), size * 0.56, line);
}

function drawWallHeader(ctx: DecorContext, rect: AtlasRect, variant: number): void {
  const random = decorRandom(0xc1a7 + variant * 31);
  const gradient = ctx.createLinearGradient(rect.x, 0, rect.x + rect.width, 0);
  gradient.addColorStop(0, DECOR_PALETTE.panelNavy);
  gradient.addColorStop(1, '#000a26');
  ctx.fillStyle = gradient;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  drawClawMark(ctx, rect.x + 9, rect.y + 6, rect.height - 12, DECOR_PALETTE.champagneGold);
  const blockY = rect.y + 10;
  const blockH = rect.height - 20;
  let x = rect.x + 40;
  ctx.fillStyle = DECOR_PALETTE.champagneGold;
  ctx.fillRect(x, blockY, 120, blockH);
  x += 132;
  for (let index = 0; index < 5 && x < rect.x + rect.width - 70; index++) {
    const width = 16 + Math.floor(random() * 34);
    ctx.fillStyle = index % 2 === 0 ? '#2a3f6e' : '#1c2c52';
    ctx.fillRect(x, blockY, width, blockH);
    x += width + 8;
  }
  ctx.fillStyle = DECOR_PALETTE.electricBlue;
  ctx.fillRect(rect.x + rect.width - 56, blockY, 18, blockH);
  ctx.fillStyle = DECOR_PALETTE.up;
  ctx.fillRect(rect.x + rect.width - 32, blockY, 18, blockH);
  ctx.fillStyle = DECOR_PALETTE.electricBlue;
  ctx.fillRect(rect.x, rect.y + rect.height - 2, rect.width, 2);
}

/** Cumulative bid / ask staircases meeting at the mid. Static: a snapshot. */
function drawDepthPanel(ctx: DecorContext, rect: AtlasRect, variant: number): void {
  const random = decorRandom(0xde97 + variant * 13);
  ctx.fillStyle = DECOR_PALETTE.screenBg;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = DECOR_PALETTE.grid;
  for (let x = rect.x + 30; x < rect.x + rect.width; x += 30) ctx.fillRect(x, rect.y, 1, rect.height);
  for (let y = rect.y + 25; y < rect.y + rect.height; y += 25) ctx.fillRect(rect.x, y, rect.width, 1);
  const mid = rect.x + rect.width / 2;
  const floor = rect.y + rect.height - 6;
  const steps = 12;
  for (const side of [-1, 1] as const) {
    const colour = side < 0 ? DECOR_PALETTE.up : DECOR_PALETTE.down;
    let depth = 0;
    ctx.beginPath();
    ctx.moveTo(mid + side * 4, floor);
    for (let step = 0; step <= steps; step++) {
      depth += 0.4 + random() * (step > steps - 3 ? 2.2 : 1);
      const x = mid + side * (4 + (step / steps) * (rect.width / 2 - 8));
      const y = floor - Math.min(rect.height - 14, depth * 7.5);
      ctx.lineTo(x, y);
      if (step < steps) ctx.lineTo(mid + side * (4 + ((step + 1) / steps) * (rect.width / 2 - 8)), y);
    }
    ctx.lineTo(mid + side * (rect.width / 2 - 4), floor);
    ctx.closePath();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.fillStyle = DECOR_PALETTE.amber;
  ctx.fillRect(mid - 1, rect.y + 6, 2, rect.height - 12);
}

/**
 * The whole monitor atlas, once. Order matters only for the gutters: the
 * background goes down first so every unused pixel is screen black.
 */
export function drawDecorAtlas(ctx: DecorContext): void {
  ctx.fillStyle = DECOR_SWATCH_COLORS.screenBlack;
  ctx.fillRect(0, 0, ATLAS, ATLAS);
  drawCandleBand(ctx, DECOR_BANDS.candleA, 0xa11ce, false);
  drawCandleBand(ctx, DECOR_BANDS.candleB, 0xb0b, true);
  drawLineBand(ctx, DECOR_BANDS.line, 0x11e);
  drawHeatBand(ctx, DECOR_BANDS.heat, 0x4ea7);
  drawBarsBand(ctx, DECOR_BANDS.bars, 0xba25);
  for (let variant = 0; variant < DECOR_DESK_HEADER_COUNT; variant++) {
    drawDeskHeader(ctx, deskHeaderRect(variant), variant);
  }
  for (let variant = 0; variant < DECOR_WALL_HEADER_COUNT; variant++) {
    drawWallHeader(ctx, wallHeaderRect(variant), variant);
  }
  for (let variant = 0; variant < DECOR_DEPTH_PANEL_COUNT; variant++) {
    drawDepthPanel(ctx, depthPanelRect(variant), variant);
  }
  for (const id of DECOR_SWATCH_IDS) {
    const rect = swatchRect(id);
    ctx.fillStyle = DECOR_SWATCH_COLORS[id];
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
}

// ---------------------------------------------------------------------------
// Glow sprite
// ---------------------------------------------------------------------------

/** White, with the strength in alpha: the vertex colour tints it. The falloff
 *  reaches zero INSIDE the square, so no pool shows a square edge. */
export function drawGlowSprite(ctx: DecorContext): void {
  const size = GLOW_SPRITE_SIZE;
  const half = size / 2;
  ctx.clearRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half - 1);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.55)');
  gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.14)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
}

// ---------------------------------------------------------------------------
// The ticker ribbon: text (pure) and strip art
// ---------------------------------------------------------------------------

/** The only words the ribbon says that are not a tape row. */
export const RIBBON_BRAND_PHRASES = Object.freeze([
  'CLAWVILLE EXCHANGE',
  'TRADING ARENA',
  'AGENTS TRADE HERE',
] as const);
/**
 * The tag on EVERY trade that prints a dollar figure. The board writes PAPER
 * twice for the same reason: a P&L figure a reader could take for real money
 * is the one dishonesty a wall can commit while every number on it is right.
 * Once per strip was not enough: a single wall shows only part of a strip
 * period, so a figure could be on screen with no PAPER anywhere near it. On
 * the segment itself, PAPER travels with the figure through any packing.
 */
export const RIBBON_PAPER_TAG = 'PAPER';
/** Newest rows offered to the packer; it keeps only what fits the strip. */
export const RIBBON_MAX_ITEMS = 8;

/** `label` is the colour of the PAPER tag; no segment carries it as a tone. */
export type RibbonTone = 'brand' | 'label' | TapeChipKind;

export interface RibbonTextSegment {
  readonly text: string;
  readonly tone: RibbonTone;
}

/**
 * What the ribbon says, in crawl order. Honest by construction: every trade is
 * the board's own tape row (`tapeTraderName` + `classifyArenaTapeItem`, the
 * helpers `tapeLine` uses), minus the age, because the ribbon is not redrawn by
 * the clock and an age would go stale on the wall. A row with a dollar figure
 * ends in `RIBBON_PAPER_TAG`.
 *
 * DATA FIRST, then the error flag (room-wide rule, lead 2026-10-01): a FAILED
 * refetch keeps the last good tape, because react-query keeps `data` across a
 * refetch error. Only a tape that never arrived, or arrived empty, falls back
 * to the brand phrases. `isError` is therefore deliberately not consulted: a
 * failure with no data already has nothing to show.
 */
export function buildRibbonSegments(tape: { readonly data: unknown; readonly isError: boolean }): RibbonTextSegment[] {
  const brand = (index: number): RibbonTextSegment => ({
    text: RIBBON_BRAND_PHRASES[index % RIBBON_BRAND_PHRASES.length]!,
    tone: 'brand',
  });
  const items = readArenaTape(tape.data).slice(0, RIBBON_MAX_ITEMS);
  if (items.length === 0) return RIBBON_BRAND_PHRASES.map((_, index) => brand(index));

  const out: RibbonTextSegment[] = [brand(0)];
  items.forEach((item, index) => {
    const face = classifyArenaTapeItem(item);
    const parts = [tapeTraderName(item.agentName), face.action, face.amount];
    if (face.amount.length > 0) parts.push(RIBBON_PAPER_TAG);
    out.push({
      text: parts.filter((part) => part.length > 0).join(' '),
      tone: face.kind,
    });
    // A brand phrase after every second trade.
    if (index % 2 === 1 && index < items.length - 1) out.push(brand((index + 1) / 2));
  });
  for (const phrase of RIBBON_BRAND_PHRASES) {
    if (!out.some((segment) => segment.tone === 'brand' && segment.text === phrase)) {
      out.push({ text: phrase, tone: 'brand' });
    }
  }
  return out;
}

/** The redraw trigger. Nothing in a segment ticks, so equal text = no upload. */
export function ribbonSignature(segments: readonly RibbonTextSegment[]): string {
  return JSON.stringify(segments);
}

/**
 * 52 px bold in a 64 px strip on a 70 wu band: Courier New Bold capitals are
 * ~0.57 em, so ~30 canvas px, ~32 wu. From the spawn the side runs are
 * 1900-2500 wu away (~0.3 screen px per wu at 1366 x 768), which gives ~10
 * screen px capitals: twice the ~5 px where the board's bold glyphs began to
 * drop strokes (memory `canvas-texture-text-needs-mipmaps-and-bold-at-distance`).
 */
export const RIBBON_FONT = 'bold 52px "Courier New", monospace';
/** Room each claw separator takes, before the slack is shared out. */
export const RIBBON_SEPARATOR_PX = 72;
/** Height of the claw separator, canvas px: the panel between the rims is
 *  56 px, so 44 leaves a 6 px margin top and bottom. */
export const RIBBON_CLAW_PX = 44;
/** Dot pitch of the LED mask, canvas px. */
export const RIBBON_LED_PITCH = 4;

export const RIBBON_TONE_COLOUR: Readonly<Record<RibbonTone, string>> = Object.freeze({
  brand: '#ffc457',
  label: '#9fd0ff',
  buy: '#ffa21a',
  gain: '#34e07a',
  loss: '#ff4545',
  flat: '#c9d6e2',
});

export interface RibbonPlacement {
  readonly text: string;
  readonly tone: RibbonTone;
  /** Left edge of the text, canvas px. */
  readonly x: number;
  readonly width: number;
  /** Centre of the claw separator that FOLLOWS this text. */
  readonly separatorX: number;
}

/**
 * Lay the segments out across exactly one strip period.
 *
 * WHOLE segments only, in order, never a cut: a cut figure is a different
 * figure (the board learned this on `-$3.21`). The packer takes the longest
 * prefix that fits; if that is less than half the strip (brand phrases only),
 * it repeats the prefix. The slack is then shared equally between the
 * separators, so the content spans EXACTLY the strip width and the crawl wraps
 * with no seam: the strip is periodic like the atlas bands.
 */
export function layoutRibbon(
  ctx: Pick<DecorContext, 'font' | 'measureText'>,
  segments: readonly RibbonTextSegment[],
  stripWidth: number = RIBBON_CANVAS_WIDTH,
): RibbonPlacement[] {
  ctx.font = RIBBON_FONT;
  const measured = segments.map((segment) => ({ ...segment, width: ctx.measureText(segment.text).width }));
  const taken: typeof measured = [];
  let used = 0;
  for (const segment of measured) {
    const cost = segment.width + RIBBON_SEPARATOR_PX;
    if (used + cost > stripWidth) break;
    taken.push(segment);
    used += cost;
  }
  if (taken.length === 0) return [];
  const repeats = Math.max(1, Math.floor(stripWidth / used));
  const sequence: typeof measured = [];
  for (let copy = 0; copy < repeats; copy++) sequence.push(...taken);
  const slack = (stripWidth - used * repeats) / sequence.length;
  const placements: RibbonPlacement[] = [];
  let x = 0;
  for (const segment of sequence) {
    const gap = RIBBON_SEPARATOR_PX + slack;
    placements.push({
      text: segment.text,
      tone: segment.tone,
      x,
      width: segment.width,
      separatorX: x + segment.width + gap / 2,
    });
    x += segment.width + gap;
  }
  return placements;
}

/**
 * Paint the strip: dark rims, an LED panel, the text with a soft glow, gold
 * claw separators (`drawClawIcon`), then the dot mask over everything so the glyphs
 * read as lit LEDs. Called only when `ribbonSignature` changes.
 */
export function drawRibbonStrip(
  ctx: DecorContext,
  segments: readonly RibbonTextSegment[],
): RibbonPlacement[] {
  const width = RIBBON_CANVAS_WIDTH;
  const height = RIBBON_CANVAS_HEIGHT;
  const rim = RIBBON_RIM_ROWS;
  ctx.fillStyle = '#4a3818';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#b08d48';
  ctx.fillRect(0, rim - 1, width, 1);
  ctx.fillRect(0, height - rim, width, 1);
  ctx.fillStyle = '#100a04';
  ctx.fillRect(0, rim, width, height - rim * 2);

  const placements = layoutRibbon(ctx, segments, width);
  const baseline = height / 2 + 1;
  const tagSuffix = ` ${RIBBON_PAPER_TAG}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const glowText = (text: string, x: number, colour: string): void => {
    ctx.shadowColor = colour;
    ctx.shadowBlur = 10;
    ctx.fillStyle = colour;
    ctx.fillText(text, x, baseline);
    ctx.shadowBlur = 0;
    ctx.fillText(text, x, baseline);
  };
  for (const placement of placements) {
    // A trade's PAPER tag is drawn in its own colour so it never reads as part
    // of the token symbol. Monospace, so `body + ' '` measures to the tag's x.
    const tagged = placement.tone !== 'brand' && placement.text.endsWith(tagSuffix);
    const body = tagged ? placement.text.slice(0, -tagSuffix.length) : placement.text;
    glowText(body, placement.x, RIBBON_TONE_COLOUR[placement.tone]);
    if (tagged) {
      glowText(RIBBON_PAPER_TAG, placement.x + ctx.measureText(`${body} `).width, RIBBON_TONE_COLOUR.label);
    }
    drawClawIcon(ctx, placement.separatorX - RIBBON_CLAW_PX * 0.45, rim + 6, RIBBON_CLAW_PX, '#d4a94e', '#4a3818');
  }
  ctx.shadowBlur = 0;

  // LED mask: dark lines between the dots. The pitch divides the strip width,
  // so the mask tiles with the text. Light enough (0.35) that the mip chain,
  // which averages the mask into the glyphs at a distance, keeps the contrast.
  ctx.fillStyle = 'rgba(6, 4, 2, 0.35)';
  for (let x = 0; x < width; x += RIBBON_LED_PITCH) ctx.fillRect(x, rim, 1, height - rim * 2);
  for (let y = rim; y < height - rim; y += RIBBON_LED_PITCH) ctx.fillRect(0, y, width, 1);
  return placements;
}
