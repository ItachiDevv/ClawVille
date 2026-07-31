// cold-load-ledger.mjs — URL-level accounting ledger for the cold-load diet (v2).
//
// v2 (rung-0 review blocker 2):
//  - URLs normalized via `new URL()` (any scheme/host — localhost http included)
//    and AGGREGATED per canonical URL (path+search), not per request.
//  - Roles come from an explicit manifest (URL rule × lane × consumers ×
//    sharedDemand), not extension heuristics alone.
//  - A FIXTURE declares which URLs are critical for that session shape; only
//    post-lane rows that are NOT fixture-critical ("post-exclusive") are
//    subtracted from the M1 reveal projection. A shared player/wanderer URL the
//    fixture's own body needs stays reveal-gated.
//  - The M1/M2/total milestone sums NEVER credit deferral toward total-session.
//
// Usage: bun apps/web/scripts/cold-load-ledger.mjs <probe-report.json> [diets.json]
// Diets file: { "<canonical-url>": afterBytes } from produced artifacts only.

// ---------------------------------------------------------------------------
// Role manifest — mirror of plan §3A. Update BOTH when the deferred set moves.
// Order matters: first match wins.
// ---------------------------------------------------------------------------
export const ROLE_MANIFEST = [
  { test: (p) => p.startsWith("/models/characters/"), lane: "post-location", consumers: ["location-npc"], sharedDemand: false },
  { test: (p) => p.startsWith("/models/lobster_plush"), lane: "post-location", consumers: ["location-npc", "wandering-npc"], sharedDemand: true },
  { test: (p) => p.startsWith("/avatars/ansem-sword"), lane: "post-attachment", consumers: ["ansem-wanderer", "player-ansem"], sharedDemand: true },
  { test: (p) => /^\/avatars\/animations\/(hermes-female|hermes-male|tekk-male|chibi|ansem)\//.test(p), lane: "post-anim-char", consumers: ["ambient-npc", "player-same-species"], sharedDemand: true },
  { test: (p) => p.startsWith("/avatars/animations/"), lane: "reveal-core", consumers: ["all-avatars"], sharedDemand: false },
  { test: (p) => p.endsWith(".vrm"), lane: "post-ambient-vrm", consumers: ["ambient-npc", "player-capable"], sharedDemand: true },
  // Everything else that is an asset gates the reveal today.
  { test: () => true, lane: "reveal-core", consumers: ["world"], sharedDemand: false },
];

/** Classes excluded from asset lanes entirely (streams, RSC, blobs, api). */
const EXCLUDED_CLASSES = new Set(["API", "OTHER", "JSON", "AUDIO"]);

// ---------------------------------------------------------------------------
// Fixtures — which URLs are CRITICAL for a given session shape. Substring
// match on the canonical URL. The guest fixture's demo-body entry is
// PROVISIONAL until the rung-1 canary's demand assertion pins the exact URL.
// ---------------------------------------------------------------------------
export const FIXTURES = {
  "guest-default": {
    criticalUrlSubstrings: ["milady-official-5.vrm"],
    note: "fresh guest, no remotes; demo-body VRM provisional pending canary demand trace",
  },
  "ansem-owner": {
    criticalUrlSubstrings: ["ansem.vrm", "ansem-sword.glb", "/avatars/animations/ansem/"],
    note: "worst-case shared-demand variant: local avatar is Ansem",
  },
};

export function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "blob:" || u.protocol === "data:") return null;
    return u.pathname + u.search;
  } catch {
    return null; // malformed — excluded
  }
}

export function classifyRole(path) {
  // Rules test the bare pathname — a `?v=N` cache-bust must never change a
  // URL's role (the query-string bug the classifier tests caught: versioned
  // VRMs fell through endsWith('.vrm') into reveal-core).
  const bare = path.split("?")[0];
  for (const rule of ROLE_MANIFEST) {
    if (rule.test(bare)) return rule;
  }
  return ROLE_MANIFEST[ROLE_MANIFEST.length - 1];
}

/**
 * Build the ledger from a probe report.
 * Returns { rows, lanes, milestones } — rows aggregated per canonical URL.
 */
export function buildLedger(report, fixtureName = "guest-default", diets = {}) {
  const fixture = FIXTURES[fixtureName];
  if (!fixture) throw new Error(`unknown fixture: ${fixtureName}`);

  // Aggregate per canonical URL.
  const byUrl = new Map();
  for (const rec of report.requests) {
    if (rec.failed || !rec.wireBytes) continue;
    if (EXCLUDED_CLASSES.has(rec.cls)) continue;
    const path = canonicalUrl(rec.url);
    if (!path) continue;
    const agg = byUrl.get(path) ?? { url: path, cls: rec.cls, requestCount: 0, beforeBytes: 0 };
    agg.requestCount += 1;
    agg.beforeBytes += rec.wireBytes;
    byUrl.set(path, agg);
  }

  const rows = [];
  for (const agg of byUrl.values()) {
    const rule = classifyRole(agg.url);
    const fixtureCritical = fixture.criticalUrlSubstrings.some((s) => agg.url.includes(s));
    // A fixture-critical URL is reveal-gated for this fixture no matter its lane.
    const effectiveLane = fixtureCritical ? "reveal-core" : rule.lane;
    const postExclusive = rule.lane.startsWith("post-") && !fixtureCritical;
    const bare = agg.url.split("?")[0];
    const afterBytes = diets[agg.url] ?? diets[bare] ?? agg.beforeBytes;
    rows.push({
      url: agg.url, cls: agg.cls, requestCount: agg.requestCount,
      manifestLane: rule.lane, effectiveLane, consumers: rule.consumers,
      sharedDemand: rule.sharedDemand, fixtureCritical, postExclusive,
      beforeBytes: agg.beforeBytes, afterBytes,
      saving: agg.beforeBytes - afterBytes,
    });
  }

  const mb = (n) => +(n / 1048576).toFixed(3);
  const sum = (filter, field) => rows.filter(filter).reduce((a, r) => a + r[field], 0);
  const laneNames = [...new Set(rows.map((r) => r.effectiveLane))].sort();
  const lanes = Object.fromEntries(laneNames.map((l) => [l, {
    urls: rows.filter((r) => r.effectiveLane === l).length,
    requests: sum((r) => r.effectiveLane === l, "requestCount"),
    beforeMB: mb(sum((r) => r.effectiveLane === l, "beforeBytes")),
    afterMB: mb(sum((r) => r.effectiveLane === l, "afterBytes")),
    savingMB: mb(sum((r) => r.effectiveLane === l, "beforeBytes") - sum((r) => r.effectiveLane === l, "afterBytes")),
  }]));

  const totalBefore = sum(() => true, "beforeBytes");
  const postExclusiveBefore = sum((r) => r.postExclusive, "beforeBytes");
  const revealDietSaving = sum((r) => !r.postExclusive, "beforeBytes") - sum((r) => !r.postExclusive, "afterBytes");
  const totalAfterDiets = sum(() => true, "afterBytes");

  return {
    fixture: fixtureName, fixtureNote: fixture.note,
    lanes,
    milestones: {
      baselineTotalMB: mb(totalBefore),
      m1RevealProjectionMB: mb(totalBefore - postExclusiveBefore),
      m2RevealProjectionMB: mb(totalBefore - postExclusiveBefore - revealDietSaving),
      queueDrainedTotalMB: mb(totalAfterDiets),
      note: "m1 subtracts POST-EXCLUSIVE rows only (fixture-critical shared URLs stay reveal-gated); m2 subtracts reveal-side diet savings; queue-drained total counts diets across ALL lanes and NEVER credits deferral.",
    },
    rows: rows.sort((a, b) => b.beforeBytes - a.beforeBytes),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const [reportPath, dietsPath, fixtureName] = process.argv.slice(2);
  if (!reportPath) {
    console.error("usage: bun cold-load-ledger.mjs <probe-report.json> [diets.json] [fixture]");
    process.exit(2);
  }
  const report = JSON.parse(await Bun.file(reportPath).text());
  if (report.summary && report.summary.valid === false) {
    console.error(`[ledger] REFUSING invalid probe report: ${report.summary.invalidReasons.join("; ")}`);
    process.exit(3);
  }
  const diets = dietsPath ? JSON.parse(await Bun.file(dietsPath).text()) : {};
  const ledger = buildLedger(report, fixtureName || "guest-default", diets);
  const outPath = reportPath.replace(/\.json$/, "") + ".ledger.json";
  await Bun.write(outPath, JSON.stringify({ source: reportPath, dietsApplied: dietsPath || null, ...ledger }, null, 2));
  console.log(JSON.stringify({ fixture: ledger.fixture, lanes: ledger.lanes, milestones: ledger.milestones }, null, 2));
  console.log(`[ledger] full ledger: ${outPath}`);
}
