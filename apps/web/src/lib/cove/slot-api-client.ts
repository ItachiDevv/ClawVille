'use client';

/**
 * Phase 6.1 — slice 5: TanStack Query hooks for the cove-slots API.
 *
 * Mirrors the shipped contract in `apps/api/src/routes/cove-slots.types.ts`.
 * Every wire field that the server emits as a stringified bigint stays a
 * string on the client too — we never `parseInt` or `Number()` a balance,
 * predict, win, or escrow value. The verifier and the UI promote to `bigint`
 * only at the boundaries where math happens (FX tier derivation, balance
 * pretty-printing where it fits in a JS number).
 *
 * Cookies: every request uses `credentials: 'include'` so Lucia's
 * session cookie ride along. Anonymous endpoints (paytables, verify) also
 * send the cookie — harmless; backend ignores it.
 *
 * Fingerprint: INJECTED here as of the 2026-06-21 prod hotfix. The cove
 * routes scope GUEST plays by the server-side `fpHash` derived from this
 * header (cove-slots `getSubject` guest branch + cove-history `resolveSubject`
 * guest branch). Without the header the server fell back to a RAW-IP-derived
 * hash that CHANGED whenever a residential guest's IP churned (DHCP / mobile /
 * VPN), so a guest's open session, ownerMatches, GET /session/current, and
 * history read keyed to a DIFFERENT subject than the one that wrote the spin —
 * orphaning the session (404 "session not found") and the recorded win ("won
 * 20 CT, no history"). Sending the stable browser fingerprint makes all guest
 * cove requests key to ONE fpHash regardless of IP changes. Authed (real-CT)
 * requests are unaffected — they scope by the Lucia user_id, never the fp.
 *
 * Idempotency-Key (per /spin call): caller passes a `crypto.randomUUID()`
 * value. Generating it INSIDE the mutation function would defeat retries
 * — every retry would mint a fresh key. We accept it as a mutation arg
 * so the caller controls retry semantics; SlotScreenModal mints once per
 * "spin button press" and reuses on retry-by-button-mash.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MachineSlug, SymbolId, WildMultiplier, WinningLine } from './types';
import { getFingerprint } from '../fingerprint';

// ---------------------------------------------------------------------------
// Env + helper
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Typed cove-slots error. The Hono backend returns `{ error?, message? }`
 * shaped JSON bodies on 4xx/5xx; we surface both plus the numeric status so
 * the UI can dispatch on it (429 toast vs 400 toast vs 409 reload).
 */
export class CoveApiError extends Error {
  public readonly status: number;
  public readonly serverMessage: string;
  public readonly code: string | null;
  constructor(status: number, serverMessage: string, code: string | null = null) {
    super(`cove_api_error(${status}): ${serverMessage}`);
    this.name = 'CoveApiError';
    this.status = status;
    this.serverMessage = serverMessage;
    this.code = code;
  }
}

async function coveFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  // Stable browser fingerprint → server `fpHash` tier-1. Scopes guest cove
  // sessions + history so they survive IP changes (2026-06-21 hotfix). Empty
  // on SSR / FingerprintJS load failure — server falls back to UA+/24 hash.
  // Never overwrite a caller-supplied header (none set it today, but keep the
  // contract explicit).
  if (!headers['X-CV-Fingerprint']) {
    const fp = await getFingerprint();
    if (fp) headers['X-CV-Fingerprint'] = fp;
  }
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    // Hono HTTPException serializes as `{ message }`; older paths may use `{ error }`.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // empty/non-JSON — fall through with empty message
    }
    const obj = (body ?? {}) as { error?: string; message?: string };
    const serverMessage = obj.message || obj.error || `HTTP ${res.status}`;
    // Extract a 1st-token "code" for UI dispatch (e.g. "insufficient_clawtokens" from
    // "insufficient_clawtokens: need 10, have 5").
    const code = typeof serverMessage === 'string' ? serverMessage.split(/[\s:]/)[0] || null : null;
    throw new CoveApiError(res.status, serverMessage, code);
  }
  // 200 / 204 with empty body is unusual but tolerated.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wire types — mirror the api types verbatim. Drift breaks the verifier.
// ---------------------------------------------------------------------------

export type Currency = 'clawtokens' | 'sol' | 'usdc';

export interface SerializedWinningLineWire {
  lineIndex: number;
  symbols: SymbolId[];
  winAmount: string;
  multiplier: number;
}

/**
 * Phase 6.1.5 — serialized mirror of the server `WildMultiplier`. No
 * bigint fields, so structurally identical to the runtime type; kept
 * separate so a future change (e.g. percent-fraction) stays wire-typed.
 */
export interface SerializedWildMultiplierWire {
  reelIndex: number;
  rowIndex: number;
  multiplier: number;
}

export interface SpinResponse {
  spinId: string;
  reels: SymbolId[][];
  winningLines: SerializedWinningLineWire[];
  winAmount: string;
  freeSpinsAwarded: number;
  isFreeSpin: boolean;
  /**
   * Phase 6.1.5 (Bundle B) — per-landed-Wild multiplier. ALWAYS present
   * (server contract locked 2026-05-19). Empty array on `classic-3x5`
   * paytable and on bonus paytable when no wild lands.
   * Per server contract: raw table draw (2/3/5), NEVER doubled in FS.
   */
  wildMultipliers: SerializedWildMultiplierWire[];
  /**
   * Phase 6.1.5 (Bundle B) — scatter pay-anywhere payout (stringified
   * bigint, atomic units). `'0'` when fewer than 3 scatters land.
   * ALWAYS present (server contract locked 2026-05-19).
   */
  scatterPayout: string;
  /**
   * Phase 6.1.5 — session-level bonus mode AFTER this spin. ALWAYS
   * present (server contract locked 2026-05-19).
   *   • 'base'      — predict-debiting spins.
   *   • 'free-spin' — NEXT spin is free; frontend swaps button label.
   */
  mode: 'base' | 'free-spin';
  /**
   * Phase 6.1.5 — unspent free-spin balance AFTER this spin. ALWAYS
   * present (server contract locked 2026-05-19). Server-enforced cap
   * = `FREE_SPIN_RULES.CAP_REMAINING` (50).
   */
  freeSpinsRemaining: number;
  cursorAfter: number;
  predict: string;
  balance: number;
  escrowRemaining: string;
  totalStaked: string;
  totalWon: string;
  spinCount: number;
  idempotencyReplay: boolean;
}

export interface OpenSessionResponse {
  sessionId: string;
  paytableId: MachineSlug;
  currency: 'clawtokens';
  serverSeedHash: string;
  clientSeed: string;
  startingBalance: string;
  escrowAmount: string;
  predict: string;
  createdAt: string;
  /**
   * Authoritative ClawTokens balance at /session/open response time —
   * snapshotted on the server, not pulled from a stale client cache.
   * Frontend uses this as `sessionStartBalance` for PnL math.
   */
  walletBalance: number;
}

export interface CloseSessionResponse {
  sessionId: string;
  status: 'closed';
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  totalStaked: string;
  totalWon: string;
  spinCount: number;
  finalBalance: number;
  closedAt: string;
}

export interface SessionDetailResponse {
  session: {
    id: string;
    userId: string;
    paytableId: MachineSlug;
    currency: Currency;
    serverSeedHash: string;
    /** Revealed only after status !== 'open'. */
    serverSeed: string | null;
    clientSeed: string;
    nonceCounter: number;
    cursorCounter: number;
    startingBalance: string;
    currentBalance: string;
    escrowAmount: string;
    totalStaked: string;
    totalWon: string;
    status: 'open' | 'closed' | 'cancelled' | 'expired';
    mode: string;
    freeSpinsRemaining: number;
    spinCount: number;
    createdAt: string;
    lastSpinAt: string | null;
    closedAt: string | null;
  };
}

export interface SessionSpinRow {
  id: string;
  sessionId: string;
  nonce: number;
  cursorBefore: number;
  cursorAfter: number;
  predict: string;
  isFreeSpin: boolean;
  reels: SymbolId[][];
  winningLines: SerializedWinningLineWire[];
  winAmount: string;
  /** Phase 6.1.5 — per-landed-Wild multipliers. `[]` on classic-3x5. */
  wildMultipliers: SerializedWildMultiplierWire[];
  /** Phase 6.1.5 — scatter pay-anywhere (stringified bigint, atomic units). */
  scatterPayout: string;
  /** Phase 6.1.5 — free spins awarded by this spin (0 if no trigger). */
  freeSpinsAwarded?: number;
  idempotencyKey: string;
  /**
   * Phase 6.1.10 — paytable snapshot version this row was recorded under.
   * 'v1' = pre-retune (96% / ~97.5% RTP), 'v2' = post-retune (94%).
   * Verifier branches on this to avoid spurious winAmount mismatches when
   * the current engine's payouts differ from the row's historical ones.
   */
  paytableVersion?: 'v1' | 'v2';
  createdAt: string;
}

export interface SessionSpinsResponse {
  spins: SessionSpinRow[];
}

export interface PaytableResponse {
  paytableId: MachineSlug;
  symbols: ReadonlyArray<{
    id: number;
    name: string;
    emoji: string;
    color: string;
    payouts: readonly [number, number, number, number];
    isWild?: boolean;
  }>;
  lines: ReadonlyArray<{
    id: number;
    rows: readonly [number, number, number, number, number];
    color: string;
  }>;
  reelStrips: ReadonlyArray<ReadonlyArray<number>>;
  rtp: number;
}

export interface SerializedSpinVerifyResponse {
  reels: SymbolId[][];
  winningLines: SerializedWinningLineWire[];
  winAmount: string;
  freeSpinsAwarded: number;
  isFreeSpin: boolean;
  cursorAfter: number;
}

// ---------------------------------------------------------------------------
// Local SpinResult adapter — for code paths that still operate on bigints
// (useFX, recordSpin, etc).
// ---------------------------------------------------------------------------

import type { SpinResult } from './types';

export function spinResponseToSpinResult(res: SpinResponse): SpinResult {
  return {
    reels: res.reels,
    winningLines: res.winningLines.map(
      (w): WinningLine => ({
        lineIndex: w.lineIndex,
        symbols: w.symbols,
        winAmount: BigInt(w.winAmount),
        multiplier: w.multiplier,
      }),
    ),
    winAmount: BigInt(res.winAmount),
    freeSpinsAwarded: res.freeSpinsAwarded,
    isFreeSpin: res.isFreeSpin,
    // Phase 6.1.5 — wire fields are required on the locked contract;
    // classic-3x5 paytable still returns `[]` / `'0'` (server-side).
    wildMultipliers: res.wildMultipliers.map(
      (w): WildMultiplier => ({
        reelIndex: w.reelIndex,
        rowIndex: w.rowIndex,
        multiplier: w.multiplier,
      }),
    ),
    scatterPayout: BigInt(res.scatterPayout),
    cursorAfter: res.cursorAfter,
  };
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const coveKeys = {
  all: ['cove', 'slots'] as const,
  paytable: (id: MachineSlug) => [...coveKeys.all, 'paytable', id] as const,
  session: (sessionId: string) => [...coveKeys.all, 'session', sessionId] as const,
  sessionSpins: (sessionId: string) => [...coveKeys.all, 'session', sessionId, 'spins'] as const,
};

// ---------------------------------------------------------------------------
// useOpenSlotSession — POST /session/open
// ---------------------------------------------------------------------------

export interface OpenSlotSessionArgs {
  paytableId: MachineSlug;
  currency: Currency;
  /** Predict as a string of decimal digits (stringified bigint). */
  predict: string;
}

export function useOpenSlotSession() {
  return useMutation<OpenSessionResponse, CoveApiError, OpenSlotSessionArgs>({
    mutationFn: (args) =>
      coveFetch<OpenSessionResponse>('/api/cove/slots/session/open', {
        method: 'POST',
        body: JSON.stringify(args),
      }),
  });
}

// ---------------------------------------------------------------------------
// fetchCurrentSlotSession — GET /session/current
//
// Returns the user's currently-open session (if any). 404 = no open session.
// Used on slot modal mount to restore state after a page refresh. The
// response shape mirrors enough of OpenSessionResponse to call setSessionMeta
// + chip-snap without an extra round-trip.
// ---------------------------------------------------------------------------

export interface CurrentSessionResponse {
  session: {
    id:                  string;
    paytableId:          MachineSlug;
    serverSeedHash:      string;
    clientSeed:          string;
    startingBalance:     string;
    spinCount:           number;
    status:              'open' | 'closed';
    /** Free-spin state — preserved across refresh so the player doesn't lose unspent free spins. */
    mode:                'base' | 'free-spin';
    freeSpinsRemaining:  number;
  };
  walletBalance: number;
}

export async function fetchCurrentSlotSession(): Promise<CurrentSessionResponse | null> {
  try {
    return await coveFetch<CurrentSessionResponse>('/api/cove/slots/session/current', {
      method: 'GET',
    });
  } catch (err) {
    // 404 = no open session, expected. Anything else bubbles.
    if (err instanceof CoveApiError && err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// useSpin — POST /spin (idempotency-keyed)
// ---------------------------------------------------------------------------

export interface SpinArgs {
  sessionId: string;
  /** Stringified bigint. Must match session.startingBalance on the slice-3 path. */
  predict: string;
  /** Caller-minted UUID. Re-use on retry to dedupe; mint fresh on a new spin press. */
  idempotencyKey: string;
}

export function useSpin() {
  const qc = useQueryClient();
  return useMutation<SpinResponse, CoveApiError, SpinArgs>({
    mutationFn: ({ sessionId, predict, idempotencyKey }) =>
      coveFetch<SpinResponse>('/api/cove/slots/spin', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ sessionId, predict }),
      }),
    onSuccess: (_data, vars) => {
      // Invalidate session detail so any open viewer sees fresh counters.
      qc.invalidateQueries({ queryKey: coveKeys.session(vars.sessionId) });
    },
    // No retry on spin — the idempotency key is intended for caller-managed
    // retries, not blind react-query auto-retry which would mint duplicate
    // requests with the same key and hit our 409 guard on predict mismatch.
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useCloseSlotSession — POST /session/close
// ---------------------------------------------------------------------------

export interface CloseSlotSessionArgs {
  sessionId: string;
}

export function useCloseSlotSession() {
  const qc = useQueryClient();
  return useMutation<CloseSessionResponse, CoveApiError, CloseSlotSessionArgs>({
    mutationFn: ({ sessionId }) =>
      coveFetch<CloseSessionResponse>('/api/cove/slots/session/close', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: coveKeys.session(vars.sessionId) });
      qc.invalidateQueries({ queryKey: coveKeys.sessionSpins(vars.sessionId) });
    },
  });
}

// ---------------------------------------------------------------------------
// useSlotSession — GET /session/:id (Lucia-authed; owner-only)
// ---------------------------------------------------------------------------

export function useSlotSession(sessionId: string | null | undefined) {
  return useQuery<SessionDetailResponse, CoveApiError>({
    queryKey: coveKeys.session(sessionId ?? '__none__'),
    queryFn: () =>
      coveFetch<SessionDetailResponse>(`/api/cove/slots/session/${sessionId}`),
    enabled: Boolean(sessionId),
    retry: (failureCount, err) => {
      // 401/403/404 — terminal, no point retrying.
      if (err instanceof CoveApiError && [401, 403, 404].includes(err.status)) return false;
      return failureCount < 1;
    },
  });
}

// ---------------------------------------------------------------------------
// useSlotSessionSpins — GET /session/:id/spins (Lucia-authed; owner-only)
// ---------------------------------------------------------------------------

export interface UseSlotSessionSpinsArgs {
  sessionId: string | null | undefined;
  /** 1..200; defaults to 200 (max) so the per-session verifier sees everything. */
  limit?: number;
}

export function useSlotSessionSpins({ sessionId, limit = 200 }: UseSlotSessionSpinsArgs) {
  return useQuery<SessionSpinsResponse, CoveApiError>({
    queryKey: [...coveKeys.sessionSpins(sessionId ?? '__none__'), limit],
    queryFn: () =>
      coveFetch<SessionSpinsResponse>(
        `/api/cove/slots/session/${sessionId}/spins?limit=${limit}`,
      ),
    enabled: Boolean(sessionId),
    retry: (failureCount, err) => {
      if (err instanceof CoveApiError && [401, 403, 404].includes(err.status)) return false;
      return failureCount < 1;
    },
  });
}

// ---------------------------------------------------------------------------
// useSlotPaytable — GET /paytables/:id (public; cache-forever)
// ---------------------------------------------------------------------------

export function useSlotPaytable(paytableId: MachineSlug | null | undefined) {
  return useQuery<PaytableResponse, CoveApiError>({
    queryKey: coveKeys.paytable(paytableId ?? ('classic-3x5' as MachineSlug)),
    queryFn: () =>
      coveFetch<PaytableResponse>(`/api/cove/slots/paytables/${paytableId}`),
    enabled: Boolean(paytableId),
    // Paytables are immutable (provably-fair constants); cache forever.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}

// ---------------------------------------------------------------------------
// useVerifySpinRemote — POST /verify (public; pure compute)
// ---------------------------------------------------------------------------

export interface VerifySpinArgs {
  paytableId: MachineSlug;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  cursor: number;
  /** Stringified bigint. */
  predict: string;
}

export function useVerifySpinRemote() {
  return useMutation<SerializedSpinVerifyResponse, CoveApiError, VerifySpinArgs>({
    mutationFn: (args) =>
      coveFetch<SerializedSpinVerifyResponse>('/api/cove/slots/verify', {
        method: 'POST',
        body: JSON.stringify(args),
      }),
  });
}

// ---------------------------------------------------------------------------
// Friendly user-facing error mapping for common cove-route status codes.
// ---------------------------------------------------------------------------

export function describeCoveError(err: unknown): string {
  if (!(err instanceof CoveApiError)) {
    return err instanceof Error ? err.message : 'Unknown error';
  }
  switch (err.status) {
    case 400:
      // Surface specific 400 codes that the user can fix.
      if (err.code?.startsWith('insufficient_clawtokens')) {
        return 'Not enough ClawTokens for that predict.';
      }
      if (err.code === 'predict_must_equal_session_reserved_predict') {
        return 'Predict was changed mid-session. Cash out and start a new session to predict differently.';
      }
      if (err.code === 'missing_idempotency_key_header') {
        return 'Internal error: missing idempotency key. Refresh and try again.';
      }
      return err.serverMessage;
    case 401:
      return 'You need to sign in to play.';
    case 403:
      return 'That session belongs to a different account.';
    case 404:
      return 'Session not found. It may have expired.';
    case 409:
      if (err.code === 'session_already_open') {
        return 'You already have an open slot session. Cash out the existing one to start fresh.';
      }
      if (err.code?.startsWith('session_already_open_different_paytable')) {
        // Server includes openPaytable in the message body — parse for UX.
        const m = err.serverMessage.match(/open=([\w-]+)/);
        const which = m ? m[1] : 'another paytable';
        return `You have an open session on ${which}. Cash out there first, or use the Switch Table button to close it.`;
      }
      if (err.code === 'session_counter_changed_retry') {
        return 'A concurrent spin won the race. Press spin again.';
      }
      if (err.code?.startsWith('idempotency_key_reused')) {
        return 'Spin was retried with a different predict. Press spin to mint a fresh ticket.';
      }
      if (err.code?.startsWith('session_not_open')) {
        return 'That session is no longer open.';
      }
      return err.serverMessage;
    case 429:
      return 'Slow down — you can spin at most 60 times per minute.';
    case 501:
      return 'SOL/USDC cove play is coming in Phase 6.2. ClawTokens is live today.';
    default:
      return err.serverMessage || `Cove server error (${err.status}).`;
  }
}
