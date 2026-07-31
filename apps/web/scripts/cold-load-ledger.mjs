// cold-load-ledger.mjs — URL-level accounting ledger for the cold-load diet.
//
// Reads a cold-load-probe report and classifies every asset URL into a LANE
// per the role rules in docs/perf-cold-load-diet-2026-07-31.md §3 A (incl. the
// animation-clip role split), then emits per-URL rows
//   { url, lane, beforeBytes, afterBytes, saving, sharedDemand }
// and the milestone sums:
//   M1 reveal projection  = total − (post-lane bytes)          [deferral only]
//   M2 reveal projection  = M1 − (reveal-lane diet savings)    [needs diets file]
//   queue-drained total   = Σ afterBytes across ALL lanes      [diets only —
//                           A deferral is NEVER credited toward total-session]
//
// Optional diets file: JSON { "<url-path>": afterBytes } for assets with a
// produced diet artifact (measured sibling file size, not an estimate). Rows
// without an entry keep afterBytes = beforeBytes.
//
// Usage: bun apps/web/scripts/cold-load-ledger.mjs <probe-report.json> [diets.json]

const [reportPath, dietsPath] = process.argv.slice(2);
if (!reportPath) {
  console.error("usage: bun cold-load-ledger.mjs <probe-report.json> [diets.json]");
  process.exit(2);
}

const report = JSON.parse(await Bun.file(reportPath).text());
const diets = dietsPath ? JSON.parse(await Bun.file(dietsPath).text()) : {};

// ---------------------------------------------------------------------------
// Role rules (mirror plan §3 A; update BOTH when the deferred set changes).
// Lanes:
//   reveal-core        — gates the loader (buildings, town props, terrain,
//                        decorations, shared locomotion, Nori, JS/CSS/etc.)
//   post-location      — 12 location character GLBs (deferred, timing-only)
//   post-ambient-vrm   — ambient wanderer VRMs (deferred; every VRM is also
//                        player-capable → sharedDemand: demand wins if a
//                        critical consumer needs the same URL)
//   post-anim-char     — character-specific clips whose only live consumers
//                        are deferred ambient NPCs (role split; demand wins)
//   post-attachment    — ansem-sword (wanderer attachment; sharedDemand)
//   excluded           — API/OTHER/HTML zero-weight noise (not an asset lane)
// ---------------------------------------------------------------------------
const CHAR_ANIM_DIRS = ["hermes-female", "hermes-male", "tekk-male", "chibi", "ansem"];

function laneOf(rec) {
  const path = rec.url.replace(/^https:\/\/[^/]+/, "").split("?")[0];
  if (rec.cls === "API" || rec.cls === "OTHER" || rec.cls === "JSON" || rec.cls === "AUDIO") return { lane: "excluded" };
  if (path.startsWith("/models/characters/") || path === "/models/lobster_plush-ktx.glb") {
    return { lane: "post-location", sharedDemand: path === "/models/lobster_plush-ktx.glb" };
  }
  if (path === "/avatars/ansem-sword.glb") return { lane: "post-attachment", sharedDemand: true };
  if (rec.cls === "VRM") return { lane: "post-ambient-vrm", sharedDemand: true };
  if (path.startsWith("/avatars/animations/")) {
    const seg = path.split("/")[3];
    if (CHAR_ANIM_DIRS.includes(seg)) return { lane: "post-anim-char", sharedDemand: true };
    return { lane: "reveal-core" }; // shared base locomotion + emote bundle stay demand/reveal semantics
  }
  return { lane: "reveal-core" };
}

const rows = [];
for (const rec of report.requests) {
  if (rec.failed || !rec.wireBytes) continue;
  const { lane, sharedDemand } = laneOf(rec);
  if (lane === "excluded") continue;
  const path = rec.url.replace(/^https:\/\/[^/]+/, "");
  const bare = path.split("?")[0];
  const afterBytes = diets[bare] ?? diets[path] ?? rec.wireBytes;
  rows.push({
    url: path, lane, sharedDemand: !!sharedDemand,
    beforeBytes: rec.wireBytes, afterBytes,
    saving: rec.wireBytes - afterBytes,
  });
}

const mb = (n) => +(n / 1048576).toFixed(3);
const laneSum = (lane, field) => rows.filter((r) => r.lane === lane).reduce((a, r) => a + r[field], 0);
const lanes = [...new Set(rows.map((r) => r.lane))].sort();

const totalBefore = rows.reduce((a, r) => a + r.beforeBytes, 0);
const postLanes = lanes.filter((l) => l.startsWith("post-"));
const postBefore = postLanes.reduce((a, l) => a + laneSum(l, "beforeBytes"), 0);
const revealDietSaving = laneSum("reveal-core", "beforeBytes") - laneSum("reveal-core", "afterBytes");
const totalAfterDiets = rows.reduce((a, r) => a + r.afterBytes, 0);

const out = {
  source: reportPath,
  dietsApplied: dietsPath || null,
  lanes: Object.fromEntries(lanes.map((l) => [l, {
    count: rows.filter((r) => r.lane === l).length,
    beforeMB: mb(laneSum(l, "beforeBytes")),
    afterMB: mb(laneSum(l, "afterBytes")),
    savingMB: mb(laneSum(l, "beforeBytes") - laneSum(l, "afterBytes")),
  }])),
  milestones: {
    baselineTotalMB: mb(totalBefore),
    m1RevealProjectionMB: mb(totalBefore - postBefore),
    m2RevealProjectionMB: mb(totalBefore - postBefore - revealDietSaving),
    queueDrainedTotalMB: mb(totalAfterDiets),
    note: "m1 = deferral only; m2 subtracts reveal-lane diet savings; queue-drained total counts diets across ALL lanes and NEVER credits deferral.",
  },
  sharedDemandCaveat: "post-lane rows with sharedDemand:true fetch reveal-priority whenever a critical consumer (local player, remote, possessed, autonomous) demands the same URL — worst-case reveal wire adds those rows back in.",
  rows: rows.sort((a, b) => b.beforeBytes - a.beforeBytes),
};

const outPath = reportPath.replace(/\.json$/, "") + ".ledger.json";
await Bun.write(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ lanes: out.lanes, milestones: out.milestones }, null, 2));
console.log(`[ledger] full ledger: ${outPath}`);
