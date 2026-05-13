/**
 * Patch character-anim-overrides.json in place with newly fetched animation
 * paths. Used by add-anim-everywhere.ts after a batch fetch completes.
 *
 * Extracted into its own module so the logic is unit-testable without
 * shelling out to fetch-animations.ts. See scripts/mixamo/smoke-patcher.ts.
 *
 * Schema:
 *   { "$comment": "...",
 *     "<animatorId>": { "<AnimName>": "<url-path-to-glb>", ... },
 *     ... }
 *
 * Slot keys must match an AnimName from vrm-character-animator.ts; the
 * runtime silently ignores unknown keys (lookup is undefined-safe).
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface PatchResult {
  animatorId: string;
  animationsDir: string;
  status: "ok" | "fail";
}

export interface PatchSummary {
  patched: number;
  entries: Array<{ animatorId: string; slot: string; glbPath: string }>;
}

/**
 * Merge new slot entries into the overrides JSON at `overridesPath`.
 * Each successful result writes `<animationsDir>/<slot>.glb` into
 * `json[animatorId][slot]`. Keys are stable-sorted with $comment first.
 *
 * @returns Summary of what was written (for logging by the caller).
 */
export function patchOverrides(
  overridesPath: string,
  results: readonly PatchResult[],
  slot: string,
): PatchSummary {
  const overridesText = readFileSync(overridesPath, "utf-8");
  const overrides = JSON.parse(overridesText) as Record<
    string,
    string | Record<string, string>
  >;

  const summary: PatchSummary = { patched: 0, entries: [] };

  for (const r of results) {
    if (r.status !== "ok") continue;
    const glbPath = `${r.animationsDir}/${slot}.glb`;
    const existing = overrides[r.animatorId];
    if (typeof existing === "string" || existing === undefined) {
      overrides[r.animatorId] = { [slot]: glbPath };
    } else {
      existing[slot] = glbPath;
    }
    summary.entries.push({ animatorId: r.animatorId, slot, glbPath });
    summary.patched++;
  }

  if (summary.patched > 0) {
    const keys = Object.keys(overrides).sort((a, b) => {
      if (a === "$comment") return -1;
      if (b === "$comment") return 1;
      return a.localeCompare(b);
    });
    const reordered: Record<string, unknown> = {};
    for (const k of keys) reordered[k] = overrides[k];
    writeFileSync(overridesPath, JSON.stringify(reordered, null, 2) + "\n");
  }

  return summary;
}
