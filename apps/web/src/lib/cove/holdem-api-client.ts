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
    // 404 = no open table (expected). 401 = guest (no auth) — also "nothing to
    // restore"; the lazy-open path handles guests on the first Deal.
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
}

export function useCloseHoldemTable() {
  const qc = useQueryClient();
  return useMutation<CloseHoldemTableResponse, CoveApiError, CloseHoldemArgs>({
    mutationFn: ({ tableId }) =>
      coveFetch<CloseHoldemTableResponse>('/api/cove/holdem/session/close', {
        method: 'POST',
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
 * AMBIGUOUS outcome (status 0 network / 408 timeout) differs per leg, and the
 * wrong guidance is a money bug: until the in-progress-hand RESYNC endpoint
 * ships (Increment 1b), closing the modal mid-hand destroys the client's ONLY
 * copy of the live handId while the server keeps the hand in_progress — after
 * which /hand/deal 409s (hand_in_progress) AND /session/close 409s
 * (table_has_in_progress_hand) with no recovery path, stranding the buy-in
 * until manual server intervention (verified against cove-holdem.ts; real
 * wedged tables exist on prod). So ambiguous-outcome copy must NEVER instruct
 * "reopen the table" while a hand may be live. A same-decision re-press is the
 * least-bad recovery: if the move never landed it lands now (authoritative
 * state re-applies); if it landed terminally the idempotency key replays the
 * settle; if it landed non-terminally the re-press either 409s harmlessly
 * (not_human_turn) or — the imperfect case — appends as the next street's
 * decision. Imperfect, but it never strands the stack.
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
    network:
      'Network error — the deal may not have reached you. Keep this table open and press Deal again; if it says a hand is already in progress, that hand needs recovery — contact support, do not buy in again.',
    timeout:
      'The deal took too long — it may have gone through. Keep this table open and press Deal again; if it says a hand is already in progress, that hand needs recovery — contact support, do not buy in again.',
  },
  action: {
    // Honest about the imperfect retry: the server appends a re-press as the
    // player's NEXT due decision when the first press actually registered
    // (isHandTerminal checks priorActions only), so a blind retry can act on a
    // later street than the player thinks. Check/fold are the safe probes:
    // an illegal check 400s harmlessly; fold is always legal and only forfeits.
    network:
      'Network error — your move may not have gone through. Keep this table open: closing mid-hand can strand your buy-in. Acting again catches the table up, but if your first press DID register, the retry counts as your NEXT decision — when unsure, check or fold rather than bet.',
    timeout:
      'The table took too long to respond — your move may have already registered. Keep this table open: closing mid-hand can strand your buy-in. Acting again catches the table up, but if your first press registered, the retry counts as your NEXT decision — when unsure, check or fold rather than bet.',
  },
  close: {
    network:
      'Network error — the cash-out may not have gone through. Try Walk Away again in a moment; if the table already closed, your chips were credited.',
    timeout:
      'Cash-out took too long — it may have gone through. Try Walk Away again in a moment; if the table already closed, your chips were credited.',
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
        // The UI gates Deal on phase==='idle' (no visible hand), so this 409
        // only surfaces when THIS window can't see the in-progress hand: either
        // it's live in another window (finish it there), or the deal response
        // was lost and no resync exists yet (the wedge state — server recovery
        // only). Don't tell the player to "finish" a hand they can't see.
        return 'A hand is already in progress on this table. If it is open in another window, finish it there; otherwise it needs server recovery — contact support. Your chips are not lost — do not buy in again.';
      }
      if (err.code?.startsWith('table_has_in_progress_hand')) {
        // Same two cases via Walk Away: handleWalkAway client-gates on a
        // visible live hand, so this server 409 means the hand lives in
        // another window or was lost to the wedge.
        return 'Cash-out is blocked by an unfinished hand. If it is open in another window, finish it there; otherwise it needs server recovery — contact support. Your chips are not lost.';
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
