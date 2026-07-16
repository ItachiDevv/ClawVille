import type { MiddlewareHandler } from 'hono';

const JSON_BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Raw-body signature/HMAC exemptions. These prefixes must bypass JSON parsing
 * because Hono may satisfy a later `c.req.text()` from its parsed-body cache by
 * re-serializing JSON, which is not guaranteed to preserve the signed bytes.
 *
 * - `/api/partner/`: Hatcher writes verify the exact raw body at
 *   `routes/partner-hatcher.ts:439-447`; storefront writes do the same at
 *   `routes/partner-storefront.ts:216-224`. Covenant's signed partner surface
 *   also shares this namespace (`middleware/require-covenant-partner.ts:126-132`;
 *   currently GET-only, so method-ineligible here).
 * - `/api/moonpay/webhook`: MoonPay verifies an HMAC over the exact raw body at
 *   `routes/moonpay.ts:196-198`.
 * - `/api/portal/mint-for-scape`: verifies ed25519 over the raw body at
 *   `routes/portal.ts:407-412`.
 * - `/api/portal/accept-scape-link`: verifies ed25519 over the raw body at
 *   `routes/portal.ts:499-504`.
 * - `/api/portal/mint-for-hatcher`: verifies ed25519 over the raw body at
 *   `routes/portal.ts:915-920`.
 * - `/api/portal/accept-hatcher-link`: verifies ed25519 over the raw body at
 *   `routes/portal.ts:1009-1014`.
 */
const RAW_BODY_EXEMPT_PREFIXES = [
  '/api/partner/',
  '/api/moonpay/webhook',
  '/api/portal/mint-for-scape',
  '/api/portal/accept-scape-link',
  '/api/portal/mint-for-hatcher',
  '/api/portal/accept-hatcher-link',
] as const;

/**
 * Pre-parse non-empty JSON request bodies so malformed JSON is always a clean
 * client error rather than an uncaught SyntaxError. Hono caches a successful
 * parse, so downstream `c.req.json()` calls continue to work without rereading
 * the request stream.
 */
export const jsonBodyGuard: MiddlewareHandler = async (c, next) => {
  if (!JSON_BODY_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  const contentType = c.req.header('content-type');
  if (!contentType?.toLowerCase().includes('application/json')) {
    await next();
    return;
  }

  if (RAW_BODY_EXEMPT_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
    await next();
    return;
  }

  // Preserve routes that deliberately treat a missing body as `{}`. A request
  // with no body has a null Body stream; an explicit zero length is equivalent.
  if (c.req.raw.body === null || c.req.header('content-length')?.trim() === '0') {
    await next();
    return;
  }

  try {
    await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  await next();
};
