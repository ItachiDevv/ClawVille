'use client';

/**
 * Phase 6.5.1 — Hold'em API client (TanStack Query hooks + thin error mapping).
 *
 * Replaces the 6.5.0 client-side mock engine (`holdem-mock-engine.ts`). Mirrors
 * `blackjack-api-client.ts`: every stringified-bigint money field stays a
 * STRING on the wire (the client only `Number()`s where it provably fits a JS
 * number for display); `credentials: 'include'` rides the Lucia cookie; the
 * caller mints an `Idempotency-Key` per deal / per terminal action so retries
 * dedupe instead of double-crediting.
 *
 * Server is AUTHORITATIVE — the client sends ONLY the human's decision
 * (fold|check|call|bet|raise + amount). It NEVER computes cards, pots,
 * side-pots, winners, or payouts. Every response is rendered verbatim.
 *
 * The wire types live in `@clawville/shared` (cove-holdem.ts) so the API route,
 * the verifier, and the client stay one-shape. CoveApiError is reused from
 * slot-api-client (same `{ error?, message? }` Hono body shape).
 *
 * Fingerprint (Increment 1b, 2026-07-03): every request now injects
 * `X-CV-Fingerprint` (mirrors slot-api-client). Guest Hold'em previously keyed
 * to the server's unstable UA+/24 fallback — the exact bug the slots
 * fingerprint hotfix closed on 2026-06-21 — so a guest's open table, resync
 * reads, and idempotency replay could all key to a DIFFERENT subject after an
 * IP churn. Sending the stable browser fingerprint fixes that for Hold'em too.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  OpenHoldemTableResponse,
  CurrentHoldemTableResponse,
  HoldemTableDetailResponse,
  HoldemDealResponse,
  HoldemActionResponse,
  HoldemSettledResponse,
  CloseHoldemTableResponse,
  HoldemActionType,
  HoldemCurrency,
} from '@clawville/shared';

import { CoveApiError } from './slot-api-client';
import { getFingerprint } from '../fingerprint';
export { CoveApiError } from './slot-api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Hard ceiling on a single Hold'em request before we abort. Without this a
 * stalled Deal/Action leaves the react-query mutation `isPending=true` (and the
 * modal `busyRef=true`) FOREVER — every button disabled, "Dealing…" frozen with
 * no recovery. Aborting rejects the mutation so the modal catch/finally runs and
 * the UI un-freezes. All holdem paths share this coveFetch, so all are covered.
 */
const COVE_HOLDEM_FETCH_TIMEOUT_MS = 15_000;

/**
 * Same contract as the blackjack/slots coveFetch (kept local so a future
 * Hold'em-only header/retry tweak doesn't perturb the other hot paths). The
 * 501 currency-seam body is surfaced on the error so callers can branch.
 *
 * Every request is bounded by a ~15s AbortController timeout; an abort surfaces
 * as a CoveApiError(408, 'request_timeout') and a raw network reject as
 * CoveApiError(0, 'network_error') so both flow through describeHoldemError
 * instead of leaking a raw DOMException/TypeError to the toast.
 */
async function coveFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  // Bound the request. Compose (never clobber) a caller-supplied signal — if the
  // caller aborts, we abort too; our timeout aborts independently.
  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), COVE_HOLDEM_FETCH_TIMEOUT_MS);

  // The try covers fetch AND the response-body read (res.json()); the timeout
  // (and any caller abort) therefore bounds the WHOLE request, so a post-header
  // body-stream stall/drop aborts instead of hanging forever. clearTimeout runs
  // only after the body is parsed.
  try {
    // Stable browser fingerprint → server `fpHash` tier-1 (mirrors slot/
    // baccarat/blackjack coveFetch). Empty on SSR / FingerprintJS load
    // failure — getFingerprint() never rejects (internal try/catch), but it
    // stays INSIDE this try anyway so any unexpected reject still maps
    // through the outer catch to a friendly CoveApiError, never a raw throw.
    // NOTE: the AbortController only cancels the fetch below, NOT this await —
    // so this lookup is not literally bounded by the 15s ceiling. It's a fast,
    // memoized, local (non-network) FingerprintJS computation, so it is not a
    // hang risk; the ceiling still bounds the request itself.
    if (!headers['X-CV-Fingerprint']) {
      const fp = await getFingerprint();
      if (fp) headers['X-CV-Fingerprint'] = fp;
    }
    const res = await fetch(url, { ...init, credentials: 'include', headers, signal: controller.signal });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch (parseErr) {
        // A body-read ABORT (our 15s ceiling firing mid-error-body) must surface
        // as the 408 timeout, not the raw HTTP status — rethrow to the outer
        // catch so it maps to 'request_timeout'. Otherwise it is an empty /
        // non-JSON body — fall through with the HTTP <status> message.
        if ((parseErr as { name?: string } | undefined)?.name === 'AbortError') throw parseErr;
      }
      const obj = (body ?? {}) as { error?: string; message?: string } & Record<string, unknown>;
      const serverMessage = obj.message || obj.error || `HTTP ${res.status}`;
      const code =
        typeof serverMessage === 'string' ? serverMessage.split(/[\s:]/)[0] || null : null;
      const apiErr = new CoveApiError(res.status, serverMessage, code);
      (apiErr as CoveApiError & { body?: unknown }).body = obj;
      throw apiErr;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    // A real server error (built above) passes through UNCHANGED — never
    // re-mapped to 408/0, so the 501 currency seam / 4xx codes keep their real
    // status. An AbortError is our 15s ceiling (or a caller cancel); any other
    // reject is a network / body-stream failure. Wrap BOTH into a CoveApiError so
    // describeHoldemError renders friendly copy instead of a raw DOMException/
    // TypeError reaching the UI.
    if (err instanceof CoveApiError) throw err;
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      throw new CoveApiError(408, 'The table took too long to respond — try again.', 'request_timeout');
    }
    throw new CoveApiError(0, 'Network error — check your connection and try again.', 'network_error');
  } finally {
    clearTimeout(timeout);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

// ---------------------------------------------------------------------------
// Type guards (deal/action responses are unions — the modal branches on these)
// ---------------------------------------------------------------------------

export function isHoldemSettled(
  r: HoldemDealResponse | HoldemActionResponse,
): r is HoldemSettledResponse {
  return r.status === 'settled';
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const holdemKeys = {
  all: ['cove', 'holdem'] as const,
  table: (tableId: string) => [...holdemKeys.all, 'table', tableId] as const,
};

// ---------------------------------------------------------------------------
// useOpenHoldemTable — POST /session/open
// ---------------------------------------------------------------------------

export interface OpenHoldemArgs {
  currency?: HoldemCurrency;
  /** Buy-in in CT (20..500); server defaults to 100 when omitted. */
  buyIn?: number;
}

export function useOpenHoldemTable() {
  return useMutation<OpenHoldemTableResponse, CoveApiError, OpenHoldemArgs>({
    mutationFn: (args) =>
      coveFetch<OpenHoldemTableResponse>('/api/cove/holdem/session/open', {
        method: 'POST',
        body: JSON.stringify({
          currency: args.currency ?? 'clawtoken',
          ...(args.buyIn !== undefined ? { buyIn: args.buyIn } : {}),
        }),
      }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// fetchCurrentHoldemTable — GET /session/current (Lucia auth; 404/401 = none)
// ---------------------------------------------------------------------------

export async function fetchCurrentHoldemTable(): Promise<CurrentHoldemTableResponse | null> {
  try {
    return await coveFetch<CurrentHoldemTableResponse>('/api/cove/holdem/session/current', {
      method: 'GET',
    });
  } catch (err) {
    // 404 = no open table (expected — ledger subject OR guest; guests are
    // resolved server-side via fpHash and get a real 200/404, not a 401).
    // 401 is kept as a defensive fallback for an unrecognized subject — not
    // expected on this route today, but harmless to treat the same as
    // "nothing to restore" (the lazy-open path handles it on the first Deal).
    if (err instanceof CoveApiError && (err.status === 404 || err.status === 401)) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// fetchHoldemTable — GET /session/:id (Lucia auth, owner-only)
// ---------------------------------------------------------------------------

export async function fetchHoldemTable(tableId: string): Promise<HoldemTableDetailResponse> {
  return coveFetch<HoldemTableDetailResponse>(
    `/api/cove/holdem/session/${encodeURIComponent(tableId)}`,
    { method: 'GET' },
  );
}

// ---------------------------------------------------------------------------
// useDealHoldemHand — POST /hand/deal (idempotency-keyed)
// ---------------------------------------------------------------------------

export interface DealHoldemArgs {
  tableId: string;
  /** Caller-minted UUID; reuse on retry within one Deal press. */
  idempotencyKey: string;
}

export function useDealHoldemHand() {
  return useMutation<HoldemDealResponse, CoveApiError, DealHoldemArgs>({
    mutationFn: ({ tableId, idempotencyKey }) =>
      coveFetch<HoldemDealResponse>('/api/cove/holdem/hand/deal', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ tableId }),
      }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useHoldemAction — POST /action (idempotency-keyed)
// ---------------------------------------------------------------------------

export interface HoldemActionArgs {
  handId: string;
  action: HoldemActionType;
  /** TOTAL street commitment after a bet/raise (required for bet/raise). */
  amount?: number;
  /** Caller-minted UUID; a terminal action that settles dedupes on retry. */
  idempotencyKey: string;
}

export function useHoldemAction() {
  const qc = useQueryClient();
  return useMutation<HoldemActionResponse, CoveApiError, HoldemActionArgs>({
    mutationFn: ({ handId, action, amount, idempotencyKey }) =>
      coveFetch<HoldemActionResponse>('/api/cove/holdem/action', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          handId,
          action,
          ...(amount !== undefined ? { amount } : {}),
        }),
      }),
    onSuccess: (res) => {
      if (res.status === 'settled') {
        qc.invalidateQueries({ queryKey: holdemKeys.table(res.tableId) });
      }
    },
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useCloseHoldemTable — POST /session/close (Lucia auth → reveals seed + cashes out)
// ---------------------------------------------------------------------------

export interface CloseHoldemArgs {
  tableId: string;
  /**
   * Caller-minted UUID; reuse on retry of the SAME close (mirrors deal/
   * action). The server's real anchor is the table's open→closed status flip
   * under FOR UPDATE — this key is accepted + logged for audit only, not
   * compared — but sending it keeps the wire contract consistent with the
   * other two idempotency-keyed legs.
   */
  idempotencyKey: string;
}

export function useCloseHoldemTable() {
  const qc = useQueryClient();
  return useMutation<CloseHoldemTableResponse, CoveApiError, CloseHoldemArgs>({
    mutationFn: ({ tableId, idempotencyKey }) =>
      coveFetch<CloseHoldemTableResponse>('/api/cove/holdem/session/close', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ tableId }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: holdemKeys.table(vars.tableId) });
    },
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Friendly user-facing error mapping (Hold'em codes + shared reuse).
// ---------------------------------------------------------------------------

/**
 * Which request leg produced the error. The honest recovery guidance for an
 * AMBIGUOUS outcome (status 0 network / 408 timeout) differs per leg.
 *
 * Increment 1b (2026-07-03) shipped the resync surface that closes the wedge
 * documented in memory `holdem-nonterminal-action-not-idempotent`: `GET
 * /session/current` + `GET /session/:id` now return the table's live
 * in-progress hand (`hand`, owner-only, street-truncated board, no seed
 * leak); `POST /hand/deal` REPLAYS the same hand on a reused Idempotency-Key
 * instead of 409ing; a duplicate TERMINAL `/action` REPLAYS the settle
 * instead of 409ing; and `POST /session/close` REPLAYS the original cash-out
 * on a retry after the close already landed. HoldemModal's `tryResync` calls
 * this surface on every ambiguous deal/action outcome (and eager-restore
 * calls it on modal open), so a lost NON-terminal action is now recovered by
 * adopting the server's authoritative live state — not just the old
 * imperfect blind re-press. Reopening a table with a live hand also resumes
 * it automatically (eager-restore), so closing the modal mid-hand no longer
 * strands the buy-in; the operator-side `apps/api/scripts/cove/
 * unwedge-holdem-tables.ts` script remains as a break-glass fallback, not the
 * primary recovery path. The copy below is written for what CAN still go
 * wrong post-1b: the resync itself failing or finding no live hand (the hand
 * may have simply settled — we never invent a settled outcome client-side)
 * and the genuine multi-window case (a hand truly live in a different tab).
 */
export type HoldemRequestLeg = 'open' | 'deal' | 'action' | 'close';

const AMBIGUOUS_OUTCOME_COPY: Record<HoldemRequestLeg, { network: string; timeout: string }> = {
  open: {
    network:
      'Network error — the buy-in may not have gone through. Check your connection and try again; if it did go through, your table resumes automatically.',
    timeout:
      'Opening the table took too long — if the buy-in went through, your table resumes automatically. Try again in a moment.',
  },
  deal: {
    // Shown only when tryResync (Increment 1b) already tried and found no
    // live hand to adopt — i.e. the deal never landed, or it landed and the
    // hand already settled.
    network:
      'Network error — the deal may not have gone through, or it landed and the hand already settled. Press Deal again; if a hand is open in another window, finish it there first.',
    timeout:
      'The deal took too long to respond — it may have gone through, or the hand already settled. Press Deal again; if a hand is open in another window, finish it there first.',
  },
  action: {
    // Shown only when tryResync (Increment 1b) already tried and found no
    // live hand to adopt for THIS window. A same-decision re-press stays the
    // right move: if it never landed it lands now; if it landed terminally
    // the idempotency key replays the settle instead of double-charging.
    network:
      'Network error — your move may not have gone through. Press it again — if it already landed, the server replays the same outcome instead of double-charging. We just tried to reconnect to the live hand automatically; if a hand is open in another window, finish it there.',
    timeout:
      'The table took too long to respond — your move may have already registered. Press it again — if it already landed, the server replays the same outcome instead of double-charging. We just tried to reconnect to the live hand automatically; if a hand is open in another window, finish it there.',
  },
  close: {
    // POST /session/close now REPLAYS the original cash-out on a retry after
    // the close already landed (Increment 1b) — a retry is always safe.
    network:
      'Network error — the cash-out may not have gone through. Try Walk Away again in a moment; a retry replays the same result if it already landed — your chips are never lost.',
    timeout:
      'Cash-out took too long — it may have gone through. Try Walk Away again in a moment; a retry replays the same result if it already landed — your chips are never lost.',
  },
};

export function describeHoldemError(err: unknown, leg: HoldemRequestLeg = 'action'): string {
  if (!(err instanceof CoveApiError)) {
    return err instanceof Error ? err.message : 'Unknown error';
  }
  switch (err.status) {
    case 0:
      return AMBIGUOUS_OUTCOME_COPY[leg].network;
    case 408:
      return AMBIGUOUS_OUTCOME_COPY[leg].timeout;
    case 400:
      if (err.code?.startsWith('insufficient_clawtokens')) {
        return 'Not enough ClawTokens to buy in. Buy-in is 20–500 CT.';
      }
      if (err.code?.startsWith('guest_buyin_exceeds_demo_grant')) {
        return 'Guests get a 100 demo-CT stack. Sign up to buy in for more.';
      }
      if (err.code?.startsWith('stack_too_low_to_play')) {
        return 'Your stack is too low for another hand. Walk away to cash out, then re-buy.';
      }
      if (err.code === 'bet_requires_amount' || err.code === 'raise_requires_amount') {
        return 'Pick a bet/raise amount first.';
      }
      if (err.code?.startsWith('illegal_action') || err.code?.startsWith('holdem_engine_error')) {
        return 'That move is not legal right now — adjust your amount and try again.';
      }
      return err.serverMessage;
    case 401:
      return 'You need to sign in to do that.';
    case 403:
      return 'That table belongs to a different player.';
    case 404:
      return 'Table or hand not found — it may have expired. Start a new table.';
    case 409:
      if (err.code?.startsWith('hand_in_progress')) {
        // The UI gates Deal on phase==='idle', and eager-restore + the
        // rehydrate-on-ambiguous resync (Increment 1b) now pull ANY live
        // hand for this table into `live` on open/reopen/retry — so this 409
        // means the hand is live in a DIFFERENT window/tab that hasn't
        // synced here yet.
        return "A hand is already in progress on this table. If it's open in another window, finish it there — reopening this table resyncs to it automatically.";
      }
      if (err.code?.startsWith('table_has_in_progress_hand')) {
        // Same reasoning via Walk Away: handleWalkAway client-gates on a
        // visible live hand, so this server 409 means the hand is live in a
        // different window that hasn't synced here yet.
        return "Cash-out is blocked by an unfinished hand. If it's open in another window, finish it there — reopening this table resyncs to it automatically.";
      }
      if (err.code?.startsWith('not_human_turn')) {
        return "It's not your turn — the hand already resolved.";
      }
      if (err.code?.startsWith('table_not_open')) {
        return 'That table is closed. Start a new one.';
      }
      return err.serverMessage;
    case 429:
      return 'Slow down a moment, then try again.';
    case 501:
      return 'SOL/USDC Hold\'em is coming later. ClawTokens play is live today.';
    default:
      return err.serverMessage || `Cove server error (${err.status}).`;
  }
}
