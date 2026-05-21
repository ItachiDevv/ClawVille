#!/usr/bin/env bun
// Submit a turnaround (3 views: front/side/back) to fal.ai's Hyper3D Rodin
// (`fal-ai/hyper3d/rodin`) image-to-3d model, poll until done, download GLB.
//
// Why Rodin: better mesh quality + cleaner topology than Tripo v2.5 for
// stylized / chibi characters (per user request 2026-05-21). Tripo lives in
// fal-i2m.ts and stays for the legacy Hermes path.
//
// Usage:
//   bun scripts/hermes-pipeline/fal-rodin.ts <character-slug>
//
// Reads turnarounds from:
//   apps/web/public/models/<slug>-turnaround/{front,side,back}.png
// Writes:
//   apps/web/public/models/<slug>-mesh/raw.glb
//
// FAL_KEY is read from .env.local first, then ~/.itachi-api-keys, then env.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal(): Record<string, string> {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1").trim();
  }
  return out;
}

function loadItachiKeys(): Record<string, string> {
  const path = `${process.env.HOME || process.env.USERPROFILE}/.itachi-api-keys`;
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1").trim();
  }
  return out;
}

const env = { ...loadItachiKeys(), ...loadEnvLocal() };
const FAL_KEY = env.FAL_KEY || process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("FAL_KEY missing. Add to .env.local or ~/.itachi-api-keys.");
  process.exit(1);
}

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: bun scripts/hermes-pipeline/fal-rodin.ts <character-slug>");
  console.error("Example: bun scripts/hermes-pipeline/fal-rodin.ts eliza-chibi");
  process.exit(1);
}

const turnaroundDir = `apps/web/public/models/${slug}-turnaround`;
const outDir = `apps/web/public/models/${slug}-mesh`;
mkdirSync(outDir, { recursive: true });
const outPath = resolve(`${outDir}/raw.glb`);

// Sanity check inputs exist
for (const view of ["front", "side", "back"] as const) {
  const p = resolve(`${turnaroundDir}/${view}.png`);
  if (!existsSync(p)) {
    console.error(`Missing input: ${p}`);
    process.exit(1);
  }
}

async function uploadImage(localPath: string): Promise<string> {
  const fileName = localPath.split(/[\\/]/).pop()!;
  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, content_type: "image/png" }),
  });
  if (!initRes.ok) throw new Error(`upload initiate failed: ${initRes.status} ${await initRes.text()}`);
  const { upload_url, file_url } = (await initRes.json()) as { upload_url: string; file_url: string };

  const bytes = readFileSync(resolve(localPath));
  const putRes = await fetch(upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": "image/png" } });
  if (!putRes.ok) throw new Error(`upload PUT failed: ${putRes.status} ${await putRes.text()}`);
  return file_url;
}

async function main() {
  const t0 = Date.now();
  console.log(`=== ${slug} → Hyper3D Rodin (fal-ai/hyper3d/rodin) ===`);

  console.log("Uploading 3 turnaround views to fal storage...");
  const [frontUrl, sideUrl, backUrl] = await Promise.all([
    uploadImage(`${turnaroundDir}/front.png`),
    uploadImage(`${turnaroundDir}/side.png`),
    uploadImage(`${turnaroundDir}/back.png`),
  ]);
  console.log(`  front: ${frontUrl.slice(-60)}`);
  console.log(`  side:  ${sideUrl.slice(-60)}`);
  console.log(`  back:  ${backUrl.slice(-60)}`);

  // Rodin's input_image_urls accepts an array of multi-view images.
  // Per fal-ai/hyper3d/rodin schema: pass 1-4 views, prefer 3 (front/left/back)
  // for full-body characters. quality='high' is the default; geometry_file_format='glb'
  // gives us the format the rest of the pipeline expects.
  const submitBody = {
    input_image_urls: [frontUrl, sideUrl, backUrl],
    geometry_file_format: "glb",
    quality: "high",
    use_hyper: false,
    tier: "Regular",
  };

  console.log("Submitting to fal-ai/hyper3d/rodin...");
  const submitRes = await fetch("https://queue.fal.run/fal-ai/hyper3d/rodin", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(submitBody),
  });
  if (!submitRes.ok) {
    console.error(`Submit failed: HTTP ${submitRes.status}\n${await submitRes.text()}`);
    process.exit(1);
  }
  const submit = (await submitRes.json()) as {
    request_id: string;
    status_url: string;
    response_url: string;
  };
  console.log(`  request_id: ${submit.request_id}`);

  // Rodin typically completes in 60-180s; poll every 5s for up to 20min.
  let lastLog = 0;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sRes = await fetch(submit.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const s = (await sRes.json()) as { status: string; logs?: Array<{ message: string }> };
    if (Date.now() - lastLog > 10000) {
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] status=${s.status}`);
      lastLog = Date.now();
    }
    if (s.status === "COMPLETED") break;
    if (s.status === "FAILED" || s.status === "ERROR") {
      console.error(`Job failed: ${JSON.stringify(s)}`);
      process.exit(1);
    }
  }

  const resultRes = await fetch(submit.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const result = (await resultRes.json()) as {
    model_mesh?: { url: string };
    textures?: Array<{ url: string }>;
  };
  const modelUrl = result.model_mesh?.url;
  if (!modelUrl) {
    console.error(`No model_mesh URL in result:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);
    process.exit(1);
  }

  console.log(`Downloading GLB from ${modelUrl.slice(-60)}...`);
  const glbRes = await fetch(modelUrl);
  if (!glbRes.ok) throw new Error(`GLB download failed: ${glbRes.status}`);
  const glbBytes = await glbRes.arrayBuffer();
  writeFileSync(outPath, Buffer.from(glbBytes));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMB = (glbBytes.byteLength / 1024 / 1024).toFixed(2);
  console.log(`Saved ${outPath} (${sizeMB} MB) in ${dt}s`);
}

await main();
