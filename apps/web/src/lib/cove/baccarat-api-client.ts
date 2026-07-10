'use client';

/**
 * Phase 6.6.1 — Baccarat (Punto Banco) API client (TanStack Query hooks +
 * thin error mapping).
 *
 * Mirrors `blackjack-api-client.ts` / `holdem-api-client.ts`: every
 * stringified-bigint money field stays a STRING on the wire (the client only
 * `Number()`s a balance where it provably fits a JS number for display);
 * `credentials: 'include'` rides the Lucia cookie; the caller mints an
 * `Idempotency-Key` per coup so a retry dedupes instead of dealing/crediting
 * a second coup.
 *
 * Server is AUTHORITATIVE — Punto Banco has NO player decisions, so the client
 * sends ONLY its bet (player/banker/tie) + stake; the server deals + resolves +
 * settles the whole coup and the response is rendered verbatim. There is NO
 * client-side shoe, NO tableau, NO payout/commission math.
 *
 * The wire types live in `@clawville/shared` (cove-baccarat.ts) so the API
 * route, the verifier, and the client stay one-shape. CoveApiError is reused
 * from slot-api-client (same `{ error?, message? }` Hono body shape).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BaccaratBet,
  BaccaratCurrency,
  OpenBaccaratShoeResponse,
  CurrentBaccaratShoeResponse,
  BaccaratShoeDetailResponse,
  BaccaratCoupResponse,
  BaccaratReshuffledBody,
  CloseBaccaratShoeResponse,
} from '@clawville/shared';

import { CoveApiError } from './slot-api-client';
export { CoveApiError } from './slot-api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Same contract as the blackjack/holdem/slots coveFetch (kept local so a future
 * baccarat-only header/retry tweak doesn't perturb the other hot paths). The
 * 409 reshuffle body + 501 currency-seam body are surfaced on the error so
 * callers can branch without a second parse.
 */
async function coveFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...init, credentials: 'include', headers });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // empty / non-JSON body — fall through with HTTP <status> message
    }
    const obj = (body ?? {}) as { error?: string; message?: string } & Record<string, unknown>;
    const serverMessage = obj.message || obj.error || `HTTP ${res.status}`;
    const code =
      typeof serverMessage === 'string' ? serverMessage.split(/[\s:]/)[0] || null : null;
    const err = new CoveApiError(res.status, serverMessage, code);
    (err as CoveApiError & { body?: unknown }).body = obj;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull a `{reshuffled:true}` body off a 409 CoveApiError (or null). */
export function reshuffledBody(err: unknown): BaccaratReshuffledBody | null {
  if (!(err instanceof CoveApiError) || err.status !== 409) return null;
  const body = (err as CoveApiError & { body?: unknown }).body as
    | Partial<BaccaratReshuffledBody>
    | undefined;
  return body && body.reshuffled === true ? (body as BaccaratReshuffledBody) : null;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const baccaratKeys = {
  all: ['cove', 'baccarat'] as const,
  shoe: (shoeId: string) => [...baccaratKeys.all, 'shoe', shoeId] as const,
};

// ---------------------------------------------------------------------------
// useOpenBaccaratShoe — POST /session/open
// ---------------------------------------------------------------------------

export interface OpenBaccaratArgs {
  currency?: BaccaratCurrency;
}

export function useOpenBaccaratShoe() {
  return useMutation<OpenBaccaratShoeResponse, CoveApiError, OpenBaccaratArgs>({
    mutationFn: (args) =>
      coveFetch<OpenBaccaratShoeResponse>('/api/cove/baccarat/session/open', {
        method: 'POST',
        body: JSON.stringify({ currency: args.currency ?? 'clawtoken' }),
      }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// fetchCurrentBaccaratShoe — GET /session/current (Lucia auth; 404/401 = none)
// ---------------------------------------------------------------------------

export async function fetchCurrentBaccaratShoe(): Promise<CurrentBaccaratShoeResponse | null> {
  try {
    return await coveFetch<CurrentBaccaratShoeResponse>('/api/cove/baccarat/session/current', {
      method: 'GET',
    });
  } catch (err) {
    // 404 = no open shoe (expected). 401 = guest (no auth) — also "nothing to
    // restore"; the lazy-open path handles guests on the first coup.
    if (err instanceof CoveApiError && (err.status === 404 || err.status === 401)) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// fetchBaccaratShoe — GET /session/:id (Lucia auth, owner-only)
// ---------------------------------------------------------------------------

export async function fetchBaccaratShoe(shoeId: string): Promise<BaccaratShoeDetailResponse> {
  return coveFetch<BaccaratShoeDetailResponse>(
    `/api/cove/baccarat/session/${encodeURIComponent(shoeId)}`,
    { method: 'GET' },
  );
}

// ---------------------------------------------------------------------------
// usePlayBaccaratCoup — POST /coup (idempotency-keyed)
// ---------------------------------------------------------------------------

export interface PlayBaccaratCoupArgs {
  shoeId: string;
  bet: BaccaratBet;
  /** Stake in CT (5..500). */
  stake: number;
  /** Caller-minted UUID; reuse on retry within one coup press. */
  idempotencyKey: string;
}

export function usePlayBaccaratCoup() {
  const qc = useQueryClient();
  return useMutation<BaccaratCoupResponse, CoveApiError, PlayBaccaratCoupArgs>({
    mutationFn: ({ shoeId, bet, stake, idempotencyKey }) =>
      coveFetch<BaccaratCoupResponse>('/api/cove/baccarat/coup', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ shoeId, bet, stake }),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: baccaratKeys.shoe(res.shoeId) });
    },
    // No blind react-query retry — the idempotency key is caller-managed.
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useCloseBaccaratShoe — POST /session/close (Lucia auth → reveals seed)
// ---------------------------------------------------------------------------

export interface CloseBaccaratArgs {
  shoeId: string;
}

export function useCloseBaccaratShoe() {
  const qc = useQueryClient();
  return useMutation<CloseBaccaratShoeResponse, CoveApiError, CloseBaccaratArgs>({
    mutationFn: ({ shoeId }) =>
      coveFetch<CloseBaccaratShoeResponse>('/api/cove/baccarat/session/close', {
        method: 'POST',
        body: JSON.stringify({ shoeId }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: baccaratKeys.shoe(vars.shoeId) });
    },
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Friendly user-facing error mapping (baccarat-specific codes + shared reuse).
// ---------------------------------------------------------------------------

export function describeBaccaratError(err: unknown): string {
  if (!(err instanceof CoveApiError)) {
    return err instanceof Error ? err.message : 'Unknown error';
  }
  switch (err.status) {
    case 400:
      if (err.code?.startsWith('insufficient_clawtokens')) {
        return 'Not enough vCLAW for that bet.';
      }
      if (err.code?.startsWith('insufficient_guest_demo_balance')) {
        return 'Out of demo vCLAW. Sign up to keep playing with a real balance.';
      }
      if (err.code === 'bet_exceeds_supported_range') {
        return 'That bet is out of range. Bets are 5–500 vCLAW.';
      }
      if (err.code?.startsWith('baccarat_engine_error')) {
        return 'Could not deal that coup — start a fresh shoe and try again.';
      }
      return err.serverMessage;
    case 401:
      return 'You need to sign in to do that.';
    case 403:
      return 'That table belongs to a different player.';
    case 404:
      return 'Shoe not found — it may have expired. Start a new shoe.';
    case 409:
      if (reshuffledBody(err)) {
        return 'Shoe is 75% dealt — shuffling a fresh shoe.';
      }
      if (err.code?.startsWith('shoe_not_open')) {
        return 'That shoe is no longer open. Start a new shoe.';
      }
      return err.serverMessage;
    case 429:
      return 'Slow down a moment, then try again.';
    case 501:
      return 'SOL/USDC baccarat is coming later. vCLAW play is live today.';
    default:
      return err.serverMessage || `Cove server error (${err.status}).`;
  }
}
