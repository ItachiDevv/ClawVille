import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { npcSimulation, type SimulationSnapshot } from '../services/npc-simulation';
import type { AppContext } from '../types';

export const npcRoutes = new Hono<AppContext>();

/**
 * GET /api/npc/stream — legacy SSE stream of the WHOLE-world simulation
 * snapshot. Multiplayer Phase 1 introduced per-room snapshots at
 * `/api/world/:roomId/stream` — every new client should use that path.
 * This route stays live for one release so dashboards / pre-Phase-1
 * tabs keep working; the payload is the same shape with `roomId: ''`
 * and `players: []`.
 * No auth required (spectator-friendly)
 */
npcRoutes.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    // Send initial snapshot immediately
    const initial = npcSimulation.getSnapshot();
    await stream.writeSSE({
      data: JSON.stringify(initial),
      event: 'snapshot',
    });

    // Set up listener for subsequent snapshots
    const listener = async (snapshot: SimulationSnapshot) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify(snapshot),
          event: 'snapshot',
        });
      } catch {
        // Stream closed
        npcSimulation.removeListener(listener);
      }
    };

    npcSimulation.addListener(listener);

    // Keep stream alive — clean up on disconnect
    stream.onAbort(() => {
      npcSimulation.removeListener(listener);
    });

    // Keep the stream open until client disconnects. Cloudflare resets
    // idle HTTP/2 streams at ~100s — without periodic bytes the client
    // surfaces ERR_HTTP2_PROTOCOL_ERROR (status 200, but the stream
    // frame layer dies). SSE comment lines start with `:` and are
    // explicitly ignored by EventSource — perfect keep-alive.
    while (true) {
      await stream.sleep(30000);
      try {
        await stream.writeSSE({ data: '', event: 'keepalive' });
      } catch {
        // Stream closed — listener teardown happens via stream.onAbort
        // above. Exit the loop so the handler resolves cleanly.
        npcSimulation.removeListener(listener);
        return;
      }
    }
  });
});

/**
 * GET /api/npc/state — REST snapshot fallback
 * No auth required
 */
npcRoutes.get('/state', (c) => {
  return c.json(npcSimulation.getSnapshot());
});
