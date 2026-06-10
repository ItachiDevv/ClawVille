#!/usr/bin/env bun
// Submit a turnaround (front/side/back, optional face close-up + right 3/4) to
// fal.ai Meshy-6 multi-image-to-3d, poll until done, download the textured GLB.
// This is the ORIGINAL hermes pipeline mesh-gen step (recreated from session
// history 2026-05-31) — quad topology + HQ texture for rigging-friendly output.
//
// Usage: bun scripts/hermes-pipeline/meshy-i2m.ts <slug>
// Reads:  apps/web/public/models/<slug>-turnaround/{front,side,back}.png (+ face.png/right.png)
// Writes: apps/web/public/models/<slug>-mesh/raw.glb
//
// FAL_KEY read from .env.local first, then ~/.itachi-api-keys, then env.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1").trim();
  }
  return out;
}
const env = { ...loadEnv(`${process.env.HOME || process.env.USERPROFILE}/.itachi-api-keys`), ...loadEnv(resolve(process.cwd(), ".env.local")) };
const FAL_KEY = env.FAL_KEY || process.env.FAL_KEY;
if (!FAL_KEY) { console.error("FAL_KEY missing."); process.exit(1); }

const slug = process.argv[2];
if (!slug) { console.error("Usage: bun scripts/hermes-pipeline/meshy-i2m.ts <slug>"); process.exit(1); }

const turnaroundDir = `apps/web/public/models/${slug}-turnaround`;
const outDir = `apps/web/public/models/${slug}-mesh`;
mkdirSync(outDir, { recursive: true });
const outPath = resolve(`${outDir}/raw.glb`);

async function uploadImage(localPath: string): Promise<string> {
  const fileName = localPath.split(/[\\/]/).pop()!;
  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, content_type: "image/png" }),
  });
  if (!initRes.ok) throw new Error(`upload initiate failed: ${initRes.status} ${await initRes.text()}`);
  const { upload_url, file_url } = (await initRes.json()) as { upload_url: string; file_url: string };
  const putRes = await fetch(upload_url, { method: "PUT", body: readFileSync(resolve(localPath)), headers: { "Content-Type": "image/png" } });
  if (!putRes.ok) throw new Error(`upload PUT failed: ${putRes.status}`);
  return file_url;
}

async function main() {
  const t0 = Date.now();
  console.log(`=== ${slug} → Meshy-6 multi-image-to-3d (HQ) ===`);

  // Up to 4 views. front/side/back required; face close-up + right 3/4 added if present.
  const views = ["front.png", "side.png", "back.png", "face.png", "right.png"]
    .filter((f) => existsSync(resolve(`${turnaroundDir}/${f}`)))
    .slice(0, 4);
  console.log(`Uploading ${views.length} views: ${views.join(", ")}`);
  const urls = await Promise.all(views.map((f) => uploadImage(`${turnaroundDir}/${f}`)));
  urls.forEach((u, i) => console.log(`  ${views[i]}: ${u.slice(-56)}`));

  const submitBody = {
    image_urls: urls,
    topology: "quad",
    target_polycount: 60000,
    texture_image_resolution: 4096,
    should_remesh: true,
    should_texture: true,
    enable_pbr: true,
    symmetry_mode: "auto",
  };

  console.log("Submitting to fal-ai/meshy/v6/multi-image-to-3d...");
  const submitRes = await fetch("https://queue.fal.run/fal-ai/meshy/v6/multi-image-to-3d", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(submitBody),
  });
  if (!submitRes.ok) { console.error(`Submit failed: HTTP ${submitRes.status}\n${await submitRes.text()}`); process.exit(1); }
  const submit = (await submitRes.json()) as { request_id: string; status_url: string; response_url: string };
  console.log(`  request_id: ${submit.request_id}`);

  let lastLog = 0;
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sRes = await fetch(submit.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const s = (await sRes.json()) as { status: string };
    if (Date.now() - lastLog > 10000) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] status=${s.status}`); lastLog = Date.now(); }
    if (s.status === "COMPLETED") break;
    if (s.status === "FAILED" || s.status === "ERROR") { console.error(`Job failed: ${JSON.stringify(s)}`); process.exit(1); }
  }

  const resultRes = await fetch(submit.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const result = (await resultRes.json()) as { model_glb?: { url: string }; model_urls?: { glb?: string } };
  const modelUrl = result.model_glb?.url || result.model_urls?.glb;
  if (!modelUrl) { console.error(`No model GLB in result:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`); process.exit(1); }

  console.log(`Downloading GLB from ${modelUrl.slice(-56)}...`);
  const glbRes = await fetch(modelUrl);
  if (!glbRes.ok) throw new Error(`GLB download failed: ${glbRes.status}`);
  const glbBytes = await glbRes.arrayBuffer();
  writeFileSync(outPath, Buffer.from(glbBytes));
  console.log(`Saved ${outPath} (${(glbBytes.byteLength / 1024 / 1024).toFixed(2)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
await main();
