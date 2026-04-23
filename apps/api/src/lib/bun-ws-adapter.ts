/**
 * Bun-native WebSocket helper — singleton shared between the route that
 * upgrades connections (activities.ts) and `index.ts` which passes the
 * `websocket` handler to Bun.serve's export default.
 *
 * Hono's `createBunWebSocket` returns two halves:
 *   - `upgradeWebSocket(events)` — middleware factory attached to the
 *     WS route. It calls `server.upgrade(c.req.raw, { data })` to hand
 *     the connection over to Bun.
 *   - `websocket` — the listener object Bun.serve wires into its
 *     websocket lifecycle. Must be exported from the Bun.serve object.
 *
 * These two halves MUST come from the same `createBunWebSocket()` call,
 * otherwise Bun won't route the upgraded socket to our handlers. This
 * module is that single call, so both sides see the same pair.
 */

import { createBunWebSocket } from 'hono/bun';

type BunWsBundle = ReturnType<typeof createBunWebSocket>;

let cached: BunWsBundle | null = null;

export function getBunWebSocketHelper(): BunWsBundle {
  if (!cached) cached = createBunWebSocket();
  return cached;
}
