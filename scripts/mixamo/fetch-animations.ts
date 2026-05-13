#!/usr/bin/env bun
/**
 * Fetch one or more animations from Mixamo for a registered character.
 *
 * Usage:
 *   bun scripts/mixamo/fetch-animations.ts <slug> <anim1> [anim2] [anim3] ...
 *
 * Example:
 *   bun scripts/mixamo/fetch-animations.ts cyrus Idle Walking Running
 *   bun scripts/mixamo/fetch-animations.ts cyrus "Stumble Backwards"
 *
 * Output: apps/web/public/models/hermes-mesh/<slug>-animations/<slot>.fbx
 *
 * Names are matched against Mixamo's library by exact + fuzzy display name.
 * Each animation is exported with skin=true (character-baked) at 30 fps,
 * matching the manual workflow we've been using for Cyrus / Mira / Tekk.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadMixamoAuth, mxHeaders, MIXAMO_BASE } from "./auth";

// ─── Args ─────────────────────────────────────────────────────────────────
// `--no-finalize` skips the Blender batch convert and stops after FBX
// download (useful for debugging just the Mixamo half). Default: run the
// full pipeline through GLB.
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith("--")));
const args = rawArgs.filter((a) => !a.startsWith("--"));
const slug = args[0];
const animQueries = args.slice(1);
const SHOULD_FINALIZE = !flags.has("--no-finalize");

if (!slug || animQueries.length === 0) {
  console.error(
    "Usage: bun scripts/mixamo/fetch-animations.ts <slug> <anim1> [anim2] ... [--no-finalize]",
  );
  process.exit(1);
}

// ─── Load registry ────────────────────────────────────────────────────────
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
const char = registry.characters[slug];
if (!char) {
  console.error(
    `Unknown character slug "${slug}". Register first with:\n` +
      `  bun scripts/mixamo/save-character.ts ${slug} <character_id> <skeleton_class>`,
  );
  process.exit(1);
}
const CHARACTER_ID = char.id;
// animationsDir is a URL path like '/avatars/animations/cyrus'; convert to
// filesystem path under apps/web/public/ for the Blender output. Default for
// older registry entries (without animationsDir) is '/avatars/animations/<slug>'.
const ANIMATIONS_URL_PATH = char.animationsDir ?? `/avatars/animations/${slug}`;
console.log(
  `Character: ${slug} (id=${CHARACTER_ID}, skeleton=${char.skeletonClass})`,
);
console.log(`  GLB output URL path: ${ANIMATIONS_URL_PATH}`);

// ─── Output dir ───────────────────────────────────────────────────────────
const OUT_DIR = resolve(
  process.cwd(),
  `apps/web/public/models/hermes-mesh/${slug}-animations`,
);
mkdirSync(OUT_DIR, { recursive: true });

// ─── Auth ─────────────────────────────────────────────────────────────────
const auth = loadMixamoAuth();

// ─── Slot mapping ────────────────────────────────────────────────────────
// Map Mixamo's free-text display names → our canonical slot filenames so the
// downstream Blender + GLB pipeline doesn't have to guess.
const SLOT_FOR_NAME: Record<string, string> = {
  "idle": "idle",
  "walking": "walk",
  "running": "run",
  "cheering": "cheering",
  "skateboarding": "skateboarding",
  "stumble backwards": "wipeout",
  "swimming": "swimming",
  "praying": "praying",
  "flying": "flying",
};

function slotFor(animName: string): string {
  const k = animName.toLowerCase().trim();
  if (SLOT_FOR_NAME[k]) return SLOT_FOR_NAME[k];
  // Default: kebab-case the name. "Catwalk Idle Twist L" → "catwalk-idle-twist-l".
  return k.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

// ─── Animation library search ────────────────────────────────────────────
interface AnimProduct {
  id: string;
  name?: string;
  description?: string;
  motion_id?: string;
}

async function findAnimation(query: string): Promise<AnimProduct | null> {
  // Mixamo search is fuzzy on the query string. We get back up to 96 results
  // per page; for common names "Idle" / "Walking" the exact match is in the
  // first page. Strict equality preferred, case-insensitive substring fallback.
  const url = `${MIXAMO_BASE}/products?page=1&limit=96&order=&type=Motion%2CMotionPack&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: mxHeaders(auth) });
  if (!res.ok) {
    console.error(`  search HTTP ${res.status} for "${query}":`, await res.text());
    return null;
  }
  const json = (await res.json()) as { results: AnimProduct[] };
  if (!json.results?.length) return null;

  const want = query.toLowerCase().trim();
  // 1. Exact case-insensitive name match
  const exact = json.results.find((r) => r.name?.toLowerCase().trim() === want);
  if (exact) return exact;
  // 2. Exact case-insensitive description match
  const exactDesc = json.results.find(
    (r) => r.description?.toLowerCase().trim() === want,
  );
  if (exactDesc) return exactDesc;
  // 3. First result that contains the query as a substring
  const fuzzy = json.results.find(
    (r) =>
      r.name?.toLowerCase().includes(want) ||
      r.description?.toLowerCase().includes(want),
  );
  return fuzzy ?? json.results[0]!;
}

// ─── Get the gms_hash for a specific (animation, character) pair ─────────
interface GmsHash {
  // Mixamo's hash carries the bake recipe — character-rig coupling +
  // per-param defaults (mirror, trim, overdrive, arm-space, in-place, etc.)
  params: Array<[string, string | number | boolean]>;
  [k: string]: unknown;
}

async function getGmsHash(animId: string): Promise<GmsHash> {
  const url = `${MIXAMO_BASE}/products/${animId}?similar=0&character_id=${CHARACTER_ID}`;
  const res = await fetch(url, { headers: mxHeaders(auth) });
  if (!res.ok) {
    throw new Error(`product fetch HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { details: { gms_hash: GmsHash } };
  if (!json.details?.gms_hash) {
    throw new Error(`no gms_hash in product response`);
  }
  return json.details.gms_hash;
}

// ─── Submit export job ───────────────────────────────────────────────────
async function submitExport(
  gmsHash: GmsHash,
  productName: string,
): Promise<void> {
  // Replicate the bake recipe the manual UI uses: flatten params to a CSV
  // string (Mixamo expects "0,0,0,..." rather than the [[k,v],...] array
  // returned by /products). The other gms_hash fields pass through.
  const params = gmsHash.params.map((p) => p[1]).join(",");
  const bakedHash = { ...gmsHash, params };
  const body = {
    character_id: CHARACTER_ID,
    gms_hash: [bakedHash],
    preferences: {
      format: "fbx7",
      skin: "true",   // bake animation onto THIS character's specific bone lengths
      fps: "30",
      reducekf: "0",
    },
    product_name: productName,
    type: "Motion",
  };
  const res = await fetch(`${MIXAMO_BASE}/animations/export`, {
    method: "POST",
    headers: mxHeaders(auth, { "X-Requested-With": "XMLHttpRequest" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`export HTTP ${res.status}: ${await res.text()}`);
  }
  // No useful response body — monitor endpoint reports the result.
}

// ─── Poll the monitor endpoint ───────────────────────────────────────────
interface MonitorResponse {
  status: string; // "processing" | "completed" | "failed"
  job_result?: string; // download URL when completed
  message?: string;
}

async function pollMonitor(timeoutMs = 120_000): Promise<string> {
  const url = `${MIXAMO_BASE}/characters/${CHARACTER_ID}/monitor`;
  const t0 = Date.now();
  let lastStatus = "";
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(url, { headers: mxHeaders(auth) });
    if (res.status === 404) {
      throw new Error("monitor 404 — character_id may have been deleted");
    }
    if (!res.ok) {
      throw new Error(`monitor HTTP ${res.status}`);
    }
    const json = (await res.json()) as MonitorResponse;
    if (json.status !== lastStatus) {
      const dt = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`    [${dt}s] status=${json.status}`);
      lastStatus = json.status;
    }
    if (json.status === "completed") {
      if (!json.job_result) throw new Error("completed but no job_result URL");
      return json.job_result;
    }
    if (json.status === "failed") {
      throw new Error(`Mixamo job failed: ${json.message ?? "(no message)"}`);
    }
  }
  throw new Error(`Mixamo job did not finish within ${timeoutMs / 1000}s`);
}

// ─── Download FBX ────────────────────────────────────────────────────────
async function downloadFbx(downloadUrl: string, dest: string): Promise<void> {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}`);
  }
  const bytes = await res.arrayBuffer();
  writeFileSync(dest, Buffer.from(bytes));
}

// ─── Main: iterate each requested animation ───────────────────────────────
let okCount = 0;
let failCount = 0;

for (const query of animQueries) {
  const t0 = Date.now();
  console.log(`\n→ "${query}"`);
  try {
    const anim = await findAnimation(query);
    if (!anim) {
      console.error(`  ✗ no match in Mixamo library`);
      failCount++;
      continue;
    }
    const displayName = anim.name ?? anim.description ?? query;
    const slot = slotFor(displayName);
    console.log(`  found: "${displayName}" (id=${anim.id}) → slot "${slot}"`);

    const gmsHash = await getGmsHash(anim.id);
    console.log(`  got gms_hash, submitting export with skin=true...`);

    await submitExport(gmsHash, displayName);
    const downloadUrl = await pollMonitor();
    console.log(`  download ready: …${downloadUrl.slice(-50)}`);

    const dest = resolve(OUT_DIR, `${slug}-${slot}.fbx`);
    await downloadFbx(downloadUrl, dest);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  ✓ saved ${dest} (${dt}s)`);
    okCount++;

    // Polite pause between calls so we never trip rate-limiting.
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    failCount++;
  }
}

console.log(`\n=== Mixamo fetch: ${okCount} ok, ${failCount} failed ===`);
if (failCount > 0 && okCount === 0) {
  console.error("All fetches failed — skipping finalize.");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Finalize: Blender batch convert FBX → mesh-free GLB
// ──────────────────────────────────────────────────────────────────────────
if (!SHOULD_FINALIZE) {
  console.log("\n--no-finalize set, stopping here.");
  console.log(`FBXs are in: ${OUT_DIR}`);
  process.exit(0);
}

// Candidate Blender executables, in order of preference. The desktop MSI
// installer (preferred) lives in Program Files; the Microsoft Store package
// is access-denied for non-admin processes, so we don't even try it.
function findBlender(): string | null {
  // 1) `BLENDER_EXE` env override — explicit win
  if (process.env.BLENDER_EXE && existsSync(process.env.BLENDER_EXE)) {
    return process.env.BLENDER_EXE;
  }
  // 2) Look for `blender` on PATH (Linux/macOS or Windows MSI install).
  const which = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(which, ["blender"], { encoding: "utf-8" });
  if (r.status === 0 && r.stdout.trim()) {
    return r.stdout.trim().split(/\r?\n/)[0]!;
  }
  // 3) Common Windows MSI install locations — covers 4.2 (first ext-marketplace
  //    version) through current 5.x. Update list if you upgrade past 5.2.
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
      "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

console.log("\n=== Finalize: Blender FBX → GLB ===");
const blender = findBlender();
// URL path '/avatars/animations/<x>' → filesystem 'apps/web/public/avatars/animations/<x>'
const GLB_OUT_DIR = resolve(process.cwd(), `apps/web/public${ANIMATIONS_URL_PATH}`);
const PY_SCRIPT = resolve(process.cwd(), "scripts/mixamo/blender-convert-anims.py");

if (!blender) {
  console.log(
    "\n⚠  No callable Blender found. Skipping FBX → GLB batch convert.\n",
  );
  console.log("To complete the pipeline, run ONE of:\n");
  console.log("  A) Install Blender desktop MSI (https://www.blender.org/download/),");
  console.log("     then re-run this command.\n");
  console.log("  B) Run manually in your existing Blender instance:");
  console.log(`     blender --background --python ${PY_SCRIPT} -- ${OUT_DIR} ${GLB_OUT_DIR}`);
  console.log("");
  console.log("  C) Set BLENDER_EXE=<absolute path to blender.exe> in your env and re-run.");
  process.exit(0);
}

console.log(`Using Blender: ${blender}`);
console.log(`Source FBX dir: ${OUT_DIR}`);
console.log(`Target GLB dir: ${GLB_OUT_DIR}`);
mkdirSync(GLB_OUT_DIR, { recursive: true });

const t0 = Date.now();
const bRes = spawnSync(
  blender,
  ["--background", "--python", PY_SCRIPT, "--", OUT_DIR, GLB_OUT_DIR],
  { stdio: "inherit", encoding: "utf-8" },
);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

if (bRes.status !== 0) {
  console.error(`\n✗ Blender exited ${bRes.status} after ${dt}s`);
  process.exit(1);
}

console.log(`\n=== Finalize done in ${dt}s. ===`);
console.log(`GLBs ready at: ${GLB_OUT_DIR}`);
console.log("\nNext: add the new GLB paths to CHARACTER_ANIM_OVERRIDES in");
console.log("  apps/web/src/lib/three/vrm-character-animator.ts");
console.log("(automated patcher coming in add-anim-everywhere.ts)");
