#!/usr/bin/env bun
/**
 * One-shot setup for the MSI Blender install: replicates the addon set from
 * the existing Microsoft Store Blender + grabs any extra tools the project
 * benefits from.
 *
 * What it installs:
 *   1. VRM Addon for Blender (Saturday06) — latest release from GitHub
 *   2. blender-mcp — copied verbatim from the MS Store Blender's
 *      scripts/addons/addon.py (the version we've been talking to on port 9876)
 *   3. Tuxedo Blender Plugin — modern Cats fork; mesh weld + bone tools.
 *      Optional, gate with --no-tuxedo to skip.
 *
 * Idempotent — re-run any time after upgrading Blender or to pick up newer
 * addon versions.
 *
 * Usage:
 *   bun scripts/setup-blender.ts                 # install all 3
 *   bun scripts/setup-blender.ts --no-tuxedo     # VRM + blender-mcp only
 */

import { writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const SKIP_TUXEDO = flags.has("--no-tuxedo");

// ─── Locate the MSI Blender ──────────────────────────────────────────────
function findMSIBlender(): string | null {
  if (process.env.BLENDER_EXE && existsSync(process.env.BLENDER_EXE))
    return process.env.BLENDER_EXE;
  const candidates = [
    "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.4\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.3\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
    "C:\\Program Files\\Blender Foundation\\Blender\\blender.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const blender = findMSIBlender();
if (!blender) {
  console.error(
    "No MSI Blender found at C:\\Program Files\\Blender Foundation\\Blender*\\blender.exe",
  );
  console.error("Install from https://www.blender.org/download/ then re-run.");
  process.exit(1);
}
console.log(`Blender: ${blender}`);

// ─── Asset prep ──────────────────────────────────────────────────────────
const STAGE = join(tmpdir(), `clawville-blender-setup-${Date.now()}`);
mkdirSync(STAGE, { recursive: true });
console.log(`Staging dir: ${STAGE}`);

const installArgs: string[] = [];

// ─── 1) VRM addon (latest release) ───────────────────────────────────────
console.log("\n--- (1/3) VRM Addon for Blender ---");
try {
  // Fetch latest release metadata
  const relRes = await fetch(
    "https://api.github.com/repos/saturday06/VRM_Addon_for_Blender/releases/latest",
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "clawville-setup" } },
  );
  if (!relRes.ok)
    throw new Error(`GitHub API HTTP ${relRes.status}: ${await relRes.text()}`);
  const rel = (await relRes.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  console.log(`  latest tag: ${rel.tag_name}`);
  // The release ships multiple zips: an "extension" zip for Blender 4.2+ and a
  // legacy "addon" zip for older Blender. The extension one is name-stable
  // around "VRM_Addon_for_Blender-extension-VERSION.zip" — prefer it.
  const asset =
    rel.assets.find((a) => /extension.*\.zip$/i.test(a.name)) ??
    rel.assets.find((a) => a.name.endsWith(".zip"));
  if (!asset) throw new Error("no .zip asset in latest release");
  console.log(`  asset: ${asset.name}`);
  const zipDest = join(STAGE, asset.name);
  const dl = await fetch(asset.browser_download_url);
  if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
  writeFileSync(zipDest, Buffer.from(await dl.arrayBuffer()));
  console.log(`  saved → ${zipDest}`);
  installArgs.push(zipDest);
} catch (err) {
  console.error(
    `  ✗ VRM addon fetch failed: ${err instanceof Error ? err.message : err}`,
  );
}

// ─── 2) blender-mcp (copy from MS Store) ─────────────────────────────────
console.log("\n--- (2/3) blender-mcp ---");
const MCP_SOURCE =
  "C:\\Users\\newma\\AppData\\Local\\Packages\\BlenderFoundation.Blender_ppwjx1n5r4v9t\\LocalCache\\Roaming\\Blender Foundation\\Blender\\5.1\\scripts\\addons\\addon.py";
if (existsSync(MCP_SOURCE)) {
  const mcpDest = join(STAGE, "blender-mcp.py");
  copyFileSync(MCP_SOURCE, mcpDest);
  console.log(`  copied MS Store addon.py → ${mcpDest}`);
  installArgs.push(mcpDest);
} else {
  console.error(`  ✗ MS Store addon.py not found at: ${MCP_SOURCE}`);
  console.error(
    "    (this is OK if you've never installed blender-mcp; skipping).",
  );
}

// ─── 3) Tuxedo (modern Cats fork) ────────────────────────────────────────
if (SKIP_TUXEDO) {
  console.log("\n--- (3/3) Tuxedo — skipped (--no-tuxedo) ---");
} else {
  console.log("\n--- (3/3) Tuxedo Blender Plugin ---");
  try {
    // Tuxedo doesn't always publish formal GitHub releases — use the master
    // branch zipball instead, which is always current.
    const tuxUrl =
      "https://github.com/feilen/tuxedo-blender-plugin/archive/refs/heads/master.zip";
    const tuxDest = join(STAGE, "tuxedo-blender-plugin.zip");
    console.log(`  downloading master.zip...`);
    const dl = await fetch(tuxUrl);
    if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
    writeFileSync(tuxDest, Buffer.from(await dl.arrayBuffer()));
    console.log(`  saved → ${tuxDest}`);
    installArgs.push(tuxDest);
  } catch (err) {
    console.error(
      `  ✗ Tuxedo fetch failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ─── Run Blender with the installer script ───────────────────────────────
if (installArgs.length === 0) {
  console.error("\nNothing to install.");
  process.exit(1);
}

const PY = resolve(process.cwd(), "scripts/setup-blender-addons.py");
console.log(
  `\n=== invoking Blender headless with ${installArgs.length} payloads ===`,
);
const t0 = Date.now();
const res = spawnSync(
  blender,
  ["--background", "--python", PY, "--", ...installArgs],
  { stdio: "inherit", encoding: "utf-8" },
);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

if (res.status !== 0) {
  console.error(`\n✗ Blender exited ${res.status} after ${dt}s`);
  process.exit(1);
}
console.log(`\n✓ Setup complete in ${dt}s.`);
