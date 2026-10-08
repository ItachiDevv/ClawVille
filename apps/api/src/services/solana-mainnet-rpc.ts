import { Connection, type Commitment, type ConnectionConfig } from '@solana/web3.js';
import { alertError } from './alert-error';

/**
 * Mainnet RPC with automatic failover to a public endpoint.
 *
 * 2026-10-08 02:04Z incident: the Helius account quota ran out and every call
 * returned HTTP 429 "max usage reached". Arena chain-checks failed closed, the
 * land hold-wallet verify door closed (balance_unknown), wallet balance reads
 * failed, and web3.js retried each 429 four times. Founder order: fail over to
 * the public Solana RPC automatically.
 *
 * Circuit breaker per primary origin+path (the api-key query is never part of
 * the key). Healthy -> primary. A trigger marks the primary down and re-sends
 * the SAME request once to the fallback. While down, requests skip the primary.
 * After the window the next request probes the primary (half-open).
 *
 * Never log a raw RPC URL: logs carry the host only, free text goes through
 * `redactRpcUrl`.
 */

export const PUBLIC_MAINNET_RPC_URL = 'https://api.mainnet-beta.solana.com';

type DownReason = 'quota' | 'auth' | 'rate' | 'error';
const DOWN_MS: Record<DownReason, number> = {
  quota: 15 * 60_000,
  auth: 15 * 60_000,
  rate: 30_000,
  error: 30_000,
};
const PRIMARY_TIMEOUT_MS = 10_000;
const SOURCE = 'solana-mainnet-rpc';

interface BreakerState {
  host: string;
  reason: DownReason | null;
  downSince: number;
  downUntil: number;
  alerted: boolean;
  fallbackCalls: number;
}

const states = new Map<string, BreakerState>();
const warnedBadFallback = new Set<string>();
let nowFn: () => number = () => Date.now();

/** Redact `api-key=<value>` anywhere in a string (URLs, error messages). */
export function redactRpcUrl(text: string): string {
  return text.replace(/(api[-_]?key=)[^&\s"'`]*/gi, '$1REDACTED');
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function breakerKey(raw: string): string | null {
  const u = parse(raw);
  return u ? `${u.origin}${u.pathname}` : null;
}

/** HELIUS_RPC_URL when it is a mainnet https URL, else built from HELIUS_API_KEY, else PUBLIC_MAINNET_RPC_URL. */
export function primaryMainnetRpcUrl(): string {
  const explicit = process.env.HELIUS_RPC_URL?.trim();
  if (explicit) {
    const u = parse(explicit);
    if (u && u.protocol === 'https:' && u.hostname.toLowerCase().includes('mainnet')) return explicit;
  }
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return PUBLIC_MAINNET_RPC_URL;
}

/** SOLANA_MAINNET_FALLBACK_RPC_URL (must be https, must not be devnet/testnet/localhost, else ignored with one warn) || PUBLIC_MAINNET_RPC_URL. */
export function fallbackMainnetRpcUrl(): string {
  const raw = process.env.SOLANA_MAINNET_FALLBACK_RPC_URL?.trim();
  if (!raw) return PUBLIC_MAINNET_RPC_URL;
  const u = parse(raw);
  const host = u?.hostname.toLowerCase() ?? '';
  const ok =
    u !== null &&
    u.protocol === 'https:' &&
    !/devnet|testnet|localhost/.test(host) &&
    host !== '127.0.0.1' &&
    host !== '[::1]';
  if (ok) return raw;
  if (!warnedBadFallback.has(raw)) {
    warnedBadFallback.add(raw);
    console.warn(
      `[${SOURCE}] SOLANA_MAINNET_FALLBACK_RPC_URL ignored (needs an https mainnet URL; host "${host || 'unparseable'}"); using ${PUBLIC_MAINNET_RPC_URL}`,
    );
  }
  return PUBLIC_MAINNET_RPC_URL;
}

/** Breaker key when `raw` is a configured mainnet primary; null means pass straight through. */
function primaryKeyFor(raw: string): string | null {
  const u = parse(raw);
  if (!u || u.protocol !== 'https:') return null;
  const key = `${u.origin}${u.pathname}`;
  if (key === breakerKey(fallbackMainnetRpcUrl())) return null;
  const host = u.hostname.toLowerCase();
  if (host.endsWith('helius-rpc.com') && host.includes('mainnet')) return key;
  return key === breakerKey(primaryMainnetRpcUrl()) ? key : null;
}

function stateFor(key: string): BreakerState {
  let s = states.get(key);
  if (!s) {
    s = { host: parse(key)?.host ?? 'primary', reason: null, downSince: 0, downUntil: 0, alerted: false, fallbackCalls: 0 };
    states.set(key, s);
  }
  return s;
}

function safeAlert(severity: 'critical' | 'warning', message: string): void {
  try {
    alertError({ severity, source: SOURCE, message: redactRpcUrl(message) }).catch((err: unknown) => {
      console.warn(`[${SOURCE}] alert failed: ${redactRpcUrl(String(err))}`);
    });
  } catch (err) {
    console.warn(`[${SOURCE}] alert failed: ${redactRpcUrl(String(err))}`);
  }
}

function markDown(s: BreakerState, reason: DownReason, detail?: string): void {
  const now = nowFn();
  const until = now + DOWN_MS[reason];
  if (s.reason !== null && until < s.downUntil) return; // a weaker, stale signal from a concurrent request
  const changed = s.reason !== reason;
  if (s.reason === null) s.downSince = now;
  s.reason = reason;
  s.downUntil = until;
  const fallbackHost = parse(fallbackMainnetRpcUrl())?.host ?? 'fallback';
  if (changed) {
    console.warn(
      `[${SOURCE}] primary ${s.host} down (${reason})${detail ? `: ${redactRpcUrl(detail)}` : ''}; using ${fallbackHost} until ${new Date(until).toISOString()}`,
    );
  }
  if ((reason === 'quota' || reason === 'auth') && !s.alerted) {
    s.alerted = true;
    safeAlert(
      'critical',
      `Primary Helius RPC (${s.host}) unusable (${reason}). All mainnet reads and sends now use the public RPC (${fallbackHost}) until it recovers.`,
    );
  }
}

function markHealthy(s: BreakerState): void {
  if (s.reason === null) return;
  const mins = Math.round((nowFn() - s.downSince) / 60_000);
  console.warn(`[${SOURCE}] primary ${s.host} recovered after ${mins} min (last reason ${s.reason}); back on primary`);
  if (s.alerted) {
    safeAlert('warning', `RESOLVED: primary Helius RPC (${s.host}) recovered after ${mins} min. Mainnet reads and sends are back on Helius.`);
  }
  s.reason = null;
  s.downSince = 0;
  s.downUntil = 0;
  s.alerted = false;
}

async function classify(res: Response): Promise<DownReason | null> {
  if (res.status === 429) {
    let text = '';
    try {
      text = await res.clone().text();
    } catch {
      /* unreadable body: treat as a plain rate limit */
    }
    return /max usage/i.test(text) ? 'quota' : 'rate';
  }
  if (res.status === 401 || res.status === 403) return 'auth';
  if (res.status >= 500) return 'error';
  return null;
}

function resendable(body: RequestInit['body']): boolean {
  return (
    body == null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  );
}

function sendFallback(s: BreakerState, init: RequestInit): Promise<Response> {
  s.fallbackCalls += 1;
  return fetch(fallbackMainnetRpcUrl(), init);
}

/** fetch-compatible. Requests whose URL is NOT a configured primary (helius host) pass straight through to fetch. */
export async function mainnetFailoverFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  const key = primaryKeyFor(url);
  if (key === null) return fetch(input, init);

  let req: RequestInit = init ?? {};
  if (input instanceof Request) {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    const body = hasBody ? await input.clone().arrayBuffer() : undefined;
    req = { method: input.method, headers: input.headers, body, signal: input.signal, ...init };
  }
  const caller = req.signal ?? undefined;
  const s = stateFor(key);

  if (s.reason !== null && nowFn() < s.downUntil) return sendFallback(s, req);
  if (!resendable(req.body)) return fetch(url, req); // a stream cannot be re-sent

  const ctrl = new AbortController();
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener('abort', () => ctrl.abort(caller.reason), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`primary timeout after ${PRIMARY_TIMEOUT_MS} ms`)), PRIMARY_TIMEOUT_MS);
  let res: Response;
  let reason: DownReason | null;
  try {
    res = await fetch(url, { ...req, signal: ctrl.signal });
    reason = await classify(res);
  } catch (err) {
    if (caller?.aborted) throw err; // never fail over a caller abort
    markDown(s, 'error', err instanceof Error ? err.message : String(err));
    return sendFallback(s, req);
  } finally {
    clearTimeout(timer);
  }

  if (reason === null) {
    markHealthy(s);
    return res;
  }
  res.body?.cancel().catch(() => {});
  markDown(s, reason, `HTTP ${res.status}`);
  return sendFallback(s, req);
}
// Bun's `typeof fetch` also requires `preconnect`; with it, this function is
// assignable wherever `typeof fetch` is expected (no cast at call sites).
mainnetFailoverFetch.preconnect = (...args: Parameters<typeof fetch.preconnect>): void => fetch.preconnect(...args);

/** new Connection(primaryUrl ?? primaryMainnetRpcUrl(), { commitment, fetch: mainnetFailoverFetch, disableRetryOnRateLimit: true, ...config }). */
export function createMainnetConnection(
  commitmentOrConfig?: Commitment | ConnectionConfig,
  primaryUrl?: string,
): Connection {
  const config: ConnectionConfig =
    typeof commitmentOrConfig === 'string' ? { commitment: commitmentOrConfig } : { ...commitmentOrConfig };
  return new Connection(primaryUrl ?? primaryMainnetRpcUrl(), {
    fetch: mainnetFailoverFetch,
    disableRetryOnRateLimit: true,
    ...config,
  });
}

export function mainnetRpcStatus(): {
  primaryHealthy: boolean;
  downSince: string | null;
  downUntil: string | null;
  reason: DownReason | null;
  fallbackCalls: number;
} {
  let open: BreakerState | undefined;
  let fallbackCalls = 0;
  for (const s of states.values()) {
    fallbackCalls += s.fallbackCalls;
    if (s.reason !== null && (!open || s.downUntil > open.downUntil)) open = s;
  }
  return {
    primaryHealthy: open === undefined,
    downSince: open ? new Date(open.downSince).toISOString() : null,
    downUntil: open ? new Date(open.downUntil).toISOString() : null,
    reason: open?.reason ?? null,
    fallbackCalls,
  };
}

export function __resetMainnetRpcStateForTests(): void {
  states.clear();
  warnedBadFallback.clear();
  nowFn = () => Date.now();
}

/** Test hook: deterministic clock. Pass undefined to restore Date.now. */
export function __setMainnetRpcNowForTests(fn?: () => number): void {
  nowFn = fn ?? (() => Date.now());
}
