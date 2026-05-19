/**
 * Phase 6.1 — Unit tests for the provably-fair RNG.
 *
 * Every expected value below was hand-computed via Node's reference
 * `crypto` implementation in a one-liner, NOT by running the
 * production code under test. The point of a test vector is that an
 * independent reference produces the same bytes; if these vectors
 * pass, the production code is byte-compatible with stock HMAC-SHA256.
 *
 * Reference one-liner (use `node`, NOT `bun`, to avoid any chance of
 * Bun-specific HMAC quirks contaminating the vectors):
 *
 *   const c = require('crypto');
 *   const block = (s, cs, n, i) => c.createHmac('sha256',
 *       Buffer.from(s, 'hex')).update(`${cs}:${n}:${i}`).digest();
 *
 * Test vectors verified 2026-05-18 against Node v22.
 */

import { describe, expect, it } from 'bun:test';

import {
  CLIENT_SEED_MAX_LENGTH,
  MAX_BYTE_COUNT,
  createServerSeed,
  deriveBytes,
  sampleIntFromBytes,
  sha256Hex,
} from '../provable-rng';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const ZERO_SEED = '0'.repeat(64); // 64 hex chars of zero
const NON_ZERO_SEED =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// ---------------------------------------------------------------------------
// createServerSeed
// ---------------------------------------------------------------------------

describe('createServerSeed', () => {
  it('produces a 64-char lowercase hex seed and matching sha256 commit', () => {
    const pair = createServerSeed();
    expect(pair.serverSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    // The commit MUST be reproducible from the revealed seed.
    expect(sha256Hex(pair.serverSeed)).toBe(pair.serverSeedHash);
  });

  it('produces distinct seeds across calls', () => {
    const a = createServerSeed();
    const b = createServerSeed();
    expect(a.serverSeed).not.toBe(b.serverSeed);
  });
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

describe('sha256Hex', () => {
  it('matches the well-known sha256 of the empty string', () => {
    // Canonical SHA-256("") from FIPS 180-4 / NIST.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes the UTF-8 representation of the hex seed, not the decoded bytes', () => {
    // The all-zero hex seed, treated as a UTF-8 string of 64 ASCII
    // '0' characters, hashes to this value. (If we'd hashed the
    // decoded 32 zero bytes instead, we'd get
    // 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925
    // — which is the wrong convention. The frontend verifier and the
    // server MUST agree on UTF-8 hashing.)
    expect(sha256Hex(ZERO_SEED)).toBe(
      '60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55',
    );
  });
});

// ---------------------------------------------------------------------------
// deriveBytes — 5 hand-computed vectors covering edge cases
// ---------------------------------------------------------------------------

describe('deriveBytes — hand-computed vectors', () => {
  // TV1 — single-block prefix, tiny request
  it('TV1: zero seed, clientSeed="a", nonce=0, cursor=0, byteCount=8', () => {
    const { bytes, cursorAfter } = deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursor: 0,
      byteCount: 8,
    });
    expect(bytes.toString('hex')).toBe('0063b519243f4a7b');
    expect(cursorAfter).toBe(8);
  });

  // TV2 — exactly one block
  it('TV2: zero seed, clientSeed="deadbeef", nonce=42, cursor=0, byteCount=32', () => {
    const { bytes, cursorAfter } = deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 0,
      byteCount: 32,
    });
    expect(bytes.toString('hex')).toBe(
      'f52cd6fbd06482bbe5d7f2a470a044bd776e0987ecccfaad95deb07e384fe39d',
    );
    expect(cursorAfter).toBe(32);
  });

  // TV3 — CROSSES BLOCK BOUNDARY (32→33 → forces a second HMAC block)
  it('TV3: crosses block boundary at cursor=0, byteCount=33 (needs blocks 0 + 1)', () => {
    const { bytes, cursorAfter } = deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 0,
      byteCount: 33,
    });
    expect(bytes.toString('hex')).toBe(
      'f52cd6fbd06482bbe5d7f2a470a044bd776e0987ecccfaad95deb07e384fe39d65',
    );
    expect(cursorAfter).toBe(33);
  });

  // TV4 — cursor lands MID-BLOCK
  it('TV4: cursor mid-block (10), byteCount=32 — spans blocks 0 + 1', () => {
    const { bytes, cursorAfter } = deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 10,
      byteCount: 32,
    });
    expect(bytes.toString('hex')).toBe(
      'f2a470a044bd776e0987ecccfaad95deb07e384fe39d657e41762e31408b86b1',
    );
    expect(cursorAfter).toBe(42);
  });

  // TV5 — non-zero seed, mixed-case clientSeed (must lowercase before HMAC),
  // 96 bytes → exactly 3 blocks
  it('TV5: non-zero seed, mixed-case clientSeed="CafeBabe" lowercased, 96 bytes', () => {
    const { bytes, cursorAfter } = deriveBytes({
      serverSeed: NON_ZERO_SEED,
      clientSeed: 'CafeBabe',
      nonce: 7,
      cursor: 0,
      byteCount: 96,
    });
    expect(bytes.toString('hex')).toBe(
      '95afca1fdb7ac244bb2cbfe0fdc04e81b982fca4545af5b6ce59c89ee015cb79' +
        '317587e180a826fdbd530c774cf0e6fd262e586837358aee074b69b7a34499fa' +
        '26a43c09e0520fb23a67a64abadd9773438dd3056b35a8ba9e15ba87f34ac057',
    );
    expect(cursorAfter).toBe(96);
  });

  // TV6 — uppercase serverSeed must produce the same bytes as TV2
  it('TV6: uppercase serverSeed produces identical output to the lowercase equivalent', () => {
    const upper = deriveBytes({
      serverSeed: ZERO_SEED.toUpperCase(),
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 0,
      byteCount: 32,
    });
    expect(upper.bytes.toString('hex')).toBe(
      'f52cd6fbd06482bbe5d7f2a470a044bd776e0987ecccfaad95deb07e384fe39d',
    );
  });
});

// ---------------------------------------------------------------------------
// deriveBytes — input validation
// ---------------------------------------------------------------------------

describe('deriveBytes — input validation', () => {
  const valid = {
    serverSeed: ZERO_SEED,
    clientSeed: 'ab',
    nonce: 0,
    cursor: 0,
    byteCount: 4,
  };

  it('rejects negative nonce', () => {
    expect(() => deriveBytes({ ...valid, nonce: -1 })).toThrow(/nonce/);
  });
  it('rejects non-integer nonce', () => {
    expect(() => deriveBytes({ ...valid, nonce: 1.5 })).toThrow(/nonce/);
  });
  it('rejects negative cursor', () => {
    expect(() => deriveBytes({ ...valid, cursor: -1 })).toThrow(/cursor/);
  });
  it('rejects zero byteCount', () => {
    expect(() => deriveBytes({ ...valid, byteCount: 0 })).toThrow(/byteCount/);
  });
  it('rejects negative byteCount', () => {
    expect(() => deriveBytes({ ...valid, byteCount: -1 })).toThrow(/byteCount/);
  });
  it('rejects serverSeed of wrong length', () => {
    expect(() => deriveBytes({ ...valid, serverSeed: 'abc' })).toThrow(
      /serverSeed/,
    );
  });
  it('rejects serverSeed with non-hex chars', () => {
    // 64 chars including a `g`
    const bad = 'g'.repeat(64);
    expect(() => deriveBytes({ ...valid, serverSeed: bad })).toThrow(
      /serverSeed/,
    );
  });
  it('rejects empty clientSeed', () => {
    expect(() => deriveBytes({ ...valid, clientSeed: '' })).toThrow(
      /clientSeed/,
    );
  });
  it('rejects non-hex clientSeed', () => {
    expect(() => deriveBytes({ ...valid, clientSeed: 'not-hex!' })).toThrow(
      /clientSeed/,
    );
  });

  it('rejects clientSeed exceeding CLIENT_SEED_MAX_LENGTH', () => {
    // 257 hex chars — one over the cap. Use an even number of hex chars
    // so the string is otherwise valid; we want the length check to be
    // the only failing condition.
    const tooLong = 'a'.repeat(CLIENT_SEED_MAX_LENGTH + 1);
    expect(tooLong.length).toBe(257);
    expect(() => deriveBytes({ ...valid, clientSeed: tooLong })).toThrow(
      new RegExp(
        `clientSeed too long \\(max ${CLIENT_SEED_MAX_LENGTH} hex chars, got 257\\)`,
      ),
    );
  });

  it('rejects byteCount exceeding MAX_BYTE_COUNT', () => {
    expect(() =>
      deriveBytes({ ...valid, byteCount: MAX_BYTE_COUNT + 1 }),
    ).toThrow(/MAX_BYTE_COUNT/);
  });

  it('rejects cursor + byteCount overflow', () => {
    expect(() =>
      deriveBytes({
        ...valid,
        cursor: Number.MAX_SAFE_INTEGER,
        byteCount: 1,
      }),
    ).toThrow(/overflow MAX_SAFE_INTEGER/);
  });

  it('rejects nonce exceeding MAX_SAFE_INTEGER', () => {
    // MAX_SAFE_INTEGER + 2 rounds to 2^53 (= MAX_SAFE_INTEGER + 1) in IEEE 754
    // round-to-nearest-even — which is distinctly > MAX_SAFE_INTEGER AND a
    // JS integer. Exactly the precision-loss zone the explicit cap catches that
    // Number.isInteger alone would let through.
    const aboveCap = Number.MAX_SAFE_INTEGER + 2;
    expect(Number.isInteger(aboveCap)).toBe(true);
    expect(aboveCap > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(() => deriveBytes({ ...valid, nonce: aboveCap })).toThrow(
      /nonce exceeds MAX_SAFE_INTEGER/,
    );
  });
});

// ---------------------------------------------------------------------------
// sampleIntFromBytes — hand-computed vectors
// ---------------------------------------------------------------------------

describe('sampleIntFromBytes — hand-computed vectors', () => {
  // Setup: at (seed=zero, clientSeed='a', nonce=0, cursor=0) the first
  // 4 bytes of block_0 are 0x00 0x63 0xb5 0x19 → little-endian uint32 =
  // 0x19b56300 = 431317760. We verify every sample below by hand
  // against that single u32 — no rejection needed since the threshold
  // is comfortably above 431317760 for every range we test.

  it('TV-S1: range=100 → 431317760 % 100 = 60, bytesConsumed=4', () => {
    const out = sampleIntFromBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursorStart: 0,
      min: 0,
      max: 100,
    });
    expect(out.value).toBe(60);
    expect(out.bytesConsumed).toBe(4);
  });

  it('TV-S2: range=100 with min offset → (431317760 % 100) + 10 = 70', () => {
    const out = sampleIntFromBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursorStart: 0,
      min: 10,
      max: 110,
    });
    expect(out.value).toBe(70);
    expect(out.bytesConsumed).toBe(4);
  });

  it('TV-S3: range=256 (power of 2) → low byte = 0, threshold = 2^32 → never reject', () => {
    const out = sampleIntFromBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursorStart: 0,
      min: 0,
      max: 256,
    });
    expect(out.value).toBe(0);
    expect(out.bytesConsumed).toBe(4);
  });

  it('TV-S4: range=2^32 (full uint32) → identity, value=u32 itself', () => {
    const out = sampleIntFromBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursorStart: 0,
      min: 0,
      max: 0x1_0000_0000,
    });
    expect(out.value).toBe(431317760);
    expect(out.bytesConsumed).toBe(4);
  });

  it('TV-S5: range=1 → only value is min, threshold = 2^32, no rejection', () => {
    const out = sampleIntFromBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursorStart: 0,
      min: 42,
      max: 43,
    });
    expect(out.value).toBe(42);
    expect(out.bytesConsumed).toBe(4);
  });

  it('determinism: same inputs always give the same output', () => {
    const args = {
      serverSeed: NON_ZERO_SEED,
      clientSeed: 'beef',
      nonce: 13,
      cursorStart: 100,
      min: 0,
      max: 37, // typical pokie reel-strip length
    };
    const a = sampleIntFromBytes(args);
    const b = sampleIntFromBytes(args);
    expect(a.value).toBe(b.value);
    expect(a.bytesConsumed).toBe(b.bytesConsumed);
  });
});

// ---------------------------------------------------------------------------
// sampleIntFromBytes — input validation
// ---------------------------------------------------------------------------

describe('sampleIntFromBytes — input validation', () => {
  const valid = {
    serverSeed: ZERO_SEED,
    clientSeed: 'a',
    nonce: 0,
    cursorStart: 0,
    min: 0,
    max: 10,
  };

  it('rejects max <= min', () => {
    expect(() => sampleIntFromBytes({ ...valid, min: 5, max: 5 })).toThrow(
      /max/,
    );
    expect(() => sampleIntFromBytes({ ...valid, min: 10, max: 5 })).toThrow(
      /max/,
    );
  });

  it('rejects range > 2^32', () => {
    expect(() =>
      sampleIntFromBytes({ ...valid, min: 0, max: 0x1_0000_0001 }),
    ).toThrow(/range/);
  });

  it('rejects non-integer min/max', () => {
    expect(() => sampleIntFromBytes({ ...valid, min: 0.5 })).toThrow(/min/);
    expect(() => sampleIntFromBytes({ ...valid, max: 10.5 })).toThrow(/max/);
  });

  it('rejects negative nonce', () => {
    expect(() => sampleIntFromBytes({ ...valid, nonce: -1 })).toThrow(/nonce/);
  });

  it('rejects negative cursorStart', () => {
    expect(() => sampleIntFromBytes({ ...valid, cursorStart: -1 })).toThrow(
      /cursorStart/,
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end commit-reveal flow
// ---------------------------------------------------------------------------

describe('commit-reveal end-to-end', () => {
  it('client can re-derive bytes from a revealed server seed', () => {
    // Simulate the full flow: session open → spin → session close.
    const { serverSeed, serverSeedHash } = createServerSeed();

    // Client picks a seed at session open.
    const clientSeed = 'd00d';

    // Server runs a spin at nonce=0 — derive 16 bytes for, say, 4 reel
    // stops via rejection sampling.
    const serverSide = deriveBytes({
      serverSeed,
      clientSeed,
      nonce: 0,
      cursor: 0,
      byteCount: 16,
    });

    // Session closes — server reveals serverSeed. Client verifies the
    // commit hash and re-derives.
    expect(sha256Hex(serverSeed)).toBe(serverSeedHash);

    const clientSide = deriveBytes({
      serverSeed,
      clientSeed,
      nonce: 0,
      cursor: 0,
      byteCount: 16,
    });

    expect(clientSide.bytes.toString('hex')).toBe(
      serverSide.bytes.toString('hex'),
    );
    expect(clientSide.cursorAfter).toBe(serverSide.cursorAfter);
  });
});
