import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../types';
import type { ResearchThoughtEvent } from '@legacyapp/shared';

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

    // Keep stream alive until client disconnects
    while (true) {
      await stream.sleep(30000);
    }
  });
});
