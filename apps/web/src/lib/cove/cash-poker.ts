'use client';

/**
 * Poker CASH GAMES (P2 — web UI) — typed REST client for the ring-table routes.
 *
 * Mirrors the SERVER contract in `apps/api/src/routes/cove-cash-poker.ts`
 * (mounted at `/api/cove/poker/cash`). Every response/request type here is a
 * one-shape mirror of the route's Zod schemas + JSON return shapes — do NOT
 * drift; the felt + lobby read these verbatim.
 *
 * ── ERROR MODEL ──────────────────────────────────────────────────────────────
 * The route raises Hono `HTTPException`s whose `message` is a structured CODE
 * (e.g. `private_requires_join_code`, `table_full`, `insufficient_clawtokens_for_buyin`,
 * `auth_required: …`). Hono serializes that as `{ message }`. We reuse the cove
 * canonical `CoveApiError {status, serverMessage, code}` (from `slot-api-client`):
 * `code` = the first whitespace/colon-delimited token of the message, so the UI
 * dispatches on `err.code` / `err.status`, NEVER the raw message string.
 *
 * ── PARITY ───────────────────────────────────────────────────────────────────
 * `credentials:'include'` rides the human Lucia cookie. A connected/hosted agent
 * hits the SAME endpoints with its own `X-Clawville-Agent-Session` header from
 * its runtime (server resolves it → bound avatar). This client is the HUMAN path;
 * the route is parity-by-construction (Rule E5) — no guest tier on a CT ring table.
 *
 * Iris Xe safe: pure fetch, no Three.js / WebGPU.
 */

import { CoveApiError } from './slot-api-client';
export { CoveApiError } from './slot-api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * Cove fetch wrapper (local copy of the slots/holdem contract so a future
 * cash-poker-only header tweak doesn't perturb the other hot paths). Throws
 * `CoveApiError {status, serverMessage, code}` on any non-2xx; returns the
 * status code alongside the body for the routes that distinguish 200/201/202.
 */
async function cashFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...init, credentials: 'include', headers });
  if (!res.ok) {
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      // empty / non-JSON body — fall through with HTTP <status>
    }
    const obj = (raw ?? {}) as { error?: string; message?: string };
    const serverMessage = obj.message || obj.error || `HTTP ${res.status}`;
    const code =
      typeof serverMessage === 'string' ? serverMessage.split(/[\s:]/)[0] || null : null;
    throw new CoveApiError(res.status, serverMessage, code);
  }
  if (res.status === 204) return { status: 204, body: undefined as T };
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Wire types — mirror cove-cash-poker.ts route shapes verbatim.
// All money fields the server emits as stringified are STRINGS here; we only
// Number() at the display boundary (chip counts fit a JS number comfortably).
// ---------------------------------------------------------------------------

/** A playing card — structurally identical to the API `holdem-engine.ts` Card. */
export type CardSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades';
export type CardRank =
  | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export interface CashPokerCard {
  suit: CardSuit;
  rank: CardRank;
}

export type CashTierKey = 'low' | 'mid' | 'high';
export type CashTableSource = 'house' | 'player-public' | 'private';
export type CashTableVisibility = 'public' | 'private';

/** Fixed house tiers (mirror the route's HOUSE_TIERS — display only). */
export const CASH_TIERS: Record<
  CashTierKey,
  { label: string; buyInCt: number; smallBlindCt: number; bigBlindCt: number }
> = {
  low: { label: 'House Low', buyInCt: 20, smallBlindCt: 1, bigBlindCt: 2 },
  mid: { label: 'Mid', buyInCt: 100, smallBlindCt: 5, bigBlindCt: 10 },
  high: { label: 'High', buyInCt: 500, smallBlindCt: 25, bigBlindCt: 50 },
};

/** One row of `GET /tables` (public open tables only). */
export interface CashTableListItem {
  id: string;
  source: CashTableSource;
  tierKey: string | null;
  /** stringified-bigint chip values (the server stores numeric/text). */
  buyInCt: string;
  smallBlindCt: string;
  bigBlindCt: string;
  maxSeats: number;
  occupiedSeats: number;
  status: string;
}

export interface ListTablesResponse {
  ok: true;
  tables: CashTableListItem[];
}

/** `POST /tables` create body — discriminated on `source`. */
export type CreateTableBody =
  | {
      source: 'house' | 'player-public';
      tierKey: CashTierKey;
      maxSeats?: number;
      seededAgentSlots?: number;
    }
  | {
      source: 'private';
      buyInCt: number;
      smallBlindCt: number;
      bigBlindCt: number;
      maxSeats?: number;
      seededAgentSlots?: number;
    };

/** `POST /tables` 201 response — `joinCode` is non-null ONLY for a private host. */
export interface CreateTableResponse {
  ok: true;
  table: {
    id: string;
    source: CashTableSource;
    visibility: CashTableVisibility;
    tierKey: string | null;
    buyInCt: string;
    smallBlindCt: string;
    bigBlindCt: string;
    maxSeats: number;
    joinCode: string | null;
  };
}

/** `POST /tables/join-by-code` response (200 alreadySeated, 201 fresh sit). */
export interface JoinByCodeResponse {
  ok: true;
  tableId: string;
  seatIndex: number;
  stackCt: string;
  alreadySeated: boolean;
}

/** `POST /tables/:id/sit` response (200 alreadySeated, 201 fresh sit). */
export interface SitResponse {
  ok: true;
  seatIndex: number;
  stackCt: string;
  alreadySeated: boolean;
}

/**
 * `POST /tables/:id/leave` response. The HTTP STATUS distinguishes the two:
 *   200 → cashed out immediately (between hands). `queued:false`.
 *   202 → mid-hand stand-up queued; cashed out at the next hand boundary.
 *         `queued:true`, `cashedOutCt:0`.
 */
export interface LeaveResponse {
  ok: true;
  cashedOutCt: number;
  queued: boolean;
}

/** A betting action (TOTAL "to" amount for bet/raise — same as the engine). */
export type CashAction =
  | { kind: 'fold' }
  | { kind: 'check' }
  | { kind: 'call' }
  | { kind: 'bet'; amount: number }
  | { kind: 'raise'; amount: number };

export type CashActionKind = CashAction['kind'];

/** `POST /tables/:id/action` request. */
export interface SubmitActionBody {
  handNumber: number;
  actionSeq: number;
  action: CashAction;
}

/** `POST /tables/:id/action` 200 response. */
export interface SubmitActionResponse {
  ok: true;
  advancedStreet: boolean;
  handComplete: boolean;
  nextToActAvatarId: string | null;
}

/** One seat in the PUBLIC table snapshot (no hole cards by design). */
export interface CashPublicSeat {
  seatIndex: number;
  avatarId: string;
  name: string;
  subjectType: 'human' | 'agent';
  chipStack: number;
  streetBet: number;
  totalCommitted: number;
  status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'busted';
  isButton: boolean;
  isSB: boolean;
  isBB: boolean;
  isActing: boolean;
}

/** The live sim snapshot embedded in `GET /tables/:id` (NO hole cards). */
export interface CashPublicSnapshot {
  tableId: string;
  handNumber: number;
  blinds: { sb: number; bb: number; ante: number; level: number };
  buttonSeatIndex: number;
  board: CashPokerCard[];
  pot: number;
  sidePots: Array<{ amount: number; eligibleSeatIndices: number[] }>;
  toActSeatIndex: number | null;
  toActDeadlineMs: number | null;
  toCall: number;
  minRaiseTo: number;
  seats: CashPublicSeat[];
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  serverSeedCommitHash: string;
}

/** One DB seat row exposed by `GET /tables/:id` (config + active seats). */
export interface CashSeatRow {
  seatIndex: number;
  avatarId: string;
  subjectType: string;
  isSeeded: boolean;
  stackCt: string;
  status: string;
}

/** `GET /tables/:id` PUBLIC table state. */
export interface PublicTableStateResponse {
  ok: true;
  table: {
    id: string;
    source: CashTableSource;
    visibility: CashTableVisibility;
    tierKey: string | null;
    buyInCt: string;
    smallBlindCt: string;
    bigBlindCt: string;
    maxSeats: number;
    status: string;
  };
  seats: CashSeatRow[];
  live: CashPublicSnapshot | null;
}

/**
 * `GET /tables/:id/state-for-agent` — the OWN poll view (own hole cards + legal
 * actions + raise bounds + `isYourTurn`). The ONLY card-bearing surface for the
 * requesting seat. 409 `not_seated_or_no_live_hand` when not seated / no live hand.
 */
export interface CashAgentView {
  table: CashPublicSnapshot;
  seatIndex: number;
  isYourTurn: boolean;
  holeCards: [CashPokerCard, CashPokerCard];
  legalActions: CashActionKind[];
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  chipStack: number;
  deadlineMs: number | null;
  handNumber: number;
}

export interface StateForAgentResponse {
  ok: true;
  view: CashAgentView;
}

// ---------------------------------------------------------------------------
// Client surface — one function per route. All resolve to the parsed body;
// the leave/sit/join callers branch on the returned `status` where it matters.
// ---------------------------------------------------------------------------

export const cashPokerApi = {
  /** GET /tables — public open tables (poll target for the lobby list). */
  async listTables(limit = 50): Promise<ListTablesResponse> {
    const { body } = await cashFetch<ListTablesResponse>(
      `/api/cove/poker/cash/tables?limit=${limit}`,
      { method: 'GET' },
    );
    return body;
  },

  /** POST /tables — create a public-tier OR private custom table. 201. */
  async createTable(body: CreateTableBody): Promise<CreateTableResponse> {
    const res = await cashFetch<CreateTableResponse>('/api/cove/poker/cash/tables', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.body;
  },

  /** POST /tables/join-by-code — resolve a private code and sit. */
  async joinByCode(joinCode: string): Promise<JoinByCodeResponse> {
    const res = await cashFetch<JoinByCodeResponse>(
      '/api/cove/poker/cash/tables/join-by-code',
      { method: 'POST', body: JSON.stringify({ joinCode }) },
    );
    return res.body;
  },

  /** POST /tables/:id/sit — sit down with the table buy-in (CT debit). */
  async sit(tableId: string, buyInCt: number): Promise<SitResponse> {
    const res = await cashFetch<SitResponse>(
      `/api/cove/poker/cash/tables/${encodeURIComponent(tableId)}/sit`,
      { method: 'POST', body: JSON.stringify({ buyInCt }) },
    );
    return res.body;
  },

  /**
   * POST /tables/:id/leave — cash out. Returns the body PLUS whether the
   * stand-up was QUEUED (HTTP 202 — mid-hand) vs immediate (HTTP 200). The body
   * already carries `queued`, but we surface the status for belt-and-suspenders.
   */
  async leave(tableId: string): Promise<LeaveResponse & { httpStatus: number }> {
    const { status, body } = await cashFetch<LeaveResponse>(
      `/api/cove/poker/cash/tables/${encodeURIComponent(tableId)}/leave`,
      { method: 'POST' },
    );
    return { ...body, httpStatus: status };
  },

  /** POST /tables/:id/action — submit ONE betting action. */
  async submitAction(
    tableId: string,
    body: SubmitActionBody,
  ): Promise<SubmitActionResponse> {
    const res = await cashFetch<SubmitActionResponse>(
      `/api/cove/poker/cash/tables/${encodeURIComponent(tableId)}/action`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return res.body;
  },

  /** GET /tables/:id/state-for-agent — own view + hole cards (poll target). */
  async stateForAgent(tableId: string): Promise<StateForAgentResponse> {
    const res = await cashFetch<StateForAgentResponse>(
      `/api/cove/poker/cash/tables/${encodeURIComponent(tableId)}/state-for-agent`,
      { method: 'GET' },
    );
    return res.body;
  },

  /** GET /tables/:id — public table state (config + seats + live snapshot). */
  async publicTableState(tableId: string): Promise<PublicTableStateResponse> {
    const res = await cashFetch<PublicTableStateResponse>(
      `/api/cove/poker/cash/tables/${encodeURIComponent(tableId)}`,
      { method: 'GET' },
    );
    return res.body;
  },
};

// ---------------------------------------------------------------------------
// Friendly error mapping — branch on err.code / err.status (NEVER the message).
// Codes come from the route's structured HTTPException messages.
// ---------------------------------------------------------------------------

export function describeCashPokerError(err: unknown): string {
  if (!(err instanceof CoveApiError)) {
    return err instanceof Error ? err.message : 'Unknown error';
  }
  const code = err.code ?? '';
  // Code-first dispatch (covers most cases regardless of status).
  if (code === 'auth_required') return 'Sign in to play cash poker.';
  if (code === 'active_avatar_required' || code === 'agent_session_has_no_active_avatar') {
    return 'Create an avatar before sitting down.';
  }
  if (code === 'agent_session_not_ledger_authorized') {
    return 'This agent session is not authorized for real-CT play.';
  }
  if (code === 'invalid_or_expired_agent_session') {
    return 'Your agent session expired — reconnect and try again.';
  }
  if (code === 'private_requires_join_code') {
    return 'This is a private table — you need its join code.';
  }
  if (code === 'no_such_table') return 'No open table for that code — it may have filled or closed.';
  if (code === 'invalid_or_expired_code' || code === 'invalid_join_body') {
    return 'That join code is invalid or expired.';
  }
  if (code === 'table_full' || code === 'room_full') return 'That table is full — try another.';
  if (code === 'too_many_open_tables') {
    return 'You already have the max open tables — close one first.';
  }
  if (code === 'buy_in_mismatch') return 'Buy-in must equal the table buy-in.';
  if (code === 'buy_in_below_bb') return 'Buy-in must cover at least one big blind.';
  if (code.startsWith('insufficient_clawtokens') || err.status === 402) {
    return 'Not enough ClawTokens for the buy-in.';
  }
  if (code === 'not_seated' || code === 'not_seated_or_no_live_hand') {
    return "You're not seated at this table.";
  }
  if (code === 'not_your_turn') return "It's not your turn.";
  if (code === 'hand_over') return 'That hand already ended.';
  if (code === 'rate_limited' || err.status === 429) return 'Slow down a moment, then try again.';
  if (code === 'table_closed') return 'That table is closed. Start a new one.';

  // Status fallbacks.
  switch (err.status) {
    case 401:
      return 'Sign in to do that.';
    case 403:
      return err.serverMessage;
    case 404:
      return 'Table not found — it may have closed.';
    case 409:
      return err.serverMessage;
    case 422:
      return 'That move is not legal right now.';
    default:
      return err.serverMessage || `Cove server error (${err.status}).`;
  }
}
