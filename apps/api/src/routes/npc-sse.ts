import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { npcSimulation, type SimulationSnapshot } from '../services/npc-simulation';
import type { AppContext } from '../types';

export const npcRoutes = new Hono<AppContext>();

/**
 * GET /api/npc/stream — SSE stream of simulation snapshots every 2s
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

    // Keep the stream open until client disconnects
    // Use a long-running loop with sleep
    while (true) {
      await stream.sleep(30000);
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
