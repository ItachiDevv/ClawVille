#!/usr/bin/env bun
/**
 * Mixamo auth helper — exports `loadMixamoAuth()` and runnable as a
 * validation entry point.
 *
 * Usage:
 *   bun scripts/mixamo/auth.ts           # ping Mixamo with current token
 *   import { loadMixamoAuth } from './auth';   # in other scripts
 */

import { readFileSync, existsSync } from "node:fs";
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

export interface MixamoAuth {
  bearer: string;
  apiKey: string;
}

export function loadMixamoAuth(): MixamoAuth {
  const envLocal = loadEnv(resolve(process.cwd(), ".env.local"));
  const itachiKeys = loadEnv(
    `${process.env.HOME || process.env.USERPROFILE}/.itachi-api-keys`,
  );
  // .env.local wins over process.env (already-shadowed OS env) and over
  // ~/.itachi-api-keys — matches the precedence used by other scripts.
  const bearer =
    envLocal.MIXAMO_BEARER_TOKEN ||
    itachiKeys.MIXAMO_BEARER_TOKEN ||
    process.env.MIXAMO_BEARER_TOKEN;
  if (!bearer) {
    console.error(
      "MIXAMO_BEARER_TOKEN missing. See scripts/mixamo/README.md — paste " +
        "your Mixamo session token from localStorage.access_token into .env.local.",
    );
    process.exit(1);
  }
  return { bearer, apiKey: "mixamo2" };
}

/** Default headers used by every Mixamo API call. */
export function mxHeaders(auth: MixamoAuth, extra: Record<string, string> = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.bearer}`,
    "X-Api-Key": auth.apiKey,
    ...extra,
  };
}

/** Mixamo monitor + export endpoints share the same base. */
export const MIXAMO_BASE = "https://www.mixamo.com/api/v1";

// ---------------------------------------------------------------------------
// Run as a CLI: ping the products endpoint with limit=1 to confirm auth works.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const auth = loadMixamoAuth();
  console.log("Pinging Mixamo with current bearer token...");
  const url = `${MIXAMO_BASE}/products?page=1&limit=1&type=Motion`;
  const res = await fetch(url, { headers: mxHeaders(auth) });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    if (res.status === 401) {
      console.error(
        "\n→ Token expired. Re-grab from mixamo.com → DevTools → " +
          "Console: copy(localStorage.access_token), then update .env.local.",
      );
    }
    process.exit(1);
  }
  const json = (await res.json()) as {
    pagination?: { num_results?: number };
    results?: unknown[];
  };
  const total = json.pagination?.num_results ?? json.results?.length ?? 0;
  console.log(`OK — token valid, ${total} motions reachable.`);
}
