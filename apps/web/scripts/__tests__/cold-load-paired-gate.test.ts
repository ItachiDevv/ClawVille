/**
 * Paired-gate tests (re-review #3 blocking 1): exact order-statistic bound,
 * counterbalance enforcement, strict-evidence pair dropping, and the
 * extend-vs-fail rule. Synthetic summaries only — the gate consumes the same
 * summary shape the probe emits.
 */
import { describe, expect, it } from 'bun:test';
import {
  evaluatePairedGate,
  medianUpperBoundIndex,
  upperBoundOfMedian,
  // @ts-expect-error — plain .mjs module, no type declarations
} from '../cold-load-paired-gate.mjs';

function summary(revealMs: number, over: any = {}) {
  return {
    validForPerformance: true,
    backendWaived: false,
    revealMs,
    frameMetrics: { worstFrameMsIn10s: 1000, stableWindowStartMsAfterReveal: 3000, framesOver100In10s: 2, ...over.fm },
    longtasks: { preRevealTotalMs: 4000, ...over.lt },
    ...over.top,
  };
}
function makePairs(n: number, candidateFactor: number) {
  return Array.from({ length: n }, (_, i) => ({
    order: i % 2 === 0 ? 'AB' : 'BA',
    baseline: summary(20_000),
    candidate: summary(20_000 * candidateFactor),
  }));
}

describe('medianUpperBoundIndex — exact binomial order statistic', () => {
  it('n=8 at 95% → 7th order statistic (cum 247/256 ≈ 0.9648)', () => {
    expect(medianUpperBoundIndex(8, 0.95)).toBe(7);
  });
  it('too-small n has no valid bound', () => {
    expect(medianUpperBoundIndex(4, 0.95)).toBeNull();
  });
  it('upperBoundOfMedian picks the k-th smallest', () => {
    expect(upperBoundOfMedian([5, 1, 4, 2, 8, 3, 7, 6], 0.95)).toBe(7); // 7th of 8 sorted
  });
});

describe('evaluatePairedGate', () => {
  it('passes when the candidate is consistently well inside the ratio limit', () => {
    const r = evaluatePairedGate(makePairs(8, 1.02));
    expect(r.verdict).toBe('pass');
    expect(r.perMetric.revealMs.verdict).toBe('pass');
  });
  it('is inconclusive (extend) below the cap when the bound does not close', () => {
    const r = evaluatePairedGate(makePairs(8, 1.3));
    expect(r.verdict).toBe('inconclusive');
  });
  it('fails at the extension cap when the bound still does not close', () => {
    const r = evaluatePairedGate(makePairs(12, 1.3));
    expect(r.verdict).toBe('fail');
  });
  it('is inconclusive below MIN_PAIRS', () => {
    const r = evaluatePairedGate(makePairs(5, 1.0));
    expect(r.verdict).toBe('inconclusive');
    expect(r.reasons.join()).toContain('usable pairs');
  });
  it('drops pairs whose reports are not strict performance evidence', () => {
    const pairs = makePairs(9, 1.0);
    (pairs[0].baseline as any).validForPerformance = false;
    (pairs[1].candidate as any).backendWaived = true;
    const r = evaluatePairedGate(pairs);
    expect(r.usablePairs).toBe(7);
    expect(r.verdict).toBe('inconclusive'); // 7 < 8 usable
  });
  it('fails on a non-counterbalanced order', () => {
    const pairs = makePairs(8, 1.0).map((p) => ({ ...p, order: 'AB' as const }));
    const r = evaluatePairedGate(pairs);
    expect(r.verdict).toBe('fail');
    expect(r.reasons.join()).toContain('counterbalanced');
  });
  it('frame-count metric gates on paired differences', () => {
    const pairs = makePairs(8, 1.0);
    for (const p of pairs) (p.candidate.frameMetrics as any).framesOver100In10s = 9; // +7 vs baseline 2
    const r = evaluatePairedGate(pairs, {});
    expect(r.perMetric.framesOver100In10s.verdict).not.toBe('pass');
  });
});
