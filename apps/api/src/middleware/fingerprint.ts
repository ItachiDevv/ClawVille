/**
 * Phase 1 anti-farm — server-side fingerprint hashing middleware.
 *
 * Reads `X-CV-Fingerprint` (set by apps/web/src/lib/fingerprint.ts) +
 * client IP, computes:
 *
 *   fpHash       = sha256(FINGERPRINT_SECRET || raw_fp_or_fallback)
 *   ipPrefixHash = sha256(FINGERPRINT_SECRET || ip_first_3_octets)
 *
 * Persists nothing — sets values on context for downstream consumers
 * (event-logger.logEventFromContext is the primary one).
 *
 * **Fallback chain** so the row never lands NULL going forward:
 *   1. Browser-supplied X-CV-Fingerprint (preferred)
 *   2. UA + raw IP hash (used when header missing — non-browser caller,
 *      curl, agent SDK)
 *   3. 'no-fp:<ipPrefixHash>' (used when neither UA nor IP resolvable —
 *      keeps something queryable)
 *
 * **Security properties of the hash**:
 *   - Salted with FINGERPRINT_SECRET (32+ bytes, server-only) so the value
 *     is non-portable: no third party can re-derive a user's hash from any
 *     externally-visible identifier.
 *   - Permanent (no daily rotation) — required so multi-day farms are
 *     detectable. Privacy disclosure in SKILL.md / connect modal explains
 *     this is a ClawVille-only correlation token.
 *   - Never reversible — sha256 doesn't allow reverse lookup of the
 *     underlying browser fingerprint.
 *
 * **Why /24 IP prefix**: a single residential user behind a dynamic IP
 * keeps a stable bucket while a farm running on one VPS/datacenter range
 * collapses into one prefix and gets squashed by the daily cap. Tradeoff:
 * users behind a NAT/CGNAT range can collide with each other, which is
 * fine because per-fp_hash + per-ip_prefix_hash is the cap key — same IP
 * prefix + different fingerprints still get separate budgets.
 */

import { createHash } from 'crypto';
import type { MiddlewareHandler } from 'hono';
import { getClientIp } from './rate-limit';
import type { AppContext } from '../types';

const SERVER_SECRET = process.env.FINGERPRINT_SECRET;

if (!SERVER_SECRET) {
  throw new Error(
    'FINGERPRINT_SECRET env var is required (32+ byte hex). ' +
      'Generate with: openssl rand -hex 32',
  );
}

if (SERVER_SECRET.length < 32) {
  throw new Error(
    `FINGERPRINT_SECRET must be at least 32 chars (got ${SERVER_SECRET.length}). ` +
      'Use 32-byte hex (64 chars) for full sha256 entropy match.',
  );
}

// Capture into a local const so TS narrows away the `string | undefined`
// for every closure below — avoids per-request `if (!SECRET)` checks.
const SECRET: string = SERVER_SECRET;

function sha256Salted(input: string): string {
  return createHash('sha256').update(SECRET + input).digest('hex');
}

function deriveIpPrefix(ip: string): string {
  // IPv4 — first three octets.
  const v4Match = ip.match(/^(\d+)\.(\d+)\.(\d+)\./);
  if (v4Match) return `${v4Match[1]}.${v4Match[2]}.${v4Match[3]}`;

  // IPv6 — first 48 bits (3 hextets) is the rough equivalent of /48,
  // which is the typical ISP allocation. Lossy but stable per ISP block.
  const v6Match = ip.match(/^([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):/i);
  if (v6Match) return `${v6Match[1]}:${v6Match[2]}:${v6Match[3]}`;

  // 'unknown' or malformed — bucket together so we still get a hash.
  return 'unknown-prefix';
}

export const fingerprintMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
  const rawFp = c.req.header('X-CV-Fingerprint')?.trim() ?? '';
  const ua = c.req.header('User-Agent')?.trim() ?? '';
  const ip = getClientIp(c.req.raw.headers);
  const ipPrefix = deriveIpPrefix(ip);

  // Three-tier fallback so fpHash is ALWAYS non-empty:
  //   1. Browser-set X-CV-Fingerprint
  //   2. UA + IP /24 PREFIX — non-browser callers (curl, agent SDK)
  //   3. Sentinel "no-fp:<ipPrefix>" — last resort
  //
  // Tier-2 fp-stability fix (2026-06-21 prod hotfix). Previously tier-2 keyed
  // on the RAW FULL client IP (`ua:<UA>:ip:<full ip>`), so a residential
  // guest on a dynamic IP (DHCP renew / mobile-CGNAT / VPN toggle) got a
  // DIFFERENT fpHash between writing a cove spin event and later reading
  // history under the same UA — orphaning the recorded win ("won 20 CT, no
  // history"). Keying tier-2 on the /24 `ipPrefix` keeps a single dynamic-IP
  // guest in ONE bucket across IP churn within their ISP block. This is a
  // BACKSTOP only: the browser now sends X-CV-Fingerprint on cove requests
  // (tier-1 stable), so this tier serves header-less callers. Tradeoff: it
  // slightly widens NAT/CGNAT collisions for header-less callers — acceptable
  // because cove guest play is demo-only (no real CT at stake) and the
  // anti-farm cap key is `(fp_hash, ip_prefix_hash)`, where ip_prefix_hash
  // already collapses a shared prefix, so this does not weaken farm detection.
  const fpInput =
    rawFp ||
    (ua || ip !== 'unknown' ? `ua:${ua}:ip:${ipPrefix}` : `no-fp:${ipPrefix}`);

  c.set('fpHash', sha256Salted(fpInput));
  c.set('ipPrefixHash', sha256Salted(ipPrefix));

  await next();
};
