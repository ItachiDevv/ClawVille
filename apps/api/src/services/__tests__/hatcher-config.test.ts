/**
 * SSRF-guard regression tests for the Hatcher cognition proxy (Phase A, fixer
 * pass 2026-06-01).
 *
 * The cognition seam (`OpenClawClient.chat()` case 'hatcher-proxy') POSTs to a
 * PARTNER-SUPPLIED URL. Two blocking SSRF findings drove these:
 *   1. The hostname-string allowlist cannot stop an IP literal that points at
 *      a private/loopback/link-local host (169.254.169.254 metadata, 127.0.0.1,
 *      ::1, RFC1918) — the sync validator must reject them on its own.
 *   2. An allowlisted hostname can RESOLVE to an internal IP (DNS rebind /
 *      attacker subdomain). The async resolved-validator must reject that.
 *
 * (The redirect-follow vector — a 3xx from an allowlisted host bouncing us to
 * an internal address — is closed in `openclaw-client.ts` via redirect:'manual'
 * + a hard 3xx fail; that path needs a live fetch so it's smoke-tested on
 * staging, per the casino live-smoke rule.)
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  validateHatcherProxyUrl,
  validateHatcherProxyUrlResolved,
  getHatcherAllowedHosts,
} from '../hatcher-config';

const ORIGINAL_ALLOWED = process.env.HATCHER_PROXY_ALLOWED_HOSTS;

afterEach(() => {
  if (ORIGINAL_ALLOWED === undefined) {
    delete process.env.HATCHER_PROXY_ALLOWED_HOSTS;
  } else {
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = ORIGINAL_ALLOWED;
  }
});

describe('validateHatcherProxyUrl — protocol + creds', () => {
  it('rejects non-https', () => {
    expect(validateHatcherProxyUrl('http://api.hatcher.host')).toMatchObject({
      ok: false,
      reason: 'not_https',
    });
  });

  it('rejects embedded credentials', () => {
    expect(validateHatcherProxyUrl('https://user:pass@api.hatcher.host')).toMatchObject({
      ok: false,
      reason: 'credentials_in_url',
    });
  });

  it('rejects a malformed URL', () => {
    expect(validateHatcherProxyUrl('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' });
  });

  it('accepts a default-allowlisted https host', () => {
    const res = validateHatcherProxyUrl('https://api.hatcher.host/x');
    expect(res.ok).toBe(true);
  });

  it('accepts a subdomain of an allowlisted bare domain', () => {
    expect(validateHatcherProxyUrl('https://proxy.hatcher.host').ok).toBe(true);
  });

  it('rejects a non-allowlisted host', () => {
    expect(validateHatcherProxyUrl('https://evil.example.com')).toMatchObject({
      ok: false,
      reason: 'host_not_allowlisted',
    });
  });
});

describe('validateHatcherProxyUrl — private/loopback/link-local IP literals (SSRF #1)', () => {
  // Even if a private IP were allowlisted, the IP-range check must fire FIRST.
  const cases: Array<[string, string]> = [
    ['https://169.254.169.254/latest/meta-data/', 'AWS/GCP metadata link-local'],
    ['https://127.0.0.1', 'IPv4 loopback'],
    ['https://10.0.0.5', 'RFC1918 10/8'],
    ['https://172.16.0.1', 'RFC1918 172.16/12'],
    ['https://172.31.255.255', 'RFC1918 172.31 edge'],
    ['https://192.168.1.1', 'RFC1918 192.168/16'],
    ['https://100.64.0.1', 'CGNAT 100.64/10'],
    ['https://0.0.0.0', '0/8 this-network'],
    ['https://[::1]', 'IPv6 loopback'],
    ['https://[fe80::1]', 'IPv6 link-local'],
    ['https://[fc00::1]', 'IPv6 unique-local'],
    ['https://[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
  ];
  for (const [url, label] of cases) {
    it(`rejects ${label} (${url})`, () => {
      const res = validateHatcherProxyUrl(url);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('private_ip');
    });
  }

  it('does not reject a non-RFC1918 172 host (172.32 is public)', () => {
    // 172.32.0.1 is OUTSIDE the 172.16-31 private range — should fall through
    // to the allowlist check (and be rejected there, not as private_ip).
    const res = validateHatcherProxyUrl('https://172.32.0.1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('host_not_allowlisted');
  });
});

describe('getHatcherAllowedHosts — env parsing', () => {
  it('falls back to defaults when env unset', () => {
    delete process.env.HATCHER_PROXY_ALLOWED_HOSTS;
    expect(getHatcherAllowedHosts()).toEqual(['hatcher.host', 'api.hatcher.host']);
  });

  it('parses a comma-separated env list (lowercased, trimmed)', () => {
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = ' Foo.Example.Com , .bar.test ';
    expect(getHatcherAllowedHosts()).toEqual(['foo.example.com', '.bar.test']);
  });
});

describe('validateHatcherProxyUrlResolved — DNS-aware (SSRF #2)', () => {
  it('short-circuits a sync failure without DNS', async () => {
    const res = await validateHatcherProxyUrlResolved('http://api.hatcher.host');
    expect(res).toMatchObject({ ok: false, reason: 'not_https' });
  });

  it('rejects an allowlisted host that resolves to a private IP', async () => {
    // localhost is on the allowlist via env so the sync check passes, but it
    // resolves to 127.0.0.1 / ::1 — the DNS guard must catch it.
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = 'localhost';
    const res = await validateHatcherProxyUrlResolved('https://localhost/cb');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('resolves_to_private_ip');
  });

  it('fails closed (not silently allowed) when DNS cannot resolve', async () => {
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = 'this-host-does-not-exist.hatcher.host';
    const res = await validateHatcherProxyUrlResolved(
      'https://this-host-does-not-exist.hatcher.host/cb',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(['dns_resolution_failed', 'dns_no_records']).toContain(res.reason);
    }
  });

  it('passes an IP-literal allowlisted host without a second DNS round-trip', async () => {
    // A public IP literal that we explicitly allowlist: sync check passes
    // (public range), and the resolved variant returns the sync result as-is
    // because the host is already an IP.
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = '8.8.8.8';
    const res = await validateHatcherProxyUrlResolved('https://8.8.8.8/cb');
    expect(res.ok).toBe(true);
  });
});
