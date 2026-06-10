#!/usr/bin/env bun
// Auto-rig a GLB via fal.ai Meshy rigging (mixamorig:* bones), download FBX+GLB.
// Usage: bun scripts/hermes-pipeline/meshy-rig.ts <input.glb> <out-basename> [height_meters]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(p: string): Record<string, string> {
  if (!existsSync(p)) return {};
  const o: Record<string, string> = {};
  for (const l of readFileSync(p, "utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/); if (m) o[m[1]] = m[2].replace(/^["'](.*)["']$/, "$1").trim(); }
  return o;
}
const env = { ...loadEnv(`${process.env.HOME || process.env.USERPROFILE}/.itachi-api-keys`), ...loadEnv(resolve(process.cwd(), ".env.local")) };
const FAL_KEY = env.FAL_KEY || process.env.FAL_KEY;
if (!FAL_KEY) { console.error("FAL_KEY missing."); process.exit(1); }

const [inGlb, outBase, heightArg] = process.argv.slice(2);
if (!inGlb || !outBase) { console.error("usage: meshy-rig.ts <input.glb> <out-basename> [height_meters]"); process.exit(1); }
const height = heightArg ? parseFloat(heightArg) : 1.8;

async function uploadGlb(localPath: string): Promise<string> {
  const fileName = localPath.split(/[\\/]/).pop()!;
  const init = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST", headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, content_type: "model/gltf-binary" }),
  });
  if (!init.ok) throw new Error(`upload initiate failed: ${init.status} ${await init.text()}`);
  const { upload_url, file_url } = (await init.json()) as { upload_url: string; file_url: string };
  const put = await fetch(upload_url, { method: "PUT", body: readFileSync(resolve(localPath)), headers: { "Content-Type": "model/gltf-binary" } });
  if (!put.ok) throw new Error(`upload PUT failed: ${put.status}`);
  return file_url;
}

const t0 = Date.now();
console.log(`=== Meshy rigging (height=${height}m) ===`);
const modelUrl = await uploadGlb(inGlb);
console.log(`  uploaded: ${modelUrl.slice(-56)}`);
const submitRes = await fetch("https://queue.fal.run/fal-ai/meshy/rigging", {
  method: "POST", headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model_url: modelUrl, height_meters: height, enable_animation: false }),
});
if (!submitRes.ok) { console.error(`Submit failed: HTTP ${submitRes.status}\n${await submitRes.text()}`); process.exit(1); }
const submit = (await submitRes.json()) as { request_id: string; status_url: string; response_url: string };
console.log(`  request_id: ${submit.request_id}`);
let lastLog = 0;
for (let i = 0; i < 360; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = (await (await fetch(submit.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } })).json()) as { status: string };
  if (Date.now() - lastLog > 10000) { console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] status=${s.status}`); lastLog = Date.now(); }
  if (s.status === "COMPLETED") break;
  if (s.status === "FAILED" || s.status === "ERROR") { console.error(`Job failed: ${JSON.stringify(s)}`); process.exit(1); }
}
const result = (await (await fetch(submit.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } })).json()) as any;
const fbxUrl = result.rigged_character_fbx?.url || result.rigged_character_fbx;
const glbUrl = result.rigged_character_glb?.url || result.rigged_character_glb;
if (!fbxUrl && !glbUrl) { console.error(`No rigged output:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`); process.exit(1); }
for (const [url, ext] of [[fbxUrl, "fbx"], [glbUrl, "glb"]] as const) {
  if (!url) continue;
  const bytes = await (await fetch(url)).arrayBuffer();
  const dest = resolve(`${outBase}.${ext}`);
  writeFileSync(dest, Buffer.from(bytes));
  console.log(`  saved ${dest} (${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB)`);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
