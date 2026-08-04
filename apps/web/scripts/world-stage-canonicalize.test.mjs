import { describe, expect, test } from "bun:test";
import {
  canonicalizeStageProbeSummary,
  renderCanonicalStageProbeSummary,
} from "./world-stage-canonicalize.mjs";

function summary(overrides = {}) {
  return {
    pass: true,
    lane: "routes",
    backend: "webgpu",
    generatedAt: "2026-07-31T01:02:03.000Z",
    url: "http://127.0.0.1:3008/cove",
    experiment: { mode: "crossings", dwellSeconds: null },
    requestedTransitions: 60,
    requestedRoundTrips: 30,
    completedRoundTrips: 30,
    completedTransitions: 60,
    warmupTransitions: 0,
    canvasMountCount: 1,
    hiddenWindowsChecked: 60,
    listenerBaseline: 13,
    listenerEnd: 13,
    listenerDelta: 0,
    listenerUnderflowCount: 0,
    hiddenFrameViolations: [],
    hiddenCameraViolations: [],
    hiddenStoreViolations: [],
    activeGrowthViolations: [],
    transitionErrors: [],
    heap: {
      baselineBytes: 100,
      endBytes: 108,
      growthRatio: 0.08,
      totalGrowthThreshold: 0.2,
    },
    heapDiff: {
      reportPath: "C:\\volatile\\heap-report.md",
    },
    renderer: {
      byteGrowthTolerance: 0.01,
      samples: [{ at: 1234, textures: 281 }],
    },
    routes: {
      pathSequence: ["/cove", "/game?__wsnav=volatile-run-id"],
      returnLoaderViolations: [],
      historyLength: {
        baseline: 2,
        final: 4,
        delta: 2,
        maxAddedEntries: 2,
        maxLength: 4,
      },
      network: {
        joins: { coldCove: 0, firstGame: 1 },
        streams: { coldCove: 0, firstGame: 1 },
        fixtureTraffic: { "GET /api/auth/me": 1 },
        interceptedFixtureTraffic: { "GET /api/auth/me": 1 },
        stubUnhandled: {},
      },
    },
    inventory: { changes: [] },
    console: { errors: [], warnings: ["volatile warning text"] },
    assertions: {
      zeroTransitionErrors: true,
      soakTotalHeapGrowthAtMost20Percent: true,
      exactlyRequestedRoundTrips: true,
    },
    ...overrides,
  };
}

describe("world-stage canonical summary", () => {
  test("strips volatile values while preserving verdicts, counts, and thresholds", () => {
    const first = summary();
    const second = summary({
      generatedAt: "2026-07-31T04:05:06.000Z",
      url: "http://localhost:3008/cove",
      heap: {
        baselineBytes: 500,
        endBytes: 590,
        growthRatio: 0.18,
        totalGrowthThreshold: 0.2,
      },
      renderer: {
        byteGrowthTolerance: 0.01,
        samples: [{ at: 9876, textures: 288 }],
      },
      console: { errors: [], warnings: ["different warning text"] },
    });

    expect(renderCanonicalStageProbeSummary(first)).toBe(
      renderCanonicalStageProbeSummary(second),
    );
    const canonical = canonicalizeStageProbeSummary(first);
    expect(canonical.schema).toBe("world-stage-probe-canonical-v2");
    expect(canonical.verdict.assertions).toEqual({
      exactlyRequestedRoundTrips: true,
      soakTotalHeapGrowthAtMost20Percent: true,
      zeroTransitionErrors: true,
    });
    expect(canonical.verdict.counts).toEqual({
      total: 3,
      passed: 3,
      failed: 0,
    });
    expect(canonical.thresholds).toMatchObject({
      "assertions.soakTotalHeapGrowthAtMost20Percent": 0.2,
      "heap.totalGrowthThreshold": 0.2,
      "renderer.byteGrowthTolerance": 0.01,
      "routes.historyLength.maxAddedEntries": 2,
      "routes.historyLength.maxLength": 4,
    });
  });

  test("strips run-variant warmup inventory snapshot deltas", () => {
    const oneWarmupDelta = summary({
      inventory: { changes: [{ loop: 1 }] },
    });
    const threeWarmupDeltas = summary({
      inventory: {
        changes: [{ loop: 2 }, { loop: 3 }, { loop: 25 }],
      },
    });

    expect(renderCanonicalStageProbeSummary(oneWarmupDelta)).toBe(
      renderCanonicalStageProbeSummary(threeWarmupDeltas),
    );
    expect(
      canonicalizeStageProbeSummary(oneWarmupDelta).counts.violations,
    ).not.toHaveProperty("inventoryChanges");
  });

  test("retains behavioral count and assertion changes", () => {
    const baseline = renderCanonicalStageProbeSummary(summary());
    expect(
      renderCanonicalStageProbeSummary(
        summary({ completedRoundTrips: 29 }),
      ),
    ).not.toBe(baseline);
    expect(
      renderCanonicalStageProbeSummary(
        summary({
          pass: false,
          assertions: {
            zeroTransitionErrors: false,
            soakTotalHeapGrowthAtMost20Percent: true,
            exactlyRequestedRoundTrips: true,
          },
        }),
      ),
    ).not.toBe(baseline);
  });
});
