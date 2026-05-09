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
const apiKey = envLocal.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY missing. Set in .env.local.");
  process.exit(1);
}

const [refPath, promptPath, outPath, modelArg] = process.argv.slice(2);
if (!refPath || !promptPath || !outPath) {
  console.error("Usage: bun scripts/hermes-pipeline/gemini-turnaround.ts <ref.png> <prompt.txt> <out.png> [model]");
  console.error("       default model = gemini-3-pro-image-preview");
  process.exit(1);
}

const model = modelArg || "gemini-3-pro-image-preview";
const refImage = readFileSync(resolve(refPath));
const prompt = readFileSync(resolve(promptPath), "utf-8");

const body = {
  contents: [
    {
      parts: [
        { inline_data: { mime_type: "image/png", data: refImage.toString("base64") } },
        { text: prompt },
      ],
    },
  ],
  generationConfig: { responseModalities: ["IMAGE"] },
};

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
console.log(`POST ${model} (ref=${refPath}, prompt=${promptPath})`);

const t0 = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (!res.ok) {
  const errText = await res.text();
  console.error(`HTTP ${res.status}:\n${errText}`);
  process.exit(1);
}

const json = await res.json() as any;
const parts = json?.candidates?.[0]?.content?.parts ?? [];
let imageB64: string | null = null;
let textOut = "";
for (const p of parts) {
  if (p?.inline_data?.data || p?.inlineData?.data) imageB64 = p.inline_data?.data ?? p.inlineData?.data;
  else if (p?.text) textOut += p.text;
}

if (textOut) console.log(`[model text]: ${textOut.slice(0, 300)}`);
if (!imageB64) {
  console.error("No image in response. Full payload:");
  console.error(JSON.stringify(json, null, 2).slice(0, 4000));
  process.exit(1);
}

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), Buffer.from(imageB64, "base64"));
const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`Saved ${outPath} in ${dt}s`);
