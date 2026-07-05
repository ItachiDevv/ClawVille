/**
 * Directive → building resolver (P3 slice 2).
 *
 * Pure, dependency-free (only the `BuildingCenters` type + an injected id→label
 * map) so it is trivially unit-testable and carries none of the ElizaOS import
 * chain the SimulationRuntime does. Extracted from simulation-runtime.ts when
 * label matching landed (spec Advisory-1).
 *
 * WHY this exists: the avatar planner's AVATAR_WORLD_STATE provider only lists
 * the 6 NEAREST buildings, so a directive naming a FAR building (e.g. memory-rag
 * ~8300px away, rank #9) is neither in the model's menu nor its examples — a
 * small model (gpt-4o-mini) then ignores the directive and keeps its local loop
 * (proven live: 14 min of no bias). So the planner resolves the directive-named
 * building HERE and dispatches the move deterministically — the honest, MEASURABLE
 * bias the slice promises, rather than hoping the LLM emits an off-menu id.
 */

import type { BuildingCenters } from './types';

/**
 * Normalize free text for whole-token matching: lowercase, every run of
 * non-alphanumerics → a single space, then trim. This makes "Squidward's House"
 * and "memory-rag" both collapse to space-delimited tokens ("squidward s house",
 * "memory rag"), so apostrophes / hyphens / commas in either the directive or a
 * label can never block a match.
 */
function normalizeTokens(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Whole-token containment: is `needleNorm` present in `hayNorm` on token
 * boundaries? Both are already normalized (single-space-delimited), so padding
 * each with a space reduces this to a boundary-respecting substring test —
 * " code development " matches "…the code development building…" but NOT
 * "decode developmental" (no leading space before "code").
 */
function containsToken(hayNorm: string, needleNorm: string): boolean {
  if (!needleNorm) return false;
  return ` ${hayNorm} `.includes(` ${needleNorm} `);
}

/**
 * Resolve the building id a directive NAMES — by building id ("memory-rag") OR
 * display name ("Squidward's House") — or null when nothing known is named.
 *
 * Matching is case-insensitive and whole-token (see helpers). All candidate
 * needles (every id + its label when `buildingLabels` is supplied) are tried
 * LONGEST-first, so a specific multi-word name ("squidward s house") wins over a
 * shorter accidental id/token overlap, and a longer label beats a generic one.
 *
 * `buildingLabels` is optional (id→display name). Without it the resolver is
 * id-only (byte-identical to the pre-Advisory-1 behavior); the bridge supplies
 * it from @clawville/shared MAP_LOCATIONS so founder-facing natural-language
 * directives ("Walk to Squidward's House") resolve. Still does NOT resolve a
 * bare TOPIC ("learn about cron jobs") — that has no building token; follow-up.
 */
export function resolveDirectiveBuildingId(
  directiveContext: string,
  buildingCenters: BuildingCenters,
  buildingLabels?: Record<string, string>,
): string | null {
  const hayNorm = normalizeTokens(directiveContext);
  if (!hayNorm) return null;

  const candidates: Array<{ id: string; needle: string }> = [];
  for (const id of Object.keys(buildingCenters)) {
    const idNorm = normalizeTokens(id);
    if (idNorm) candidates.push({ id, needle: idNorm });
    const label = buildingLabels?.[id];
    if (label) {
      const labelNorm = normalizeTokens(label);
      if (labelNorm) candidates.push({ id, needle: labelNorm });
    }
  }
  // Longest needle first — "squidward s house" (17) before "memory rag" (10)
  // before a bare id — so the most specific name wins.
  candidates.sort((a, b) => b.needle.length - a.needle.length);

  for (const cand of candidates) {
    if (containsToken(hayNorm, cand.needle)) return cand.id;
  }
  return null;
}
