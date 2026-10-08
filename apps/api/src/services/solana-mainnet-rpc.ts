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
const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_RETRY_MS = 60_000;
const SOURCE = 'solana-mainnet-rpc';
/** mainnet-beta genesis hash; a fallback must answer getGenesisHash with it before it gets any traffic. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/**
 * Fallback rate limiter (2026-10-08 staging: the arena chain-check loop burst past the public RPC's per-IP limits,
 * every check failed `rpc_rate_limited`, and that budget is shared with wallet withdraw, agent pay and land refunds).
 * One process-wide token bucket for requests SENT TO THE FALLBACK only (failover sends and the genesis probe); the
 * primary is never limited. A request waits up to 3 s for a token, then gets a local 429 without a fallback call.
 * Public mainnet limits (solana.com/docs/references/clusters): 100 requests / 10 s per IP, 40 / 10 s per IP for a
 * single RPC method.
 */
const FALLBACK_BURST = 10;
const DEFAULT_FALLBACK_RPS = 6;
const FALLBACK_MAX_WAIT_MS = 3_000;
const FALLBACK_WARN_EVERY_MS = 60_000;
const LOCAL_RATE_LIMIT_BODY = '{"jsonrpc":"2.0","error":{"code":429,"message":"fallback rate limited (local)"}}';

interface BreakerState {
  host: string;
  reason: DownReason | null;
  downSince: number;
  downUntil: number;
  alerted: boolean;
  fallbackCalls: number;
}

type ProofVerdict = 'mainnet' | 'not-mainnet' | 'unreachable';
interface FallbackProof {
  verdict: ProofVerdict;
  at: number;
}

const states = new Map<string, BreakerState>();
const warnedBadFallback = new Set<string>();
const proofs = new Map<string, FallbackProof>();
const probing = new Map<string, Promise<FallbackProof>>();
let noFailoverAlerted = false;
let timeoutMs = DEFAULT_TIMEOUT_MS;
let nowFn: () => number = () => Date.now();

let bucketTokens = FALLBACK_BURST;
let bucketAt: number | null = null;
let fallbackRateLimited = 0;
let fallbackLocalLimited = 0;
let lastFallback429WarnAt = Number.NEGATIVE_INFINITY;
let lastLocalLimitWarnAt = Number.NEGATIVE_INFINITY;
const warnedBadRps = new Set<string>();

/** Sleep `ms`, rejecting with the signal's reason on abort; the timer and the listener are removed on every path. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
let limiterSleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep;

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

/** Literal host check (no DNS): devnet/testnet names, IP literals, localhost, single-label and .local/.internal names. */
function fallbackHostRejected(host: string): boolean {
  return (
    /devnet|testnet/.test(host) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || // IPv4 literal (URL already normalizes 0x7f.1 and friends)
    host.startsWith('[') || // IPv6 literal
    host === 'localhost' ||
    /\.(localhost|local|internal)$/.test(host) ||
    !host.includes('.')
  );
}

/**
 * SOLANA_MAINNET_FALLBACK_RPC_URL (https, a public DNS name: no devnet/testnet,
 * IP literal, localhost or internal name; else ignored with one warn) ||
 * PUBLIC_MAINNET_RPC_URL. The URL still gets no traffic until it passes the
 * genesis-hash proof (`fallbackProven`).
 */
export function fallbackMainnetRpcUrl(): string {
  const raw = process.env.SOLANA_MAINNET_FALLBACK_RPC_URL?.trim();
  if (!raw) return PUBLIC_MAINNET_RPC_URL;
  const u = parse(raw);
  const host = u?.hostname.toLowerCase() ?? '';
  const ok = u !== null && u.protocol === 'https:' && !fallbackHostRejected(host);
  if (ok) return raw;
  if (!warnedBadFallback.has(raw)) {
    warnedBadFallback.add(raw);
    console.warn(
      `[${SOURCE}] SOLANA_MAINNET_FALLBACK_RPC_URL ignored (needs an https mainnet URL; host "${host || 'unparseable'}"); using ${PUBLIC_MAINNET_RPC_URL}`,
    );
  }
  return PUBLIC_MAINNET_RPC_URL;
}

/** SOLANA_MAINNET_FALLBACK_MAX_RPS when it is a number in 1..50, else 6 (an invalid value warns once). */
export function fallbackMaxRps(): number {
  const raw = process.env.SOLANA_MAINNET_FALLBACK_MAX_RPS?.trim();
  if (!raw) return DEFAULT_FALLBACK_RPS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  if (!warnedBadRps.has(raw)) {
    warnedBadRps.add(raw);
    console.warn(`[${SOURCE}] SOLANA_MAINNET_FALLBACK_MAX_RPS ignored (needs a number 1..50); using ${DEFAULT_FALLBACK_RPS}`);
  }
  return DEFAULT_FALLBACK_RPS;
}

/**
 * Take one fallback token. Refill at `fallbackMaxRps()` per second up to FALLBACK_BURST. With no token, the request
 * reserves the next one (the balance goes negative, so concurrent waiters queue in order) and sleeps until it is due,
 * when that is at most 3 s away. Returns false (and reserves nothing) when it is further away. A caller abort while
 * waiting returns the reservation and rethrows the abort reason.
 */
async function acquireFallbackToken(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const rps = fallbackMaxRps();
  const now = nowFn();
  if (bucketAt === null) bucketAt = now;
  bucketTokens = Math.min(FALLBACK_BURST, bucketTokens + (Math.max(0, now - bucketAt) * rps) / 1000);
  bucketAt = Math.max(bucketAt, now);
  if (bucketTokens >= 1) {
    bucketTokens -= 1;
    return true;
  }
  const waitMs = ((1 - bucketTokens) * 1000) / rps;
  if (waitMs > FALLBACK_MAX_WAIT_MS) {
    fallbackLocalLimited += 1;
    if (now - lastLocalLimitWarnAt >= FALLBACK_WARN_EVERY_MS) {
      lastLocalLimitWarnAt = now;
      console.warn(
        `[${SOURCE}] fallback budget exhausted (${rps}/s, burst ${FALLBACK_BURST}); ${fallbackLocalLimited} request(s) refused locally with 429 so far (callers fail closed)`,
      );
    }
    return false;
  }
  bucketTokens -= 1;
  try {
    await limiterSleep(waitMs, signal);
  } catch (err) {
    bucketTokens = Math.min(FALLBACK_BURST, bucketTokens + 1);
    throw err;
  }
  return true;
}

function localRateLimited(): Response {
  return new Response(LOCAL_RATE_LIMIT_BODY, { status: 429 });
}

/** The fallback's own HTTP 429: counted, and one warn per minute at most. */
function noteFallback429(url: string): void {
  fallbackRateLimited += 1;
  const now = nowFn();
  if (now - lastFallback429WarnAt < FALLBACK_WARN_EVERY_MS) return;
  lastFallback429WarnAt = now;
  console.warn(
    `[${SOURCE}] fallback ${parse(url)?.host ?? 'fallback'} answered HTTP 429 (${fallbackRateLimited} so far); callers fail closed`,
  );
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

/** Run `run` with a signal that aborts on the caller's signal OR after `timeoutMs`; the timer is cleared on every path. */
async function withTimeout<T>(
  caller: AbortSignal | undefined,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const ms = timeoutMs;
  const timer = setTimeout(() => ctrl.abort(new Error(`${label} timeout after ${ms} ms`)), ms);
  try {
    return await run(caller ? AbortSignal.any([caller, ctrl.signal]) : ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function probeGenesis(url: string): Promise<{ verdict: ProofVerdict; detail: string }> {
  try {
    if (!(await acquireFallbackToken())) return { verdict: 'unreachable', detail: 'fallback rate limited (local)' };
    const hash = await withTimeout(undefined, 'genesis probe', async (signal) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}',
        signal,
      });
      if (res.status === 429) noteFallback429(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { result?: unknown }).result;
    });
    return hash === MAINNET_GENESIS_HASH
      ? { verdict: 'mainnet', detail: 'genesis hash matches mainnet-beta' }
      : { verdict: 'not-mainnet', detail: `genesis hash ${String(hash).slice(0, 64)}` };
  } catch (err) {
    return { verdict: 'unreachable', detail: redactRpcUrl(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * B1 (Codex 2026-10-08): money guards check the PRIMARY endpoint, so the
 * fallback must prove it is mainnet before it gets any traffic. One
 * getGenesisHash probe per fallback URL (concurrent callers share it):
 * success is cached for the process, failure for 60 s. Unproven => no
 * failover (fail closed, as before the breaker existed).
 */
async function fallbackProven(url: string): Promise<boolean> {
  const cached = proofs.get(url);
  if (cached && (cached.verdict === 'mainnet' || nowFn() - cached.at < PROBE_RETRY_MS)) {
    return cached.verdict === 'mainnet';
  }
  let pending = probing.get(url);
  if (!pending) {
    pending = (async () => {
      const { verdict, detail } = await probeGenesis(url);
      const proof: FallbackProof = { verdict, at: nowFn() };
      const prev = proofs.get(url);
      proofs.set(url, proof);
      const host = parse(url)?.host ?? 'fallback';
      if (prev?.verdict !== verdict) console.warn(`[${SOURCE}] fallback ${host} verdict ${verdict}: ${detail}`);
      if (verdict !== 'mainnet' && !noFailoverAlerted) {
        noFailoverAlerted = true;
        safeAlert(
          'critical',
          `Fallback RPC (${host}) is not mainnet / unreachable (${verdict}: ${detail}); no failover. Mainnet RPC calls fail closed while the primary is down.`,
        );
      }
      return proof;
    })().finally(() => probing.delete(url));
    probing.set(url, pending);
  }
  return (await pending).verdict === 'mainnet';
}

/**
 * The fallback URL once it has passed the genesis proof (runs or awaits the
 * same cached probe), else null. For callers that retry outside the fetch
 * wrapper (the x402 prepare): null means do not retry, fail closed.
 */
export async function provenFallbackMainnetRpcUrl(): Promise<string | null> {
  const url = fallbackMainnetRpcUrl();
  return (await fallbackProven(url)) ? url : null;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * Read the whole body under `signal` and return an in-memory copy, so the
 * 10 s timeout also covers a stalled body (Codex round 2): web3.js reads the
 * body after fetch returns, outside any timer.
 */
async function bufferResponse(res: Response, signal: AbortSignal): Promise<Response> {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const buf = await Promise.race([res.arrayBuffer(), aborted]);
    const headers = new Headers(res.headers);
    headers.delete('content-encoding'); // the body is already decoded
    headers.delete('content-length');
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : buf, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

/**
 * One send to the fallback with the same 10 s timeout (headers AND body) as the primary; its errors and timeout go to
 * the caller. It first takes a fallback token (up to 3 s wait, the caller's signal aborts the wait); with none it
 * returns a local 429 and never calls the fallback.
 */
async function sendFallback(s: BreakerState, url: string, init: RequestInit, caller: AbortSignal | undefined): Promise<Response> {
  if (!(await acquireFallbackToken(caller))) return localRateLimited();
  s.fallbackCalls += 1;
  const res = await withTimeout(caller, 'fallback', async (signal) => bufferResponse(await fetch(url, { ...init, signal }), signal));
  if (res.status === 429) noteFallback429(url);
  return res;
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

  const fallbackUrl = fallbackMainnetRpcUrl();

  if (s.reason !== null && nowFn() < s.downUntil && (await fallbackProven(fallbackUrl))) {
    return sendFallback(s, fallbackUrl, req, caller);
  }
  if (!resendable(req.body)) return fetch(url, req); // a stream cannot be re-sent

  let res: Response;
  let reason: DownReason | null;
  try {
    [res, reason] = await withTimeout(caller, 'primary', async (signal) => {
      // A stalled body times out here too and counts as an 'error' trigger.
      const r = await bufferResponse(await fetch(url, { ...req, signal }), signal);
      return [r, await classify(r)] as const;
    });
  } catch (err) {
    if (caller?.aborted) throw err; // never fail over a caller abort
    if (!(await fallbackProven(fallbackUrl))) throw err; // fail closed: the primary's own error
    markDown(s, 'error', err instanceof Error ? err.message : String(err));
    return sendFallback(s, fallbackUrl, req, caller);
  }

  if (reason === null) {
    markHealthy(s);
    return res;
  }
  if (!(await fallbackProven(fallbackUrl))) return res; // fail closed: the primary's own response
  markDown(s, reason, `HTTP ${res.status}`);
  return sendFallback(s, fallbackUrl, req, caller);
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
  /** HTTP 429 answers from the fallback itself (failover sends and genesis probes). */
  fallbackRateLimited: number;
  /** Fallback requests refused by the local rate limiter (local 429, the fallback was not called). */
  fallbackLocalLimited: number;
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
    fallbackRateLimited,
    fallbackLocalLimited,
  };
}

export function __resetMainnetRpcStateForTests(): void {
  states.clear();
  warnedBadFallback.clear();
  proofs.clear();
  probing.clear();
  noFailoverAlerted = false;
  timeoutMs = DEFAULT_TIMEOUT_MS;
  nowFn = () => Date.now();
  bucketTokens = FALLBACK_BURST;
  bucketAt = null;
  fallbackRateLimited = 0;
  fallbackLocalLimited = 0;
  lastFallback429WarnAt = Number.NEGATIVE_INFINITY;
  lastLocalLimitWarnAt = Number.NEGATIVE_INFINITY;
  warnedBadRps.clear();
  limiterSleep = abortableSleep;
}

/** Test hook: the fallback limiter's wait. Pass undefined to restore the real abortable sleep. */
export function __setFallbackLimiterSleepForTests(fn?: (ms: number, signal?: AbortSignal) => Promise<void>): void {
  limiterSleep = fn ?? abortableSleep;
}

/** Test hook: mark a fallback URL proven mainnet, so a fetch mock need not answer getGenesisHash. */
export function __markFallbackProvenForTests(url: string = fallbackMainnetRpcUrl()): void {
  proofs.set(url, { verdict: 'mainnet', at: nowFn() });
}

/** Test hook: the primary / fallback / probe timeout. Pass undefined to restore 10 s. */
export function __setMainnetRpcTimeoutMsForTests(ms?: number): void {
  timeoutMs = ms ?? DEFAULT_TIMEOUT_MS;
}

/** Test hook: deterministic clock. Pass undefined to restore Date.now. */
export function __setMainnetRpcNowForTests(fn?: () => number): void {
  nowFn = fn ?? (() => Date.now());
}

export type PolledConfirmation =
  | { status: 'confirmed'; slot: number }
  | { status: 'failed'; err: unknown; slot: number }
  | { status: 'expired' };

export interface ConfirmByPollingOptions {
  /** The `lastValidBlockHeight` returned with the blockhash the tx was signed with. */
  lastValidBlockHeight: number;
  /** The level that counts, for success AND for failure. Default 'confirmed'. */
  commitment?: 'confirmed' | 'finalized';
  pollMs?: number;
  signal?: AbortSignal;
  /** Throw after this many consecutive failed RPC rounds (both endpoints). Default 5. */
  maxConsecutiveRpcErrors?: number;
  /** History checks after the block height passed `lastValidBlockHeight`, while the tx is seen but below `commitment`. Default 15. */
  maxChecksAfterExpiry?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

function reachedCommitment(
  status: string | null | undefined,
  commitment: 'confirmed' | 'finalized',
): boolean {
  return commitment === 'finalized' ? status === 'finalized' : status === 'confirmed' || status === 'finalized';
}

/**
 * Confirm a sent signature over HTTP only, with no websocket.
 *
 * web3.js `confirmTransaction` sends its one HTTP status check only after the
 * websocket subscription is up, and the websocket URL is derived from the
 * primary (Helius) URL. With Helius quota out the subscription never comes
 * up, and a landed tx expires as "unconfirmed". This polls
 * `getSignatureStatuses` and `getBlockHeight` through the connection's
 * (failover) fetch instead.
 *
 * - The status counts (success OR error) only once `confirmationStatus`
 *   reaches `commitment`. A `processed` error is never final: that fork can
 *   drop and the same signed tx can still land elsewhere.
 * - After the block height passes `lastValidBlockHeight` it checks with
 *   `searchTransactionHistory: true`: reached -> confirmed / failed, not seen
 *   -> 'expired', seen below `commitment` -> keep checking (bounded).
 * - It never sends anything. 'expired' and a throw are AMBIGUOUS for the
 *   caller (the same meaning as a web3.js confirm throw).
 */
export async function confirmSignatureByPolling(
  connection: Connection,
  signature: string,
  opts: ConfirmByPollingOptions,
): Promise<PolledConfirmation> {
  const commitment = opts.commitment ?? 'confirmed';
  const pollMs = opts.pollMs ?? 2_000;
  const maxErrors = opts.maxConsecutiveRpcErrors ?? 5;
  const maxAfterExpiry = opts.maxChecksAfterExpiry ?? 15;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let rpcErrors = 0;
  let expired = false;
  let checksAfterExpiry = 0;
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('confirm aborted');
    try {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: expired,
      });
      const s = value[0];
      if (s && reachedCommitment(s.confirmationStatus, commitment)) {
        return s.err ? { status: 'failed', err: s.err, slot: s.slot } : { status: 'confirmed', slot: s.slot };
      }
      rpcErrors = 0;
      if (expired) {
        checksAfterExpiry += 1;
        if (!s || checksAfterExpiry >= maxAfterExpiry) return { status: 'expired' };
      } else if ((await connection.getBlockHeight(commitment)) > opts.lastValidBlockHeight) {
        expired = true;
        continue; // the history check runs now, without a sleep
      }
    } catch (err) {
      rpcErrors += 1;
      if (rpcErrors >= maxErrors) {
        throw new Error(
          `[${SOURCE}] confirm polling failed ${rpcErrors}x: ${redactRpcUrl(err instanceof Error ? err.message : String(err))}`,
        );
      }
    }
    await sleep(pollMs);
  }
}
