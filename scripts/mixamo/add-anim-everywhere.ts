#!/usr/bin/env bun
/**
 * Apply ONE new animation to every character of a given skeleton class.
 *
 * Usage:
 *   bun scripts/mixamo/add-anim-everywhere.ts <anim_name> <skeleton_class>
 *
 * Example:
 *   bun scripts/mixamo/add-anim-everywhere.ts "Dancing" mixamo-adult-male
 *
 * For each registered character whose skeletonClass matches:
 *   1. Spawns fetch-animations.ts to download the FBX from Mixamo + convert
 *      to mesh-free GLB via Blender (same per-character pipeline).
 *   2. After all complete, prints the CHARACTER_ANIM_OVERRIDES patch snippet
 *      to paste into apps/web/src/lib/three/vrm-character-animator.ts.
 *
 * The current Mixamo free tier holds only ONE active user character at a time,
 * BUT the character_id remains valid for animation API calls even after the
 * upload is no longer in "My Assets". So this works across all registered
 * characters as long as their UUIDs were ever valid.
 *
 * If a character's UUID has been permanently invalidated by Mixamo, the
 * per-character fetch will fail with HTTP 404 and the script logs it as
 * skipped — the others continue.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { patchOverrides } from "./patch-overrides";

// Path to the runtime override map (now JSON, see vrm-character-animator.ts).
const OVERRIDES_PATH = resolve(
  process.cwd(),
  "apps/web/src/lib/three/character-anim-overrides.json",
);

const [animName, skeletonClass] = process.argv.slice(2);
if (!animName || !skeletonClass) {
  console.error(
    "Usage: bun scripts/mixamo/add-anim-everywhere.ts <anim_name> <skeleton_class>",
  );
  console.error("\nExample:");
  console.error(
    '  bun scripts/mixamo/add-anim-everywhere.ts "Dancing" mixamo-adult-male',
  );
  process.exit(1);
}

// ─── Load registry + filter ──────────────────────────────────────────────
const REGISTRY_PATH = resolve(process.cwd(), "scripts/mixamo/characters.json");
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as {
  characters: Record<
    string,
    {
      id: string;
      skeletonClass: string;
      animatorId?: string;
      animationsDir?: string;
    }
  >;
};

const matching = Object.entries(registry.characters).filter(
  ([, c]) => c.skeletonClass === skeletonClass,
);

if (matching.length === 0) {
  console.error(
    `No registered characters with skeletonClass "${skeletonClass}".`,
  );
  console.error("\nKnown skeleton classes in registry:");
  const classes = new Set(
    Object.values(registry.characters).map((c) => c.skeletonClass),
  );
  for (const sk of classes) console.error(`  - ${sk}`);
  process.exit(1);
}

console.log(
  `\n=== add "${animName}" to ${matching.length} character(s) of skeleton "${skeletonClass}" ===`,
);
for (const [slug, c] of matching) {
  console.log(`  - ${slug} (animatorId=${c.animatorId ?? slug})`);
}

// ─── Per-character fetch via the existing CLI ────────────────────────────
const t0 = Date.now();
const FETCH_SCRIPT = resolve(process.cwd(), "scripts/mixamo/fetch-animations.ts");
const results: Array<{
  slug: string;
  animatorId: string;
  animationsDir: string;
  status: "ok" | "fail";
  err?: string;
}> = [];

for (const [slug, char] of matching) {
  console.log(`\n──────── ${slug} ────────`);
  const r = spawnSync(
    "bun",
    [FETCH_SCRIPT, slug, animName],
    { stdio: "inherit", encoding: "utf-8" },
  );
  results.push({
    slug,
    animatorId: char.animatorId ?? slug,
    animationsDir: char.animationsDir ?? `/avatars/animations/${slug}`,
    status: r.status === 0 ? "ok" : "fail",
    err: r.status !== 0 ? `bun fetch-animations exited ${r.status}` : undefined,
  });
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
const okCount = results.filter((r) => r.status === "ok").length;
console.log(
  `\n=== batch done in ${dt}s — ${okCount}/${matching.length} ok ===`,
);

// ─── Generate the patch snippet ──────────────────────────────────────────
// Slot name = whatever fetch-animations.ts wrote the GLB as. The SLOT_FOR_NAME
// table in fetch-animations.ts maps Mixamo's display names to our canonical
// runtime slot keys (e.g. "Stumble Backwards" → "wipeout").
const SLOT_FOR_NAME: Record<string, string> = {
  idle: "idle",
  walking: "walk",
  running: "run",
  cheering: "cheering",
  cheer: "cheering",
  skateboarding: "skateboarding",
  "stumble backwards": "wipeout",
  swimming: "swimming",
  praying: "praying",
  flying: "flying",
};
function slotFor(s: string): string {
  const k = s.toLowerCase().trim();
  if (SLOT_FOR_NAME[k]) return SLOT_FOR_NAME[k]!;
  return k.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}
const slot = slotFor(animName);

// ─── Patch character-anim-overrides.json automatically ──────────────────
// Runtime reads this JSON via vrm-character-animator.ts; updating it here
// is the entire "wire the new animation into the game" step.
console.log("\n=== Patching character-anim-overrides.json ===");

const summary = patchOverrides(OVERRIDES_PATH, results, slot);
for (const e of summary.entries) {
  console.log(`  ${e.animatorId}.${e.slot}  →  '${e.glbPath}'`);
}
if (summary.patched > 0) {
  console.log(`\n✓ wrote ${summary.patched} entries to ${OVERRIDES_PATH}`);
} else {
  console.log("  (no successful fetches to patch)");
}

// ─── Failures ────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status !== "ok");
if (failed.length > 0) {
  console.log(`\n=== ${failed.length} failed ===`);
  for (const f of failed) console.log(`  ✗ ${f.slug}: ${f.err}`);
  console.log(
    "\nIf failure was HTTP 404 from Mixamo, that character's upload has likely been purged.",
  );
  console.log(
    "Re-upload it via mixamo.com (markers + auto-rig, 60s), grab the new character_id, and re-run save-character.ts with --animator-id and --animations-dir matching the existing entry to overwrite. Then re-run this command.",
  );
  process.exit(1);
}
