/**
 * Phase 6.1 — slice 5: browser-safe provably-fair verifier.
 *
 * Pure-browser port of `apps/api/src/services/provable-rng.ts` (slice 1)
 * and `slot-engine.ts` (slice 2). Same inputs ⇒ byte-identical bytes,
 * byte-identical sampled integers, byte-identical SpinResult. The slice-5
 * acceptance test is the byte-identity property: anything that differs
 * here from the server is a verifier bug.
 *
 * Why this exists separately from the server module:
 *   - Server uses Node `crypto` (createHmac, createHash, randomBytes).
 *     Those are unavailable in the browser; we use WebCrypto via the
 *     `crypto.subtle` API instead.
 *   - The server module imports paytables from `@clawville/shared`; the
 *     verifier imports the same constants so reel-strip and line shapes
 *     match exactly. (Drift between web and api is impossible — single
 *     source of truth.)
 *   - The server runs SYNCHRONOUSLY (`createHmac(...).digest()`). WebCrypto
 *     is async — `crypto.subtle.sign` returns a Promise. The exported
 *     `runSpinLocal` is async as a result; verifier UI awaits it.
 *
 * Hashing convention (CRITICAL, matches server file docstring):
 *   - sha256Hex hashes the **UTF-8 bytes of the input string**, NOT the
 *     hex-decoded bytes. `sha256Hex(serverSeedHex)` re-derives the
 *     commit hash exactly the way `serverSeedHash` was originally
 *     generated.
 *   - The HMAC key is the **raw bytes** that the hex serverSeed
 *     represents (`hexToBytes(serverSeed)`).
 *   - HMAC message is `${clientSeed}:${nonce}:${blockIndex}` encoded as
 *     UTF-8 — `:` never collides with hex digits or ASCII integers.
 *   - clientSeed is lowercased before going into the HMAC message;
 *     serverSeed is lowercased before being interpreted as hex.
 *   - All caps match the server: CLIENT_SEED_MAX_LENGTH=256,
 *     MAX_BYTE_COUNT=65536, BLOCK_SIZE=32, SAMPLE_WIDTH=4.
 */

import {
  CLASSIC_LINES,
  CLASSIC_REEL_STRIPS,
  CLASSIC_SYMBOLS,
  BONUS_REEL_STRIPS,
  BONUS_SYMBOLS,
  FREE_SPIN_RULES,
  SCATTER_PAY_TABLE,
  WILD_MULTIPLIER_TABLE,
} from '@clawville/shared';

import type {
  SpinResult,
  WinningLine,
  WildMultiplier,
  SymbolId,
  MachineSlug,
} from './types';

// ---------------------------------------------------------------------------
// Constants — must match `apps/api/src/services/provable-rng.ts` exactly.
// ---------------------------------------------------------------------------

export const BLOCK_SIZE = 32;
export const SAMPLE_WIDTH = 4;
export const CLIENT_SEED_MAX_LENGTH = 256;
export const MAX_BYTE_COUNT = 65536;

const TWO_POW_32 = 0x1_0000_0000;
const SERVER_SEED_HEX_LEN = 64;
const LOWERCASE_HEX = /^[0-9a-f]+$/;
const ANY_CASE_HEX = /^[0-9a-fA-F]+$/;

// ---------------------------------------------------------------------------
// Public types — mirror the server slot-engine + provable-rng surface.
// ---------------------------------------------------------------------------

export interface DerivedBytes {
  bytes: Uint8Array;
  cursorAfter: number;
}

export interface SampledInt {
  value: number;
  bytesConsumed: number;
}

export interface DeriveBytesArgs {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursor: number;
  byteCount: number;
}

export interface SampleIntFromBytesArgs {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursorStart: number;
  min: number;
  max: number;
}

export interface RunSpinLocalArgs {
  paytableId: MachineSlug;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursor: number;
  predict: bigint;
  /**
   * Phase 6.1.5 (Bundle B) — when true, evaluate as a FREE spin:
   *   • line wins are multiplied by `FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER`
   *     (1 in the shipped rules — line wins NOT doubled per the RTP-shape
   *     decision; see `slot-paytables.ts` commentary).
   *   • wild multiplier products amplify line wins crossing those cells.
   *   • per-Wild multiplier values are doubled iff
   *     `FREE_SPIN_RULES.FS_WILD_MULTIPLIER_DOUBLE` is true (false in
   *     the shipped rules).
   *   • scatter pay-anywhere is NOT doubled in FS mode.
   *   • a 3+ scatter retrigger awards `FREE_SPIN_RULES.AWARD_RETRIGGER`
   *     spins (vs. `AWARD_BASE` in base mode).
   *
   * Default false. ALWAYS false on `classic-3x5` (no bonus paytable).
   */
  freeSpinMode?: boolean;
}

/**
 * Phase 6.1.5 — options passed to `evaluateReelsLocal` so the bonus
 * paytable can apply wild multipliers + free-spin line scalar without
 * changing the existing slice-2 call site. Defaults reproduce slice-2
 * line math byte-for-byte (empty wilds + scalar=1).
 */
export interface EvaluateReelsLocalOptions {
  /**
   * Per-cell wild multipliers (output of `runSpinLocal`'s wild-detection
   * pass). Engine multiplies a line's payout by the PRODUCT of any wild
   * multipliers that sit on the matchLen prefix of that line.
   */
  wildMultipliers?: readonly WildMultiplier[];
  /**
   * Scalar applied to every line win AFTER wild-multiplier products.
   * In free-spin mode this is `FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER`
   * (1 in the shipped rules). 1 in base mode.
   */
  freeSpinLineMultiplier?: number;
}

// ---------------------------------------------------------------------------
// WebCrypto helpers
// ---------------------------------------------------------------------------

function getCrypto(): Crypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }
  throw new Error(
    'verifier: WebCrypto unavailable. The verifier runs in the browser; ' +
      'SSR callers must wrap usage in a useEffect.',
  );
}

/** UTF-8 encode a string. */
const utf8 = new TextEncoder();

/** Decode hex (any case) to Uint8Array. Rejects odd-length / non-hex input. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('verifier: hex string has odd length');
  }
  if (!ANY_CASE_HEX.test(hex)) {
    throw new Error('verifier: hex string contains non-hex characters');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/** Encode Uint8Array to lowercase hex. */
function bytesToHex(bytes: Uint8Array): string {
  const chars: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    chars[i] = bytes[i]!.toString(16).padStart(2, '0');
  }
  return chars.join('');
}

/**
 * sha256 of an arbitrary string, lowercase hex output. Hashes the UTF-8
 * bytes of the input string (matches server `sha256Hex`). NOT
 * hex-decoded — callers pass the hex STRING and we hash its UTF-8 bytes.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = utf8.encode(input);
  const digest = await getCrypto().subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * HMAC-SHA256 over `message` keyed by `key`. Returns the 32-byte tag.
 * Matches Node `createHmac('sha256', key).update(message).digest()`.
 */
async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const subtle = getCrypto().subtle;
  // WebCrypto refuses a zero-length key on some implementations; the
  // server module accepts any 32-byte key, including all-zero, so we
  // mirror that. SHA256 HMAC with an empty key is well-defined though
  // we never hit it in practice (server seed is 32 bytes).
  // `importKey` operates on a SLICE of the buffer to avoid the
  // "shared buffer" SAB constraint some browsers enforce.
  const slice = key.slice();
  const cryptoKey = await subtle.importKey(
    'raw',
    slice,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', cryptoKey, message.slice());
  return new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function normalizeServerSeed(serverSeed: string): string {
  if (typeof serverSeed !== 'string') {
    throw new Error('verifier: serverSeed must be a string');
  }
  const lower = serverSeed.toLowerCase();
  if (lower.length !== SERVER_SEED_HEX_LEN) {
    throw new Error(
      `verifier: serverSeed must be ${SERVER_SEED_HEX_LEN} hex chars, got ${lower.length}`,
    );
  }
  if (!LOWERCASE_HEX.test(lower)) {
    throw new Error('verifier: serverSeed must be hex ([0-9a-fA-F])');
  }
  return lower;
}

function normalizeClientSeed(clientSeed: string): string {
  if (typeof clientSeed !== 'string') {
    throw new Error('verifier: clientSeed must be a string');
  }
  if (clientSeed.length === 0) {
    throw new Error('verifier: clientSeed must be non-empty');
  }
  if (clientSeed.length > CLIENT_SEED_MAX_LENGTH) {
    throw new Error(
      `verifier: clientSeed too long (max ${CLIENT_SEED_MAX_LENGTH} hex chars, got ${clientSeed.length})`,
    );
  }
  if (!ANY_CASE_HEX.test(clientSeed)) {
    throw new Error('verifier: clientSeed must be a hex string ([0-9a-fA-F]+)');
  }
  return clientSeed.toLowerCase();
}

// ---------------------------------------------------------------------------
// deriveBytes — port of server `deriveBytes`.
// ---------------------------------------------------------------------------

export async function deriveBytes(args: DeriveBytesArgs): Promise<DerivedBytes> {
  const { nonce, cursor, byteCount } = args;
  const serverSeed = normalizeServerSeed(args.serverSeed);
  const clientSeed = normalizeClientSeed(args.clientSeed);

  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`verifier.deriveBytes: nonce must be a non-negative integer, got ${nonce}`);
  }
  if (nonce > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `verifier.deriveBytes: nonce exceeds MAX_SAFE_INTEGER (${nonce})`,
    );
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error(`verifier.deriveBytes: cursor must be a non-negative integer, got ${cursor}`);
  }
  if (!Number.isInteger(byteCount) || byteCount <= 0) {
    throw new Error(`verifier.deriveBytes: byteCount must be a positive integer, got ${byteCount}`);
  }
  if (byteCount > MAX_BYTE_COUNT) {
    throw new Error(
      `verifier.deriveBytes: byteCount exceeds MAX_BYTE_COUNT (${MAX_BYTE_COUNT}, got ${byteCount})`,
    );
  }
  if (cursor > Number.MAX_SAFE_INTEGER - byteCount) {
    throw new Error('verifier.deriveBytes: cursor + byteCount would overflow MAX_SAFE_INTEGER');
  }

  const startBlock = Math.floor(cursor / BLOCK_SIZE);
  const endBlock = Math.floor((cursor + byteCount - 1) / BLOCK_SIZE);
  const blockCount = endBlock - startBlock + 1;

  const key = hexToBytes(serverSeed);
  const blocks: Uint8Array[] = new Array(blockCount);
  for (let i = 0; i < blockCount; i++) {
    const blockIndex = startBlock + i;
    const message = utf8.encode(`${clientSeed}:${nonce}:${blockIndex}`);
    // eslint-disable-next-line no-await-in-loop -- sequential by design, blocks form a stream
    blocks[i] = await hmacSha256(key, message);
  }

  // Concatenate blocks into a single buffer.
  const stream = new Uint8Array(blockCount * BLOCK_SIZE);
  for (let i = 0; i < blockCount; i++) {
    stream.set(blocks[i]!, i * BLOCK_SIZE);
  }

  const localOffset = cursor - startBlock * BLOCK_SIZE;
  // .slice() copies the bytes so callers can't mutate the larger buffer.
  const bytes = stream.slice(localOffset, localOffset + byteCount);

  return { bytes, cursorAfter: cursor + byteCount };
}

// ---------------------------------------------------------------------------
// sampleIntFromBytes — port of server `sampleIntFromBytes`.
// ---------------------------------------------------------------------------

/**
 * Read a little-endian uint32 from the first 4 bytes of `b`.
 * Mirrors Node `Buffer.readUInt32LE(0)`.
 */
function readUInt32LE(b: Uint8Array): number {
  if (b.length < 4) throw new Error('verifier: readUInt32LE needs ≥4 bytes');
  // Use unsigned right shift to coerce to uint32 (JS bitwise ops are i32).
  return (
    (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0
  );
}

export async function sampleIntFromBytes(
  args: SampleIntFromBytesArgs,
): Promise<SampledInt> {
  const { nonce, cursorStart, min, max } = args;
  const serverSeed = normalizeServerSeed(args.serverSeed);
  const clientSeed = normalizeClientSeed(args.clientSeed);

  if (!Number.isInteger(min)) {
    throw new Error(`verifier.sampleIntFromBytes: min must be an integer, got ${min}`);
  }
  if (!Number.isInteger(max)) {
    throw new Error(`verifier.sampleIntFromBytes: max must be an integer, got ${max}`);
  }
  if (max <= min) {
    throw new Error(`verifier.sampleIntFromBytes: max must be > min, got min=${min} max=${max}`);
  }
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`verifier.sampleIntFromBytes: nonce must be a non-negative integer, got ${nonce}`);
  }
  if (!Number.isInteger(cursorStart) || cursorStart < 0) {
    throw new Error(
      `verifier.sampleIntFromBytes: cursorStart must be a non-negative integer, got ${cursorStart}`,
    );
  }

  const range = max - min;
  if (range > TWO_POW_32) {
    throw new Error(
      `verifier.sampleIntFromBytes: range (max - min) must be <= 2^32, got ${range}`,
    );
  }

  const threshold = TWO_POW_32 - (TWO_POW_32 % range);
  let bytesConsumed = 0;
  for (let attempt = 0; attempt < 64; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- rejection sampling is intrinsically serial
    const { bytes } = await deriveBytes({
      serverSeed,
      clientSeed,
      nonce,
      cursor: cursorStart + bytesConsumed,
      byteCount: SAMPLE_WIDTH,
    });
    const u32 = readUInt32LE(bytes);
    bytesConsumed += SAMPLE_WIDTH;
    if (u32 < threshold) {
      return { value: (u32 % range) + min, bytesConsumed };
    }
  }

  throw new Error(
    `verifier.sampleIntFromBytes: rejection sampling failed after 64 attempts (range=${range})`,
  );
}

// ---------------------------------------------------------------------------
// Paytable lookup — local mirror of the server's `PaytableBundle`.
// Phase 6.1.5 adds `classic-3x5-bonus` with the scatter id pre-resolved
// from the BONUS_SYMBOLS table so the runSpin path can branch cheaply.
// ---------------------------------------------------------------------------

interface VerifierBundle {
  id: MachineSlug;
  symbols: readonly { id: number; isWild?: boolean; isScatter?: boolean; payouts: readonly number[] }[];
  lines: typeof CLASSIC_LINES;
  reelStrips: readonly (readonly number[])[];
  wildId: SymbolId;
  /**
   * Bundle B — scatter symbol id, or null if the paytable has no scatter
   * (classic-3x5). Set ONCE here from `isScatter` flag.
   */
  scatterId: SymbolId | null;
}

function buildVerifierBundle(
  id: MachineSlug,
  symbols: readonly { id: number; isWild?: boolean; isScatter?: boolean; payouts: readonly number[] }[],
  lines: typeof CLASSIC_LINES,
  reelStrips: readonly (readonly number[])[],
): VerifierBundle {
  const wild = symbols.find((s) => s.isWild);
  if (!wild) throw new Error(`verifier: paytable '${id}' has no wild symbol`);
  const scatters = symbols.filter((s) => s.isScatter);
  if (scatters.length > 1) {
    throw new Error(`verifier: paytable '${id}' has ${scatters.length} scatter symbols — at most one supported`);
  }
  const scatterId = scatters[0]?.id ?? null;
  if (scatterId !== null && symbols[scatterId]?.isWild) {
    throw new Error(`verifier: paytable '${id}' scatter id=${scatterId} is also wild — cannot be both`);
  }
  if (reelStrips.length !== 5) {
    throw new Error(`verifier: paytable '${id}' must have exactly 5 reel strips`);
  }
  return { id, symbols, lines, reelStrips, wildId: wild.id, scatterId };
}

const BUNDLES: Record<MachineSlug, VerifierBundle> = {
  'classic-3x5': buildVerifierBundle('classic-3x5', CLASSIC_SYMBOLS, CLASSIC_LINES, CLASSIC_REEL_STRIPS),
  'classic-3x5-bonus': buildVerifierBundle(
    'classic-3x5-bonus',
    BONUS_SYMBOLS,
    CLASSIC_LINES,
    BONUS_REEL_STRIPS,
  ),
};

export function getVerifierBundle(paytableId: MachineSlug): VerifierBundle {
  const bundle = BUNDLES[paytableId];
  if (!bundle) {
    throw new Error(`verifier: unknown paytableId '${paytableId}'`);
  }
  return bundle;
}

/**
 * Map a `sampleIntFromBytes(range=100)` draw → wild multiplier tier.
 * Mirrors server `wildMultiplierForDraw`. Buckets are cumulative; the
 * first tier whose `cum` strictly exceeds the draw wins.
 *
 * With the shipped table `[{cum:60,2},{cum:90,3},{cum:100,5}]`:
 *   draws  0..59  → 2×
 *   draws 60..89  → 3×
 *   draws 90..99  → 5×
 */
export function wildMultiplierForDrawLocal(draw: number): number {
  if (!Number.isInteger(draw) || draw < 0 || draw >= 100) {
    throw new Error(
      `verifier.wildMultiplierForDraw: expects 0 <= draw < 100, got ${draw}`,
    );
  }
  for (const tier of WILD_MULTIPLIER_TABLE) {
    if (draw < tier.cum) return tier.multiplier;
  }
  throw new Error(
    `verifier.wildMultiplierForDraw: WILD_MULTIPLIER_TABLE does not cover draw=${draw}`,
  );
}

// ---------------------------------------------------------------------------
// evaluateReelsLocal — synchronous, mirrors server `evaluateReels`.
// ---------------------------------------------------------------------------

export function evaluateReelsLocal(
  reels: readonly (readonly SymbolId[])[],
  paytableId: MachineSlug,
  predict: bigint,
  options: EvaluateReelsLocalOptions = {},
): { winningLines: WinningLine[]; winAmount: bigint } {
  const bundle = getVerifierBundle(paytableId);
  if (typeof predict !== 'bigint') {
    throw new Error(`verifier.evaluateReels: predict must be bigint, got ${typeof predict}`);
  }
  if (predict <= 0n) {
    throw new Error(`verifier.evaluateReels: predict must be > 0, got ${predict}`);
  }
  const lineCount = BigInt(bundle.lines.length);
  if (predict % lineCount !== 0n) {
    throw new Error(
      `verifier.evaluateReels: predict (${predict}) must be divisible by lineCount (${lineCount})`,
    );
  }
  if (reels.length !== 5) {
    throw new Error(`verifier.evaluateReels: reels must have 5 entries, got ${reels.length}`);
  }
  for (let r = 0; r < 5; r++) {
    const reel = reels[r]!;
    if (reel.length !== 3) {
      throw new Error(`verifier.evaluateReels: reels[${r}] must have 3 rows, got ${reel.length}`);
    }
    for (let c = 0; c < 3; c++) {
      const sym = reel[c];
      if (!Number.isInteger(sym) || (sym as number) < 0 || (sym as number) >= bundle.symbols.length) {
        throw new Error(
          `verifier.evaluateReels: reels[${r}][${c}]=${sym} out of range [0, ${bundle.symbols.length})`,
        );
      }
    }
  }

  const wildMultipliers = options.wildMultipliers ?? [];
  const freeSpinLineMultiplier = options.freeSpinLineMultiplier ?? 1;
  if (!Number.isInteger(freeSpinLineMultiplier) || freeSpinLineMultiplier < 1) {
    throw new Error(
      `verifier.evaluateReels: freeSpinLineMultiplier must be a positive integer, got ${freeSpinLineMultiplier}`,
    );
  }
  // Adversarial guard mirroring server: every passed wild multiplier
  // must sit on an actual WILD cell. Mismatch = caller lying about the
  // grid, which would inflate the payout.
  for (const wm of wildMultipliers) {
    if (
      !Number.isInteger(wm.reelIndex) || wm.reelIndex < 0 || wm.reelIndex >= 5 ||
      !Number.isInteger(wm.rowIndex) || wm.rowIndex < 0 || wm.rowIndex >= 3
    ) {
      throw new Error(
        `verifier.evaluateReels: wildMultiplier index out of range: reel=${wm.reelIndex}, row=${wm.rowIndex}`,
      );
    }
    if (reels[wm.reelIndex]![wm.rowIndex] !== bundle.wildId) {
      throw new Error(
        `verifier.evaluateReels: wildMultiplier at (${wm.reelIndex},${wm.rowIndex}) does not sit on a WILD cell`,
      );
    }
    if (!Number.isInteger(wm.multiplier) || wm.multiplier <= 0) {
      throw new Error(
        `verifier.evaluateReels: wildMultiplier.multiplier must be a positive integer, got ${wm.multiplier}`,
      );
    }
  }

  // Fast (reel,row) → multiplier lookup for the matchLen scan. Empty when
  // no wildMultipliers passed (classic-3x5 + base bonus spins).
  const wmLookup = new Map<number, number>();
  for (const wm of wildMultipliers) {
    wmLookup.set(wm.reelIndex * 3 + wm.rowIndex, wm.multiplier);
  }

  const perLinePredict = predict / lineCount;
  const winningLines: WinningLine[] = [];
  let totalWin = 0n;

  for (const line of bundle.lines) {
    const lineSymbols: SymbolId[] = new Array(5);
    for (let r = 0; r < 5; r++) {
      lineSymbols[r] = reels[r]![line.rows[r]]!;
    }

    // kindId = first non-wild, non-scatter symbol on the line.
    // Scatter NEVER counts as kind (its payouts are all zero anyway,
    // but explicit skip keeps the intent obvious + prevents accidental
    // scatter-line-match inflation when payouts table is later edited).
    let kindId: SymbolId | undefined;
    for (let r = 0; r < 5; r++) {
      const sym = lineSymbols[r]!;
      if (sym !== bundle.wildId && sym !== bundle.scatterId) {
        kindId = sym;
        break;
      }
    }
    if (kindId === undefined) {
      kindId = bundle.wildId;
    }

    // Scatter BREAKS the prefix run. A run "Cherry,Cherry,Scatter,Cherry"
    // pays 2-of-kind Cherry, NOT 4-of-kind. This mirrors the server.
    let matchLen = 0;
    for (let r = 0; r < 5; r++) {
      const sym = lineSymbols[r]!;
      if (sym === bundle.scatterId) break;
      if (sym === kindId || sym === bundle.wildId) {
        matchLen++;
      } else {
        break;
      }
    }
    if (matchLen < 2) continue;

    const symDef = bundle.symbols[kindId];
    if (!symDef) continue;
    const multiplier = symDef.payouts[matchLen - 2] ?? 0;
    if (multiplier <= 0) continue;

    let lineWin = perLinePredict * BigInt(multiplier);

    // Bundle B — multiply by the product of any wild multipliers on the
    // matchLen prefix of this line. No-op when wmLookup is empty.
    if (wmLookup.size > 0) {
      for (let r = 0; r < matchLen; r++) {
        const cellRow = line.rows[r]!;
        const key = r * 3 + cellRow;
        const wm = wmLookup.get(key);
        if (wm !== undefined) {
          lineWin *= BigInt(wm);
        }
      }
    }

    // Bundle B free-spin line scalar (1 in shipped rules — effectively
    // a no-op when FS_LINE_WIN_MULTIPLIER=1). Branch kept so re-enabling
    // doubling later only requires a constant flip.
    if (freeSpinLineMultiplier !== 1) {
      lineWin *= BigInt(freeSpinLineMultiplier);
    }

    winningLines.push({
      lineIndex: line.id,
      symbols: lineSymbols,
      winAmount: lineWin,
      multiplier,
    });
    totalWin += lineWin;
  }

  return { winningLines, winAmount: totalWin };
}

// ---------------------------------------------------------------------------
// runSpinLocal — async port of server `runSpin`.
// ---------------------------------------------------------------------------

export async function runSpinLocal(args: RunSpinLocalArgs): Promise<SpinResult> {
  const bundle = getVerifierBundle(args.paytableId);
  if (typeof args.predict !== 'bigint') {
    throw new Error(`verifier.runSpin: predict must be bigint, got ${typeof args.predict}`);
  }
  if (args.predict <= 0n) {
    throw new Error(`verifier.runSpin: predict must be > 0, got ${args.predict}`);
  }
  const lineCount = BigInt(bundle.lines.length);
  if (args.predict % lineCount !== 0n) {
    throw new Error(
      `verifier.runSpin: predict (${args.predict}) must be divisible by lineCount (${lineCount})`,
    );
  }
  if (!Number.isInteger(args.cursor) || args.cursor < 0) {
    throw new Error(`verifier.runSpin: cursor must be a non-negative integer, got ${args.cursor}`);
  }

  const isFreeSpin = args.freeSpinMode === true;

  // ---- Reel sampling (5 reel stops) ----
  const reels: SymbolId[][] = new Array(5);
  let cursor = args.cursor;
  for (let r = 0; r < 5; r++) {
    const strip = bundle.reelStrips[r]!;
    const stripLen = strip.length;
    // eslint-disable-next-line no-await-in-loop -- sequential RNG calls advance the cursor
    const { value: stop, bytesConsumed } = await sampleIntFromBytes({
      serverSeed: args.serverSeed,
      clientSeed: args.clientSeed,
      nonce: args.nonce,
      cursorStart: cursor,
      min: 0,
      max: stripLen,
    });
    cursor += bytesConsumed;
    const top = strip[(stop - 1 + stripLen) % stripLen]!;
    const middle = strip[stop]!;
    const bottom = strip[(stop + 1) % stripLen]!;
    reels[r] = [top, middle, bottom];
  }

  // ---- Wild multiplier draws (bonus paytable only) ----
  // Walk the visible window in (reel, row) order. Each landed WILD
  // consumes ONE more `sampleIntFromBytes(range=100)` call. Server runs
  // these draws on the bonus paytable regardless of mode (cursor advances
  // identically in base + FS — only the applied scalar differs).
  //
  // Detection key: `scatterId !== null` — classic-3x5 has no scatter, so
  // no multiplier draws happen there (preserving slice-2 cursor math
  // byte-for-byte). Mirrors server `isBonusPaytable` flag.
  const wildMultipliers: WildMultiplier[] = [];
  const isBonusPaytable = bundle.scatterId !== null;
  if (isBonusPaytable) {
    for (let r = 0; r < 5; r++) {
      for (let row = 0; row < 3; row++) {
        if (reels[r]![row] !== bundle.wildId) continue;
        // eslint-disable-next-line no-await-in-loop -- sequential cursor advancement
        const { value: draw, bytesConsumed } = await sampleIntFromBytes({
          serverSeed: args.serverSeed,
          clientSeed: args.clientSeed,
          nonce: args.nonce,
          cursorStart: cursor,
          min: 0,
          max: 100,
        });
        cursor += bytesConsumed;
        const baseMultiplier = wildMultiplierForDrawLocal(draw);
        // In FS mode emit the doubled value iff the rules flag says so;
        // otherwise emit the raw draw (informational in base mode).
        // Server applies the SAME logic in `runSpin` — verifier must
        // match byte-identically.
        const effectiveMultiplier = isFreeSpin && FREE_SPIN_RULES.FS_WILD_MULTIPLIER_DOUBLE
          ? baseMultiplier * 2
          : baseMultiplier;
        wildMultipliers.push({
          reelIndex: r,
          rowIndex: row,
          multiplier: effectiveMultiplier,
        });
      }
    }
  }

  // ---- Win evaluation ----
  // Bundle B: pass wildMultipliers + FS scalar ONLY in free-spin mode
  // (per the RTP-shape decision — see slot-paytables.ts commentary).
  // Base mode reproduces slice-2 line math byte-for-byte (empty wilds +
  // scalar=1).
  const evalOptions: EvaluateReelsLocalOptions = isFreeSpin
    ? {
        wildMultipliers,
        freeSpinLineMultiplier: FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER,
      }
    : {};
  const { winningLines, winAmount: lineWinTotal } = evaluateReelsLocal(
    reels,
    args.paytableId,
    args.predict,
    evalOptions,
  );

  // ---- Scatter pay-anywhere (bonus paytable only) ----
  let scatterPayout = 0n;
  let freeSpinsAwarded = 0;
  if (bundle.scatterId !== null) {
    let scatterCount = 0;
    for (let r = 0; r < 5; r++) {
      for (let row = 0; row < 3; row++) {
        if (reels[r]![row] === bundle.scatterId) scatterCount++;
      }
    }
    if (scatterCount >= FREE_SPIN_RULES.TRIGGER_THRESHOLD) {
      // Pay multiplier on TOTAL PREDICT (not perLine). Clamp to table
      // length to avoid OOB on a future 6-of-kind misprint.
      const tier =
        SCATTER_PAY_TABLE[Math.min(scatterCount, SCATTER_PAY_TABLE.length - 1)] ?? 0;
      scatterPayout = args.predict * BigInt(tier);
      // Free spin award: base trigger = 10 outside FS, +5 retrigger inside.
      // Engine emits per-spin award; SESSION cap (`CAP_REMAINING`) is the
      // route's responsibility — verifier replays per-spin value as-is.
      freeSpinsAwarded = isFreeSpin
        ? FREE_SPIN_RULES.AWARD_RETRIGGER
        : FREE_SPIN_RULES.AWARD_BASE;
    }
  }

  const winAmount = lineWinTotal + scatterPayout;

  return {
    reels,
    winningLines,
    winAmount,
    freeSpinsAwarded,
    isFreeSpin,
    wildMultipliers,
    scatterPayout,
    cursorAfter: cursor,
  };
}

// ---------------------------------------------------------------------------
// Replay comparison — used by the per-spin verifier page.
// ---------------------------------------------------------------------------

export interface SpinReplayInput {
  paytableId: MachineSlug;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursor: number;
  predict: bigint;
  /**
   * Phase 6.1.5 — was this spin executed in free-spin mode? Drives FS
   * cursor + payout math. Required for replay correctness; the session
   * verifier page reads `spin.isFreeSpin` (defaulting to false on legacy
   * classic-3x5 rows where the column may be absent).
   */
  freeSpinMode?: boolean;
  /**
   * Phase 6.1.10 — the paytable version this spin was recorded under.
   * 'v1' (pre-retune, classic 96% / bonus ~97.5% RTP) spins have winAmount
   * recorded with HISTORICAL payouts; replaying them through the current
   * engine (v2, 94% RTP) produces a winAmount mismatch even though reels
   * and cursor are byte-identical. The verifier branches on this to skip
   * the winAmount cross-check for v1 rows while still verifying reels +
   * cursor (the load-bearing provably-fair half).
   *
   * Missing/undefined ⇒ treat as 'v2' (current). Legacy rows pre-dating
   * the column migration carry 'v1' explicitly via the backfill.
   */
  paytableVersion?: 'v1' | 'v2';
  /** What the server stored for this spin (already-serialized winAmount string). */
  expected: {
    reels: SymbolId[][];
    winAmount: string;
    cursorAfter: number;
    /**
     * Phase 6.1.5 — server-recorded wild multipliers + scatter payout.
     * Optional so legacy classic-3x5 rows (no wildMultipliers/scatterPayout
     * column) still replay green. When present, the verifier deep-compares.
     */
    wildMultipliers?: readonly WildMultiplier[];
    scatterPayout?: string;
    freeSpinsAwarded?: number;
  };
}

export interface SpinReplayVerdict {
  ok: boolean;
  reasons: string[];
  computed: SpinResult;
}

export async function replaySpin(input: SpinReplayInput): Promise<SpinReplayVerdict> {
  const computed = await runSpinLocal({
    paytableId: input.paytableId,
    serverSeed: input.serverSeed,
    clientSeed: input.clientSeed,
    nonce: input.nonce,
    cursor: input.cursor,
    predict: input.predict,
    freeSpinMode: input.freeSpinMode,
  });

  const reasons: string[] = [];
  // Reels: deep equal (5×3 ints).
  if (computed.reels.length !== input.expected.reels.length) {
    reasons.push(
      `reels length mismatch: computed=${computed.reels.length}, expected=${input.expected.reels.length}`,
    );
  } else {
    for (let r = 0; r < computed.reels.length; r++) {
      const a = computed.reels[r]!;
      const b = input.expected.reels[r];
      if (!b || a.length !== b.length) {
        reasons.push(`reels[${r}] length mismatch`);
        continue;
      }
      for (let c = 0; c < a.length; c++) {
        if (a[c] !== b[c]) {
          reasons.push(`reels[${r}][${c}] mismatch: computed=${a[c]}, expected=${b[c]}`);
        }
      }
    }
  }
  // winAmount cross-check — gated on paytable version. v1 rows were
  // recorded under the pre-retune payouts; the current engine bundles
  // v2 payouts, so a recomputed winAmount won't equal the stored one
  // even when the spin was honest. Reels + cursor (below) are version-
  // stable and still verify the underlying RNG stream.
  const ver = input.paytableVersion ?? 'v2';
  if (ver === 'v2') {
    if (computed.winAmount.toString() !== input.expected.winAmount) {
      reasons.push(
        `winAmount mismatch: computed=${computed.winAmount.toString()}, expected=${input.expected.winAmount}`,
      );
    }
  }
  if (computed.cursorAfter !== input.expected.cursorAfter) {
    reasons.push(
      `cursorAfter mismatch: computed=${computed.cursorAfter}, expected=${input.expected.cursorAfter}`,
    );
  }

  // Bundle B — only compare when the server sent these (legacy rows lack
  // them). Missing fields ⇒ skip rather than spuriously fail.
  if (input.expected.wildMultipliers !== undefined) {
    const expWilds = input.expected.wildMultipliers;
    if (expWilds.length !== computed.wildMultipliers.length) {
      reasons.push(
        `wildMultipliers length mismatch: computed=${computed.wildMultipliers.length}, expected=${expWilds.length}`,
      );
    } else {
      for (let i = 0; i < expWilds.length; i++) {
        const a = computed.wildMultipliers[i]!;
        const b = expWilds[i]!;
        if (a.reelIndex !== b.reelIndex || a.rowIndex !== b.rowIndex || a.multiplier !== b.multiplier) {
          reasons.push(
            `wildMultipliers[${i}] mismatch: computed=(${a.reelIndex},${a.rowIndex},×${a.multiplier}), expected=(${b.reelIndex},${b.rowIndex},×${b.multiplier})`,
          );
        }
      }
    }
  }
  if (input.expected.scatterPayout !== undefined) {
    if (computed.scatterPayout.toString() !== input.expected.scatterPayout) {
      reasons.push(
        `scatterPayout mismatch: computed=${computed.scatterPayout.toString()}, expected=${input.expected.scatterPayout}`,
      );
    }
  }
  if (input.expected.freeSpinsAwarded !== undefined) {
    if (computed.freeSpinsAwarded !== input.expected.freeSpinsAwarded) {
      reasons.push(
        `freeSpinsAwarded mismatch: computed=${computed.freeSpinsAwarded}, expected=${input.expected.freeSpinsAwarded}`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons, computed };
}
