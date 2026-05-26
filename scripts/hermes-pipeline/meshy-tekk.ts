#!/usr/bin/env bun
// Fire Meshy v6 multi-image-to-3d for Tekk with 4 input views (front+side+back+3q).
// Uses HQ settings that worked for the female.

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

const turnaroundDir = "apps/web/public/models/tekk-turnaround";
const outDir = "apps/web/public/models/hermes-mesh";
mkdirSync(outDir, { recursive: true });
const outPath = resolve(`${outDir}/tekk-meshy-hq.glb`);

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
  console.log("=== Tekk I2M via Meshy-6 multi-image-to-3d (4 views) ===");

  console.log("Uploading 4 views to fal storage...");
  const [frontUrl, sideUrl, backUrl, threeQUrl] = await Promise.all([
    uploadImage(`${turnaroundDir}/with-wings-front.png`),
    uploadImage(`${turnaroundDir}/with-wings-side.png`),
    uploadImage(`${turnaroundDir}/with-wings-back.png`),
    uploadImage(`${turnaroundDir}/with-wings-3q.png`),
  ]);
  console.log(`  front: …${frontUrl.slice(-40)}`);
  console.log(`  side:  …${sideUrl.slice(-40)}`);
  console.log(`  back:  …${backUrl.slice(-40)}`);
  console.log(`  3q:    …${threeQUrl.slice(-40)}`);

  const submitBody = {
    image_urls: [frontUrl, sideUrl, backUrl, threeQUrl],
    topology: "quad",
    target_polycount: 60000,
    texture_image_resolution: 4096,
    should_texture: true,
    should_remesh: true,
    enable_pbr: true,
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
    console.error(`No GLB URL:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);
    process.exit(1);
  }

  console.log(`Downloading GLB from …${modelUrl.slice(-40)}...`);
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
