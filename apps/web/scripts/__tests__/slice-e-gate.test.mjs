// slice-e-gate.test.mjs — rung-4 slice-E gate exports (spec rev 3 §3
// [R1-7][R1-9][R2-3][R2-4][R2-5][R2-6]): compile-stamp schema (all stamps
// required, nonneg durations, integer counts, accounting invariants),
// mode/failure/coverage counterexamples, PAIRED improvement bound, lane
// enforcement, build-identity rules.
import { describe, expect, test } from "bun:test";
import {
  SLICE_D_REQUIRED_PAIRS,
  SLICE_E_COMPILE_MODE,
  SLICE_E_COMPILE_TAIL_LIMIT_MS,
  evaluateSliceEGate,
  sliceECandidateDefects,
} from "../cold-load-paired-gate.mjs";

const REVEAL = 4000;

const goodCompileStamps = () => ({
  bootCoreCompileMs: 900,
  bootCoreCompileTailMs: 450,
  bootCoreCompileEarlyHiddenMs: 450,
  bootCoreCompileEarlyMs: 850,
  bootCoreCompileLateMs: 50,
  bootCoreCompileRequested: 17,
  bootCoreCompileDispatched: 17,
  bootCoreCompileSettled: 17,
  bootCoreCompileFailedGroups: 0,
  bootCoreCompileRenderables: 140,
  bootCoreCompileMode: SLICE_E_COMPILE_MODE,
});

const goodPhases = () => ({
  bootCorePresentedAt: 3200,
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
  ...goodCompileStamps(),
});

const framesFor = (phases) => {
  const settle = Math.max(phases.streamSettledAt, phases.landSettledAt);
  const out = [];
  for (let t = REVEAL + 50; t <= settle + 3600; t += 50) out.push({ t, d: 50 });
  return out;
};

const mkCandidate = (phaseOverrides = {}, summaryOverrides = {}) => {
  const phases = { ...goodPhases(), ...phaseOverrides };
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

// Baseline = slice-D build (dc44a10d): carries the serial compile wall stamp.
const mkBaseline = (compileMs = 1280) => {
  const phases = { bootCoreCompileMs: compileMs };
  return {
    revealMs: 9500,
    backend: "webgpu",
    backendWaived: false,
    validForPerformance: true,
    longtasks: { boundaryKind: "polled-reveal-v2", preRevealTotalMs: 2000 },
    frameMetrics: { framesOver100In10s: 1, worstFrameMsIn10s: 300, stableWindowStartMsAfterReveal: 700 },
    phases,
    phasesAtWindow: phases,
  };
};

const mkPairs = (candOverrides = {}, baselineCompileMs = 1280) =>
  Array.from({ length: SLICE_D_REQUIRED_PAIRS }, (_, i) => {
    const candidate = mkCandidate(candOverrides);
    return {
      order: i % 2 === 0 ? "AB" : "BA",
      baseline: mkBaseline(baselineCompileMs),
      candidate,
      candidateFrames: framesFor(candidate.phasesAtWindow),
    };
  });

const OPTS = {
  backend: "webgpu",
  expectBootActor: "player-vrm",
  baselineSha: "dc44a10dabcd",
  candidateSha: "deadbeef1234",
};

describe("sliceECandidateDefects", () => {
  test("clean candidate has zero defects", () => {
    expect(sliceECandidateDefects(mkCandidate())).toEqual([]);
  });

  test("missing compile stamps are defects (slice-D-only build cannot pass)", () => {
    const c = mkCandidate();
    const ph = { ...c.phasesAtWindow };
    for (const k of Object.keys(goodCompileStamps())) delete ph[k];
    c.phases = ph;
    c.phasesAtWindow = ph;
    const defects = sliceECandidateDefects(c);
    expect(defects.some((d) => d.includes("bootCoreCompileTailMs"))).toBe(true);
    expect(defects.some((d) => d.includes("bootCoreCompileEarlyMs"))).toBe(true);
    expect(defects.some((d) => d.includes("bootCoreCompileMode"))).toBe(true);
  });

  test("negative durations and fractional counts are defects [R2-4]", () => {
    const neg = sliceECandidateDefects(mkCandidate({ bootCoreCompileTailMs: -500 }));
    expect(neg.some((d) => d.includes("negative bootCoreCompileTailMs"))).toBe(true);
    const negWall = sliceECandidateDefects(mkCandidate({ bootCoreCompileMs: -1 }));
    expect(negWall.some((d) => d.includes("negative bootCoreCompileMs"))).toBe(true);
    const frac = sliceECandidateDefects(mkCandidate({
      bootCoreCompileRequested: 0.5,
      bootCoreCompileDispatched: 0.5,
      bootCoreCompileSettled: 0.5,
    }));
    expect(frac.some((d) => d.includes("non-integer bootCoreCompileRequested"))).toBe(true);
  });

  test("accounting invariants: tail ≤ wall and wall = hidden + tail [R2-4]", () => {
    const tailOverWall = sliceECandidateDefects(mkCandidate({
      bootCoreCompileTailMs: 1200,
      bootCoreCompileMs: 900,
      bootCoreCompileEarlyHiddenMs: 0,
    }));
    expect(tailOverWall.some((d) => d.includes("exceeds wall"))).toBe(true);
    const holed = sliceECandidateDefects(mkCandidate({
      bootCoreCompileMs: 900,
      bootCoreCompileTailMs: 400,
      bootCoreCompileEarlyHiddenMs: 100, // 400+100 ≠ 900
    }));
    expect(holed.some((d) => d.includes("hidden + tail"))).toBe(true);
  });

  test("wrong mode / failed groups / zero inventory / coverage mismatch are defects", () => {
    expect(sliceECandidateDefects(mkCandidate({ bootCoreCompileMode: "group-pooled-4" }))
      .some((d) => d.includes("bootCoreCompileMode"))).toBe(true);
    expect(sliceECandidateDefects(mkCandidate({ bootCoreCompileFailedGroups: 1 }))
      .some((d) => d.includes("!= 0"))).toBe(true);
    expect(sliceECandidateDefects(
      mkCandidate({ bootCoreCompileRequested: 0, bootCoreCompileDispatched: 0, bootCoreCompileSettled: 0 }),
    ).some((d) => d.includes("must be > 0"))).toBe(true);
    expect(sliceECandidateDefects(mkCandidate({ bootCoreCompileSettled: 16 }))
      .some((d) => d.includes("coverage mismatch"))).toBe(true);
    expect(sliceECandidateDefects(mkCandidate({ bootCoreCompileRenderables: 0 }))
      .some((d) => d.includes("Renderables must be > 0"))).toBe(true);
  });
});

describe("evaluateSliceEGate", () => {
  test("12 clean pairs with identity pass", () => {
    const result = evaluateSliceEGate(mkPairs(), OPTS);
    expect(result.verdict).toBe("pass");
    expect(result.perMetric.bootCoreCompileTailMs.verdict).toBe("pass");
    expect(result.perMetric.compileImprovement.verdict).toBe("pass");
    expect(result.perMetric.compileImprovement.pairedImprovementMedian).toBe(1280 - 450);
  });

  test("missing/identical/dirty build identity fails before statistics [R1-9][R2-6]", () => {
    expect(evaluateSliceEGate(mkPairs(), { ...OPTS, candidateSha: null }).verdict).toBe("fail");
    const same = evaluateSliceEGate(mkPairs(), { ...OPTS, candidateSha: OPTS.baselineSha });
    expect(same.verdict).toBe("fail");
    expect(same.reasons.join(" ")).toContain("distinct committed build");
    const dirty = evaluateSliceEGate(mkPairs(), { ...OPTS, candidateSha: "deadbeef-dirty" });
    expect(dirty.verdict).toBe("fail");
    expect(dirty.reasons.join(" ")).toContain("dirty");
  });

  test("non-player-vrm lane cannot produce a ship verdict [R2-5]", () => {
    const result = evaluateSliceEGate(mkPairs(), { ...OPTS, expectBootActor: "player-glb" });
    expect(result.verdict).toBe("fail");
    expect(result.reasons.join(" ")).toContain("player-vrm");
  });

  test("tail median at/over the absolute ceiling fails", () => {
    const over = SLICE_E_COMPILE_TAIL_LIMIT_MS + 50;
    const result = evaluateSliceEGate(
      mkPairs({
        bootCoreCompileTailMs: over,
        bootCoreCompileMs: over + 100,
        bootCoreCompileEarlyHiddenMs: 100,
      }),
      OPTS,
    );
    expect(result.verdict).toBe("fail");
    expect(result.perMetric.bootCoreCompileTailMs.verdict).toBe("fail");
  });

  test("Codex R2-3 counterexample: diff-of-medians passes, PAIRED median fails", () => {
    // Large improvements on small baselines, small improvements on large
    // baselines: baselineMedian − tailMedian = 335 (old unpaired check would
    // pass) but the median WITHIN-PAIR improvement is 287.5 < 300.
    const baselines = [900, 905, 910, 915, 920, 1200, 1210, 1220, 1230, 1240, 1250, 1260];
    const improvements = [400, 395, 390, 385, 380, 290, 285, 280, 275, 270, 265, 260];
    const pairs = baselines.map((b, i) => {
      const tail = b - improvements[i];
      const candidate = mkCandidate({
        bootCoreCompileTailMs: tail,
        bootCoreCompileMs: tail + 100,
        bootCoreCompileEarlyHiddenMs: 100,
      });
      return {
        order: i % 2 === 0 ? "AB" : "BA",
        baseline: mkBaseline(b),
        candidate,
        candidateFrames: framesFor(candidate.phasesAtWindow),
      };
    });
    const result = evaluateSliceEGate(pairs, OPTS);
    expect(result.perMetric.compileImprovement.pairedImprovementMedian).toBe(287.5);
    expect(result.perMetric.compileImprovement.verdict).toBe("fail");
    expect(result.verdict).toBe("fail");
  });

  test("insufficient paired improvement fails even with a good tail", () => {
    // Baseline 600 − tail 450 = 150 < 300 per pair.
    const result = evaluateSliceEGate(mkPairs({}, 600), OPTS);
    expect(result.verdict).toBe("fail");
    expect(result.perMetric.compileImprovement.verdict).toBe("fail");
  });

  test("baseline without compile stamps fails the improvement bound (wrong baseline build)", () => {
    const pairs = mkPairs();
    for (const p of pairs) {
      p.baseline.phases = {};
      p.baseline.phasesAtWindow = {};
    }
    const result = evaluateSliceEGate(pairs, OPTS);
    expect(result.verdict).toBe("fail");
    expect(result.perMetric.compileImprovement.verdict).toBe("fail");
  });

  test("one wrong-mode candidate fails the batch (zero-defect discipline)", () => {
    const pairs = mkPairs();
    const badPhases = { ...pairs[4].candidate.phasesAtWindow, bootCoreCompileMode: "group-pooled-4" };
    pairs[4].candidate.phases = badPhases;
    pairs[4].candidate.phasesAtWindow = badPhases;
    const result = evaluateSliceEGate(pairs, OPTS);
    expect(result.verdict).toBe("fail");
    expect(result.reasons.some((r) => r.includes("pair 5"))).toBe(true);
  });

  test("slice-D layer still binds (drift fails through the slice-E gate)", () => {
    const pairs = mkPairs();
    const badPhases = {
      ...pairs[0].candidate.phasesAtWindow,
      bootCoreDriftCount: 2,
      bootCoreDriftChunks: "x,y",
    };
    pairs[0].candidate.phases = badPhases;
    pairs[0].candidate.phasesAtWindow = badPhases;
    const result = evaluateSliceEGate(pairs, OPTS);
    expect(result.verdict).toBe("fail");
  });
});
