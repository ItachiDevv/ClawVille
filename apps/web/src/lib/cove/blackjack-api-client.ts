'use client';

/**
 * Phase 6.4.1 — blackjack API client (TanStack Query hooks + wire types).
 *
 * Replaces the 6.4.0 no-op stub. Mirrors `slot-api-client.ts`: every
 * stringified-bigint money field stays a STRING on the wire (the client only
 * `Number()`s a balance where it provably fits in a JS number for display);
 * `credentials: 'include'` rides the Lucia cookie; the caller mints the
 * `Idempotency-Key` per deal / per terminal action so retries dedupe.
 *
 * Server is AUTHORITATIVE — the client sends ONLY its decision + bet, never
 * cards/outcomes/payouts. Every response is rendered verbatim; the modal never
 * computes a payout or settles a hand locally.
 *
 * The wire types live HERE (next to the hooks) exactly like SlotResponse lives
 * in slot-api-client.ts — the cross-package CARD/OUTCOME primitives come from
 * `@clawville/shared` so the API route + verifier + (6.4.2) connection
 * SKILL.md stay one-shape with the client.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BlackjackCard,
  BlackjackActionType,
  SerializedBlackjackHandResult,
} from './blackjack-types';

// ---------------------------------------------------------------------------
// Env + shared fetch helper (re-uses the slots error model)
// ---------------------------------------------------------------------------

import { CoveApiError } from './slot-api-client';
export { CoveApiError } from './slot-api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Same contract as slot-api-client's coveFetch (kept local so a future
 * blackjack-only header/retry tweak doesn't perturb the slots hot path).
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
    // The 409 reshuffle response carries `reshuffled:true` in the BODY (not
    // an error string); surface the raw body on the error so callers can
    // branch on it without a second parse.
    const err = new CoveApiError(res.status, serverMessage, code);
    (err as CoveApiError & { body?: unknown }).body = obj;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wire types — mirror apps/api/src/routes/cove-blackjack.ts verbatim.
// ---------------------------------------------------------------------------

/** Public shoe shape (serverSeed redacted while status='open'). */
export interface BlackjackShoeWire {
  id: string;
  userId: string | null;
  currency: string;
  serverSeedHash: string;
  clientSeed: string;
  handCounter: number;
  cursorCounter: number;
  dealtCount: number;
  startingBalance: string;
  currentBalance: string;
  totalBet: string;
  totalPayout: string;
  status: 'open' | 'closed';
  handsPlayed: number;
  createdAt: string;
  lastHandAt: string | null;
  closedAt: string | null;
  /** null while status='open' (revealing it would leak future cards). */
  serverSeed: string | null;
}

export interface OpenShoeResponse {
  shoe: BlackjackShoeWire;
  walletBalance: number;
}

export type CurrentShoeResponse = OpenShoeResponse;

export interface ShoeDetailResponse {
  shoe: BlackjackShoeWire;
}

/** In-progress response from POST /hand/deal (non-natural). */
export interface DealInProgressResponse {
  handId: string;
  shoeId: string;
  handIndex: number;
  bet: string;
  playerHand: BlackjackCard[];
  dealerUpcard: BlackjackCard;
  insuranceOffered: boolean;
  tookInsurance: boolean;
  /**
   * Balance AFTER the deal-time stake commit (Phase 6.4.1 finding #3). The base
   * bet (+ deal-time insurance) is debited when the cards are dealt, so this
   * reflects the post-stake balance — the modal updates the HUD immediately
   * instead of waiting for settle. `undefined` only on older API builds.
   */
  balance?: number;
  status: 'in_progress';
}

/** In-progress response from POST /action (non-terminal decision). */
export interface ActionInProgressResponse {
  handId: string;
  status: 'in_progress';
  playerHands: Array<{
    cards: BlackjackCard[];
    total: number;
    isSoft: boolean;
    isBust: boolean;
  }>;
  dealerUpcard: BlackjackCard;
  didSplit: boolean;
}

/**
 * GET /hand/current — the authoritative in-progress hand's VISIBLE view, or
 * `{ hand: null }` when no hand is live (the prior hand settled). Used by the
 * Autonomous driver to RESTORE the real server hand after a stale 409 instead of
 * stranding on a cleared local view. Upcard only (never the hole card/seed).
 */
export interface CurrentHandLive {
  handId: string;
  shoeId: string;
  handIndex: number;
  status: 'in_progress';
  playerHands: Array<{
    cards: BlackjackCard[];
    total: number;
    isSoft: boolean;
    isBust: boolean;
  }>;
  dealerUpcard: BlackjackCard | null;
  didSplit: boolean;
  insuranceOffered: boolean;
  tookInsurance: boolean;
  bet: string;
}
export interface CurrentHandNone {
  hand: null;
  shoeId: string;
}
export type CurrentHandResponse = CurrentHandLive | CurrentHandNone;

/** True when GET /hand/current returned a live in-progress hand (not `{hand:null}`). */
export function isCurrentHandLive(r: CurrentHandResponse): r is CurrentHandLive {
  return (r as CurrentHandLive).status === 'in_progress';
}

/** Response from POST /action with action:'insure'. */
export interface InsureResponse {
  handId: string;
  tookInsurance: true;
  status: 'in_progress';
}

/** Settled response (terminal action, natural, or idempotent replay). */
export interface SettledHandResponse {
  handId: string;
  shoeId: string;
  handIndex: number;
  status: 'settled';
  outcome: SerializedBlackjackHandResult;
  balance: number;
  totalBet: string;
  totalPayout: string;
  net: string;
  dealtCount: number;
  reshuffleSuggested: boolean;
  idempotencyReplay: boolean;
  /** Present (true) when a natural settled inline on the deal round-trip. */
  dealtImmediately?: boolean;
}

/** /hand/deal returns either an in-progress hand OR a settled natural. */
export type DealResponse = DealInProgressResponse | SettledHandResponse;
/** /action returns in-progress, an insure ack, or a settled hand. */
export type ActionResponse =
  | ActionInProgressResponse
  | InsureResponse
  | SettledHandResponse;

export interface CloseShoeResponse {
  shoeId: string;
  status: 'closed';
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  handsPlayed: number;
  totalBet: string;
  totalPayout: string;
  closedAt: string;
}

/** 409 body returned by /hand/deal when penetration >= 75% (open a new shoe). */
export interface ReshuffledBody {
  reshuffled: true;
  message: string;
  dealtCount: number;
  threshold: number;
}

// ---------------------------------------------------------------------------
// Type guards (response is a union — the modal branches on these)
// ---------------------------------------------------------------------------

export function isSettled(r: DealResponse | ActionResponse): r is SettledHandResponse {
  return r.status === 'settled';
}

export function isInsureAck(r: ActionResponse): r is InsureResponse {
  return r.status === 'in_progress' && 'tookInsurance' in r && r.tookInsurance === true;
}

export function isActionInProgress(r: ActionResponse): r is ActionInProgressResponse {
  return r.status === 'in_progress' && 'playerHands' in r;
}

/** Pull a `{reshuffled:true}` body off a 409 CoveApiError (or null). */
export function reshuffledBody(err: unknown): ReshuffledBody | null {
  if (!(err instanceof CoveApiError) || err.status !== 409) return null;
  const body = (err as CoveApiError & { body?: unknown }).body as
    | Partial<ReshuffledBody>
    | undefined;
  return body && body.reshuffled === true ? (body as ReshuffledBody) : null;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const blackjackKeys = {
  all: ['cove', 'blackjack'] as const,
  shoe: (shoeId: string) => [...blackjackKeys.all, 'shoe', shoeId] as const,
};

// ---------------------------------------------------------------------------
// useOpenBlackjackShoe — POST /session/open
// ---------------------------------------------------------------------------

export interface OpenShoeArgs {
  currency?: 'clawtoken' | 'sol' | 'usdc';
}

export function useOpenBlackjackShoe() {
  return useMutation<OpenShoeResponse, CoveApiError, OpenShoeArgs>({
    mutationFn: (args) =>
      coveFetch<OpenShoeResponse>('/api/cove/blackjack/session/open', {
        method: 'POST',
        body: JSON.stringify({ currency: args.currency ?? 'clawtoken' }),
      }),
  });
}

// ---------------------------------------------------------------------------
// fetchCurrentBlackjackShoe — GET /session/current (Lucia auth; 404 = none)
// ---------------------------------------------------------------------------

export async function fetchCurrentBlackjackShoe(): Promise<CurrentShoeResponse | null> {
  try {
    return await coveFetch<CurrentShoeResponse>('/api/cove/blackjack/session/current', {
      method: 'GET',
    });
  } catch (err) {
    // 404 = no open shoe (expected). 401 = guest (no auth) — also "no shoe
    // to restore"; the lazy-open path handles guests on first Deal.
    if (err instanceof CoveApiError && (err.status === 404 || err.status === 401)) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// fetchCurrentBlackjackHand — GET /hand/current (Lucia auth)
//
// Returns the authoritative in-progress hand's visible view, or CurrentHandNone
// (`{hand:null}`) when the prior hand settled. The Autonomous driver uses this to
// RESTORE the real server hand after a stale 409 instead of stranding on a
// cleared local view. A 404 (no open shoe) / 401 (guest) resolves to null, which
// the caller treats as "no live hand to restore" — same as CurrentHandNone.
// ---------------------------------------------------------------------------

export async function fetchCurrentBlackjackHand(): Promise<CurrentHandResponse | null> {
  try {
    return await coveFetch<CurrentHandResponse>('/api/cove/blackjack/hand/current', {
      method: 'GET',
    });
  } catch (err) {
    if (err instanceof CoveApiError && (err.status === 404 || err.status === 401)) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// useDealHand — POST /hand/deal (idempotency-keyed)
// ---------------------------------------------------------------------------

export interface DealArgs {
  shoeId: string;
  bet: number;
  insurance?: boolean;
  /** Caller-minted UUID; reuse on retry within one Deal press. */
  idempotencyKey: string;
  /**
   * OPTIONAL stale-agent-deal precondition. Set ONLY by the Autonomous driver
   * (threaded from /agent/decide's `expectedHandsPlayed`); the server rejects
   * with 409 stale_agent_deal if a hand was dealt since the agent decided. Human
   * manual deals MUST omit this so /hand/deal stays unconditional for them.
   */
  expectedHandsPlayed?: number;
}

export function useDealHand() {
  return useMutation<DealResponse, CoveApiError, DealArgs>({
    mutationFn: ({ shoeId, bet, insurance, idempotencyKey, expectedHandsPlayed }) =>
      coveFetch<DealResponse>('/api/cove/blackjack/hand/deal', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          shoeId,
          bet,
          insurance: insurance ?? false,
          // Only included for the agent-driven deal; undefined keys are dropped by
          // JSON.stringify so human manual deals send the legacy unconditional body.
          ...(expectedHandsPlayed !== undefined ? { expectedHandsPlayed } : {}),
        }),
      }),
    // No blind react-query retry — the idempotency key is caller-managed.
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useBlackjackAction — POST /action (idempotency-keyed on terminal actions)
// ---------------------------------------------------------------------------

export interface PlayerActionArgs {
  handId: string;
  action: BlackjackActionType;
  handSlot?: 0 | 1;
  /** Required for terminal actions; harmless on a hit/stand-in-progress. */
  idempotencyKey: string;
  /**
   * OPTIONAL stale-agent-decision precondition. Set ONLY by the Autonomous
   * driver (threaded from /agent/decide's `handVersion`); the server rejects
   * with 409 stale_agent_decision if the hand advanced since the agent decided.
   * Human manual taps MUST omit this so /action stays unconditional for them.
   */
  expectedHandVersion?: number;
}

export function useBlackjackAction() {
  const qc = useQueryClient();
  return useMutation<ActionResponse, CoveApiError, PlayerActionArgs>({
    mutationFn: ({ handId, action, handSlot, idempotencyKey, expectedHandVersion }) =>
      coveFetch<ActionResponse>('/api/cove/blackjack/action', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          handId,
          action,
          handSlot: handSlot ?? 0,
          // Only included for the agent-apply path; undefined keys are dropped by
          // JSON.stringify so human manual taps send the legacy unconditional body.
          ...(expectedHandVersion !== undefined ? { expectedHandVersion } : {}),
        }),
      }),
    onSuccess: (res) => {
      if ('shoeId' in res && res.shoeId) {
        qc.invalidateQueries({ queryKey: blackjackKeys.shoe(res.shoeId) });
      }
    },
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useTakeInsurance — POST /action {action:'insure'} (before main-hand actions)
// ---------------------------------------------------------------------------

export interface InsureArgs {
  handId: string;
  /**
   * OPTIONAL stale-agent-decision precondition — parity with PlayerActionArgs.
   * Set ONLY by the Autonomous driver (threaded from /agent/decide's
   * `handVersion`); the server rejects with 409 stale_agent_decision if the hand
   * advanced since the agent decided. Human manual insure taps MUST omit this so
   * /action stays unconditional for them.
   */
  expectedHandVersion?: number;
}

/**
 * Insure can come back as the in-progress ack OR — when a stale agent insure
 * decision races an already-settled hand — a full settled-hand replay (the
 * server's settled-replay path returns `status:'settled'`). The Autonomous
 * driver must branch on both, so the response type is the union, not bare
 * InsureResponse. A human manual insure on a live hand always gets InsureResponse.
 */
export type InsureMutationResponse = InsureResponse | SettledHandResponse;

export function useTakeInsurance() {
  return useMutation<InsureMutationResponse, CoveApiError, InsureArgs>({
    mutationFn: ({ handId, expectedHandVersion }) =>
      coveFetch<InsureMutationResponse>('/api/cove/blackjack/action', {
        method: 'POST',
        body: JSON.stringify({
          handId,
          action: 'insure',
          // Only included for the agent-apply path; undefined keys are dropped by
          // JSON.stringify so human manual insure taps send the legacy body.
          ...(expectedHandVersion !== undefined ? { expectedHandVersion } : {}),
        }),
      }),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useCloseBlackjackShoe — POST /session/close (Lucia auth → reveals seed)
// ---------------------------------------------------------------------------

export interface CloseShoeArgs {
  shoeId: string;
}

export function useCloseBlackjackShoe() {
  const qc = useQueryClient();
  return useMutation<CloseShoeResponse, CoveApiError, CloseShoeArgs>({
    mutationFn: ({ shoeId }) =>
      coveFetch<CloseShoeResponse>('/api/cove/blackjack/session/close', {
        method: 'POST',
        body: JSON.stringify({ shoeId }),
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: blackjackKeys.shoe(vars.shoeId) });
    },
  });
}

// ---------------------------------------------------------------------------
// useBlackjackAgentDecision — POST /agent/decide (autonomous-mode relay)
//
// When a HUMAN is at /game with a CONNECTED agent and flips the table to
// Autonomous, the browser asks the agent (server-side, bound to the live
// session) for its next decision on the currently-open shoe/hand. The server
// is authoritative: it sees the hand state and the agent's bound skill memory,
// runs the agent's decision, and returns ONLY the decision verb (+ a bet amount
// for the opening `deal`). The browser then APPLIES that verb through the same
// /hand/deal or /action endpoints after the human-input window — it never
// receives undealt cards, the dealer hole, or the seed.
//
// FEATURE_GATE: blackjack_autonomous_agent_mode (graduation handled in the
// modal's AgentModeBar block). The relay contract is locked with impl-1's
// `POST /api/cove/blackjack/agent/decide` route. Two distinct failure shapes
// the driver MUST treat differently:
//   - AgentDriverUnavailableError (sticky → drop the whole table to Control):
//     403 shoe_not_owned, 404 no_open_shoe | no_connected_agent, 409
//     shoe_not_open, 503 agent_unavailable (carries a `reason`; `self_managed_agent`
//     = a nanoclaw agent that decides client-side and can't be push-asked). 501
//     kept defensively though the live relay never emits it.
//   - AgentUndecidedError (transient → skip THIS decision, stay Autonomous):
//     422 agent_undecided — the agent replied but produced no parseable verb;
//     the human can act this decision, the agent may decide fine next time.
// Either way the modal never crashes.
// ---------------------------------------------------------------------------

/** Decision verbs the relay can return. `deal` opens the next hand at `amount`. */
export type AgentDecisionAction =
  | 'deal'
  | 'hit'
  | 'stand'
  | 'double'
  | 'split'
  | 'surrender'
  | 'insure';

export interface AgentDecisionResponse {
  action: AgentDecisionAction;
  /** Present only for `deal` — the agent's chosen bet (server-clamped 5..500). */
  amount?: number;
  /**
   * The in-progress hand the decision targets (null when action==='deal'). The
   * SERVER derives this authoritatively from the shoe, so the driver applies the
   * action against THIS handId/handSlot rather than its local view (prevents
   * acting on a stale hand).
   */
  handId?: string | null;
  /** Sub-hand slot for split hands (server-authoritative). */
  handSlot?: 0 | 1;
  /**
   * The decision version of the hand the agent decided for (null for `deal` or
   * when no hand was live). The driver threads this back to /action as
   * `expectedHandVersion` so a human tap that advanced the hand in the meantime
   * rejects the stale agent apply server-side (409 stale_agent_decision).
   */
  handVersion?: number | null;
  /**
   * Shoe EPOCH for a `deal` decision (shoe.handCounter at decision time; null for
   * non-deal verbs). The driver threads this back to /hand/deal as
   * `expectedHandsPlayed` so a stale agent `deal` that lands after an intervening
   * human deal (even one that natural-settled inline) rejects server-side with
   * 409 stale_agent_deal instead of opening an extra unwanted hand.
   */
  expectedHandsPlayed?: number | null;
  /** Optional one-line rationale the modal surfaces in the advisor panel. */
  rationale?: string;
  /** Always 'agent' from the relay — provenance marker. */
  source?: 'agent';
}

export interface AgentDecideArgs {
  shoeId: string;
}

/**
 * Sticky failure: the agent cannot be asked at all for this table (no bound
 * agent, no open shoe, relay missing, or the agent's runtime can't be reached
 * synchronously). The modal drops to Control mode for the rest of the sit-down.
 */
export class AgentDriverUnavailableError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    /** Relay `reason` (e.g. 'self_managed_agent' on a nanoclaw 503). */
    public reason?: string,
  ) {
    super(`agent decision relay unavailable (${status}${code ? ` ${code}` : ''})`);
    this.name = 'AgentDriverUnavailableError';
  }
  /** True only for a nanoclaw self-managed agent that decides client-side. */
  get isSelfManaged(): boolean {
    return this.reason === 'self_managed_agent';
  }
}

/**
 * Transient failure: the agent was asked but produced no parseable decision
 * for THIS spot. The driver skips this one decision (the human can act) and
 * stays in Autonomous so the next decision point still asks the agent.
 */
export class AgentUndecidedError extends Error {
  constructor(public raw?: string) {
    super('agent produced no parseable decision');
    this.name = 'AgentUndecidedError';
  }
}

/**
 * Ask the human's connected agent for its next decision on its open shoe. The
 * server derives the authoritative in-progress hand from the shoe (the request
 * carries ONLY the shoeId). Resolves to the decision, or throws a typed error
 * the caller branches on (sticky-unavailable vs transient-undecided). Any other
 * error propagates.
 */
export async function fetchAgentBlackjackDecision(
  args: AgentDecideArgs,
): Promise<AgentDecisionResponse> {
  try {
    return await coveFetch<AgentDecisionResponse>('/api/cove/blackjack/agent/decide', {
      method: 'POST',
      body: JSON.stringify({ shoeId: args.shoeId }),
    });
  } catch (err) {
    if (err instanceof CoveApiError) {
      // Transient: agent replied, no parseable verb → skip this decision only.
      if (err.status === 422 || err.code === 'agent_undecided') {
        const raw = (err as CoveApiError & { body?: { raw?: string } }).body?.raw;
        throw new AgentUndecidedError(raw);
      }
      // Sticky: cannot ask the agent for this table → fall back to Control.
      // 403 shoe_not_owned, 404 no_open_shoe|no_connected_agent, 409 shoe_not_open,
      // 503 agent_unavailable (e.g. a self-managed nanoclaw agent that decides
      // client-side and cannot be push-asked). 501 kept defensively though the
      // relay does not emit it.
      if (
        err.status === 403 || err.status === 404 || err.status === 409 ||
        err.status === 501 || err.status === 503
      ) {
        const reason = (err as CoveApiError & { body?: { reason?: string } }).body?.reason;
        throw new AgentDriverUnavailableError(err.status, err.code, reason);
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Friendly user-facing error mapping (blackjack-specific codes + slots reuse).
// ---------------------------------------------------------------------------

export function describeBlackjackError(err: unknown): string {
  if (!(err instanceof CoveApiError)) {
    return err instanceof Error ? err.message : 'Unknown error';
  }
  switch (err.status) {
    case 400:
      if (err.code?.startsWith('insufficient_clawtokens')) {
        return 'Not enough ClawTokens for that bet.';
      }
      if (err.code?.startsWith('insufficient_guest_demo_balance')) {
        return 'Out of demo ClawTokens. Sign up to keep playing with a real balance.';
      }
      if (err.code === 'bet_exceeds_supported_range') {
        return 'That bet is out of range. Bets are 5–500 ClawTokens.';
      }
      if (err.code === 'already_split') {
        return 'You can only split once per hand.';
      }
      if (err.code === 'sub_hand_already_terminal') {
        return 'That hand is already finished — act on the other hand.';
      }
      if (err.code === 'split_ace_one_card_only') {
        return 'Split aces get exactly one card each — you cannot hit or double them.';
      }
      return err.serverMessage;
    case 401:
      return 'You need to sign in to do that.';
    case 403:
      return 'That table belongs to a different player.';
    case 404:
      return 'Hand or shoe not found — it may have expired. Start a new hand.';
    case 409:
      if (reshuffledBody(err)) {
        return 'Shoe is 75% dealt — shuffling a fresh shoe.';
      }
      if (err.code?.startsWith('shoe_has_in_progress_hand')) {
        return 'Finish the current hand before you walk away.';
      }
      if (err.code?.startsWith('hand_in_progress')) {
        return 'Finish the current hand before dealing another.';
      }
      if (err.code?.startsWith('shoe_not_open')) {
        return 'That shoe is no longer open. Start a new hand.';
      }
      if (err.code?.startsWith('hand_not_in_progress')) {
        return 'That hand is already resolved.';
      }
      return err.serverMessage;
    case 429:
      return 'Slow down a moment, then try again.';
    case 501:
      return 'SOL/USDC blackjack is coming later. ClawTokens play is live today.';
    default:
      return err.serverMessage || `Cove server error (${err.status}).`;
  }
}
