#!/usr/bin/env bun
// Submit a 3-view turnaround to fal.ai Meshy-6 multi-image-to-3d, poll until done,
// download the resulting .glb. Quad topology + texture for rigging-friendly output.
//
// Usage: bun scripts/hermes-pipeline/meshy-i2m.ts <male|female>

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
const env = {
  ...loadEnv(`${process.env.HOME || process.env.USERPROFILE}/.itachi-api-keys`),
  ...loadEnv(resolve(process.cwd(), ".env.local")),
};
const FAL_KEY = env.FAL_KEY || process.env.FAL_KEY;
if (!FAL_KEY) { console.error("FAL_KEY missing."); process.exit(1); }

const character = process.argv[2];
if (!character || !["male", "female"].includes(character)) {
  console.error("Usage: bun scripts/hermes-pipeline/meshy-i2m.ts <male|female>");
  process.exit(1);
}

const turnaroundDir = "apps/web/public/models/hermes-turnaround";
const outDir = "apps/web/public/models/hermes-mesh";
mkdirSync(outDir, { recursive: true });
const outPath = resolve(`${outDir}/${character}-meshy-hq.glb`);

async function uploadImage(localPath: string): Promise<string> {
  const fileName = localPath.split(/[\\/]/).pop()!;
  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, content_type: "image/png" }),
  });
  if (!initRes.ok) throw new Error(`upload initiate ${initRes.status}: ${await initRes.text()}`);
  const { upload_url, file_url } = await initRes.json() as { upload_url: string; file_url: string };
  const bytes = readFileSync(resolve(localPath));
  const putRes = await fetch(upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": "image/png" } });
  if (!putRes.ok) throw new Error(`upload PUT ${putRes.status}: ${await putRes.text()}`);
  return file_url;
}

async function main() {
  const t0 = Date.now();
  console.log(`=== ${character} I2M via Meshy-6 multi-image-to-3d ===`);

  console.log("Uploading 3 views to fal storage...");
  const [frontUrl, sideUrl, backUrl] = await Promise.all([
    uploadImage(`${turnaroundDir}/${character}-front.png`),
    uploadImage(`${turnaroundDir}/${character}-side.png`),
    uploadImage(`${turnaroundDir}/${character}-back.png`),
  ]);
  console.log(`  front: …${frontUrl.slice(-50)}`);
  console.log(`  side:  …${sideUrl.slice(-50)}`);
  console.log(`  back:  …${backUrl.slice(-50)}`);

  const submitBody = {
    image_urls: [frontUrl, sideUrl, backUrl],
    topology: "quad",
    target_polycount: 60000,                  // 2x more topology, less marching-cube fragmentation
    texture_image_resolution: 4096,            // 4x texture, more UV padding -> less bleed
    should_texture: true,
    should_remesh: true,                       // Meshy's retopo pass (cleaner UVs)
    enable_pbr: true,                          // PBR materials
    symmetry_mode: "auto",
    enable_safety_checker: false,
  };

  console.log("Submitting to fal-ai/meshy/v6/multi-image-to-3d...");
  const submitRes = await fetch("https://queue.fal.run/fal-ai/meshy/v6/multi-image-to-3d", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(submitBody),
  });
  if (!submitRes.ok) {
    console.error(`Submit failed: HTTP ${submitRes.status}\n${await submitRes.text()}`);
    process.exit(1);
  }
  const submit = await submitRes.json() as { request_id: string; status_url: string; response_url: string };
  console.log(`  request_id: ${submit.request_id}`);

  let lastLog = 0;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sRes = await fetch(submit.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const s = await sRes.json() as { status: string };
    if (Date.now() - lastLog > 10000) {
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] status=${s.status}`);
      lastLog = Date.now();
    }
    if (s.status === "COMPLETED") break;
    if (["FAILED", "ERROR"].includes(s.status)) {
      console.error(`Job failed: ${JSON.stringify(s)}`);
      process.exit(1);
    }
  }

  const resultRes = await fetch(submit.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const result = await resultRes.json() as {
    model_glb?: { url: string };
    model_urls?: { glb?: string; fbx?: string };
    thumbnail?: { url: string };
  };
  const modelUrl = result.model_glb?.url || result.model_urls?.glb;
  if (!modelUrl) {
    console.error(`No GLB URL in result:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);
    process.exit(1);
  }

  console.log(`Downloading GLB from …${modelUrl.slice(-50)}...`);
  const glbRes = await fetch(modelUrl);
  if (!glbRes.ok) throw new Error(`GLB download failed: ${glbRes.status}`);
  const glbBytes = await glbRes.arrayBuffer();
  writeFileSync(outPath, Buffer.from(glbBytes));
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMB = (glbBytes.byteLength / 1024 / 1024).toFixed(2);
  console.log(`Saved ${outPath} (${sizeMB} MB) in ${dt}s`);
  if (result.thumbnail?.url) console.log(`Thumbnail: ${result.thumbnail.url}`);
}

await main();
