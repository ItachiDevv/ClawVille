#!/usr/bin/env bun
/**
 * Smoke test for patchOverrides() — the JSON-patch step of the Mixamo CLI.
 *
 * Copies the live character-anim-overrides.json to a temp file, injects fake
 * successful results, runs the patcher, then asserts:
 *   1. $comment is preserved.
 *   2. Existing animator entries get the new slot merged (other slots untouched).
 *   3. New animator entries get created with just the new slot.
 *   4. Keys are alphabetized with $comment first.
 *   5. File ends with a single trailing newline.
 *
 * Usage:
 *   bun scripts/mixamo/smoke-patcher.ts
 *
 * Exit code is 0 on success, 1 on any assertion failure.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { patchOverrides, type PatchResult } from "./patch-overrides";

const LIVE_PATH = resolve(
  process.cwd(),
  "apps/web/src/lib/three/character-anim-overrides.json",
);

let failed = 0;
function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ─── Set up temp copy ────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "mixamo-patch-smoke-"));
const tmpPath = join(tmp, "character-anim-overrides.json");
const before = readFileSync(LIVE_PATH, "utf-8");
writeFileSync(tmpPath, before);

const beforeJson = JSON.parse(before) as Record<string, unknown>;
const hadHermesMaleSwim =
  typeof (beforeJson["hermes-male"] as Record<string, string> | undefined)?.[
    "swimming"
  ] === "string";

console.log(`\n=== smoke-patcher.ts ===`);
console.log(`tmp:  ${tmpPath}`);
console.log(`live: ${LIVE_PATH} (read-only here)`);

// ─── Fake results — three scenarios ──────────────────────────────────────
// 1. Update existing animator with new slot (hermes-male.jump).
// 2. Create new animator (smoke-test-rig.jump).
// 3. Failed result — must be ignored entirely.
const results: PatchResult[] = [
  {
    animatorId: "hermes-male",
    animationsDir: "/avatars/animations/hermes-male",
    status: "ok",
  },
  {
    animatorId: "smoke-test-rig",
    animationsDir: "/avatars/animations/smoke-test-rig",
    status: "ok",
  },
  {
    animatorId: "should-be-skipped",
    animationsDir: "/avatars/animations/should-be-skipped",
    status: "fail",
  },
];

// ─── Run the patcher ─────────────────────────────────────────────────────
const summary = patchOverrides(tmpPath, results, "jump");

assert("summary.patched === 2", summary.patched === 2, `got ${summary.patched}`);
assert(
  "summary.entries reflects only ok results",
  summary.entries.length === 2 &&
    summary.entries.every((e) => e.slot === "jump"),
);

// ─── Inspect mutated file ────────────────────────────────────────────────
const after = readFileSync(tmpPath, "utf-8");
const afterJson = JSON.parse(after) as Record<string, unknown>;

// 1. $comment preserved
assert(
  "$comment preserved",
  typeof afterJson["$comment"] === "string" &&
    afterJson["$comment"] === beforeJson["$comment"],
);

// 2. Existing slots on hermes-male untouched
const hermesMale = afterJson["hermes-male"] as Record<string, string>;
assert(
  "hermes-male.jump merged",
  hermesMale?.["jump"] === "/avatars/animations/hermes-male/jump.glb",
  `got ${hermesMale?.["jump"]}`,
);
if (hadHermesMaleSwim) {
  assert(
    "hermes-male.swimming unchanged",
    hermesMale?.["swimming"] ===
      (beforeJson["hermes-male"] as Record<string, string>)?.["swimming"],
  );
}

// 3. New animator created
const newRig = afterJson["smoke-test-rig"] as Record<string, string>;
assert(
  "smoke-test-rig created with jump only",
  newRig &&
    Object.keys(newRig).length === 1 &&
    newRig["jump"] === "/avatars/animations/smoke-test-rig/jump.glb",
);

// 4. Failed results ignored
assert(
  "should-be-skipped NOT present",
  afterJson["should-be-skipped"] === undefined,
);

// 5. Key order: $comment first, then alphabetical
const keys = Object.keys(afterJson);
const expected = [
  "$comment",
  ...keys.filter((k) => k !== "$comment").slice().sort((a, b) => a.localeCompare(b)),
];
assert(
  "keys ordered ($comment first, rest alphabetical)",
  JSON.stringify(keys) === JSON.stringify(expected),
  `got ${JSON.stringify(keys)}`,
);

// 6. Trailing newline (exactly one)
assert(
  "file ends with exactly one trailing newline",
  after.endsWith("\n") && !after.endsWith("\n\n"),
);

// 7. Live file untouched
assert(
  "live overrides file untouched",
  readFileSync(LIVE_PATH, "utf-8") === before,
);

// ─── Cleanup + report ────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });

console.log(`\n=== ${failed === 0 ? "PASS" : `FAIL (${failed})`} ===\n`);
process.exit(failed === 0 ? 0 : 1);
