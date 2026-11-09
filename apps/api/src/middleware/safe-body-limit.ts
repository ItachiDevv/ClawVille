/**
 * A body size limit that works after `jsonBodyGuard`.
 *
 * `jsonBodyGuard` (mounted app-wide) reads and caches every non-empty JSON
 * body. Hono's `bodyLimit` checks `Content-Length` when the header is present;
 * without it, it calls `getReader()` on the request stream, which the guard has
 * already read, and the request fails with 500 `ReadableStream is locked`. The
 * MCP `clawville_call` sub-request (and any chunked client) sends no
 * `Content-Length`, so every agent POST to such a route failed (found
 * 2026-11-09: agent Studios image calls through MCP answered 500).
 *
 * This wrapper measures the cached body text when one exists and otherwise
 * defers to Hono's `bodyLimit` unchanged.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export interface SafeBodyLimitOptions {
  maxSize: number;
  onError: (c: Context) => Response | Promise<Response>;
}

export function safeBodyLimit(options: SafeBodyLimitOptions): MiddlewareHandler {
  const inner = bodyLimit(options);
  return async (c, next) => {
    const cached = (c.req.bodyCache as { text?: Promise<string> }).text;
    if (cached) {
      // The guard already read the whole body: measure it, and never trust a
      // smaller Content-Length. Decoding drops a UTF-8 BOM and the original
      // bytes are gone, so 3 bytes are always counted for a possible BOM (a body
      // within 3 bytes of the limit is refused; these routes take small JSON).
      const UTF8_BOM_BYTES = 3;
      const measured = new TextEncoder().encode(await cached).byteLength + UTF8_BOM_BYTES;
      const declared = Number.parseInt(c.req.raw.headers.get('content-length') ?? '', 10);
      const size = Number.isFinite(declared) ? Math.max(measured, declared) : measured;
      return size > options.maxSize ? options.onError(c) : next();
    }
    return inner(c, next);
  };
}
