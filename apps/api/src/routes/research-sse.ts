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
  // Buffering hints — proxies/CDNs honour different headers, so set both:
  //   `X-Accel-Buffering: no` is the nginx convention (also respected by
  //   Coolify/Traefik in pass-through mode and some Cloudflare PoPs).
  //   Empirically, without these hints the 30s keepalive bytes (~24 B SSE
  //   frame) get absorbed in upstream buffers and the client never sees a
  //   single byte after the initial 'connected' event — observed live
  //   2026-04-25 via 70s curl: only the initial event arrived, no keepalives.
  c.header('X-Accel-Buffering', 'no');
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    // Send an immediate "connected" event so the HTTP/2 stream actually
    // delivers initial bytes to the client. Without this, the connection
    // hangs indefinitely waiting for the first eventBus emission, which
    // some browsers (Chrome over HTTP/2) treat as a failed response —
    // resulting in `TypeError: Failed to fetch` and a CORS-style error
    // in the console even though headers are correct.
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

    // Keepalive — defends against Cloudflare HTTP/2 idle stream reset that
    // surfaces in the browser as `ERR_HTTP2_PROTOCOL_ERROR 200 (OK)`.
    //
    // Three deliberate choices vs the previous attempt that didn't work:
    //   1. **15s interval** (was 30s). User report 2026-04-25 reproduced
    //      ERR_HTTP2_PROTOCOL_ERROR live with 30s keepalive deployed.
    //      Some Cloudflare PoPs close idle streams as low as ~30s.
    //   2. **Non-empty payload + non-zero data**. A `{ data: '', event: 'keepalive' }`
    //      frame is ~24 bytes; some HTTP/2 stacks buffer micro-writes until
    //      threshold or timer. A timestamped JSON ping (~70-80 B) plus the
    //      explicit `id:` field reliably emits a flushable frame.
    //   3. **Try/catch around the whole iteration** (was only around the write).
    //      `stream.sleep` throws on abort signal — without the outer catch
    //      the loop crashes silently and the listener is never removed.
    let pingCount = 0;
    while (true) {
      try {
        await stream.sleep(15000);
        await stream.writeSSE({
          id: String(++pingCount),
          event: 'keepalive',
          data: JSON.stringify({ t: Date.now(), n: pingCount }),
        });
      } catch {
        researchEventBus.removeListener(listener);
        return;
      }
    }
  });
});
