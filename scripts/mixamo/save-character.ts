#!/usr/bin/env bun
/**
 * Register a Mixamo character_id under a slug + skeleton class.
 * Run once per character after you've rigged it in Mixamo's web UI and
 * extracted its character_id from any Network-tab API call.
 *
 * Usage:
 *   bun scripts/mixamo/save-character.ts <slug> <character_id> <skeleton_class>
 *
 * Example:
 *   bun scripts/mixamo/save-character.ts cyrus ef7eb018-7cf3-4ae1-99ac-bab1c2c5d419 mixamo-adult-male
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMixamoAuth, mxHeaders, MIXAMO_BASE } from "./auth";

const [slug, characterId, skeletonClass] = process.argv.slice(2);
if (!slug || !characterId || !skeletonClass) {
  console.error(
    "Usage: bun scripts/mixamo/save-character.ts <slug> <character_id> <skeleton_class>",
  );
  console.error("\nExample:");
  console.error(
    "  bun scripts/mixamo/save-character.ts cyrus ef7eb018-7cf3-4ae1-99ac-bab1c2c5d419 mixamo-adult-male",
  );
  process.exit(1);
}

const REGISTRY_PATH = resolve(process.cwd(), "scripts/mixamo/characters.json");
const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as {
  _comment?: string;
  characters: Record<
    string,
    { id: string; skeletonClass: string; registeredAt: string }
  >;
};

// Sanity check: hit /products?character_id=<id> with a placeholder anim to
// confirm Mixamo recognises the character_id as one of ours.
const auth = loadMixamoAuth();
console.log(`Validating character_id ${characterId} against Mixamo...`);

// Get any one Motion to use as a probe. The /products endpoint with a
// character_id parameter only succeeds if the character belongs to the
// authenticated user.
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
      "\n404 usually means: (a) the character_id is wrong, or (b) the character was deleted from Mixamo.",
    );
  }
  process.exit(1);
}

// All good — write to registry.
const existing = registry.characters[slug];
if (existing) {
  console.log(`Overwriting existing slug "${slug}" (was ${existing.id}).`);
}
registry.characters[slug] = {
  id: characterId,
  skeletonClass,
  registeredAt: new Date().toISOString(),
};
writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
console.log(
  `OK — registered ${slug} (${characterId}) under skeleton class "${skeletonClass}".`,
);
