/**
 * Covenant partner — READ-ONLY verification-surface auth gate.
 *
 * Fronts the `/api/partner/covenant/*` read routes (see
 * `apps/api/src/routes/partner-covenant.ts`). Covenant is a machine
 * VERIFICATION partner: it polls the bounty board + agent-services identity
 * bundle to verify bounty work and (later) co-sign on-chain SAP escrow settles.
 * There is NO user here and NO economy write — this gate protects a read-only
 * disclosure surface, so it is deliberately strict + fail-closed.
 *
 * TWO LAYERS, BOTH REQUIRED (fail closed):
 *   1. ed25519 partner signature (PRIMARY auth) — consumes the EXISTING
 *      multi-partner verifier `verifyPartnerGetSignature('covenant', …)` in
 *      `services/partner-signature.ts` (NOT modified here). The wire format is
 *      byte-identical to the Hatcher GET scheme so the integration doc can say
 *      "same scheme as our other partners": the partner signs the canonical
 *      challenge `clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>` (ed25519
 *      over its sha256) and presents:
 *        - `X-Covenant-Issuer-Pubkey`  (base58 ed25519 pubkey; must equal
 *                                        `PARTNER_PUBKEYS.covenant`)
 *        - `X-Covenant-Signature`      (base58 ed25519 signature)
 *        - `X-Covenant-Timestamp`      (unix ms; ±5 min window)
 *      `PATH` is Hono's `c.req.path` — the leading-slash path WITHOUT the query
 *      string — so the partner signs the path only, never `?limit=…`.
 *   2. IP allowlist (DEFENSE-IN-DEPTH) — env `COVENANT_ALLOWED_IPS`
 *      (comma-separated exact IPs; ops sets `62.242.144.246`). The client IP is
 *      taken from the SAME Cloudflare-aware extraction the rate limiters use
 *      (`getClientIp`: `cf-connecting-ip` first, then the trusted-proxy XFF
 *      tail) — the raw socket IP is WRONG behind Cloudflare.
 *
 * FAIL-CLOSED CONFIG GATE: if `PARTNER_PUBKEYS.covenant` is absent OR
 * `COVENANT_ALLOWED_IPS` is empty, every route returns 503
 * `{ error:'partner_not_configured' }` with no detail — the surface stays dark
 * until ops provisions BOTH. We NEVER echo the presented pubkey/signature back.
 *
 * NOTE: the staging-only `ALLOW_TEST_PARTNER_PUBKEY` test signer is HATCHER-ONLY
 * (see partner-signature.ts) and is deliberately NOT extended to `covenant`.
 */

import type { MiddlewareHandler } from 'hono';
import { createRateLimiter, getClientIp } from './rate-limit';
import { loadPartnerPubkeys, verifyPartnerGetSignature } from '../services/partner-signature';

/** The partner id this gate authorizes — keys `PARTNER_PUBKEYS.covenant`. */
export const COVENANT_PARTNER_ID = 'covenant';

/** Signed-request headers (mirror the Hatcher GET scheme, `Covenant` prefix). */
export const COVENANT_PUBKEY_HEADER = 'X-Covenant-Issuer-Pubkey';
export const COVENANT_SIGNATURE_HEADER = 'X-Covenant-Signature';
export const COVENANT_TIMESTAMP_HEADER = 'X-Covenant-Timestamp';

/**
 * Parse `COVENANT_ALLOWED_IPS` (comma-separated exact IPs) into a trimmed,
 * empty-dropped list. Whitespace-tolerant (`" a , b ,, c "` → `[a,b,c]`).
 * Missing/blank env → empty list (which the config gate treats as
 * "not configured" → 503). Pure + env-free so it is unit-testable.
 */
export function parseCovenantAllowedIps(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Exact-match membership. `ip` is already the CF-authoritative client IP. */
export function isCovenantIpAllowed(ip: string, allowed: string[]): boolean {
  return allowed.includes(ip);
}

/**
 * Snapshot the covenant config from env at CALL time (never module load), so
 * ops can provision it without a restart and tests can flip it per case:
 *   - `pubkeyConfigured` — `PARTNER_PUBKEYS.covenant` is present.
 *   - `allowedIps`       — parsed `COVENANT_ALLOWED_IPS`.
 */
export function covenantConfigStatus(): {
  pubkeyConfigured: boolean;
  allowedIps: string[];
} {
  const allowlist = loadPartnerPubkeys();
  const pubkeyConfigured = !!(allowlist && allowlist[COVENANT_PARTNER_ID]);
  const allowedIps = parseCovenantAllowedIps(process.env.COVENANT_ALLOWED_IPS);
  return { pubkeyConfigured, allowedIps };
}

/** True only when BOTH the partner pubkey AND at least one allowed IP are set. */
export function isCovenantConfigured(): boolean {
  const { pubkeyConfigured, allowedIps } = covenantConfigStatus();
  return pubkeyConfigured && allowedIps.length > 0;
}

// Per-IP read limiter — bounds work from any single source before the config
// read + ed25519 verify. Mirrors the Hatcher stats read limiter (60/min). The
// IP allowlist is the primary abuse bound (only Covenant's IP is admitted); this
// is belt-and-suspenders. Module-scoped isolated bucket (see rate-limit.ts).
const covenantReadLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

/**
 * The gate. Order: rate-limit → config (503) → IP allowlist (403) → ed25519
 * signature (401). All rejection bodies are generic; the presented
 * pubkey/signature is never echoed. On success calls `next()` — the handlers
 * are pure reads and need nothing set on the context.
 */
export const requireCovenantPartner: MiddlewareHandler = async (c, next) => {
  const ip = getClientIp({ get: (n) => c.req.header(n) ?? null });

  // Bound total work from a single IP (incl. the crypto verify below).
  if (!covenantReadLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Fail closed when the surface isn't provisioned (BOTH the partner pubkey and
  // the IP allowlist must be set). No detail — do not leak which half is missing.
  const { pubkeyConfigured, allowedIps } = covenantConfigStatus();
  if (!pubkeyConfigured || allowedIps.length === 0) {
    return c.json({ error: 'partner_not_configured' }, 503);
  }

  // Defense-in-depth IP allowlist. CF-authoritative IP (never the raw socket).
  if (!isCovenantIpAllowed(ip, allowedIps)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Primary auth — ed25519 partner signature over the canonical GET challenge.
  const verify = verifyPartnerGetSignature(COVENANT_PARTNER_ID, {
    method: c.req.method,
    path: c.req.path,
    tsHeader: c.req.header(COVENANT_TIMESTAMP_HEADER) ?? null,
    pubkeyHeader: c.req.header(COVENANT_PUBKEY_HEADER) ?? null,
    sigHeader: c.req.header(COVENANT_SIGNATURE_HEADER) ?? null,
  });
  if (!verify.ok) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  await next();
};
