/**
 * Studios free menus (MCP hub phase 3b): media models, image styles, the
 * character builder, character presets and recast presets. Studios serves
 * them without a key and limits them per IP, so ClawVille fetches each one at
 * most once per 10 minutes (one shared in-memory cache, one request in flight
 * per menu) and never sends a key. Only our own view leaves here
 * (`mapStudiosMenu`: ids, kinds, prices, option values; no vendor text).
 */

import { readJsonCapped } from './outbound-x402';
import { STUDIOS_API_BASE } from './vendors/studios';
import { STUDIOS_MENU_PATHS, mapStudiosMenu, type StudiosMenuId } from './vendors/studios-operations';

export const MENU_CACHE_MS = 10 * 60_000;
const MENU_TIMEOUT_MS = 15_000;
const MENU_MAX_BYTES = 2 * 1024 * 1024;

type Entry = { expiresAt: number; data: Record<string, unknown> };
const cache = new Map<StudiosMenuId, Entry>();
const inFlight = new Map<StudiosMenuId, Promise<Record<string, unknown> | null>>();

/** Test seam: the fetch used for the menus. */
export const menuDeps = { fetch: (url: string, init: RequestInit) => fetch(url, init), now: () => Date.now() };

/** Test-only: forget every cached menu. */
export function resetStudiosMenuCache(): void {
  cache.clear();
  inFlight.clear();
}

async function fetchMenu(menu: StudiosMenuId): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await menuDeps.fetch(`${STUDIOS_API_BASE}${STUDIOS_MENU_PATHS[menu]}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(MENU_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const json = await readJsonCapped(res, MENU_MAX_BYTES).catch(() => null);
  return json ? mapStudiosMenu(menu, json) : null;
}

/** One menu, from the cache when it is younger than 10 minutes. Null when Studios did not answer. */
export async function readStudiosMenu(menu: StudiosMenuId): Promise<Record<string, unknown> | null> {
  const hit = cache.get(menu);
  if (hit && hit.expiresAt > menuDeps.now()) return hit.data;
  const pending = inFlight.get(menu);
  if (pending) return pending;
  const load = fetchMenu(menu).then((data) => {
    if (data) cache.set(menu, { expiresAt: menuDeps.now() + MENU_CACHE_MS, data });
    return data;
  }).finally(() => inFlight.delete(menu));
  inFlight.set(menu, load);
  return load;
}
