/**
 * Boundary + validity tests for the cold-load probe's pure aggregation
 * functions (rung-0 delta re-review blockers 1-2): byte-split sides incl. the
 * chunk-residual rule, interval-overlap frame windows with cross-boundary
 * stalls, and adversarial validity fixtures for every fail-closed path.
 */
import { describe, expect, it } from 'bun:test';
import {
  computeByteSplit,
  computeFrameMetrics,
  computeValidity,
  // @ts-expect-error — plain .mjs module, no type declarations
} from '../cold-load-probe.mjs';

const REVEAL = 10_000;

describe('computeByteSplit', () => {
  it('pre-only: finished before reveal keeps ALL bytes pre even with zero chunk coverage', () => {
    // The v2 chunk-residual leak: chunkless request finished at 5s, reveal 10s.
    const r = { wireBytes: 1000, startPageMs: 1000, endPageMs: 5000, chunks: [] };
    expect(computeByteSplit(r, REVEAL)).toEqual({ pre: 1000, post: 0 });
  });
  it('pre-only: partial chunk coverage never leaks residual to post', () => {
    const r = { wireBytes: 1000, startPageMs: 1000, endPageMs: 5000, chunks: [{ pageMs: 2000, bytes: 400 }] };
    expect(computeByteSplit(r, REVEAL)).toEqual({ pre: 1000, post: 0 });
  });
  it('post-only: started after reveal is all post', () => {
    const r = { wireBytes: 500, startPageMs: 11_000, endPageMs: 12_000, chunks: [{ pageMs: 11_500, bytes: 500 }] };
    expect(computeByteSplit(r, REVEAL)).toEqual({ pre: 0, post: 500 });
  });
  it('straddler: chunks split by side, residual follows the end (post) side', () => {
    const r = {
      wireBytes: 1000, startPageMs: 9000, endPageMs: 12_000,
      chunks: [{ pageMs: 9500, bytes: 300 }, { pageMs: 11_000, bytes: 200 }], // 500 residual
    };
    expect(computeByteSplit(r, REVEAL)).toEqual({ pre: 300, post: 700 });
  });
  it('no reveal observed: everything counts pre (whole capture gated)', () => {
    const r = { wireBytes: 100, startPageMs: 1, endPageMs: 2, chunks: [] };
    expect(computeByteSplit(r, null)).toEqual({ pre: 100, post: 0 });
  });
});

describe('computeFrameMetrics — interval overlap', () => {
  it('counts a stall that STARTS inside the window but ends outside it', () => {
    // 9s stall: begins at reveal+8s, callback fires at reveal+17s (outside).
    const frames = [
      { t: REVEAL + 1000, d: 10 },
      { t: REVEAL + 17_000, d: 9000 }, // interval [reveal+8s, reveal+17s] overlaps
    ];
    const m = computeFrameMetrics(frames, REVEAL);
    expect(m.worstFrameMsIn10s).toBe(9000);
    expect(m.framesOver100In10s).toBe(1);
  });
  it('excludes frames wholly outside the window', () => {
    const frames = [
      { t: REVEAL + 1000, d: 10 },
      { t: REVEAL + 25_000, d: 5000 }, // interval [reveal+20s, reveal+25s]
    ];
    expect(computeFrameMetrics(frames, REVEAL).worstFrameMsIn10s).toBe(10);
  });
  it('stable window: first contiguous 3s run of ≤100ms frames after reveal', () => {
    const frames = [];
    for (let t = REVEAL + 16; t <= REVEAL + 1500; t += 16) frames.push({ t, d: 16 });
    frames.push({ t: REVEAL + 1600, d: 200 }); // breaks the run at +1.6s
    for (let t = REVEAL + 1616; t <= REVEAL + 6000; t += 16) frames.push({ t, d: 16 });
    const m = computeFrameMetrics(frames, REVEAL);
    expect(m.stableWindowStartMsAfterReveal).toBe(1600);
  });
});

describe('computeValidity — adversarial fixtures', () => {
  const goodAsset = (over = {}) => ({
    url: 'https://x/models/a.glb', cls: 'GLB', failed: false, finished: true,
    status: 200, everFromCache: false, everFromSW: false, startPageMs: 1, endPageMs: 2, wireBytes: 10, ...over,
  });
  const base = { revealMs: 5000, backend: 'webgpu', expectedBackend: 'webgpu' };

  it('accepts a clean run', () => {
    expect(computeValidity({ all: [goodAsset()], ...base }).valid).toBe(true);
  });
  it('rejects arbitrary backend strings (not just -requested)', () => {
    const v = computeValidity({ all: [goodAsset()], ...base, backend: 'unknown' });
    expect(v.valid).toBe(false);
    expect(v.reasons.join()).toContain('backend not actual');
  });
  it('rejects a backend that does not match the requested lane', () => {
    const v = computeValidity({ all: [goodAsset()], ...base, backend: 'webgl2' });
    expect(v.reasons.join()).toContain('!= requested lane');
  });
  it('rejects when a FAILED leg carries SW evidence (failed legs are counted)', () => {
    const v = computeValidity({ all: [goodAsset({ failed: true, everFromSW: true })], ...base });
    expect(v.reasons.join()).toContain('service-worker');
  });
  it('redirect-preserved cache evidence invalidates the first occurrence', () => {
    const v = computeValidity({ all: [goodAsset({ everFromCache: true })], ...base });
    expect(v.reasons.join()).toContain('first-occurrence cache');
  });
  it('later duplicate served from cache is fine; first from network is cold', () => {
    const v = computeValidity({
      all: [goodAsset({ startPageMs: 1 }), goodAsset({ startPageMs: 50, everFromCache: true })],
      ...base,
    });
    expect(v.valid).toBe(true);
  });
  it('rejects a finished network asset with no observed status', () => {
    const v = computeValidity({ all: [goodAsset({ status: null })], ...base });
    expect(v.reasons.join()).toContain('no observed status');
  });
  it('rejects non-2xx (304 = warm) and unfinished assets', () => {
    expect(computeValidity({ all: [goodAsset({ status: 304 })], ...base }).valid).toBe(false);
    expect(computeValidity({ all: [goodAsset({ finished: false })], ...base }).reasons.join()).toContain('unfinished');
  });
  it('rejects unobserved reveal', () => {
    const v = computeValidity({ all: [goodAsset()], ...base, revealMs: null });
    expect(v.reasons.join()).toContain('reveal never observed');
  });
  it('backend waiver: only a NULL backend passes, only with the flag, and is stamped', () => {
    const nullBackend = { all: [goodAsset()], revealMs: 5000, backend: null, expectedBackend: 'webgpu' };
    expect(computeValidity(nullBackend).valid).toBe(false);
    const waived = computeValidity({ ...nullBackend, waiveBackend: true });
    expect(waived.valid).toBe(true);
    expect(waived.backendWaived).toBe(true);
    // A present-but-wrong backend is NEVER waivable.
    const wrong = computeValidity({ ...nullBackend, backend: 'unknown', waiveBackend: true });
    expect(wrong.valid).toBe(false);
  });
  it('data:/blob: never participate in the cold criterion', () => {
    const v = computeValidity({
      all: [goodAsset(), { url: 'data:image/webp;base64,AA', cls: 'OTHER', failed: false, finished: true, status: 200, everFromCache: true, everFromSW: false, startPageMs: 1, wireBytes: 0 }],
      ...base,
    });
    expect(v.valid).toBe(true);
  });
});
