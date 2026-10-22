'use client';

/**
 * Shared-table baccarat REST client (spec
 * ~/.clawville-brain/plans/baccarat-shared-table-port-2026-10-22.md §3).
 *
 * Routes: `/api/cove/baccarat/tables[/:id[/sit|leave|bet]]`. The Lucia cookie
 * rides every call (`credentials: 'include'`). No vCLAW moves at bet time: the
 * server debits the stake and credits the gross payout in one transaction when
 * the betting window closes, so this client does no money math at all.
 *
 * Errors reuse `CoveApiError` (status + code). Callers branch on `status` and
 * `code`, never on message text. Extra 409 body fields (`tableId`, `roundSeq`,
 * `nextBettingOpensAt`) stay on `error.body`.
 */

import type {
  BaccaratLobbyRow,
  BaccaratTableBetSide,
  BaccaratTablePublicState,
} from '@clawville/shared';

import { CoveApiError } from './slot-api-client';
export { CoveApiError } from './slot-api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const TABLES_PATH = '/api/cove/baccarat/tables';

export interface BaccaratLobbyResponse {
  ok: boolean;
  serverNow: number;
  tables: BaccaratLobbyRow[];
}

export interface BaccaratTableStateResponse {
  ok: boolean;
  table: BaccaratTablePublicState;
}

export interface BaccaratSitResponse {
  ok: boolean;
  seatIndex: number;
  alreadySeated: boolean;
  roundSeq: number;
  bettingClosesAt: number | null;
}

export interface BaccaratLeaveResponse {
  ok: boolean;
  left: true;
  lockedBet: { roundSeq: number; bet: BaccaratTableBetSide; stake: number } | null;
}

export interface BaccaratPlaceBetBody {
  roundSeq: number;
  bet: BaccaratTableBetSide;
  stake: number;
}

export interface BaccaratPlaceBetResponse {
  ok: boolean;
  roundSeq: number;
  seatIndex: number;
  bet: BaccaratTableBetSide;
  stake: number;
  bettingClosesAt: number | null;
}

export interface BaccaratCancelBetResponse {
  ok: boolean;
  cancelled: boolean;
}

export type CoveApiErrorWithBody = CoveApiError & { body?: Record<string, unknown> };

async function tableFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Empty or non-JSON body: keep the HTTP status fallback below.
    }
    const obj = (body ?? {}) as { error?: unknown; message?: unknown } & Record<string, unknown>;
    const serverMessage = typeof obj.message === 'string' && obj.message
      ? obj.message
      : typeof obj.error === 'string' && obj.error
        ? obj.error
        : `HTTP ${res.status}`;
    const explicitCode = typeof obj.code === 'string' && obj.code ? obj.code : null;
    const code = explicitCode ?? (serverMessage.split(/[\s:]/)[0] || null);
    const err = new CoveApiError(res.status, serverMessage, code) as CoveApiErrorWithBody;
    err.body = obj;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function tablePath(tableId: string, suffix = ''): string {
  return `${TABLES_PATH}/${encodeURIComponent(tableId)}${suffix}`;
}

export const baccaratTableApi = {
  listTables(limit = 50): Promise<BaccaratLobbyResponse> {
    return tableFetch(`${TABLES_PATH}?limit=${encodeURIComponent(String(limit))}`, {
      method: 'GET',
    });
  },
  getTable(tableId: string): Promise<BaccaratTableStateResponse> {
    return tableFetch(tablePath(tableId), { method: 'GET' });
  },
  sit(tableId: string, seatIndex?: number): Promise<BaccaratSitResponse> {
    return tableFetch(tablePath(tableId, '/sit'), {
      method: 'POST',
      body: JSON.stringify(seatIndex === undefined ? {} : { seatIndex }),
    });
  },
  leave(tableId: string): Promise<BaccaratLeaveResponse> {
    return tableFetch(tablePath(tableId, '/leave'), {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  placeBet(tableId: string, body: BaccaratPlaceBetBody): Promise<BaccaratPlaceBetResponse> {
    return tableFetch(tablePath(tableId, '/bet'), {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  cancelBet(tableId: string): Promise<BaccaratCancelBetResponse> {
    return tableFetch(tablePath(tableId, '/bet'), { method: 'DELETE' });
  },
};

export type BaccaratTableApi = typeof baccaratTableApi;

/** Read one extra field from a CoveApiError body (e.g. `tableId` on 409). */
export function errorBodyField(err: unknown, key: string): unknown {
  if (!(err instanceof CoveApiError)) return undefined;
  return (err as CoveApiErrorWithBody).body?.[key];
}

/** True when the error is a 409 with this exact server code. */
export function isTableErrorCode(err: unknown, status: number, code: string): boolean {
  return err instanceof CoveApiError && err.status === status && err.code === code;
}

/** Plain-language text for the §3.3 error codes. Branches on status + code only. */
export function describeBaccaratTableError(err: unknown): string {
  if (!(err instanceof CoveApiError)) {
    return 'The table did not answer. Check your connection.';
  }
  const code = err.code ?? '';
  switch (err.status) {
    case 400:
      if (code === 'stake_out_of_bounds') return 'That stake is outside this table\'s limits.';
      if (code === 'invalid_table_id') return 'That table link is not valid.';
      return 'The table refused that request.';
    case 401:
      return 'Sign in to play.';
    case 402:
      return 'Not enough vCLAW for that bet.';
    case 403:
      if (code === 'guest_not_allowed') return 'Sign in to play. Guest accounts can use the private shoe.';
      if (code === 'active_avatar_required') return 'Create your avatar first, then take a seat.';
      if (code === 'seeded_seat_cannot_bet') return 'House seats cannot bet.';
      return 'Sign in to play.';
    case 404:
      return 'This table is not open.';
    case 409:
      switch (code) {
        case 'table_full':
          return 'This table is full. Try another table.';
        case 'seat_taken':
          return 'That seat was just taken. Try again.';
        case 'not_seated':
          return 'Take a seat first.';
        case 'already_seated_elsewhere':
          return 'You already sit at another baccarat table.';
        case 'betting_closed':
          return 'Betting is closed for this round.';
        case 'stale_round':
          return 'The round moved on. Place your bet again.';
        case 'table_closed':
          return 'This table is closed.';
        default:
          return 'The table state changed. Try again.';
      }
    case 429:
      return 'Slow down a moment, then try again.';
    default:
      return `The table server had a problem (${err.status}). Try again.`;
  }
}
