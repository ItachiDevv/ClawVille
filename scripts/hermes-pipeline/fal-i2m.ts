#!/usr/bin/env bun
// Submit a 3-view turnaround to fal.ai Tripo v2.5 multiview-to-3d, poll until done,
// download the resulting .glb. No Blender required.
//
// Usage: bun scripts/hermes-pipeline/fal-i2m.ts <character>
//   character = male | female
//
// Reads .env.local explicitly (overrides OS-env shadows from ~/.itachi-api-keys).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

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
  console.error("FAL_KEY missing.");
  process.exit(1);
}

const character = process.argv[2];
if (!character) {
  console.error(
    "Usage: bun scripts/hermes-pipeline/fal-i2m.ts <character-slug>",
  );
  console.error("");
  console.error("Legacy slugs (Hermes pipeline):");
  console.error("  male    → apps/web/public/models/hermes-turnaround/male-{front,side,back}.png");
  console.error("  female  → apps/web/public/models/hermes-turnaround/female-{front,side,back}.png");
  console.error("");
  console.error("New slug convention (post-2026-05-21):");
  console.error("  <slug>  → apps/web/public/models/<slug>-turnaround/{front,side,back}.png");
  console.error("           → apps/web/public/models/<slug>-mesh/raw.glb");
  process.exit(1);
}

// Legacy Hermes layout used `<character>-{front,side,back}.png` files inside
// a shared `hermes-turnaround/` dir. New characters use `{front,side,back}.png`
// inside a dedicated `<slug>-turnaround/` dir. Branch on the slug.
const isLegacyHermes = character === "male" || character === "female";
const turnaroundDir = isLegacyHermes
  ? "apps/web/public/models/hermes-turnaround"
  : `apps/web/public/models/${character}-turnaround`;
const filePrefix = isLegacyHermes ? `${character}-` : "";
const outDir = isLegacyHermes
  ? "apps/web/public/models/hermes-mesh"
  : `apps/web/public/models/${character}-mesh`;
mkdirSync(outDir, { recursive: true });
const outPath = isLegacyHermes
  ? resolve(`${outDir}/${character}-raw.glb`)
  : resolve(`${outDir}/raw.glb`);

// Upload one image to fal.ai storage, return its URL.
async function uploadImage(localPath: string): Promise<string> {
  const fileName = localPath.split(/[\\/]/).pop()!;
  const initRes = await fetch("https://rest.alpha.fal.ai/storage/upload/initiate", {
    method: "POST",
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: fileName, content_type: "image/png" }),
  });
  if (!initRes.ok) throw new Error(`upload initiate failed: ${initRes.status} ${await initRes.text()}`);
  const { upload_url, file_url } = await initRes.json() as { upload_url: string; file_url: string };

  const bytes = readFileSync(resolve(localPath));
  const putRes = await fetch(upload_url, { method: "PUT", body: bytes, headers: { "Content-Type": "image/png" } });
  if (!putRes.ok) throw new Error(`upload PUT failed: ${putRes.status} ${await putRes.text()}`);
  return file_url;
}

async function main() {
  const t0 = Date.now();
  console.log(`=== ${character} I2M via Tripo v2.5 multi-view ===`);

  console.log("Uploading 3 views to fal storage...");
  const [frontUrl, sideUrl, backUrl] = await Promise.all([
    uploadImage(`${turnaroundDir}/${filePrefix}front.png`),
    uploadImage(`${turnaroundDir}/${filePrefix}side.png`),
    uploadImage(`${turnaroundDir}/${filePrefix}back.png`),
  ]);
  console.log(`  front: ${frontUrl.slice(-60)}`);
  console.log(`  side:  ${sideUrl.slice(-60)}`);
  console.log(`  back:  ${backUrl.slice(-60)}`);

  // ───────────────────────────────────────────────────────────────────────
  // QUALITY SETTINGS — fixed 2026-06-08.
  // The old hardcoded values (texture:"standard", pbr:false,
  // style:"person:person2cartoon") were tuned for the CHIBI/stylised characters
  // (eliza-chibi, milady-chibi). On REALISTIC Hatcher figures they produced
  // demented faces / mushy eyes / messed-up toes — that combo is Tripo's LOWEST
  // tier + a cartoonify pass on a realistic input. Defaults are now realistic-HD.
  //
  //   Realistic (Helen/Clytemnestra/Cronus/Phanes): HD + pbr + NO style ← default
  //   Chibi/stylised: --texture=standard --pbr=false --style=person:person2cartoon
  //
  // Tripo v2.5 params (verified from fal API schema):
  //   texture: "no"|"standard"|"HD"   pbr: bool (default true; overrides texture)
  //   style: omit for faithful realism; "person:person2cartoon" to cartoonify
  //   quad: bool (cleaner topology, +$0.05, forces FBX) — not enabled here
  const flags = Object.fromEntries(
    process.argv.slice(3).filter((a) => a.startsWith("--")).map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
  );
  const texture = flags.texture || "HD";
  const pbr = flags.pbr !== undefined ? flags.pbr === "true" : true;
  const style = flags.style && flags.style !== "none" ? flags.style : undefined;
  const submitBody: Record<string, unknown> = {
    front_image_url: frontUrl,
    left_image_url: sideUrl,
    back_image_url: backUrl,
    texture,
    pbr,
    ...(style ? { style } : {}),
  };
  console.log(`  quality: texture=${texture} pbr=${pbr} style=${style ?? "(none / realistic)"}`);

  console.log("Submitting to tripo3d/tripo/v2.5/multiview-to-3d...");
  const submitRes = await fetch("https://queue.fal.run/tripo3d/tripo/v2.5/multiview-to-3d", {
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

  // Poll
  let lastLog = 0;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sRes = await fetch(submit.status_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const s = await sRes.json() as { status: string; logs?: Array<{ message: string }> };
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

  // Get result
  const resultRes = await fetch(submit.response_url, { headers: { Authorization: `Key ${FAL_KEY}` } });
  const result = await resultRes.json() as { model_mesh?: { url: string }; pbr_model?: { url: string } };
  const modelUrl = result.model_mesh?.url || result.pbr_model?.url;
  if (!modelUrl) {
    console.error(`No model_mesh/pbr_model URL in result:\n${JSON.stringify(result, null, 2).slice(0, 2000)}`);
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
