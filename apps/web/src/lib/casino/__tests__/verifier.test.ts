/**
 * Phase 6.1 slice 5 — Browser-side verifier byte-identity tests.
 *
 * Same test-vector strategy as `apps/api/src/services/__tests__/
 * provable-rng.test.ts`: hand-computed (or independently-derived)
 * fixtures, never relying on the production code to produce its own
 * expected output. The fixtures here are LITERALLY the bytes that the
 * Node `crypto` module emits — verified against the server module in
 * the same conversation as this file's authorship (slice 5 byte-identity
 * proof).
 *
 * The verifier MUST match those bytes exactly, because:
 *   - Server uses `createHmac('sha256', Buffer.from(seed, 'hex'))`
 *   - Verifier uses `crypto.subtle.sign('HMAC', importKey(hexToBytes(seed), SHA-256), msg)`
 * If WebCrypto disagrees with Node's HMAC by a single byte, the verifier
 * is wrong and the casino's provably-fair claim is broken.
 *
 * Bun's `bun:test` is the harness (matches apps/api). Bun ships WebCrypto
 * by default; tests run headless without a browser.
 */

import { describe, expect, it } from 'bun:test';

import {
  deriveBytes,
  sampleIntFromBytes,
  sha256Hex,
  runSpinLocal,
  evaluateReelsLocal,
  replaySpin,
} from '../verifier';

// ---------------------------------------------------------------------------
// Fixtures — verified byte-for-byte against the server provable-rng module
// (see slice-5 implementer ship report). DO NOT regenerate these from the
// verifier itself; that would invalidate the byte-identity guarantee.
// ---------------------------------------------------------------------------

const ZERO_SEED = '0'.repeat(64);
const NON_ZERO_SEED =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

function hex(u8: Uint8Array): string {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// sha256Hex parity with the server's UTF-8 hashing convention
// ---------------------------------------------------------------------------

describe('verifier.sha256Hex', () => {
  it('matches the canonical SHA-256("") = e3b0...855', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes UTF-8 bytes of the hex string (NOT hex-decoded bytes)', async () => {
    // If we accidentally hex-decoded first, we'd get
    // 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925.
    // The right answer matches the server fixture.
    expect(await sha256Hex(ZERO_SEED)).toBe(
      '60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55',
    );
  });
});

// ---------------------------------------------------------------------------
// deriveBytes — byte-for-byte parity with `apps/api .../provable-rng.test.ts`
// ---------------------------------------------------------------------------

describe('verifier.deriveBytes — hand-computed vectors', () => {
  it('TV1: zero seed, clientSeed="a", nonce=0, cursor=0, byteCount=8', async () => {
    const { bytes, cursorAfter } = await deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'a',
      nonce: 0,
      cursor: 0,
      byteCount: 8,
    });
    expect(hex(bytes)).toBe('0063b519243f4a7b');
    expect(cursorAfter).toBe(8);
  });

  it('TV2: zero seed, clientSeed="deadbeef", nonce=42, cursor=0, byteCount=32', async () => {
    const { bytes, cursorAfter } = await deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 0,
      byteCount: 32,
    });
    expect(hex(bytes)).toBe(
      'f52cd6fbd06482bbe5d7f2a470a044bd776e0987ecccfaad95deb07e384fe39d',
    );
    expect(cursorAfter).toBe(32);
  });

  it('TV3: cursor mid-block (10), byteCount=32 — spans blocks 0+1', async () => {
    const { bytes, cursorAfter } = await deriveBytes({
      serverSeed: ZERO_SEED,
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 10,
      byteCount: 32,
    });
    expect(hex(bytes)).toBe(
      'f2a470a044bd776e0987ecccfaad95deb07e384fe39d657e41762e31408b86b1',
    );
    expect(cursorAfter).toBe(42);
  });

  it('TV5: non-zero seed, mixed-case clientSeed "CafeBabe" lowercased, 96 bytes', async () => {
    const { bytes, cursorAfter } = await deriveBytes({
      serverSeed: NON_ZERO_SEED,
      clientSeed: 'CafeBabe',
      nonce: 7,
      cursor: 0,
      byteCount: 96,
    });
    expect(hex(bytes)).toBe(
      '95afca1fdb7ac244bb2cbfe0fdc04e81b982fca4545af5b6ce59c89ee015cb79' +
        '317587e180a826fdbd530c774cf0e6fd262e586837358aee074b69b7a34499fa' +
        '26a43c09e0520fb23a67a64abadd9773438dd3056b35a8ba9e15ba87f34ac057',
    );
    expect(cursorAfter).toBe(96);
  });

  it('TV6: uppercase serverSeed produces identical output to lowercase', async () => {
    const a = await deriveBytes({
      serverSeed: ZERO_SEED.toUpperCase(),
      clientSeed: 'deadbeef',
      nonce: 42,
      cursor: 0,
      byteCount: 32,
    });
    expect(hex(a.bytes)).toBe(
      'f52cd6fbd06482bbe5d7f2a470a044bd776e0987ecccfaad95deb07e384fe39d',
    );
  });
});

// ---------------------------------------------------------------------------
// deriveBytes — input validation parity
// ---------------------------------------------------------------------------

describe('verifier.deriveBytes — input validation', () => {
  const valid = {
    serverSeed: ZERO_SEED,
    clientSeed: 'ab',
    nonce: 0,
    cursor: 0,
    byteCount: 4,
  };

  it('rejects empty clientSeed', async () => {
    await expect(deriveBytes({ ...valid, clientSeed: '' })).rejects.toThrow(/non-empty/);
  });
  it('rejects non-hex clientSeed', async () => {
    await expect(deriveBytes({ ...valid, clientSeed: 'zz' })).rejects.toThrow(/hex/);
  });
  it('rejects wrong-length serverSeed', async () => {
    await expect(deriveBytes({ ...valid, serverSeed: 'abc' })).rejects.toThrow(/hex/);
  });
  it('rejects negative cursor', async () => {
    await expect(deriveBytes({ ...valid, cursor: -1 })).rejects.toThrow(/cursor/);
  });
  it('rejects byteCount=0', async () => {
    await expect(deriveBytes({ ...valid, byteCount: 0 })).rejects.toThrow(/byteCount/);
  });
});

// ---------------------------------------------------------------------------
// sampleIntFromBytes — must produce identical reel stops to the server
// ---------------------------------------------------------------------------

describe('verifier.sampleIntFromBytes — parity', () => {
  it('reproduces the slice-2 reel stops fixture exactly', async () => {
    // Independently computed via Node `crypto` against the production
    // CLASSIC_REEL_STRIPS lengths (84 each). serverSeed='a'.repeat(64),
    // clientSeed='abcd1234', nonce=0, cursor=0.
    const seed = 'a'.repeat(64);
    let cursor = 0;
    const stops: number[] = [];
    for (let r = 0; r < 5; r++) {
      const { value, bytesConsumed } = await sampleIntFromBytes({
        serverSeed: seed,
        clientSeed: 'abcd1234',
        nonce: 0,
        cursorStart: cursor,
        min: 0,
        max: 84,
      });
      cursor += bytesConsumed;
      stops.push(value);
    }
    expect(stops).toEqual([43, 64, 54, 52, 63]);
    expect(cursor).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// runSpinLocal — full byte-identity vs the server slot-engine
// ---------------------------------------------------------------------------

describe('verifier.runSpinLocal — byte-identity', () => {
  it('matches the server slot-engine output for the canonical fixture', async () => {
    // Expected = output of `runSpin({serverSeed:'a'*64, clientSeed:'abcd1234',
    // nonce:0, cursor:0, predict:20n, paytableId:'classic-3x5'})`. Captured
    // by executing the server engine separately during slice 5 authoring.
    const result = await runSpinLocal({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 0,
      predict: 20n,
    });
    expect(result.reels).toEqual([
      [7, 1, 1],
      [1, 3, 0],
      [3, 1, 1],
      [1, 4, 3],
      [2, 2, 0],
    ]);
    expect(result.winAmount.toString()).toBe('55');
    expect(result.cursorAfter).toBe(20);
    expect(result.freeSpinsAwarded).toBe(0);
    expect(result.isFreeSpin).toBe(false);
    // Spot-check ONE winning line — full re-emission of all 10 lines
    // would just duplicate the server test; the deep field that matters
    // for player trust is `winAmount` which we already pin above.
    const winSum = result.winningLines.reduce((s, l) => s + l.winAmount, 0n);
    expect(winSum).toBe(55n);
  });

  it('different cursor ⇒ different reels', async () => {
    const a = await runSpinLocal({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 0,
      predict: 20n,
    });
    const b = await runSpinLocal({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 100,
      predict: 20n,
    });
    expect(a.reels).not.toEqual(b.reels);
  });

  it('rejects predict not divisible by line count (20)', async () => {
    await expect(
      runSpinLocal({
        paytableId: 'classic-3x5',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce: 0,
        cursor: 0,
        predict: 25n, // not % 20
      }),
    ).rejects.toThrow(/divisible/);
  });
});

// ---------------------------------------------------------------------------
// evaluateReelsLocal — synthetic grid sanity
// ---------------------------------------------------------------------------

describe('verifier.evaluateReelsLocal', () => {
  it('flat 0-0-0-0-0 across middle row pays line 0 5-of-Cherry (multiplier 20)', () => {
    // middle row [0,0,0,0,0], top/bot filled with id 2 (Orange) so no
    // accidental cross-pay on diagonals.
    const reels = [
      [2, 0, 2],
      [2, 0, 2],
      [2, 0, 2],
      [2, 0, 2],
      [2, 0, 2],
    ];
    const { winAmount, winningLines } = evaluateReelsLocal(reels, 'classic-3x5', 20n);
    // Line 0 is rows [1,1,1,1,1] — middle row all Cherries → 5-of-kind = payouts[3]=20.
    // perLinePredict = 20 / 20 = 1. So at least line 0 contributes 20.
    const line0 = winningLines.find((l) => l.lineIndex === 0);
    expect(line0).toBeDefined();
    expect(line0!.multiplier).toBe(20);
    expect(line0!.winAmount).toBe(20n);
    expect(winAmount).toBeGreaterThanOrEqual(20n);
  });
});

// ---------------------------------------------------------------------------
// replaySpin — happy + tamper paths
// ---------------------------------------------------------------------------

describe('verifier.replaySpin', () => {
  it('reports ok=true when expected matches computed', async () => {
    const verdict = await replaySpin({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 0,
      predict: 20n,
      expected: {
        reels: [
          [7, 1, 1],
          [1, 3, 0],
          [3, 1, 1],
          [1, 4, 3],
          [2, 2, 0],
        ],
        winAmount: '55',
        cursorAfter: 20,
      },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('detects a tampered winAmount', async () => {
    const verdict = await replaySpin({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 0,
      predict: 20n,
      expected: {
        reels: [
          [7, 1, 1],
          [1, 3, 0],
          [3, 1, 1],
          [1, 4, 3],
          [2, 2, 0],
        ],
        winAmount: '999', // tampered
        cursorAfter: 20,
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('winAmount'))).toBe(true);
  });

  it('detects a tampered reel cell', async () => {
    const verdict = await replaySpin({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 0,
      predict: 20n,
      expected: {
        reels: [
          [7, 1, 1],
          [1, 3, 0],
          [3, 1, 1],
          [1, 4, 3],
          [2, 2, 9], // tampered (was 0)
        ],
        winAmount: '55',
        cursorAfter: 20,
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('reels[4][2]'))).toBe(true);
  });
});
