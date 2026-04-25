import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../types';
import type { ResearchThoughtEvent } from '@clawville/shared';

type ResearchListener = (event: ResearchThoughtEvent) => void;

/**
 * Global event bus for research thought events.
 * Research service emits events → SSE stream delivers to all connected clients.
 */
class ResearchEventBus {
  private listeners = new Set<ResearchListener>();

  addListener(listener: ResearchListener) {
    this.listeners.add(listener);
  }

  removeListener(listener: ResearchListener) {
    this.listeners.delete(listener);
  }

  emit(event: ResearchThoughtEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch { /* ignore listener errors */ }
    }
  }
}

export const researchEventBus = new ResearchEventBus();

export const researchSseRoutes = new Hono<AppContext>();

/**
 * GET /api/research/stream — SSE stream for research thought events.
 * No auth required (spectator-friendly).
 */
researchSseRoutes.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    // Send an immediate "connected" event so the HTTP/2 stream actually
    // delivers initial bytes to the client. Without this, the connection
    // hangs indefinitely waiting for the first eventBus emission, which
    // some browsers (Chrome over HTTP/2) treat as a failed response —
    // resulting in `TypeError: Failed to fetch` and a CORS-style error
    // in the console even though headers are correct. (User report
    // 2026-04-25: persistent /api/research/stream "blocked by CORS" /
    // 500 error despite verified-correct CORS + CORP headers.)
    await stream.writeSSE({
      data: JSON.stringify({ type: 'connected', timestamp: Date.now() }),
      event: 'connected',
    });

    const listener: ResearchListener = async (event) => {
      try {
        await stream.writeSSE({
          data: JSON.stringify(event),
          event: 'research_thought',
        });
      } catch {
        researchEventBus.removeListener(listener);
      }
    };

    researchEventBus.addListener(listener);

    stream.onAbort(() => {
      researchEventBus.removeListener(listener);
    });

    // Match npc-sse pattern exactly — sleep loop, no heartbeat writes.
    // The earlier heartbeat write triggered HTTP/2 protocol errors in
    // Chrome (ERR_HTTP2_PROTOCOL_ERROR 200 OK) when proxied through
    // Cloudflare, even though SSE bytes were technically valid. Initial
    // 'connected' event above is sufficient to establish the stream;
    // research events flowing through eventBus.emit() keep it alive.
    while (true) {
      await stream.sleep(30000);
    }
  });
});
