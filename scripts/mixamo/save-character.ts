#!/usr/bin/env bun
/**
 * Register a Mixamo character_id under a slug + skeleton class.
 * Run once per character after you've rigged it in Mixamo's web UI and
 * extracted its character_id from any Network-tab API call.
 *
 * Usage:
 *   bun scripts/mixamo/save-character.ts <slug> <character_id> <skeleton_class>
 *       [--animator-id=<id>] [--animations-dir=<path>]
 *
 * Example (basic):
 *   bun scripts/mixamo/save-character.ts cyrus ef7eb018-... mixamo-adult-male
 *
 * Example (legacy folder name doesn't match slug — Tekk uses tekk-male/):
 *   bun scripts/mixamo/save-character.ts tekk abcd-... mixamo-adult-male \
 *       --animator-id=tekk --animations-dir=/avatars/animations/tekk-male
 *
 * The slug is the local identifier used in commands. animator-id is the key in
 * CHARACTER_ANIM_OVERRIDES (defaults to slug). animations-dir is the URL path
 * prefix that runtime imports use (defaults to /avatars/animations/<slug>).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMixamoAuth, mxHeaders, MIXAMO_BASE } from "./auth";

const rawArgs = process.argv.slice(2);
const flagMap = new Map<string, string>();
const positional: string[] = [];
for (const a of rawArgs) {
  const m = a.match(/^--([\w-]+)=(.*)$/);
  if (m) flagMap.set(m[1]!, m[2]!);
  else positional.push(a);
}

const [slug, characterId, skeletonClass] = positional;
if (!slug || !characterId || !skeletonClass) {
  console.error(
    "Usage: bun scripts/mixamo/save-character.ts <slug> <character_id> <skeleton_class> [--animator-id=<id>] [--animations-dir=<path>]",
  );
  process.exit(1);
}

const animatorId = flagMap.get("animator-id") ?? slug;
const animationsDir =
  flagMap.get("animations-dir") ?? `/avatars/animations/${slug}`;

// ─── Validate against Mixamo ─────────────────────────────────────────────
const auth = loadMixamoAuth();
console.log(`Validating character_id ${characterId} against Mixamo...`);

const probeRes = await fetch(
  `${MIXAMO_BASE}/products?page=1&limit=1&type=Motion`,
  { headers: mxHeaders(auth) },
);
if (!probeRes.ok) {
  console.error(`HTTP ${probeRes.status} listing motions:`, await probeRes.text());
  process.exit(1);
}
const probe = (await probeRes.json()) as { results: Array<{ id: string }> };
const probeAnimId = probe.results?.[0]?.id;
if (!probeAnimId) {
  console.error("No motion found in /products response — Mixamo library empty?");
  process.exit(1);
}

const validateRes = await fetch(
  `${MIXAMO_BASE}/products/${probeAnimId}?similar=0&character_id=${characterId}`,
  { headers: mxHeaders(auth) },
);
if (!validateRes.ok) {
  console.error(
    `HTTP ${validateRes.status} validating character — does this character_id belong to your Mixamo account?`,
  );
  if (validateRes.status === 404) {
    console.error(
      "\n404 usually means: (a) wrong character_id, or (b) Mixamo has purged the upload (free tier; happens after ~24h).",
    );
  }
  process.exit(1);
}

// ─── Write registry ──────────────────────────────────────────────────────
const REGISTRY_PATH = resolve(process.cwd(), "scripts/mixamo/characters.json");
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as {
  _comment?: string;
  characters: Record<
    string,
    {
      id: string;
      skeletonClass: string;
      animatorId: string;
      animationsDir: string;
      registeredAt: string;
    }
  >;
};

const existing = registry.characters[slug];
if (existing) {
  console.log(`Overwriting existing slug "${slug}" (was ${existing.id}).`);
}
registry.characters[slug] = {
  id: characterId,
  skeletonClass,
  animatorId,
  animationsDir,
  registeredAt: new Date().toISOString(),
};
writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");

console.log(
  `OK — registered ${slug} (${characterId})\n` +
    `     skeletonClass:  ${skeletonClass}\n` +
    `     animatorId:     ${animatorId}\n` +
    `     animationsDir:  ${animationsDir}`,
);
