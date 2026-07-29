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
 * is wrong and the cove's provably-fair claim is broken.
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
  wildMultiplierForDrawLocal,
  getVerifierBundle,
} from '../verifier';
import { FREE_SPIN_RULES, SCATTER_PAY_TABLE } from '@clawville/shared';

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
    // 54 re-captured from BOTH engines (server slot-engine AND this verifier,
    // identical reels) after the Phase 6.1.10 RTP-94% paytable retune; the
    // original 55 predated the retune.
    expect(result.winAmount.toString()).toBe('54');
    expect(result.cursorAfter).toBe(20);
    expect(result.freeSpinsAwarded).toBe(0);
    expect(result.isFreeSpin).toBe(false);
    // Spot-check ONE winning line — full re-emission of all 10 lines
    // would just duplicate the server test; the deep field that matters
    // for player trust is `winAmount` which we already pin above.
    const winSum = result.winningLines.reduce((s, l) => s + l.winAmount, 0n);
    expect(winSum).toBe(54n);
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
  it('flat 0-0-0-0-0 across middle row pays line 0 5-of-kind id 0 (multiplier 18)', () => {
    // middle row [0,0,0,0,0] (id 0 = Claw since the roster re-theme), top/bot
    // filled with id 2 so no accidental cross-pay on diagonals.
    const reels = [
      [2, 0, 2],
      [2, 0, 2],
      [2, 0, 2],
      [2, 0, 2],
      [2, 0, 2],
    ];
    const { winAmount, winningLines } = evaluateReelsLocal(reels, 'classic-3x5', 20n);
    // Line 0 is rows [1,1,1,1,1] — middle row all id 0 → 5-of-kind =
    // payouts[3]=18 (RTP-94% retune). perLinePredict = 20 / 20 = 1, so at
    // least line 0 contributes 18.
    const line0 = winningLines.find((l) => l.lineIndex === 0);
    expect(line0).toBeDefined();
    expect(line0!.multiplier).toBe(18);
    expect(line0!.winAmount).toBe(18n);
    expect(winAmount).toBeGreaterThanOrEqual(18n);
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
        winAmount: '54',
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

// ---------------------------------------------------------------------------
// Phase 6.1.5 (Bundle B) — classic-3x5-bonus paytable
// ---------------------------------------------------------------------------

describe('verifier.wildMultiplierForDrawLocal — mapping table', () => {
  it('draw=0..59 → 2×', () => {
    expect(wildMultiplierForDrawLocal(0)).toBe(2);
    expect(wildMultiplierForDrawLocal(59)).toBe(2);
  });
  it('draw=60..89 → 3×', () => {
    expect(wildMultiplierForDrawLocal(60)).toBe(3);
    expect(wildMultiplierForDrawLocal(89)).toBe(3);
  });
  it('draw=90..99 → 5×', () => {
    expect(wildMultiplierForDrawLocal(90)).toBe(5);
    expect(wildMultiplierForDrawLocal(99)).toBe(5);
  });
  it('out-of-range draws throw', () => {
    expect(() => wildMultiplierForDrawLocal(-1)).toThrow();
    expect(() => wildMultiplierForDrawLocal(100)).toThrow();
    expect(() => wildMultiplierForDrawLocal(1.5)).toThrow();
  });
});

describe('verifier.getVerifierBundle — bonus paytable', () => {
  it('classic-3x5-bonus has scatterId=10 and wildId=7', () => {
    const b = getVerifierBundle('classic-3x5-bonus');
    expect(b.id).toBe('classic-3x5-bonus');
    expect(b.wildId).toBe(7);
    expect(b.scatterId).toBe(10);
    expect(b.symbols.length).toBe(11);
    expect(b.reelStrips.length).toBe(5);
    for (const strip of b.reelStrips) {
      expect(strip.length).toBe(84);
    }
  });

  it('classic-3x5 keeps scatterId=null (no bonus side-effects)', () => {
    const b = getVerifierBundle('classic-3x5');
    expect(b.scatterId).toBeNull();
    expect(b.wildId).toBe(7);
  });
});

describe('verifier.runSpinLocal — classic-3x5-bonus determinism', () => {
  it('same inputs ⇒ byte-identical SpinResult (reels, cursor, wilds, scatter)', async () => {
    const args = {
      paytableId: 'classic-3x5-bonus' as const,
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 7,
      cursor: 100,
      predict: 20n,
    };
    const a = await runSpinLocal(args);
    const b = await runSpinLocal(args);
    expect(a.reels).toEqual(b.reels);
    expect(a.cursorAfter).toBe(b.cursorAfter);
    expect(a.winAmount).toBe(b.winAmount);
    expect(a.wildMultipliers).toEqual(b.wildMultipliers);
    expect(a.scatterPayout).toBe(b.scatterPayout);
    expect(a.freeSpinsAwarded).toBe(b.freeSpinsAwarded);
    expect(a.isFreeSpin).toBe(false);
  });

  it('cursor advances 20 bytes + 4 bytes per landed WILD (no rejection sampling)', async () => {
    // Scan many nonces; for each spin assert cursorDelta is
    //   20 (reel samples) + 4 × wildCount + 4 × rejection-resamples.
    // Per-reel sampleIntFromBytes(range=84) almost never rejects
    // (threshold = 2^32 - 2^32 % 84 ≈ 99.999% pass rate); same for
    // range=100 (threshold ≈ 99.999996%). So a typical spin lands at
    // exactly 20 + 4 × wildCount; assertion uses a >= floor with the
    // observation that rejection-overhead is a multiple of 4.
    let cursor = 0;
    for (let nonce = 1; nonce <= 30; nonce++) {
      const result = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor,
        predict: 20n,
      });
      const delta = result.cursorAfter - cursor;
      expect(delta % 4).toBe(0);
      expect(delta).toBeGreaterThanOrEqual(20 + 4 * result.wildMultipliers.length);
      cursor = result.cursorAfter;
    }
  });

  it('classic-3x5 still yields wildMultipliers=[] and scatterPayout=0n (no bonus bleed)', async () => {
    const result = await runSpinLocal({
      paytableId: 'classic-3x5',
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 0,
      cursor: 0,
      predict: 20n,
    });
    expect(result.wildMultipliers).toEqual([]);
    expect(result.scatterPayout).toBe(0n);
    expect(result.freeSpinsAwarded).toBe(0);
    expect(result.isFreeSpin).toBe(false);
    // Slice-2 baseline: classic-3x5 cursorAfter must still be 20 (no
    // wild-multiplier draws ever run on the no-scatter paytable).
    expect(result.cursorAfter).toBe(20);
  });

  it('wildMultipliers sit on actual WILD cells in (reel,row) order', async () => {
    // Scan a range of nonces and verify every emitted wildMultiplier
    // {reelIndex,rowIndex} corresponds to a WILD on the grid.
    const bundle = getVerifierBundle('classic-3x5-bonus');
    let cursor = 0;
    for (let nonce = 1; nonce <= 50; nonce++) {
      const result = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor,
        predict: 20n,
      });
      cursor = result.cursorAfter;
      // Emission order must be (reel asc, row asc).
      let prevKey = -1;
      for (const wm of result.wildMultipliers) {
        expect(result.reels[wm.reelIndex]![wm.rowIndex]).toBe(bundle.wildId);
        const key = wm.reelIndex * 3 + wm.rowIndex;
        expect(key).toBeGreaterThan(prevKey);
        prevKey = key;
        // 2× / 3× / 5× are the only legal effective multipliers when
        // FS_WILD_MULTIPLIER_DOUBLE=false (shipped). Sanity-check.
        expect([2, 3, 5]).toContain(wm.multiplier);
      }
    }
  });
});

describe('verifier.runSpinLocal — base vs free-spin mode parity', () => {
  it('reels + cursor identical across freeSpinMode=false vs true (same RNG)', async () => {
    // Reel samples + wild multiplier draws consume bytes deterministically
    // regardless of mode — only the doubling/scalar step differs. Server
    // engine has the same guarantee (cursor parity is load-bearing for
    // session-level replay).
    for (let nonce = 1; nonce <= 10; nonce++) {
      const base = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor: 0,
        predict: 20n,
        freeSpinMode: false,
      });
      const fs = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor: 0,
        predict: 20n,
        freeSpinMode: true,
      });
      expect(fs.reels).toEqual(base.reels);
      expect(fs.cursorAfter).toBe(base.cursorAfter);
      expect(fs.isFreeSpin).toBe(true);
      expect(base.isFreeSpin).toBe(false);
      // Scatter pay NEVER doubles in FS.
      expect(fs.scatterPayout).toBe(base.scatterPayout);
      // Line-win component honoring shipped FS_LINE_WIN_MULTIPLIER:
      //   • FS_LINE_WIN_MULTIPLIER=1 (shipped) ⇒ fsLine equals baseLine
      //     when no wild participates in a winning line, or some integer
      //     multiple of baseLine when at least one wild does.
      //   • If a future tune flips FS_LINE_WIN_MULTIPLIER back to 2,
      //     fsLine becomes >= 2 × baseLine; this assertion auto-tracks
      //     the constant via floor = baseLine * FS_LINE_WIN_MULTIPLIER.
      const baseLine = base.winAmount - base.scatterPayout;
      const fsLine = fs.winAmount - fs.scatterPayout;
      if (baseLine > 0n) {
        const minFsLine = baseLine * BigInt(FREE_SPIN_RULES.FS_LINE_WIN_MULTIPLIER);
        expect(fsLine).toBeGreaterThanOrEqual(minFsLine);
      }
    }
  });
});

describe('verifier.runSpinLocal — scatter pay-anywhere', () => {
  it('over 500 nonces, scatter-paying spins match SCATTER_PAY_TABLE multipliers', async () => {
    // Walk many spins; whenever scatterPayout > 0, verify the multiplier
    // matches the on-grid scatter count via SCATTER_PAY_TABLE.
    const predict = 20n;
    let cursor = 0;
    let hits = 0;
    const bundle = getVerifierBundle('classic-3x5-bonus');
    for (let nonce = 1; nonce < 500; nonce++) {
      const r = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor,
        predict,
      });
      cursor = r.cursorAfter;
      if (r.scatterPayout > 0n) {
        hits++;
        let count = 0;
        for (let reel = 0; reel < 5; reel++) {
          for (let row = 0; row < 3; row++) {
            if (r.reels[reel]![row] === bundle.scatterId) count++;
          }
        }
        expect(count).toBeGreaterThanOrEqual(FREE_SPIN_RULES.TRIGGER_THRESHOLD);
        const tier =
          SCATTER_PAY_TABLE[Math.min(count, SCATTER_PAY_TABLE.length - 1)] ?? 0;
        expect(r.scatterPayout).toBe(predict * BigInt(tier));
        // Base-mode trigger awards AWARD_BASE free spins.
        expect(r.freeSpinsAwarded).toBe(FREE_SPIN_RULES.AWARD_BASE);
      }
    }
    // Trigger rate ~1 per 96 base spins; expect >0 hits in 500 nonces.
    expect(hits).toBeGreaterThan(0);
  });

  it('free-spin retrigger awards AWARD_RETRIGGER (vs AWARD_BASE in base)', async () => {
    // Scan many nonces with a FIXED cursor=0; for each one run both BASE
    // and FS mode. When the BASE-mode spin pays scatter, the same nonce
    // in FS mode pays the same scatter amount (reels are identical), but
    // awards AWARD_RETRIGGER instead of AWARD_BASE.
    let foundRetrigger = false;
    for (let nonce = 1; nonce < 500 && !foundRetrigger; nonce++) {
      const base = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor: 0,
        predict: 20n,
      });
      if (base.scatterPayout === 0n) continue;
      const fs = await runSpinLocal({
        paytableId: 'classic-3x5-bonus',
        serverSeed: 'a'.repeat(64),
        clientSeed: 'abcd1234',
        nonce,
        cursor: 0,
        predict: 20n,
        freeSpinMode: true,
      });
      expect(base.freeSpinsAwarded).toBe(FREE_SPIN_RULES.AWARD_BASE);
      expect(fs.freeSpinsAwarded).toBe(FREE_SPIN_RULES.AWARD_RETRIGGER);
      expect(fs.scatterPayout).toBe(base.scatterPayout);
      foundRetrigger = true;
    }
    // In 500 base-mode nonces we expect at least one scatter trigger
    // (~1 per 96 spins from the binomial trigger rate).
    expect(foundRetrigger).toBe(true);
  });
});

describe('verifier.evaluateReelsLocal — bonus scatter + wild multiplier math', () => {
  // SYMBOL id constants for grid synthesis (match BONUS_SYMBOLS / CLASSIC_SYMBOLS).
  const CHERRY = 0;
  const LEMON = 1;
  const PLUM = 3;
  const WILD_ID = 7;
  const SCATTER = 10;

  function gridBonus(middle: number[], fill: number): number[][] {
    if (middle.length !== 5) throw new Error('middle must be 5 entries');
    return middle.map((m) => [fill, m, fill]);
  }

  it('scatter on a payline BREAKS the run (Cherry,Cherry,Scatter,Cherry,Cherry → 2-of-kind only)', () => {
    const reels = gridBonus([CHERRY, CHERRY, SCATTER, CHERRY, CHERRY], LEMON);
    const { winningLines } = evaluateReelsLocal(reels, 'classic-3x5-bonus', 20n);
    const mid = winningLines.find((w) => w.lineIndex === 0);
    expect(mid).toBeDefined();
    expect(mid!.multiplier).toBe(2); // 2-of-kind Cherry payouts[0]
    expect(mid!.winAmount).toBe(2n);
  });

  it('two wilds on one line multiply their multipliers (×2 × ×5 = ×10 line scalar)', () => {
    const reels = gridBonus([WILD_ID, CHERRY, WILD_ID, CHERRY, CHERRY], LEMON);
    const { winningLines } = evaluateReelsLocal(reels, 'classic-3x5-bonus', 20n, {
      wildMultipliers: [
        { reelIndex: 0, rowIndex: 1, multiplier: 2 },
        { reelIndex: 2, rowIndex: 1, multiplier: 5 },
      ],
    });
    const mid = winningLines.find((w) => w.lineIndex === 0)!;
    expect(mid.multiplier).toBe(18); // 5-of-kind id 0 (RTP-94% retune)
    // perLine=1, raw payout=18, wild product=10 ⇒ 18 × 10 = 180
    expect(mid.winAmount).toBe(180n);
  });

  it('wild OUTSIDE matchLen prefix does NOT multiply (line broken before it)', () => {
    const reels = gridBonus([CHERRY, CHERRY, PLUM, WILD_ID, CHERRY], LEMON);
    const { winningLines } = evaluateReelsLocal(reels, 'classic-3x5-bonus', 20n, {
      wildMultipliers: [{ reelIndex: 3, rowIndex: 1, multiplier: 5 }],
    });
    const mid = winningLines.find((w) => w.lineIndex === 0)!;
    expect(mid.multiplier).toBe(2); // 2-of-kind Cherry only
    expect(mid.winAmount).toBe(2n);
  });

  it('rejects wildMultiplier pointing at a non-WILD cell (adversarial guard)', () => {
    const reels = gridBonus([CHERRY, CHERRY, CHERRY, CHERRY, CHERRY], LEMON);
    expect(() =>
      evaluateReelsLocal(reels, 'classic-3x5-bonus', 20n, {
        wildMultipliers: [{ reelIndex: 0, rowIndex: 1, multiplier: 3 }],
      }),
    ).toThrow(/does not sit on a WILD cell/);
  });
});

describe('verifier.replaySpin — bonus paytable round-trip', () => {
  it('byte-identity replay of a bonus spin (computed = expected)', async () => {
    // Generate a real bonus spin and feed its outputs back as `expected`
    // — replay must report ok=true. This is the canonical session-verifier
    // path: server emits a spin row → page asks verifier to replay → match.
    const args = {
      paytableId: 'classic-3x5-bonus' as const,
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 11,
      cursor: 0,
      predict: 40n,
    };
    const truth = await runSpinLocal(args);
    const verdict = await replaySpin({
      ...args,
      expected: {
        reels: truth.reels,
        winAmount: truth.winAmount.toString(),
        cursorAfter: truth.cursorAfter,
        wildMultipliers: truth.wildMultipliers,
        scatterPayout: truth.scatterPayout.toString(),
        freeSpinsAwarded: truth.freeSpinsAwarded,
      },
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it('detects a tampered scatterPayout', async () => {
    const args = {
      paytableId: 'classic-3x5-bonus' as const,
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 11,
      cursor: 0,
      predict: 40n,
    };
    const truth = await runSpinLocal(args);
    const verdict = await replaySpin({
      ...args,
      expected: {
        reels: truth.reels,
        winAmount: truth.winAmount.toString(),
        cursorAfter: truth.cursorAfter,
        wildMultipliers: truth.wildMultipliers,
        scatterPayout: (truth.scatterPayout + 99n).toString(),
        freeSpinsAwarded: truth.freeSpinsAwarded,
      },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((r) => r.includes('scatterPayout'))).toBe(true);
  });

  it('replays a FS-mode spin correctly when freeSpinMode is passed through', async () => {
    const args = {
      paytableId: 'classic-3x5-bonus' as const,
      serverSeed: 'a'.repeat(64),
      clientSeed: 'abcd1234',
      nonce: 5,
      cursor: 0,
      predict: 20n,
      freeSpinMode: true,
    };
    const truth = await runSpinLocal(args);
    const verdict = await replaySpin({
      ...args,
      expected: {
        reels: truth.reels,
        winAmount: truth.winAmount.toString(),
        cursorAfter: truth.cursorAfter,
        wildMultipliers: truth.wildMultipliers,
        scatterPayout: truth.scatterPayout.toString(),
        freeSpinsAwarded: truth.freeSpinsAwarded,
      },
    });
    expect(verdict.ok).toBe(true);
    expect(truth.isFreeSpin).toBe(true);
  });
});
