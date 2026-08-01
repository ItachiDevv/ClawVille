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

/** §2b outer sanity bounds — a candidate beyond these fails regardless of pairing. */
export const SANITY_BOUNDS = {
  webgpu: { revealMs: 22_000, worstFrameMsIn10s: 4_000, stableWindowStartMsAfterReveal: 6_000, framesOver100In10s: 6, preRevealLongtaskMs: 6_500 },
  webgl2: { revealMs: 30_000, worstFrameMsIn10s: 12_000, stableWindowStartMsAfterReveal: 15_000, framesOver100In10s: 5, preRevealLongtaskMs: 25_000 },
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
  return summary?.validForPerformance === true && summary?.backendWaived === false;
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

if (import.meta.main) {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) {
    console.error("usage: bun cold-load-paired-gate.mjs <pairs-manifest.json>");
    process.exit(2);
  }
  const manifest = JSON.parse(await Bun.file(manifestPath).text());
  if (manifest.backend !== "webgpu" && manifest.backend !== "webgl2") {
    console.error(`[paired-gate] manifest.backend must be webgpu|webgl2 (got ${manifest.backend})`);
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
    const baseline = JSON.parse(await Bun.file(p.baseline).text()).summary;
    const candidate = JSON.parse(await Bun.file(p.candidate).text()).summary;
    pairs.push({ order: p.order, baseline, candidate });
  }
  const result = evaluatePairedGate(pairs, { backend: manifest.backend });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "inconclusive" ? 4 : 3);
}
