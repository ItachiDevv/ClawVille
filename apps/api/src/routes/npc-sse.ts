import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { npcSimulation } from '../services/npc-simulation';
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

    // Set up listener for subsequent snapshots — receives pre-serialized
    // JSON (B6 punch list); broadcast loop stringifies once and shares
    // the buffer across all consumers.
    const listener = async (snapshotJson: string) => {
      try {
        await stream.writeSSE({
          data: snapshotJson,
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
  // Deliberately does NOT arm the ambient-banter watcher gate: this endpoint
  // is public, so any crawler/monitor hitting it once a minute could force
  // continuous paid inference (Codex round, 2026-07-13). Watching is signaled
  // ONLY by the visibility heartbeat below.
  return c.json(npcSimulation.getSnapshot());
});

/**
 * POST /api/npc/watch — visibility heartbeat for the ambient-banter watcher
 * gate. The web client (`use-world-stream.ts`) sends it every ~30s ONLY while
 * `document.visibilityState === 'visible'`; it arms the sim's inference latch
 * for ~90s. Design notes (Codex adversarial round, 2026-07-13):
 * - No auth BY DESIGN: anonymous explore-mode visitors are real watchers (the
 *   acquisition funnel) and must see live banter. Spoofing this endpoint
 *   cannot burn unbounded money — the hourly LLM banter budget in
 *   npc-simulation bounds worst-case spend regardless of the latch.
 * - Agent sessions are NOT watchers: a caller presenting an agent-session
 *   header gets a 204 but does not arm the latch (banter is user
 *   entertainment; agents read world state via server-side perception).
 * - SSE connections do NOT arm the latch (hidden tabs hold streams open).
 */
npcRoutes.post('/watch', (c) => {
  if (!c.req.header('X-Clawville-Agent-Session')) {
    npcSimulation.noteWorldWatched();
  }
  return c.body(null, 204);
});
