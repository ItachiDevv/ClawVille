#!/usr/bin/env bun
/**
 * cold-load-canary-assert.mjs — rung-1 canary behavior assertion.
 *
 * Proves, from a cold-load-probe report, that a release-deferred asset
 * (a) was actually fetched during the capture (never stranded/omitted), and
 * (b) every fetch of it STARTED at/after the decorative release stamp
 *     (`summary.decorativeReleasedAt`, page-clock ms — same clock as
 *     `startPageMs` on request records).
 *
 * Usage: bun cold-load-canary-assert.mjs <report.json> <url-substring>
 *   e.g. bun cold-load-canary-assert.mjs report.json flying-dutchman
 *
 * Exit codes: 0 = canary holds · 3 = violation (pre-release fetch or asset
 * missing) · 2 = report unusable for this assertion (no release stamp).
 */

// Clock-mapping tolerance: the release stamp is Math.round(performance.now())
// in-page while startPageMs maps CDP monotonic time onto the page clock —
// sub-frame skew/rounding only. A REAL pre-release fetch (a mounted mesh
// demanding the GLB during initial load) starts seconds early, never within
// this window, so the epsilon cannot mask the defect being tested.
const CLOCK_EPSILON_MS = 25;

const [reportPath, needle] = process.argv.slice(2);
if (!reportPath || !needle) {
  console.error("usage: bun cold-load-canary-assert.mjs <report.json> <url-substring>");
  process.exit(2);
}

const report = JSON.parse(await Bun.file(reportPath).text());
const releasedAt = report?.summary?.decorativeReleasedAt;
const reason = report?.summary?.decorativeReleaseReason;

if (typeof releasedAt !== "number" || !Number.isFinite(releasedAt)) {
  console.error(`[canary] UNUSABLE: no finite decorativeReleasedAt in ${reportPath} — probe predates the stamp capture or the release never fired in-page.`);
  process.exit(2);
}

const matches = [
  ...(Array.isArray(report.requests) ? report.requests : []),
  ...(Array.isArray(report.failedRequests) ? report.failedRequests : []),
].filter((r) => typeof r?.url === "string" && r.url.includes(needle));

if (matches.length === 0) {
  console.error(`[canary] VIOLATION: no request matching "${needle}" in the capture — the deferred asset never loaded (stranded content is a product defect, not a byte win).`);
  process.exit(3);
}
// A FAILED request is not proof of loading (Codex canary review advisory):
// the ordering check below still covers failed matches, but "it loaded" needs
// at least one request that actually finished successfully.
if (!matches.some((r) => !r.failed)) {
  console.error(`[canary] VIOLATION: ${matches.length} matching request(s) but none succeeded — the deferred asset never actually loaded.`);
  process.exit(3);
}

const early = matches.filter((r) => typeof r.startPageMs === "number" && r.startPageMs < releasedAt - CLOCK_EPSILON_MS);
const unstamped = matches.filter((r) => typeof r.startPageMs !== "number" || !Number.isFinite(r.startPageMs));

for (const r of matches) {
  const rel = typeof r.startPageMs === "number" ? `+${((r.startPageMs - releasedAt) / 1000).toFixed(2)}s after release` : "NO START TIMESTAMP";
  console.log(`[canary] ${r.url.replace(/^https?:\/\/[^/]+/, "")} start=${r.startPageMs}ms (${rel})${r.failed ? " [FAILED REQUEST]" : ""}`);
}
console.log(`[canary] release: ${releasedAt}ms (${reason ?? "no reason"}); reveal: ${report.summary.revealMs}ms; matches: ${matches.length}`);

if (unstamped.length > 0) {
  console.error(`[canary] VIOLATION: ${unstamped.length} matching request(s) carry no finite startPageMs — cannot prove ordering.`);
  process.exit(3);
}
if (early.length > 0) {
  console.error(`[canary] VIOLATION: ${early.length} matching request(s) started BEFORE the decorative release.`);
  process.exit(3);
}
console.log(`[canary] PASS: all ${matches.length} "${needle}" fetch(es) started after the decorative release.`);
process.exit(0);
