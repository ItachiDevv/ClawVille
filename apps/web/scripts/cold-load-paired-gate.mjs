// cold-load-paired-gate.mjs — the machine-enforced PAIRED acceptance gate for
// the cold-load diet round (re-review #3 blocking 1).
//
// Model: a canary/widening batch runs counterbalanced interleaved sessions
// (AB BA AB BA …) of baseline (A) and candidate (B), fresh daemon+profile per
// run. Each complete pair yields, per ratio metric, the within-pair log ratio
// log(candidate/baseline). Acceptance per backend and metric:
//   - at least MIN_PAIRS complete pairs whose BOTH reports are
//     validForPerformance === true and backendWaived === false;
//   - the exact one-sided upper 95% confidence bound for the MEDIAN paired
//     log-ratio (binomial order statistic, p=1/2) is < log(RATIO_LIMIT);
//   - counterbalance: |#AB − #BA| ≤ 1;
//   - frame-count metric uses paired DIFFERENCES with the same order-statistic
//     bound against COUNT_DIFF_LIMIT.
// If the bound does not close at the observed n, verdict is "inconclusive:
// extend to EXTEND_PAIRS pairs" — never a silent pass.
//
// Usage: bun cold-load-paired-gate.mjs <pairs-manifest.json>
//   manifest: { backend, pairs: [{ order: "AB"|"BA", baseline: "<report>", candidate: "<report>" }] }

export const RATIO_LIMIT = 1.15;
export const COUNT_DIFF_LIMIT = 2;
export const MIN_PAIRS = 8;
export const EXTEND_PAIRS = 12;
export const CONFIDENCE = 0.95;

export const RATIO_METRICS = [
  ["revealMs", (s) => s.revealMs],
  ["worstFrameMsIn10s", (s) => s.frameMetrics?.worstFrameMsIn10s],
  ["stableWindowStartMsAfterReveal", (s) => s.frameMetrics?.stableWindowStartMsAfterReveal],
  ["preRevealLongtaskMs", (s) => s.longtasks?.preRevealTotalMs],
];
export const COUNT_METRIC = ["framesOver100In10s", (s) => s.frameMetrics?.framesOver100In10s];

/**
 * Exact one-sided upper confidence bound for the median of n paired values:
 * the k-th order statistic (1-based, ascending) where k is the smallest
 * integer with P(Binomial(n, 1/2) < k) ≥ confidence. Returns null when no
 * order statistic achieves the confidence at this n (n too small).
 */
export function medianUpperBoundIndex(n, confidence = CONFIDENCE) {
  let cum = 0;
  // binomial pmf via multiplicative recurrence, exact enough for n ≤ 64
  let pmf = Math.pow(0.5, n); // C(n,0)/2^n
  for (let k = 1; k <= n; k++) {
    cum += pmf; // P(X < k) after adding pmf of k-1
    if (cum >= confidence) return k;
    pmf = (pmf * (n - (k - 1))) / k;
  }
  return null;
}

export function upperBoundOfMedian(values, confidence = CONFIDENCE) {
  const sorted = [...values].sort((a, b) => a - b);
  const k = medianUpperBoundIndex(sorted.length, confidence);
  if (k == null) return null;
  return sorted[k - 1];
}

/** §2b outer sanity bounds — a candidate beyond these fails regardless of pairing.
 *  webgl2.revealMs recalibrated 30_000→40_000 (2026-08-01, rung-1 batch): 4/8
 *  BASELINE (pre-canary, identical-code) runs breached 30s at 31.3-34.8s in the
 *  same session — the lane is bimodal on this box (~21-26s / ~31-35s, the M0
 *  vrmBulk variance), so 30s sat inside the environmental ceiling and failed
 *  identical code. 40s stays above the observed baseline max while still
 *  catching true pathology; the PAIRED statistics remain the regression
 *  instrument. Evidence: manifest-webgl2.json pairs 3/4/5/6 baselines. */
export const SANITY_BOUNDS = {
  webgpu: { revealMs: 22_000, worstFrameMsIn10s: 4_000, stableWindowStartMsAfterReveal: 6_000, framesOver100In10s: 6, preRevealLongtaskMs: 6_500 },
  webgl2: { revealMs: 40_000, worstFrameMsIn10s: 12_000, stableWindowStartMsAfterReveal: 15_000, framesOver100In10s: 5, preRevealLongtaskMs: 25_000 },
};

const METRIC_GETTERS = new Map([...RATIO_METRICS, [COUNT_METRIC[0], COUNT_METRIC[1]]]);

/** All gate metrics must be finite numbers on a summary; returns defect reasons. */
export function rawMetricDefects(summary) {
  const defects = [];
  for (const [name, get] of METRIC_GETTERS) {
    const v = get(summary);
    if (typeof v !== "number" || !Number.isFinite(v)) defects.push(`${name} not finite (${v})`);
  }
  return defects;
}

export function sanityBreaches(summary, backend) {
  const bounds = SANITY_BOUNDS[backend];
  if (!bounds) return [`no sanity bounds for backend ${backend}`];
  const out = [];
  for (const [name, limit] of Object.entries(bounds)) {
    const v = METRIC_GETTERS.get(name)(summary);
    if (typeof v === "number" && v > limit) out.push(`${name} ${v} > sanity bound ${limit}`);
  }
  return out;
}

function usableReport(summary) {
  return (
    summary?.validForPerformance === true &&
    summary?.backendWaived === false &&
    // §2b amendment (founder 2026-08-10): only symmetric polled-reveal
    // longtask accounting is comparable. Historical release-boundary reports
    // (no boundaryKind, or a different kind) are unusable evidence — a
    // reused manifest must never silently compare unlike metrics.
    summary?.longtasks?.boundaryKind === "polled-reveal-v2"
  );
}

/**
 * Evaluate the paired gate. `pairs`: [{ order, baseline: summary, candidate: summary }].
 * Returns { verdict: 'pass'|'fail'|'inconclusive', reasons, perMetric }.
 */
export function evaluatePairedGate(pairs, {
  ratioLimit = RATIO_LIMIT,
  countDiffLimit = COUNT_DIFF_LIMIT,
  minPairs = MIN_PAIRS,
  confidence = CONFIDENCE,
  backend = null,
} = {}) {
  const reasons = [];
  // Order tokens must be exactly AB|BA — an unknown token is a DEFECT, not a
  // silently uncounted row (re-review #4 finding 1).
  const badOrders = pairs.filter((p) => p.order !== "AB" && p.order !== "BA").length;
  if (badOrders) {
    return { verdict: "fail", reasons: [`${badOrders} pairs with invalid order token`], perMetric: {}, usablePairs: 0 };
  }
  const usable = pairs.filter((p) =>
    usableReport(p.baseline) && usableReport(p.candidate)
    && rawMetricDefects(p.baseline).length === 0 && rawMetricDefects(p.candidate).length === 0
    && (!backend || (p.baseline.backend === backend && p.candidate.backend === backend)));
  if (usable.length < pairs.length) {
    reasons.push(`${pairs.length - usable.length} pairs dropped (not strict/finite/backend-matched evidence)`);
  }
  // Outer sanity bounds (§2b): ANY candidate breach fails regardless of pairing.
  if (backend) {
    const breaches = usable.flatMap((p) => sanityBreaches(p.candidate, backend));
    if (breaches.length) {
      return { verdict: "fail", reasons: [...reasons, ...breaches.slice(0, 6)], perMetric: {}, usablePairs: usable.length };
    }
  }
  if (usable.length < minPairs) {
    return { verdict: "inconclusive", reasons: [...reasons, `only ${usable.length}/${minPairs} usable pairs`], perMetric: {}, usablePairs: usable.length };
  }
  const ab = usable.filter((p) => p.order === "AB").length;
  const ba = usable.filter((p) => p.order === "BA").length;
  if (Math.abs(ab - ba) > 1) {
    return { verdict: "fail", reasons: [...reasons, `order not counterbalanced: ${ab} AB vs ${ba} BA`], perMetric: {}, usablePairs: usable.length };
  }

  const perMetric = {};
  let anyFail = false, anyInconclusive = false;
  for (const [name, get] of RATIO_METRICS) {
    const logRatios = usable.map((p) => Math.log(get(p.candidate) / get(p.baseline)));
    if (logRatios.some((v) => !Number.isFinite(v))) {
      perMetric[name] = { verdict: "fail", reason: "non-finite ratio (missing metric slipped through)" };
      anyFail = true;
      continue;
    }
    const ub = upperBoundOfMedian(logRatios, confidence);
    if (ub == null) { perMetric[name] = { verdict: "inconclusive", reason: "n too small for bound" }; anyInconclusive = true; continue; }
    const pass = ub < Math.log(ratioLimit);
    // Not passing below the extension cap ⇒ collect more pairs; at the cap ⇒ fail.
    perMetric[name] = {
      verdict: pass ? "pass" : usable.length < EXTEND_PAIRS ? "inconclusive" : "fail",
      medianLogRatio: median(logRatios),
      upperBoundLogRatio: ub,
      limitLogRatio: Math.log(ratioLimit),
      n: logRatios.length,
    };
    if (perMetric[name].verdict === "fail") anyFail = true;
    if (perMetric[name].verdict === "inconclusive") anyInconclusive = true;
  }
  {
    const [name, get] = COUNT_METRIC;
    const diffs = usable.map((p) => get(p.candidate) - get(p.baseline));
    if (diffs.some((v) => !Number.isFinite(v))) {
      perMetric[name] = { verdict: "fail", reason: "non-finite count diff" };
      anyFail = true;
    } else {
      const ub = upperBoundOfMedian(diffs, confidence);
      const pass = ub != null && ub <= countDiffLimit;
      // Same disposition as ratio metrics: below the extension cap, a
      // non-passing bound EXTENDS; only at the cap does it fail (finding 4).
      perMetric[name] = {
        verdict: ub == null ? "inconclusive" : pass ? "pass" : usable.length < EXTEND_PAIRS ? "inconclusive" : "fail",
        upperBoundDiff: ub, limit: countDiffLimit, n: diffs.length,
      };
      if (perMetric[name].verdict === "fail") anyFail = true;
      if (perMetric[name].verdict === "inconclusive") anyInconclusive = true;
    }
  }
  const verdict = anyFail ? "fail" : anyInconclusive ? "inconclusive" : "pass";
  if (verdict === "inconclusive") reasons.push(`extend to ${EXTEND_PAIRS} pairs or accept inconclusive`);
  return { verdict, reasons, perMetric, usablePairs: usable.length };
}

function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------------------
// Rung-4 slice D gate mode (spec §5, FROZEN rev 5 [R2-F13][R3-F7][F15][F16]).
// DISJOINT fail-closed schema: the baseline arm (pre-slice-D build) never
// stamps the new events, so NO candidate-vs-baseline ratio uses them. The
// candidate is judged on (a) absolute bootCorePresentedAt, (b) the existing
// like-for-like paired framesOver100In10s statistic, (c) per-run fail-closed
// validity (drift, cohort 16/16, land failure counters, settle-in-window,
// expected boot actor + ordering, post-settle stable interval), (d) §2b
// sanity bounds. worstFrame/stable log-ratios are REPORTED, never judged
// (the candidate's post-reveal window deliberately CONTAINS the stream).
// ---------------------------------------------------------------------------

/** Measured-window widening — a RECORDED rig decision (spec §4b): the first
 * slice-D smoke settled the stream 9.5s after reveal, so a 3s post-settle
 * stable interval cannot exist inside the historical 10s window. 15s =
 * observed settle (~9.5s) + 3s stable + margin. framesOver100In10s stays on
 * the 10s window (like-for-like with the baseline arm). */
export const SLICE_D_WINDOW_MS = 15_000;
export const SLICE_D_PRESENTED_LIMIT_MS = 5_000;
export const SLICE_D_REQUIRED_PAIRS = 12;
export const SLICE_D_STABLE_SPAN_MS = 3_000;
export const SLICE_D_STABLE_FRAME_LIMIT_MS = 100;
export const SLICE_D_BODY_KINDS = new Set(["player-vrm", "player-glb", "npc-body"]);

/** 3s span after `settleMs` (absolute page-clock ms) containing zero frames
 * over 100ms, ending no later than revealMs + SLICE_D_WINDOW_MS. Frames:
 * [{ t, d }] page-clock ms + duration. Returns the span start or null. */
export function sliceDPostSettleStable(frames, revealMs, settleMs, windowMs = SLICE_D_WINDOW_MS) {
  if (!Array.isArray(frames) || !Number.isFinite(revealMs) || !Number.isFinite(settleMs)) return null;
  const windowEnd = revealMs + windowMs;
  if (settleMs + SLICE_D_STABLE_SPAN_MS > windowEnd) return null;
  const bad = frames
    .filter((f) => f.t >= settleMs && f.t <= windowEnd && f.d > SLICE_D_STABLE_FRAME_LIMIT_MS)
    .map((f) => f.t)
    .sort((a, b) => a - b);
  let spanStart = settleMs;
  for (const t of bad) {
    if (t - spanStart >= SLICE_D_STABLE_SPAN_MS) return spanStart;
    spanStart = t; // restart the span after the offending frame
  }
  return windowEnd - spanStart >= SLICE_D_STABLE_SPAN_MS ? spanStart : null;
}

/** Per-run fail-closed candidate validity (spec §5). Returns defect strings. */
export function sliceDCandidateDefects(summary, frames, expectBootActor) {
  const defects = [];
  const ph = summary?.phases ?? {};
  const reveal = summary?.revealMs;
  for (const key of ["bootCorePresentedAt", "streamSettledAt", "landSettledAt"]) {
    if (typeof ph[key] !== "number" || !Number.isFinite(ph[key])) defects.push(`${key} not finite (${ph[key]})`);
  }
  if ((ph.bootCoreDriftCount ?? null) !== 0) defects.push(`bootCoreDriftCount ${ph.bootCoreDriftCount} (must be 0; drift='${ph.bootCoreDriftChunks}')`);
  const cohort = ph.streamCohort;
  if (!cohort || cohort.total !== 16 || cohort.terminal !== 16) defects.push(`streamCohort not 16/16 (${JSON.stringify(cohort)})`);
  else {
    if (cohort.failed !== 0) defects.push(`streamCohort.failed ${cohort.failed}`);
    if (cohort.failopen !== 0) defects.push(`streamCohort.failopen ${cohort.failopen} (ready-failopen invalidates measurement)`);
  }
  const land = ph.landTracker;
  if (!land) defects.push("landTracker missing");
  else {
    if (land.dataFailed !== 0) defects.push(`landTracker.dataFailed ${land.dataFailed}`);
    if (land.glbFallback !== 0) defects.push(`landTracker.glbFallback ${land.glbFallback}`);
    if (land.glbFailed !== 0) defects.push(`landTracker.glbFailed ${land.glbFailed}`);
    if (land.inFlightRequests !== 0) defects.push(`landTracker.inFlightRequests ${land.inFlightRequests} at capture end`);
  }
  if (Number.isFinite(reveal) && Number.isFinite(ph.streamSettledAt) && Number.isFinite(ph.landSettledAt)) {
    const settle = Math.max(ph.streamSettledAt, ph.landSettledAt);
    if (settle - reveal > SLICE_D_WINDOW_MS) defects.push(`settle ${Math.round(settle - reveal)}ms after reveal > window ${SLICE_D_WINDOW_MS}`);
    else if (sliceDPostSettleStable(frames, reveal, settle) == null) defects.push("no 3s stable interval after settle inside the window");
  }
  if (expectBootActor) {
    if (ph.bootActorKind !== expectBootActor) defects.push(`bootActorKind '${ph.bootActorKind}' != expected '${expectBootActor}'`);
    if (typeof ph.bootActorResolvedAt !== "number" || !(ph.bootActorResolvedAt <= ph.bootCorePresentedAt)) {
      defects.push(`bootActorResolvedAt ${ph.bootActorResolvedAt} not ≤ bootCorePresentedAt ${ph.bootCorePresentedAt}`);
    }
    if (SLICE_D_BODY_KINDS.has(expectBootActor)) {
      if (typeof ph.bootActorReadyAt !== "number" || !(ph.bootActorReadyAt <= ph.bootCorePresentedAt)) {
        defects.push(`bootActorReadyAt ${ph.bootActorReadyAt} not ≤ bootCorePresentedAt ${ph.bootCorePresentedAt} (body kind)`);
      }
    }
    if (ph.bootActorGateTimedOut === true) defects.push("bootActorGateTimedOut (fail-open gate on a measurement run)");
  }
  return defects;
}

/**
 * Slice-D gate. `pairs`: [{ order, baseline: summary, candidate: summary,
 * candidateFrames }]. Requires EXACTLY SLICE_D_REQUIRED_PAIRS usable pairs —
 * an invalid run invalidates its PAIR; re-run pairs, never top up
 * asymmetrically [F16].
 */
export function evaluateSliceDGate(pairs, { backend = null, expectBootActor = null } = {}) {
  const reasons = [];
  const badOrders = pairs.filter((p) => p.order !== "AB" && p.order !== "BA").length;
  if (badOrders) return { verdict: "fail", reasons: [`${badOrders} pairs with invalid order token`], perMetric: {} };

  const pairDefects = pairs.map((p, i) => {
    const defects = [];
    if (!usableReport(p.baseline)) defects.push("baseline not usable (strict/boundaryKind)");
    if (!usableReport(p.candidate)) defects.push("candidate not usable (strict/boundaryKind)");
    defects.push(...sliceDCandidateDefects(p.candidate, p.candidateFrames, expectBootActor).map((d) => `candidate: ${d}`));
    if (backend) defects.push(...sanityBreaches(p.candidate, backend).map((d) => `candidate: ${d}`));
    return { i, defects };
  });
  const usable = pairs.filter((_, i) => pairDefects[i].defects.length === 0);
  for (const { i, defects } of pairDefects) {
    if (defects.length) reasons.push(`pair ${i + 1} INVALID: ${defects.join("; ")}`);
  }
  if (usable.length !== SLICE_D_REQUIRED_PAIRS) {
    return {
      verdict: usable.length < SLICE_D_REQUIRED_PAIRS ? "inconclusive" : "fail",
      reasons: [...reasons, `exactly ${SLICE_D_REQUIRED_PAIRS} usable pairs required (have ${usable.length}) — re-run invalid PAIRS, never top up`],
      perMetric: {}, usablePairs: usable.length,
    };
  }
  const ab = usable.filter((p) => p.order === "AB").length;
  const ba = usable.filter((p) => p.order === "BA").length;
  if (Math.abs(ab - ba) > 1) {
    return { verdict: "fail", reasons: [...reasons, `order not counterbalanced: ${ab} AB vs ${ba} BA`], perMetric: {}, usablePairs: usable.length };
  }

  const perMetric = {};
  // PRIMARY: absolute candidate bootCorePresentedAt median ≤ 5s.
  const presented = usable.map((p) => p.candidate.phases.bootCorePresentedAt);
  perMetric.bootCorePresentedAt = {
    verdict: median(presented) <= SLICE_D_PRESENTED_LIMIT_MS ? "pass" : "fail",
    median: median(presented), limit: SLICE_D_PRESENTED_LIMIT_MS, values: presented,
  };
  // Like-for-like frame gate (both arms measure [reveal, reveal+10s]).
  const diffs = usable.map((p) => p.candidate.frameMetrics.framesOver100In10s - p.baseline.frameMetrics.framesOver100In10s);
  const ubDiff = upperBoundOfMedian(diffs, CONFIDENCE);
  perMetric.framesOver100In10s = {
    verdict: ubDiff != null && ubDiff <= COUNT_DIFF_LIMIT ? "pass" : ubDiff == null ? "inconclusive" : "fail",
    upperBoundDiff: ubDiff, limit: COUNT_DIFF_LIMIT, n: diffs.length,
  };
  // REPORT-ONLY distributions (no verdict weight — unlike events vs baseline).
  const report = (vals) => ({ median: median(vals), min: Math.min(...vals), max: Math.max(...vals) });
  perMetric.reportOnly = {
    streamSettledAfterRevealMs: report(usable.map((p) => p.candidate.phases.streamSettledAt - p.candidate.revealMs)),
    landSettledAfterRevealMs: report(usable.map((p) => p.candidate.phases.landSettledAt - p.candidate.revealMs)),
    candidateRevealMs: report(usable.map((p) => p.candidate.revealMs)),
    baselineRevealMs: report(usable.map((p) => p.baseline.revealMs)),
    worstFrameLogRatio: report(usable.map((p) => Math.log(p.candidate.frameMetrics.worstFrameMsIn10s / p.baseline.frameMetrics.worstFrameMsIn10s))),
  };
  const anyFail = perMetric.bootCorePresentedAt.verdict === "fail" || perMetric.framesOver100In10s.verdict === "fail";
  const anyInconclusive = perMetric.framesOver100In10s.verdict === "inconclusive";
  return {
    verdict: anyFail ? "fail" : anyInconclusive ? "inconclusive" : "pass",
    reasons, perMetric, usablePairs: usable.length,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sliceD = args.includes("--slice-d");
  const manifestPath = args.find((a) => !a.startsWith("--"));
  if (!manifestPath) {
    console.error("usage: bun cold-load-paired-gate.mjs <pairs-manifest.json> [--slice-d]");
    process.exit(2);
  }
  const manifest = JSON.parse(await Bun.file(manifestPath).text());
  if (manifest.backend !== "webgpu" && manifest.backend !== "webgl2") {
    console.error(`[paired-gate] manifest.backend must be webgpu|webgl2 (got ${manifest.backend})`);
    process.exit(2);
  }
  if (sliceD && !manifest.expectBootActor) {
    // Fail-closed [R2-F13]: the slice-D headline lane is the AUTHENTICATED
    // actor lane — a manifest without the expected kind cannot silently
    // regress to the guest path.
    console.error("[paired-gate] --slice-d requires manifest.expectBootActor (e.g. 'player-vrm')");
    process.exit(2);
  }
  const seenPaths = new Set();
  const pairs = [];
  for (const p of manifest.pairs) {
    if (p.baseline === p.candidate) {
      console.error(`[paired-gate] baseline and candidate are the same file: ${p.baseline}`);
      process.exit(2);
    }
    for (const path of [p.baseline, p.candidate]) {
      if (seenPaths.has(path)) {
        console.error(`[paired-gate] report reused across arms/pairs: ${path}`);
        process.exit(2);
      }
      seenPaths.add(path);
    }
    const baselineReport = JSON.parse(await Bun.file(p.baseline).text());
    const candidateReport = JSON.parse(await Bun.file(p.candidate).text());
    pairs.push({
      order: p.order,
      baseline: baselineReport.summary,
      candidate: candidateReport.summary,
      candidateFrames: candidateReport.frames,
    });
  }
  const result = sliceD
    ? evaluateSliceDGate(pairs, { backend: manifest.backend, expectBootActor: manifest.expectBootActor })
    : evaluatePairedGate(pairs, { backend: manifest.backend });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "inconclusive" ? 4 : 3);
}
