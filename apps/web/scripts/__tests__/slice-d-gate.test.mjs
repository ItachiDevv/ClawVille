// slice-d-gate.test.mjs — rung-4 slice-D gate exports (spec §5, FROZEN
// rev 5; findings I2-F4/F5/F6 regression coverage).
import { describe, expect, test } from "bun:test";
import {
  SLICE_D_REQUIRED_PAIRS,
  SLICE_D_WINDOW_MS,
  evaluateSliceDGate,
  sliceDCandidateDefects,
  sliceDPostSettleStable,
} from "../cold-load-paired-gate.mjs";

// ---------------------------------------------------------------------------
// sliceDPostSettleStable [I2-F4]
// ---------------------------------------------------------------------------

describe("sliceDPostSettleStable", () => {
  // TILING series (d = step): frame entries tile time by construction in
  // the real probe (d = now − last), and the coverage proof requires it.
  const denseFrames = (fromMs, toMs, stepMs = 50) => {
    const out = [];
    for (let t = fromMs + stepMs; t <= toMs; t += stepMs) out.push({ t, d: stepMs });
    return out;
  };

  test("Codex counterexample: overlapping bad interval near the window edge is NOT a pass", () => {
    // reveal=0 → window ends 15000. settle=12000. Bad frame {t:16000,d:2000}
    // occupies [14000,16000]: only 2 clean seconds exist inside the window.
    const frames = [...denseFrames(11900, 13900), { t: 16000, d: 2000 }];
    expect(sliceDPostSettleStable(frames, 0, 12000)).toBeNull();
  });

  test("empty frame series proves nothing", () => {
    expect(sliceDPostSettleStable([], 0, 5000)).toBeNull();
  });

  test("series ending before the claimed span proves nothing (coverage)", () => {
    // Clean frames but the series stops at settle+1s — no proof the loop
    // was alive through the 3s span.
    expect(sliceDPostSettleStable(denseFrames(5000, 6000), 0, 5000)).toBeNull();
  });

  test("clean covered span passes with the span start", () => {
    const frames = denseFrames(5000, 9000);
    expect(sliceDPostSettleStable(frames, 0, 5000)).toBe(5000);
  });

  test("bad interval mid-span restarts after its END (interval overlap)", () => {
    // Bad frame [6500,6700] breaks 5000→; restart at 6700; clean to 10000.
    const frames = [...denseFrames(5000, 10000), { t: 6700, d: 200 }];
    expect(sliceDPostSettleStable(frames, 0, 5000)).toBe(6700);
  });

  test("settle too close to the window edge can never pass", () => {
    expect(sliceDPostSettleStable(denseFrames(12500, 15000), 0, 12500)).toBeNull();
  });

  test("I3 counterexample: a single later frame is NOT continuous coverage", () => {
    // Claimed span [13000,16000] with the ONLY frame at {t:20000,d:16} —
    // nothing covers the span; a later frame existing proves nothing.
    expect(sliceDPostSettleStable([{ t: 20000, d: 16 }], 4000, 13000, 16000)).toBeNull();
  });

  test("series beginning AFTER the claimed span is not coverage", () => {
    expect(sliceDPostSettleStable(denseFrames(9000, 12000), 0, 5000)).toBeNull();
  });

  test("a coverage seam inside the span (trimmed ring) rejects the span", () => {
    // Frames cover [5000,6000] and [7000,9000] — a 1s hole mid-span.
    const frames = [...denseFrames(5000, 6000), ...denseFrames(7000, 9000, 100)];
    // The 7000-start entries have d=16-ish? denseFrames uses d:16 with step
    // 100 — intervals [t-16,t] leave seams > tolerance, so coverage itself
    // must come from tiling frames; build a tiling series instead.
    const tile = (from, to, step = 30) => {
      const out = [];
      for (let t = from + step; t <= to; t += step) out.push({ t, d: step });
      return out;
    };
    const holed = [...tile(5000, 6000), ...tile(7000, 9000)];
    expect(sliceDPostSettleStable(holed, 0, 5000)).toBeNull();
    void frames;
  });

  test("tiling frames covering the span pass", () => {
    const tile = (from, to, step = 30) => {
      const out = [];
      for (let t = from + step; t <= to; t += step) out.push({ t, d: step });
      return out;
    };
    expect(sliceDPostSettleStable(tile(5000, 8200), 0, 5000)).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Synthetic report builders
// ---------------------------------------------------------------------------

const REVEAL = 4000;
const goodPhases = () => ({
  bootCorePresentedAt: 3500,
  bootActorKind: "player-vrm",
  bootActorResolvedAt: 1200,
  bootActorReadyAt: 2000,
  bootActorGateTimedOut: false,
  bootCoreDriftCount: 0,
  bootCoreDriftChunks: "",
  streamSettledAt: REVEAL + 9000,
  landSettledAt: REVEAL + 8000,
  streamCohort: { total: 16, terminal: 16, warmed: 16, failopen: 0, failed: 0, nonterminal: [] },
  landTracker: { inFlightRequests: 0, dataOk: 4, dataFailed: 0, glbOk: 30, glbFallback: 0, glbFailed: 0, slots: {} },
});

const framesFor = (summaryPhases) => {
  const settle = Math.max(summaryPhases.streamSettledAt, summaryPhases.landSettledAt);
  const out = [];
  // Tiling 50ms frames from reveal through settle+3.6s (coverage proof).
  for (let t = REVEAL + 50; t <= settle + 3600; t += 50) out.push({ t, d: 50 });
  return out;
};

const mkCandidate = (overrides = {}, summaryOverrides = {}) => {
  const phases = { ...goodPhases(), ...overrides };
  return {
    revealMs: REVEAL,
    backend: "webgpu",
    backendWaived: false,
    validForPerformance: true,
    expectedBootActor: "player-vrm",
    storageStateInjected: true,
    longtasks: { boundaryKind: "polled-reveal-v2", preRevealTotalMs: 900 },
    frameMetrics: { framesOver100In10s: 1, worstFrameMsIn10s: 150, stableWindowStartMsAfterReveal: 40 },
    phases,
    phasesAtWindow: phases,
    ...summaryOverrides,
  };
};

const mkBaseline = () => ({
  revealMs: 9500,
  backend: "webgpu",
  backendWaived: false,
  validForPerformance: true,
  longtasks: { boundaryKind: "polled-reveal-v2", preRevealTotalMs: 2000 },
  frameMetrics: { framesOver100In10s: 1, worstFrameMsIn10s: 300, stableWindowStartMsAfterReveal: 700 },
  phases: {},
});

const mkPair = (order, candOverrides = {}, candSummaryOverrides = {}) => {
  const candidate = mkCandidate(candOverrides, candSummaryOverrides);
  return {
    order,
    baseline: mkBaseline(),
    candidate,
    candidateFrames: framesFor(candidate.phasesAtWindow),
  };
};

const mkManifestPairs = (n = SLICE_D_REQUIRED_PAIRS) =>
  Array.from({ length: n }, (_, i) => mkPair(i % 2 === 0 ? "AB" : "BA"));

// ---------------------------------------------------------------------------
// sliceDCandidateDefects [I2-F6]
// ---------------------------------------------------------------------------

describe("sliceDCandidateDefects", () => {
  test("clean authenticated candidate has zero defects", () => {
    const c = mkCandidate();
    expect(sliceDCandidateDefects(c, framesFor(c.phasesAtWindow), "player-vrm")).toEqual([]);
  });

  test("guest report cannot satisfy the authenticated lane", () => {
    const c = mkCandidate(
      { bootActorKind: "none" },
      { expectedBootActor: "none", storageStateInjected: false },
    );
    const defects = sliceDCandidateDefects(c, framesFor(c.phasesAtWindow), "player-vrm");
    expect(defects.some((d) => d.includes("expectedBootActor"))).toBe(true);
    expect(defects.some((d) => d.includes("storageStateInjected"))).toBe(true);
  });

  test("ready-failopen and drift invalidate the run", () => {
    const c = mkCandidate({
      bootCoreDriftCount: 1,
      bootCoreDriftChunks: "chunk:wandering-npcs",
      streamCohort: { total: 16, terminal: 16, warmed: 15, failopen: 1, failed: 0, nonterminal: [] },
    });
    const defects = sliceDCandidateDefects(c, framesFor(c.phasesAtWindow), "player-vrm");
    expect(defects.some((d) => d.includes("bootCoreDriftCount"))).toBe(true);
    expect(defects.some((d) => d.includes("failopen"))).toBe(true);
  });

  test("settle outside the window invalidates the run", () => {
    const c = mkCandidate({ streamSettledAt: REVEAL + SLICE_D_WINDOW_MS + 500 });
    const defects = sliceDCandidateDefects(c, framesFor(c.phasesAtWindow), "player-vrm");
    expect(defects.some((d) => d.includes("window"))).toBe(true);
  });

  test("missing phasesAtWindow snapshot is a defect", () => {
    const c = mkCandidate({}, { phasesAtWindow: null });
    const defects = sliceDCandidateDefects(c, framesFor(c.phases), "player-vrm");
    expect(defects.some((d) => d.includes("phasesAtWindow"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateSliceDGate [I2-F5][I2-F6]
// ---------------------------------------------------------------------------

describe("evaluateSliceDGate", () => {
  test("12 clean counterbalanced authenticated pairs pass", () => {
    const result = evaluateSliceDGate(mkManifestPairs(), {
      backend: "webgpu",
      expectBootActor: "player-vrm",
    });
    expect(result.verdict).toBe("pass");
    expect(result.perMetric.bootCorePresentedAt.verdict).toBe("pass");
  });

  test("13-pair manifest FAILS even when 12 are clean (no topping up) [I2-F5]", () => {
    const result = evaluateSliceDGate(mkManifestPairs(13), {
      backend: "webgpu",
      expectBootActor: "player-vrm",
    });
    expect(result.verdict).toBe("fail");
    expect(result.reasons.join(" ")).toContain("exactly");
  });

  test("one defective pair FAILS the batch (re-run the pair) [I2-F5]", () => {
    const pairs = mkManifestPairs();
    pairs[3] = mkPair("BA", { bootCoreDriftCount: 2, bootCoreDriftChunks: "x,y" });
    const result = evaluateSliceDGate(pairs, {
      backend: "webgpu",
      expectBootActor: "player-vrm",
    });
    expect(result.verdict).toBe("fail");
    expect(result.reasons.some((r) => r.includes("pair 4 INVALID"))).toBe(true);
  });

  test("guest reports against the authenticated lane FAIL [I2-F6]", () => {
    const pairs = Array.from({ length: SLICE_D_REQUIRED_PAIRS }, (_, i) =>
      mkPair(i % 2 === 0 ? "AB" : "BA", { bootActorKind: "none" }, {
        expectedBootActor: "none",
        storageStateInjected: false,
      }),
    );
    const result = evaluateSliceDGate(pairs, {
      backend: "webgpu",
      expectBootActor: "player-vrm",
    });
    expect(result.verdict).toBe("fail");
  });

  test("presented median over the limit fails the primary metric", () => {
    const pairs = Array.from({ length: SLICE_D_REQUIRED_PAIRS }, (_, i) =>
      mkPair(i % 2 === 0 ? "AB" : "BA", { bootCorePresentedAt: 6200 }),
    );
    const result = evaluateSliceDGate(pairs, {
      backend: "webgpu",
      expectBootActor: "player-vrm",
    });
    expect(result.verdict).toBe("fail");
    expect(result.perMetric.bootCorePresentedAt.verdict).toBe("fail");
  });
});
