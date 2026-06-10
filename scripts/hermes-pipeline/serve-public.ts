#!/usr/bin/env bun
// Tiny static file server for QC pages (e.g. the VRM viewer). Serves a dir,
// defaults `/` to vrm-viewer.html. WebGL-only pages — Iris-Xe-safe.
//   bun scripts/hermes-pipeline/serve-public.ts [root=apps/web/public] [port=8123]
import { join, normalize, sep } from "node:path";
import { existsSync, statSync } from "node:fs";

const ROOT = normalize(process.argv[2] || "apps/web/public");
const PORT = Number(process.argv[3] || 8123);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".vrm": "model/gltf-binary",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/vrm-viewer.html";
    const filePath = normalize(join(ROOT, p));
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      return new Response("403 forbidden", { status: 403 });
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      return new Response("404 not found: " + p, { status: 404 });
    }
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return new Response(Bun.file(filePath), {
      headers: {
        "Content-Type": TYPES[ext] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
      },
    });
  },
});
console.log(`Serving ${ROOT} at http://localhost:${PORT}/  (→ vrm-viewer.html)`);
