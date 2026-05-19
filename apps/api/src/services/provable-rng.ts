/**
 * Phase 6.1 — Provably-fair RNG core for ClawVille's casino slots.
 *
 * Commit-reveal HMAC-SHA256 scheme (industry-standard, used by Stake,
 * Roobet, et al.). Player and server jointly contribute entropy; the
 * server can never bias the outcome because it commits to its seed
 * BEFORE seeing the player's seed, and the player can replay every
 * spin after the seed is revealed at session close.
 *
 *   1. Server: serverSeed = randomBytes(32) hex-encoded (64 chars).
 *   2. Server: publish serverSeedHash = sha256(serverSeed) at session open.
 *   3. Per spin: client provides clientSeed (hex) + nonce (monotonic int).
 *   4. Server derives bytes from the conceptual stream
 *
 *        stream = block_0 || block_1 || block_2 || ...
 *        block_i = HMAC-SHA256(serverSeed_raw_bytes,
 *                              `${clientSeed}:${nonce}:${i}`)
 *
 *      where the HMAC key is the 32 raw bytes the hex serverSeed
 *      represents, and `i` is the BLOCK INDEX (0, 1, 2, …) — NOT a
 *      byte cursor. The caller-facing `cursor` parameter is the BYTE
 *      offset INTO that stream; the function maps cursor → block index
 *      internally (`floor(cursor / 32)`).
 *   5. Each block is 32 bytes. Callers request `byteCount` bytes
 *      starting at `cursor` — the function pulls just enough blocks to
 *      cover [cursor, cursor + byteCount) and slices.
 *   6. On session close: server reveals serverSeed. Player verifies
 *      sha256(serverSeed) === serverSeedHash and re-derives every spin.
 *
 * --- Threat model ---
 *
 * Server controls serverSeed (held secret until session close, but
 * committed via published sha256 hash at session open). Client
 * controls clientSeed + nonce (chosen at session open / monotonic per
 * spin, both visible to player). HMAC ensures:
 *
 *   (a) Server CANNOT pick a serverSeed AFTER seeing clientSeed —
 *       the commit hash is published first and a different seed will
 *       not hash to the committed value.
 *   (b) Player CANNOT predict outcomes — without serverSeed, every
 *       block is indistinguishable from random to anyone who only
 *       knows serverSeedHash + clientSeed + nonce.
 *   (c) After reveal, ANY third party can re-derive every spin and
 *       prove the server played fair.
 *
 * A malicious DB operator with read access to a still-open session
 * could read the stored plaintext serverSeed and pre-compute future
 * spin outcomes; mitigation lives at the DB layer (encrypt
 * `slot_sessions.server_seed` at rest, restrict role grants), not
 * here.
 *
 * Determinism contract: same inputs → same output, byte-for-byte,
 * across machines, Node versions, and platforms. This is the WHOLE
 * point of the module — the frontend verifier in `apps/web/src/lib/
 * casino/verifier.ts` (next slice) must produce identical bytes given
 * identical inputs.
 *
 * No state, no caching, no I/O. Pure functions only (modulo
 * `createServerSeed`, which is intentionally non-deterministic).
 */

import { createHash, createHmac, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bytes per HMAC-SHA256 output. Exported so downstream consumers
 * (e.g. the pokie `RandomNumberGenerator` adapter in the next slice)
 * can reason about cursor stride without re-deriving the constant.
 */
export const BLOCK_SIZE = 32;

/**
 * Bytes consumed per rejection-sampling attempt in sampleIntFromBytes
 * (one uint32 LE = 4 bytes). Exported for the same reason as
 * BLOCK_SIZE — the slot-engine cursor bookkeeping multiplies by this.
 */
export const SAMPLE_WIDTH = 4;

/**
 * Maximum hex-char length accepted for a clientSeed. 256 hex chars = 128
 * bytes of player-supplied entropy — well above any cryptographic need
 * and any UI-facing input width. Exported so Hono route slices can
 * mirror the cap in Zod schemas before the value ever reaches the RNG.
 */
export const CLIENT_SEED_MAX_LENGTH = 256;

/**
 * Maximum `byteCount` accepted by a single `deriveBytes` call.
 * 65536 = 2^16 bytes (2048 HMAC blocks) — comfortably above any
 * realistic slot-engine consumer (a 1000-spin batch at ~16 bytes/spin
 * fits in 16 KB). The cap exists to prevent a misbehaving caller from
 * forcing the server to perform unbounded HMAC work in a single call.
 */
export const MAX_BYTE_COUNT = 65536;

/** 2^32 — exclusive upper bound of a uint32. */
const TWO_POW_32 = 0x1_0000_0000;

/** Required hex length of a server seed (32 bytes = 256 bits of entropy). */
const SERVER_SEED_HEX_LEN = 64;

/** Lowercase-hex character class — used by serverSeed + clientSeed validators. */
const LOWERCASE_HEX = /^[0-9a-f]+$/;

/** Any-case-hex — used to validate clientSeed before lowercasing. */
const ANY_CASE_HEX = /^[0-9a-fA-F]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A freshly-generated server seed + its public commit hash. */
export interface ServerSeedPair {
  /** 64-char lowercase hex (32 random bytes). */
  serverSeed: string;
  /** sha256 of the serverSeed hex string (utf-8 bytes), 64-char lowercase hex. */
  serverSeedHash: string;
}

/** Result of a `deriveBytes` call. */
export interface DerivedBytes {
  /** Length === requested byteCount. */
  bytes: Buffer;
  /** Always equals input cursor + byteCount. */
  cursorAfter: number;
}

/** Result of a `sampleIntFromBytes` call. */
export interface SampledInt {
  /** Integer in [min, max). */
  value: number;
  /** Multiple of 4 — how many bytes were CONSUMED including rejected attempts. */
  bytesConsumed: number;
}

/** Arguments to `deriveBytes`. */
export interface DeriveBytesArgs {
  /** 64-char lowercase hex server seed. */
  serverSeed: string;
  /** Non-empty hex string (any case). Normalized to lowercase before use. */
  clientSeed: string;
  /** Non-negative integer. Monotonically increases per spin within a session. */
  nonce: number;
  /** Non-negative integer byte offset into the conceptual stream. */
  cursor: number;
  /** Positive integer count of bytes to derive. */
  byteCount: number;
}

/** Arguments to `sampleIntFromBytes`. */
export interface SampleIntFromBytesArgs {
  /** 64-char lowercase hex server seed. */
  serverSeed: string;
  /** Non-empty hex string (any case). */
  clientSeed: string;
  /** Non-negative integer. */
  nonce: number;
  /** Non-negative integer byte cursor — where to start sampling. */
  cursorStart: number;
  /** Inclusive lower bound of the sampled integer. */
  min: number;
  /** Exclusive upper bound of the sampled integer. */
  max: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 256-bit server seed + its sha256
 * commit hash. The seed is held server-side until session close; the
 * hash is published to the client at session open.
 *
 * Non-deterministic by design — backed by `crypto.randomBytes`.
 */
export function createServerSeed(): ServerSeedPair {
  const serverSeed = randomBytes(BLOCK_SIZE).toString('hex');
  return {
    serverSeed,
    serverSeedHash: sha256Hex(serverSeed),
  };
}

/**
 * sha256 of an arbitrary string, lowercase hex output.
 *
 * Convention: we hash the UTF-8 bytes of the input string verbatim,
 * NOT the bytes the hex represents. That way both server and client
 * can verify the commit with a single `sha256(string)` call regardless
 * of whether they ever decode the hex. This matches the Stake/Roobet
 * provably-fair convention.
 *
 * IMPORTANT: hashes UTF-8 bytes of the input STRING. Case-sensitive.
 * `sha256Hex("ABC") !== sha256Hex("abc")`. Callers must normalize their
 * input to a canonical form (`createServerSeed` emits lowercase;
 * verifiers must normalize before re-hashing).
 *
 * Does NOT hex-decode. To hash decoded bytes, the caller decodes first.
 */
export function sha256Hex(input: string): string {
  // IMPORTANT: hashes UTF-8 bytes of the hex STRING, not the decoded
  // bytes. Frontend verifier must do the same — i.e.
  //   sha256(utf8Encode(serverSeedHexString))
  // NOT
  //   sha256(hexDecode(serverSeedHexString)).
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Derive `byteCount` bytes from the deterministic stream defined by
 * (serverSeed, clientSeed, nonce), starting at `cursor`.
 *
 * Stream construction (block-indexed, NOT cursor-indexed — the HMAC
 * message contains the BLOCK INDEX, not the byte cursor; cursor is a
 * caller-facing primitive that maps to block index via
 * `floor(cursor / 32)`):
 *
 *   block_i = HMAC-SHA256(key = serverSeed_raw_bytes,
 *                         msg = `${clientSeed}:${nonce}:${i}`)
 *   stream = block_0 || block_1 || block_2 || ...
 *
 * The function computes `startBlock = floor(cursor / 32)` and
 * `endBlock = floor((cursor + byteCount - 1) / 32)`, generates exactly
 * `endBlock - startBlock + 1` HMAC blocks, concatenates them, then
 * slices `[cursor mod 32, cursor mod 32 + byteCount)`. This handles
 * arbitrary cursors and byteCounts including cases that cross
 * multiple block boundaries.
 *
 * The HMAC key is the 32 RAW bytes that the hex serverSeed represents
 * (`Buffer.from(serverSeed, 'hex')`), not the hex-string bytes. This
 * matches the construction the frontend verifier will use.
 *
 * clientSeed is lowercased before HMAC; verifier must match. Empty
 * clientSeed is rejected.
 *
 * The `:` separator in the message is safe because hex digits are
 * `[0-9a-f]` and nonce/block are ASCII digits — `:` never collides.
 *
 * @note `clientSeed` is lowercased before HMAC, so "ABC" and "abc"
 * produce identical bytes. Upstream replay-prevention logic that tracks
 * distinct clientSeed values must use the normalized (lowercase) form.
 *
 * @note `nonce === -0` is accepted and treated identically to
 * `nonce === 0` (both stringify to "0").
 */
export function deriveBytes(args: DeriveBytesArgs): DerivedBytes {
  const { nonce, cursor, byteCount } = args;
  const serverSeed = normalizeServerSeed(args.serverSeed);
  const clientSeed = normalizeClientSeed(args.clientSeed);

  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`deriveBytes: nonce must be a non-negative integer, got ${nonce}`);
  }
  // Note: `Number.isInteger(Number.MAX_SAFE_INTEGER + 2)` returns true
  // even though precision is lost above 2^53 - 1. The explicit cap
  // catches the precision-loss zone where increments stop being faithful.
  if (nonce > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `provable-rng: nonce exceeds MAX_SAFE_INTEGER (${nonce}); use a smaller nonce`,
    );
  }
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error(`deriveBytes: cursor must be a non-negative integer, got ${cursor}`);
  }
  if (!Number.isInteger(byteCount) || byteCount <= 0) {
    throw new Error(`deriveBytes: byteCount must be a positive integer, got ${byteCount}`);
  }
  if (byteCount > MAX_BYTE_COUNT) {
    throw new Error(
      `provable-rng: byteCount exceeds MAX_BYTE_COUNT (${MAX_BYTE_COUNT}, got ${byteCount})`,
    );
  }
  if (cursor > Number.MAX_SAFE_INTEGER - byteCount) {
    throw new Error(
      `provable-rng: cursor + byteCount would overflow MAX_SAFE_INTEGER`,
    );
  }

  const startBlock = Math.floor(cursor / BLOCK_SIZE);
  const endBlock = Math.floor((cursor + byteCount - 1) / BLOCK_SIZE);
  const blockCount = endBlock - startBlock + 1;

  const key = Buffer.from(serverSeed, 'hex');
  const chunks: Buffer[] = new Array<Buffer>(blockCount);
  for (let i = 0; i < blockCount; i++) {
    const blockIndex = startBlock + i;
    chunks[i] = createHmac('sha256', key)
      .update(`${clientSeed}:${nonce}:${blockIndex}`, 'utf8')
      .digest();
  }
  const stream = blockCount === 1 ? chunks[0]! : Buffer.concat(chunks);

  const localOffset = cursor - startBlock * BLOCK_SIZE;
  const bytes = stream.subarray(localOffset, localOffset + byteCount);

  return {
    // Copy out of the larger buffer so callers can't accidentally
    // mutate the concatenated stream backing it (Buffer.subarray
    // returns a view, not a copy).
    bytes: Buffer.from(bytes),
    cursorAfter: cursor + byteCount,
  };
}

/**
 * Sample an unbiased integer in `[min, max)` using rejection sampling
 * against 4-byte uint32 LE slices of the derived byte stream.
 *
 * --- Why rejection sampling, not modulo ---
 *
 * Naive `u32 % R` is biased whenever R doesn't divide 2^32 evenly:
 * the leading `floor(2^32 / R) + 1` outcomes for small remainders
 * have one more chance than the trailing ones. The bias is small for
 * tiny R but compounds across millions of spins.
 *
 * Standard fix: precompute T = 2^32 - (2^32 mod R). T is the largest
 * multiple of R that fits in a uint32. Samples in [0, T) map to
 * [0, R) uniformly via `% R`; samples in [T, 2^32) are REJECTED and
 * we draw a fresh u32. Special case: when R divides 2^32 exactly,
 * 2^32 mod R = 0 so T = 2^32 = TWO_POW_32 — and since every u32 is
 * < 2^32, no sample is ever rejected. This includes R = 1, 2, 4, ...,
 * 2^32 (powers of two and the full range itself).
 *
 * Each rejected sample still consumes 4 bytes of the stream — the
 * `bytesConsumed` return field reflects the total bytes the caller
 * must skip in the cursor. This keeps the derivation deterministic
 * and replayable.
 *
 * --- Bounds ---
 *
 * Refuses range > 2^32 outright (the algorithm fundamentally requires
 * the candidate distribution to be at least as large as the target
 * range). For slots, R is bounded by reel-strip length (~30-40), so
 * we'll never approach this limit — the guard exists to fail loudly
 * if someone misuses the function downstream.
 */
export function sampleIntFromBytes(args: SampleIntFromBytesArgs): SampledInt {
  const { nonce, cursorStart, min, max } = args;
  const serverSeed = normalizeServerSeed(args.serverSeed);
  const clientSeed = normalizeClientSeed(args.clientSeed);

  if (!Number.isInteger(min)) {
    throw new Error(`sampleIntFromBytes: min must be an integer, got ${min}`);
  }
  if (!Number.isInteger(max)) {
    throw new Error(`sampleIntFromBytes: max must be an integer, got ${max}`);
  }
  if (max <= min) {
    throw new Error(`sampleIntFromBytes: max must be > min, got min=${min} max=${max}`);
  }
  if (!Number.isInteger(nonce) || nonce < 0) {
    throw new Error(`sampleIntFromBytes: nonce must be a non-negative integer, got ${nonce}`);
  }
  if (!Number.isInteger(cursorStart) || cursorStart < 0) {
    throw new Error(
      `sampleIntFromBytes: cursorStart must be a non-negative integer, got ${cursorStart}`,
    );
  }

  const range = max - min;
  if (range > TWO_POW_32) {
    throw new Error(
      `sampleIntFromBytes: range (max - min) must be <= 2^32, got ${range}`,
    );
  }

  // Threshold for rejection. When range divides 2^32 evenly,
  // 2^32 mod range === 0, so threshold === 2^32 — meaning no u32 is
  // ever rejected (any value < 2^32 is < threshold).
  const threshold = TWO_POW_32 - (TWO_POW_32 % range);

  let bytesConsumed = 0;
  // The loop is bounded probabilistically — for any range, the
  // acceptance rate is at least 50% (worst case range just over a
  // power of 2). 64 attempts → rejection probability < 2^-64. For
  // pokie-sized ranges (< 100), the typical case is 0 rejections.
  for (let attempt = 0; attempt < 64; attempt++) {
    const { bytes, cursorAfter: _next } = deriveBytes({
      serverSeed,
      clientSeed,
      nonce,
      cursor: cursorStart + bytesConsumed,
      byteCount: SAMPLE_WIDTH,
    });
    void _next; // we track bytesConsumed locally
    const u32 = bytes.readUInt32LE(0);
    bytesConsumed += SAMPLE_WIDTH;
    if (u32 < threshold) {
      return {
        value: (u32 % range) + min,
        bytesConsumed,
      };
    }
  }

  // 64 consecutive rejections is so improbable that hitting this is
  // either a bug or a sign something is wrong with the OS RNG /
  // HMAC implementation. Fail loudly.
  throw new Error(
    `sampleIntFromBytes: rejection sampling failed after 64 attempts (range=${range})`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate + lowercase a server seed. Throws on anything that isn't
 * exactly 64 hex chars (32 bytes of entropy).
 */
function normalizeServerSeed(serverSeed: string): string {
  if (typeof serverSeed !== 'string') {
    throw new Error('provable-rng: serverSeed must be a string');
  }
  const lower = serverSeed.toLowerCase();
  if (lower.length !== SERVER_SEED_HEX_LEN) {
    throw new Error(
      `provable-rng: serverSeed must be ${SERVER_SEED_HEX_LEN} hex chars, got ${lower.length}`,
    );
  }
  if (!LOWERCASE_HEX.test(lower)) {
    throw new Error('provable-rng: serverSeed must be hex ([0-9a-fA-F])');
  }
  return lower;
}

/**
 * Validate + lowercase a client seed. Spec: non-empty hex string,
 * any case accepted, normalized to lowercase before being baked into
 * the HMAC message. Lowercasing is part of the canonical message
 * format — the frontend verifier MUST lowercase identically.
 */
function normalizeClientSeed(clientSeed: string): string {
  if (typeof clientSeed !== 'string') {
    throw new Error('provable-rng: clientSeed must be a string');
  }
  if (clientSeed.length === 0) {
    throw new Error('provable-rng: clientSeed must be non-empty');
  }
  if (clientSeed.length > CLIENT_SEED_MAX_LENGTH) {
    throw new Error(
      `provable-rng: clientSeed too long (max ${CLIENT_SEED_MAX_LENGTH} hex chars, got ${clientSeed.length})`,
    );
  }
  if (!ANY_CASE_HEX.test(clientSeed)) {
    throw new Error('provable-rng: clientSeed must be a hex string ([0-9a-fA-F]+)');
  }
  return clientSeed.toLowerCase();
}
