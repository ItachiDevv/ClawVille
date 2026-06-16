#!/usr/bin/env bun
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Read .env.local explicitly with HIGHER priority than OS env vars.
// Bun's default behavior is OS env > .env.local, which means an outdated key
// in PowerShell $PROFILE / Windows User env shadows the file. Force the file.
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
const envLocal = loadEnvLocal();
const apiKey = envLocal.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY missing. Set in .env.local.");
  process.exit(1);
}

const [refPath, promptPath, outPath, modelArg, sizeArg] = process.argv.slice(2);
if (!refPath || !promptPath || !outPath) {
  console.error("Usage: bun scripts/hermes-pipeline/openai-turnaround.ts <ref.png> <prompt.txt> <out.png> [model] [size]");
  console.error("       default model = gpt-image-1, default size = auto (1024x1024 | 1536x1024 | 1024x1536 | auto)");
  process.exit(1);
}

const model = modelArg || "gpt-image-1";
const size = sizeArg || "auto";
const refImage = readFileSync(resolve(refPath));
const prompt = readFileSync(resolve(promptPath), "utf-8");

// OpenAI gpt-image-1 image EDIT: reference image + prompt -> new image (identity-
// preserving turnaround). Multipart form; gpt-image-1 always returns b64_json
// (no `url` option). Ported to OpenAI in the 2026-06-16 image-backend scrub.
const form = new FormData();
form.set("model", model);
form.set("prompt", prompt);
form.set("size", size);
form.set("image", new Blob([refImage], { type: "image/png" }), "ref.png");

const url = "https://api.openai.com/v1/images/edits";
console.log(`POST ${model} (ref=${refPath}, prompt=${promptPath}, size=${size})`);

const t0 = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form,
});

if (!res.ok) {
  const errText = await res.text();
  console.error(`HTTP ${res.status}:\n${errText}`);
  process.exit(1);
}

const json = (await res.json()) as any;
const imageB64: string | null = json?.data?.[0]?.b64_json ?? null;

if (!imageB64) {
  console.error("No image in response. Full payload:");
  console.error(JSON.stringify(json, null, 2).slice(0, 4000));
  process.exit(1);
}

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), Buffer.from(imageB64, "base64"));
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Saved ${outPath} in ${dt}s`);
