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
/** Max tolerated seam between consecutive frame intervals when proving
 * continuous coverage. Frame entries tile time by construction
 * (d = now − last), so real seams are rounding-only (±1ms per stamp); one
 * 30fps frame of slack absorbs accumulated rounding without materially
 * weakening the proof. */
export const SLICE_D_COVERAGE_GAP_TOLERANCE_MS = 34;

/** [I3-F1] CONTINUOUS coverage proof: the union of frame intervals
 * [t−d, t] must tile the claimed span with no seam beyond the rounding
 * tolerance. A later frame merely EXISTING proves nothing about the span. */
export function sliceDSpanCovered(frames, spanStart, spanEnd) {
  const relevant = frames
    .filter(
      (f) =>
        Number.isFinite(f.t) &&
        Number.isFinite(f.d) &&
        f.t > spanStart &&
        f.t - f.d < spanEnd,
    )
    .sort((a, b) => (a.t - a.d) - (b.t - b.d));
  let cover = spanStart;
  for (const f of relevant) {
    if (f.t - f.d > cover + SLICE_D_COVERAGE_GAP_TOLERANCE_MS) return false;
    if (f.t > cover) cover = f.t;
    if (cover >= spanEnd) return true;
  }
  return cover >= spanEnd;
}

export function sliceDPostSettleStable(frames, revealMs, settleMs, windowMs = SLICE_D_WINDOW_MS) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  if (!Number.isFinite(revealMs) || !Number.isFinite(settleMs)) return null;
  const windowEnd = revealMs + windowMs;
  if (settleMs + SLICE_D_STABLE_SPAN_MS > windowEnd) return null;
  // [I2-F4] frames are INTERVALS [t-d, t]: a bad frame overlapping any part
  // of the candidate span breaks it — the clean gap runs to the bad
  // interval's START (t-d) and restarts after its END (t). A span is
  // accepted only when the frame series CONTINUOUSLY covers it [I3-F1].
  const bad = frames
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.d) && f.d > SLICE_D_STABLE_FRAME_LIMIT_MS)
    .map((f) => ({ start: f.t - f.d, end: f.t }))
    .filter((iv) => iv.end > settleMs && iv.start < windowEnd)
    .sort((a, b) => a.start - b.start);
  let spanStart = settleMs;
  for (const iv of bad) {
    if (
      iv.start - spanStart >= SLICE_D_STABLE_SPAN_MS &&
      sliceDSpanCovered(frames, spanStart, spanStart + SLICE_D_STABLE_SPAN_MS)
    ) {
      return spanStart;
    }
    if (iv.end > spanStart) spanStart = iv.end;
  }
  if (
    windowEnd - spanStart >= SLICE_D_STABLE_SPAN_MS &&
    sliceDSpanCovered(frames, spanStart, spanStart + SLICE_D_STABLE_SPAN_MS)
  ) {
    return spanStart;
  }
  return null;
}

/** Per-run fail-closed candidate validity (spec §5). Returns defect strings. */
export function sliceDCandidateDefects(summary, frames, expectBootActor) {
  const defects = [];
  // [I1-F7] judge the WINDOW-CLOSE snapshot when present: land/cohort
  // stamps read at capture end can be churned by post-window refresh
  // polls; the boot-assembly question is answered at reveal+window.
  const ph = summary?.phasesAtWindow ?? summary?.phases ?? {};
  if (summary?.phasesAtWindow == null) {
    defects.push("phasesAtWindow snapshot missing (probe predates slice-D or tail ended early)");
  }
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
    // [I2-F6] the REPORT must have been captured expecting this lane — a
    // guest report cannot satisfy an authenticated manifest.
    if (summary?.expectedBootActor !== expectBootActor) {
      defects.push(`report expectedBootActor '${summary?.expectedBootActor}' != manifest '${expectBootActor}'`);
    }
    if (SLICE_D_BODY_KINDS.has(expectBootActor) && summary?.storageStateInjected !== true) {
      defects.push("authenticated body lane requires storageStateInjected=true");
    }
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

  // [I2-F5] EXACTLY 12 manifest entries: a 13-pair manifest with one
  // invalid pair must never pass off the other 12 (that IS topping up).
  if (pairs.length !== SLICE_D_REQUIRED_PAIRS) {
    return {
      verdict: "fail",
      reasons: [`manifest must contain exactly ${SLICE_D_REQUIRED_PAIRS} pairs (has ${pairs.length}) — re-run invalid PAIRS, never top up`],
      perMetric: {}, usablePairs: 0,
    };
  }
  const pairDefects = pairs.map((p, i) => {
    const defects = [];
    if (!usableReport(p.baseline)) defects.push("baseline not usable (strict/boundaryKind)");
    if (!usableReport(p.candidate)) defects.push("candidate not usable (strict/boundaryKind)");
    if (backend && (p.baseline?.backend !== backend || p.candidate?.backend !== backend)) {
      defects.push(`backend mismatch (baseline ${p.baseline?.backend}, candidate ${p.candidate?.backend}, want ${backend})`);
    }
    defects.push(...sliceDCandidateDefects(p.candidate, p.candidateFrames, expectBootActor).map((d) => `candidate: ${d}`));
    if (backend) defects.push(...sanityBreaches(p.candidate, backend).map((d) => `candidate: ${d}`));
    return { i, defects };
  });
  const usable = pairs.filter((_, i) => pairDefects[i].defects.length === 0);
  for (const { i, defects } of pairDefects) {
    if (defects.length) reasons.push(`pair ${i + 1} INVALID: ${defects.join("; ")}`);
  }
  if (usable.length !== SLICE_D_REQUIRED_PAIRS) {
    // Any defective pair fails the batch [I2-F5]: fix the environment or
    // re-run those exact pairs; statistics never run around a hole.
    return {
      verdict: "fail",
      reasons: [...reasons, `all ${SLICE_D_REQUIRED_PAIRS} pairs must be valid (have ${usable.length}) — re-run invalid PAIRS, never top up`],
      perMetric: {}, usablePairs: usable.length,
    };
  }
  const ab = usable.filter((p) => p.order === "AB").length;
  const ba = usable.filter((p) => p.order === "BA").length;
  if (Math.abs(ab - ba) > 1) {
    return { verdict: "fail", reasons: [...reasons, `order not counterbalanced: ${ab} AB vs ${ba} BA`], perMetric: {}, usablePairs: usable.length };
  }

  const perMetric = {};
  const phasesOf = (summary) => summary.phasesAtWindow ?? summary.phases;
  // PRIMARY: absolute candidate bootCorePresentedAt median ≤ 5s.
  const presented = usable.map((p) => phasesOf(p.candidate).bootCorePresentedAt);
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
    streamSettledAfterRevealMs: report(usable.map((p) => phasesOf(p.candidate).streamSettledAt - p.candidate.revealMs)),
    landSettledAfterRevealMs: report(usable.map((p) => phasesOf(p.candidate).landSettledAt - p.candidate.revealMs)),
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

// ---------------------------------------------------------------------------
// Slice E (rev 2, docs/perf-cold-load-rung4-sliceE-spec.md §3 [R1-7][R1-9]):
// additive evaluator layered ON TOP of the frozen slice-D schema. Rejects
// candidates whose compile stamps are missing/non-finite, whose mode is not
// the serial-early mode, whose coverage counts disagree, or with any failed
// group; then gates the compile TAIL (the on-critical-path portion after the
// texture scans) absolutely AND against the baseline's slice-D compile wall.
// ---------------------------------------------------------------------------

// [R2-9] improvement-primary: the binding statistic is the PAIRED per-run
// improvement (baseline compileMs − candidate tailMs, median ≥ 300ms); the
// absolute ceiling is a safety net against a poisoned-slow baseline
// relaxing acceptance, recalibrated 800→1000ms (800 was the pre-analysis
// handoff guess; the width-1 main-thread compile floor is structural).
export const SLICE_E_COMPILE_TAIL_LIMIT_MS = 1000;
export const SLICE_E_COMPILE_IMPROVEMENT_MS = 300;
export const SLICE_E_COMPILE_MODE = "group-serial-early-1";
// [R2-4] EVERY advertised stamp is required — a slice-D-era build or a
// partial-publish run cannot pass on incidental fields.
const SLICE_E_DURATION_STAMPS = [
  "bootCoreCompileMs",
  "bootCoreCompileTailMs",
  "bootCoreCompileEarlyHiddenMs",
  "bootCoreCompileEarlyMs",
  "bootCoreCompileLateMs",
];
const SLICE_E_COUNT_STAMPS = [
  "bootCoreCompileRequested",
  "bootCoreCompileDispatched",
  "bootCoreCompileSettled",
  "bootCoreCompileFailedGroups",
  "bootCoreCompileRenderables",
];
const SLICE_E_ACCOUNTING_TOLERANCE_MS = 1.5;

export function sliceECandidateDefects(summary) {
  const defects = [];
  const ph = summary?.phasesAtWindow ?? summary?.phases ?? {};
  for (const k of SLICE_E_DURATION_STAMPS) {
    if (!Number.isFinite(ph[k]) || ph[k] < 0) defects.push(`missing/negative ${k} (${ph[k]})`);
  }
  for (const k of SLICE_E_COUNT_STAMPS) {
    if (!Number.isInteger(ph[k]) || ph[k] < 0) defects.push(`missing/non-integer ${k} (${ph[k]})`);
  }
  if (ph.bootCoreCompileMode !== SLICE_E_COMPILE_MODE) {
    defects.push(`bootCoreCompileMode ${JSON.stringify(ph.bootCoreCompileMode ?? null)} != "${SLICE_E_COMPILE_MODE}"`);
  }
  if (defects.length > 0) return defects; // numeric invariants below assume sane stamps
  if (ph.bootCoreCompileFailedGroups !== 0) {
    defects.push(`bootCoreCompileFailedGroups ${ph.bootCoreCompileFailedGroups} != 0`);
  }
  if (ph.bootCoreCompileRequested <= 0) defects.push("bootCoreCompileRequested must be > 0");
  if (ph.bootCoreCompileRenderables <= 0) defects.push("bootCoreCompileRenderables must be > 0");
  if (
    ph.bootCoreCompileDispatched !== ph.bootCoreCompileRequested
    || ph.bootCoreCompileSettled !== ph.bootCoreCompileRequested
  ) {
    defects.push(
      `compile coverage mismatch (requested ${ph.bootCoreCompileRequested}, dispatched ${ph.bootCoreCompileDispatched}, settled ${ph.bootCoreCompileSettled})`,
    );
  }
  // [R2-4] accounting invariants: tail is part of the wall, and
  // hidden = wall − tail by construction.
  if (ph.bootCoreCompileTailMs > ph.bootCoreCompileMs + SLICE_E_ACCOUNTING_TOLERANCE_MS) {
    defects.push(`tail ${ph.bootCoreCompileTailMs} exceeds wall ${ph.bootCoreCompileMs}`);
  }
  const accounting = Math.abs(
    ph.bootCoreCompileMs - (ph.bootCoreCompileEarlyHiddenMs + ph.bootCoreCompileTailMs),
  );
  if (accounting > SLICE_E_ACCOUNTING_TOLERANCE_MS) {
    defects.push(`wall ≠ hidden + tail (off by ${accounting.toFixed(1)}ms)`);
  }
  return defects;
}

export function evaluateSliceEGate(
  pairs,
  { backend = null, expectBootActor = null, baselineSha = null, candidateSha = null } = {},
) {
  // Build identity is REQUIRED [R1-9][R2-6] — runner-derived, differing,
  // clean-tree SHAs. A dirty-tree SHA cannot identify what was measured.
  const shaDefects = [];
  if (!baselineSha || !candidateSha) shaDefects.push("manifest must carry baselineSha + candidateSha [R1-9]");
  else {
    if (baselineSha === candidateSha) shaDefects.push(`baselineSha === candidateSha (${baselineSha}) — candidate must be a distinct committed build [R2-6]`);
    if (String(baselineSha).includes("dirty") || String(candidateSha).includes("dirty")) {
      shaDefects.push(`dirty-tree SHA (${baselineSha} / ${candidateSha}) — measure committed clean worktrees [R2-6]`);
    }
  }
  // [R2-5] the SHIP lane is the authenticated player-vrm lane, enforced in
  // the evaluator itself — CLI plumbing alone must not be load-bearing.
  if (expectBootActor !== "player-vrm") {
    shaDefects.push(`--slice-e requires expectBootActor 'player-vrm' (got '${expectBootActor}') [R2-5]`);
  }
  if (shaDefects.length > 0) {
    return { verdict: "fail", reasons: shaDefects, perMetric: {}, usablePairs: 0, baselineSha, candidateSha };
  }
  const base = evaluateSliceDGate(pairs, { backend, expectBootActor });
  const reasons = [...base.reasons];
  const eDefects = [];
  pairs.forEach((p, i) => {
    for (const d of sliceECandidateDefects(p.candidate)) {
      eDefects.push(`pair ${i + 1} candidate: ${d}`);
    }
  });
  reasons.push(...eDefects);
  if (base.verdict === "fail" || eDefects.length > 0) {
    return {
      verdict: "fail", reasons,
      perMetric: base.perMetric, usablePairs: base.usablePairs ?? 0,
      baselineSha, candidateSha,
    };
  }
  const phasesOf = (summary) => summary.phasesAtWindow ?? summary.phases;
  const tails = pairs.map((p) => phasesOf(p.candidate).bootCoreCompileTailMs);
  const perMetric = { ...base.perMetric };
  perMetric.bootCoreCompileTailMs = {
    verdict: median(tails) < SLICE_E_COMPILE_TAIL_LIMIT_MS ? "pass" : "fail",
    median: median(tails), limit: SLICE_E_COMPILE_TAIL_LIMIT_MS, values: tails,
  };
  // [R2-3] PAIRED improvement: median of the WITHIN-PAIR improvements
  // (median-of-diffs ≠ diff-of-medians). Report the 95% one-sided lower
  // bound alongside (order statistic via the existing machinery).
  const baselineCompiles = pairs.map((p) => phasesOf(p.baseline)?.bootCoreCompileMs);
  if (baselineCompiles.every((v) => Number.isFinite(v))) {
    const improvements = pairs.map(
      (p) => phasesOf(p.baseline).bootCoreCompileMs - phasesOf(p.candidate).bootCoreCompileTailMs,
    );
    const negUB = upperBoundOfMedian(improvements.map((v) => -v), CONFIDENCE);
    perMetric.compileImprovement = {
      verdict: median(improvements) >= SLICE_E_COMPILE_IMPROVEMENT_MS ? "pass" : "fail",
      pairedImprovementMedian: median(improvements),
      pairedImprovementLower95: negUB == null ? null : -negUB,
      requiredImprovementMs: SLICE_E_COMPILE_IMPROVEMENT_MS,
      baselineCompileMedian: median(baselineCompiles),
      candidateTailMedian: median(tails),
      values: improvements,
    };
  } else {
    perMetric.compileImprovement = {
      verdict: "fail",
      reason: "baseline bootCoreCompileMs missing — wrong baseline build for the paired improvement bound",
    };
  }
  const anyFail = perMetric.bootCoreCompileTailMs.verdict === "fail"
    || perMetric.compileImprovement.verdict === "fail";
  return {
    verdict: anyFail ? "fail" : base.verdict,
    reasons, perMetric, usablePairs: base.usablePairs,
    baselineSha, candidateSha,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sliceE = args.includes("--slice-e");
  const sliceD = args.includes("--slice-d") || sliceE;
  const manifestPath = args.find((a) => !a.startsWith("--"));
  if (!manifestPath) {
    console.error("usage: bun cold-load-paired-gate.mjs <pairs-manifest.json> [--slice-d|--slice-e] [--watchdog-lane]");
    process.exit(2);
  }
  const manifest = JSON.parse(await Bun.file(manifestPath).text());
  if (manifest.backend !== "webgpu" && manifest.backend !== "webgl2") {
    console.error(`[paired-gate] manifest.backend must be webgpu|webgl2 (got ${manifest.backend})`);
    process.exit(2);
  }
  const watchdogLane = args.includes("--watchdog-lane");
  if (sliceD && !manifest.expectBootActor) {
    // Fail-closed [R2-F13]: the slice-D headline lane is the AUTHENTICATED
    // actor lane — a manifest without the expected kind cannot silently
    // regress to the guest path.
    console.error("[paired-gate] --slice-d requires manifest.expectBootActor (e.g. 'player-vrm')");
    process.exit(2);
  }
  if (sliceD && !watchdogLane && manifest.expectBootActor !== "player-vrm") {
    // [I2-F6] the HEADLINE gate is the authenticated VRM lane, full stop.
    // Guest/GLB/NPC lanes run with an explicit --watchdog-lane flag so a
    // manifest can never quietly substitute a weaker lane for the ship
    // number.
    console.error(`[paired-gate] --slice-d headline requires expectBootActor 'player-vrm' (got '${manifest.expectBootActor}'); pass --watchdog-lane for non-headline lanes`);
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
  if (sliceE && watchdogLane) {
    // [R2-5] the slice-E SHIP verdict is the authenticated player-vrm lane,
    // full stop — no weaker lane may produce it.
    console.error("[paired-gate] --slice-e cannot be combined with --watchdog-lane");
    process.exit(2);
  }
  if (sliceE && (!manifest.baselineSha || !manifest.candidateSha)) {
    console.error("[paired-gate] --slice-e requires manifest.baselineSha + manifest.candidateSha [R1-9]");
    process.exit(2);
  }
  const result = sliceE
    ? evaluateSliceEGate(pairs, {
        backend: manifest.backend, expectBootActor: manifest.expectBootActor,
        baselineSha: manifest.baselineSha, candidateSha: manifest.candidateSha,
      })
    : sliceD
    ? evaluateSliceDGate(pairs, { backend: manifest.backend, expectBootActor: manifest.expectBootActor })
    : evaluatePairedGate(pairs, { backend: manifest.backend });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "inconclusive" ? 4 : 3);
}
