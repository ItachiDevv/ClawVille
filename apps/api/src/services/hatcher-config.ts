/**
 * Hatcher partner #2 (Phase A — 2026-06-01) — proxy-cognition config + SSRF
 * guard.
 *
 * ClawVille's cognition seam (`OpenClawClient.chat()` case 'hatcher-proxy')
 * POSTs to a PARTNER-SUPPLIED URL. That is a classic SSRF surface: a
 * malicious or compromised registration could point `proxy_url` at an
 * internal address (169.254.169.254 metadata, localhost, a private RFC1918
 * host, a coolify/supabase service) and turn our server into a request proxy
 * for the attacker. To prevent that we (a) require https and (b) require the
 * URL's host to be on an allowlist before ANY outbound call. This guard runs
 * BOTH at registration time (reject bad URLs before persisting) and again at
 * call time (defense-in-depth — env can change, rows can be stale).
 *
 * Allowlist source (most-specific first):
 *   - `HATCHER_PROXY_ALLOWED_HOSTS` — comma-separated exact hostnames or
 *     `.suffix` entries (a leading dot matches the domain + any subdomain).
 *   - default → `hatcher.host` + `api.hatcher.host` (+ their subdomains).
 *
 * See `.claude/plans/hatcher-integration.md` §14 (SSRF guard mandatory).
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Default Hatcher hosts when HATCHER_PROXY_ALLOWED_HOSTS is unset. */
const DEFAULT_ALLOWED_HOSTS = ['hatcher.host', 'api.hatcher.host'];

/**
 * Parse the allowlist env into a normalized lowercase list. Entries may be
 * exact hosts (`api.hatcher.host`) or domain suffixes (`.hatcher.host`, which
 * matches `hatcher.host` and any subdomain). Falls back to the defaults when
 * the env var is missing or empty.
 */
export function getHatcherAllowedHosts(): string[] {
  const raw = process.env.HATCHER_PROXY_ALLOWED_HOSTS;
  if (!raw || !raw.trim()) return [...DEFAULT_ALLOWED_HOSTS];
  const parsed = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_HOSTS];
}

/** True if `host` matches an allowlist entry (exact, or `.suffix` subdomain). */
function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of allowlist) {
    if (entry.startsWith('.')) {
      // `.hatcher.host` matches `hatcher.host` and `*.hatcher.host`.
      const suffix = entry.slice(1);
      if (h === suffix || h.endsWith(entry)) return true;
    } else {
      // Exact host, OR a subdomain of it (treat a bare domain as covering
      // its subdomains so `hatcher.host` also allows `proxy.hatcher.host`).
      if (h === entry || h.endsWith(`.${entry}`)) return true;
    }
  }
  return false;
}

/**
 * True if an IPv4 dotted-quad string is in a private / loopback / link-local /
 * reserved range that must never be a proxy target (SSRF). Covers RFC1918,
 * loopback (127/8), link-local (169.254/16 — AWS/GCP metadata),
 * "this network" (0/8), CGNAT (100.64/10), and the 192.0.2/198.18/203.0.113
 * documentation/benchmark ranges as a conservative deny.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Not a well-formed dotted-quad — treat as unsafe (caller already knows
    // isIP() said 4, so this should not happen; deny defensively).
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * True if an IPv6 address string is loopback (::1), unspecified (::),
 * link-local (fe80::/10), unique-local (fc00::/7), or an IPv4-mapped/embedded
 * address whose embedded IPv4 is private. Conservative deny for anything we
 * can't positively classify as global unicast.
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]; // strip zone id
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  // IPv4-mapped/embedded in DOTTED form (::ffff:a.b.c.d) — extract trailing quad.
  const v4Dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Dotted) return isPrivateIPv4(v4Dotted[1]);
  // IPv4-mapped/embedded in HEX form. The WHATWG URL parser normalizes
  // `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the last two 16-bit groups
  // encode the embedded IPv4 (7f00:0001 == 127.0.0.1). Reconstruct + classify.
  const groups = lower.split(':');
  if (groups.length >= 2) {
    const lo = groups[groups.length - 1];
    const hi = groups[groups.length - 2];
    if (/^[0-9a-f]{1,4}$/.test(lo) && /^[0-9a-f]{1,4}$/.test(hi)) {
      const hiN = parseInt(hi, 16);
      const loN = parseInt(lo, 16);
      const embedded = `${(hiN >> 8) & 0xff}.${hiN & 0xff}.${(loN >> 8) & 0xff}.${loN & 0xff}`;
      // Only treat as embedded-IPv4 when the prefix is the v4-mapped/compat
      // marker (::ffff: or pure ::) — avoids false positives on real GUA hosts.
      if (lower.includes('::ffff:') || lower.startsWith('::')) {
        if (isPrivateIPv4(embedded)) return true;
      }
    }
  }
  return false;
}

/** True if a literal IP string (v4 or v6) is in a private/loopback/reserved range. */
function isPrivateIP(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return false;
}

export type HatcherProxyUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Validate a partner-supplied proxy URL for SSRF safety. MUST be https with
 * an allowlisted host. Returns the normalized URL on success or a sanitized
 * reason on failure. Callers treat any failure as a hard reject — never fall
 * through to the outbound fetch.
 */
export function validateHatcherProxyUrl(rawUrl: string): HatcherProxyUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' };
  }
  // Reject embedded credentials (`https://user:pass@host`) — never legitimate
  // for a partner proxy and a common SSRF/obfuscation trick.
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials_in_url' };
  }
  // Reject IP-literal hosts in private/loopback/link-local/reserved ranges
  // (e.g. https://169.254.169.254, https://127.0.0.1, https://[::1]). The
  // allowlist is hostname-string based, so a numeric host that happened to be
  // allowlisted (mis-config) — or any private literal — is denied here. URL
  // brackets are stripped from IPv6 hostnames by the URL parser.
  const hostnameNoBrackets = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostnameNoBrackets) && isPrivateIP(hostnameNoBrackets)) {
    return { ok: false, reason: 'private_ip' };
  }
  if (!hostMatchesAllowlist(parsed.hostname, getHatcherAllowedHosts())) {
    return { ok: false, reason: 'host_not_allowlisted' };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * DNS-aware SSRF guard (async). Runs `validateHatcherProxyUrl` first, then
 * resolves the hostname and rejects if ANY resolved A/AAAA record is a
 * private/loopback/link-local/reserved IP — defeating DNS-rebind and
 * allowlisted-subdomain-pointing-at-internal-IP attacks that the pure
 * hostname-string allowlist cannot. Used at REGISTRATION time (where a one-time
 * DNS round-trip is acceptable). The call-time path stays synchronous +
 * additionally sets `redirect:'manual'` so a rebind between resolve and connect
 * still cannot reach an internal host via a redirect hop.
 *
 * Fails CLOSED: a DNS error (NXDOMAIN, timeout) returns `{ ok:false }` so a
 * resolution failure is never silently treated as safe.
 */
export async function validateHatcherProxyUrlResolved(
  rawUrl: string,
): Promise<HatcherProxyUrlCheck> {
  const syncCheck = validateHatcherProxyUrl(rawUrl);
  if (!syncCheck.ok) return syncCheck;

  let hostname: string;
  try {
    hostname = new URL(syncCheck.url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  // If the host is already an IP literal it was range-checked synchronously.
  if (isIP(hostname)) return syncCheck;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'dns_resolution_failed' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_no_records' };
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      return { ok: false, reason: 'resolves_to_private_ip' };
    }
  }
  return syncCheck;
}

/**
 * Generic DNS-aware SSRF guard for an arbitrary OUTBOUND gateway URL (Codex
 * round-2 R2-6, 2026-06-12). UNLIKE `validateHatcherProxyUrl*` there is NO host
 * allowlist (and http is permitted): a connected agent's own gateway is an
 * arbitrary caller-supplied URL declared at /connect (only `z.string().url()`),
 * so we cannot constrain the host — but we MUST still refuse to POST the agent's
 * own token to a private/loopback/link-local/reserved address. The blind-SSRF
 * surface is `OpenClawClient.chatOpenAI` / `chatAnthropic` / `chatCustomWebhook`,
 * which fire on every NPC-conversation tick to `this.gatewayUrl`.
 *
 * Rules (all fail-CLOSED):
 *   - must parse as a URL; http OR https allowed (legitimate self-hosted gateways
 *     may be plain http on a public IP — only the IP range matters for SSRF).
 *   - reject embedded credentials (`https://user:pass@host`) — an obfuscation
 *     trick, never legitimate here.
 *   - reject an IP-literal host in a private/loopback/link-local/reserved range
 *     (169.254.169.254 cloud metadata, 127.0.0.1, ::1, RFC1918, CGNAT, …).
 *   - resolve the hostname and reject if ANY A/AAAA record is private (DNS-rebind
 *     defense). A DNS error / no-records fails closed.
 *
 * Returns the normalized URL on success. Callers treat any failure as a hard
 * reject and fail soft (return '' for the cognition tick) — never fall through to
 * the outbound fetch. Mirrors `validateHatcherProxyUrlResolved` minus the
 * allowlist, reusing the SAME IP-classification (single source of truth) so the
 * private-range coverage can never drift between the two SSRF surfaces.
 */
export async function validateOutboundUrlResolved(
  rawUrl: string,
): Promise<HatcherProxyUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials_in_url' };
  }
  const hostnameNoBrackets = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostnameNoBrackets)) {
    if (isPrivateIP(hostnameNoBrackets)) {
      return { ok: false, reason: 'private_ip' };
    }
    // A public IP literal needs no DNS resolution.
    return { ok: true, url: parsed.toString() };
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostnameNoBrackets, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'dns_resolution_failed' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_no_records' };
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      return { ok: false, reason: 'resolves_to_private_ip' };
    }
  }
  return { ok: true, url: parsed.toString() };
}
