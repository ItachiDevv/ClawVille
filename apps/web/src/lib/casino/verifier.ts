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
} from '@clawville/shared';

import type { SpinResult, WinningLine, SymbolId, MachineSlug } from './types';

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
// ---------------------------------------------------------------------------

interface VerifierBundle {
  id: MachineSlug;
  symbols: typeof CLASSIC_SYMBOLS;
  lines: typeof CLASSIC_LINES;
  reelStrips: typeof CLASSIC_REEL_STRIPS;
  wildId: SymbolId;
}

const CLASSIC_WILD_ID = CLASSIC_SYMBOLS.find((s) => s.isWild)?.id ?? -1;
if (CLASSIC_WILD_ID < 0) {
  throw new Error('verifier: classic-3x5 paytable has no wild symbol');
}

const BUNDLES: Record<MachineSlug, VerifierBundle> = {
  'classic-3x5': {
    id: 'classic-3x5',
    symbols: CLASSIC_SYMBOLS,
    lines: CLASSIC_LINES,
    reelStrips: CLASSIC_REEL_STRIPS,
    wildId: CLASSIC_WILD_ID,
  },
};

export function getVerifierBundle(paytableId: MachineSlug): VerifierBundle {
  const bundle = BUNDLES[paytableId];
  if (!bundle) {
    throw new Error(`verifier: unknown paytableId '${paytableId}'`);
  }
  return bundle;
}

// ---------------------------------------------------------------------------
// evaluateReelsLocal — synchronous, mirrors server `evaluateReels`.
// ---------------------------------------------------------------------------

export function evaluateReelsLocal(
  reels: readonly (readonly SymbolId[])[],
  paytableId: MachineSlug,
  predict: bigint,
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

  const perLinePredict = predict / lineCount;
  const winningLines: WinningLine[] = [];
  let totalWin = 0n;

  for (const line of bundle.lines) {
    const lineSymbols: SymbolId[] = new Array(5);
    for (let r = 0; r < 5; r++) {
      lineSymbols[r] = reels[r]![line.rows[r]]!;
    }

    let kindId: SymbolId | undefined;
    for (let r = 0; r < 5; r++) {
      if (lineSymbols[r] !== bundle.wildId) {
        kindId = lineSymbols[r];
        break;
      }
    }
    if (kindId === undefined) kindId = bundle.wildId;

    let matchLen = 0;
    for (let r = 0; r < 5; r++) {
      const sym = lineSymbols[r]!;
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

    const lineWin = perLinePredict * BigInt(multiplier);
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

  const { winningLines, winAmount } = evaluateReelsLocal(reels, args.paytableId, args.predict);

  return {
    reels,
    winningLines,
    winAmount,
    freeSpinsAwarded: 0,
    isFreeSpin: false,
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
  /** What the server stored for this spin (already-serialized winAmount string). */
  expected: {
    reels: SymbolId[][];
    winAmount: string;
    cursorAfter: number;
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
  if (computed.winAmount.toString() !== input.expected.winAmount) {
    reasons.push(
      `winAmount mismatch: computed=${computed.winAmount.toString()}, expected=${input.expected.winAmount}`,
    );
  }
  if (computed.cursorAfter !== input.expected.cursorAfter) {
    reasons.push(
      `cursorAfter mismatch: computed=${computed.cursorAfter}, expected=${input.expected.cursorAfter}`,
    );
  }

  return { ok: reasons.length === 0, reasons, computed };
}
