'use client';

/**
 * Phase 6.7.0 — Cove Game History API client.
 *
 * Wire types mirror what impl-api ships at GET /api/cove/history
 * (cursor-based pagination, owner-only via Lucia session).
 *
 * All monetary values are stringified bigints on the wire; convert
 * at render time, never at fetch time.
 */

import { useInfiniteQuery } from '@tanstack/react-query';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Wire types (must stay in sync with impl-api response shape)
// ---------------------------------------------------------------------------

export type GameType = 'slots' | 'blackjack' | 'holdem' | 'baccarat';

export interface CoveHistoryEventRow {
  id: string;
  userId: string;
  gameType: GameType;
  createdAt: string;
  sessionId: string;
  shoeId: string;
  betAmount: string;
  payout: string;
  /** Game-specific outcome — shape varies by gameType */
  outcomeJson: Record<string, unknown>;
  serverSeedHash: string;
  /** Null while parent shoe/session is still open */
  revealedServerSeed: string | null;
  clientSeed: string;
  nonce: number;
  /** Null on fun-money rows; populated for real-money Solana rows (Phase 6.7.4) */
  txSignature: string | null;
  /** e.g. 'slot-engine-v2' — parse version via engineVersion.replace('slot-engine-', '') */
  engineVersion: string;
}

export interface CoveHistoryPage {
  events: CoveHistoryEventRow[];
  /** Opaque base64url cursor; null on last page */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Server-side verify endpoint response shapes
// ---------------------------------------------------------------------------

export type EventVerifyResponse =
  | {
      /** Spin replay matched stored outcome byte-for-byte */
      verified: true;
      expected: Record<string, unknown>;
      stored: Record<string, unknown>;
      hashMatches: boolean;
    }
  | {
      /** Cannot verify yet: session open or engine not shipped */
      verified: null;
      reason: 'shoe-not-yet-closed' | 'engine-not-yet-shipped';
      expected: null;
      stored: Record<string, unknown>;
      hashMatches: null | boolean;
    }
  | {
      /**
       * Replay ran but diverged — expected carries the engine's recomputed result
       * so the UI can render a side-by-side diff (reels, winAmount).
       * On engine error (backfill row missing parent slot_spins) expected is null
       * and reason starts with 'engine_replay_failed:'.
       */
      verified: false;
      reason: string;
      expected: Record<string, unknown> | null;
      stored: Record<string, unknown>;
      hashMatches: boolean;
    };

export async function fetchEventVerdict(eventId: string): Promise<EventVerifyResponse> {
  const res = await fetch(`${API_BASE}/api/cove/history/${eventId}/verify`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      msg = body.message || body.error || msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as EventVerifyResponse;
}

// ---------------------------------------------------------------------------
// Fetch helper (mirrors slot-api-client.ts pattern)
// ---------------------------------------------------------------------------

async function fetchHistory(opts: {
  game?: GameType;
  outcome?: 'win' | 'loss';
  cursor?: string;
  limit?: number;
}): Promise<CoveHistoryPage> {
  const params = new URLSearchParams();
  if (opts.game) params.set('game', opts.game);
  if (opts.outcome) params.set('outcome', opts.outcome);
  if (opts.cursor) params.set('cursor', opts.cursor);
  params.set('limit', String(opts.limit ?? 50));

  const res = await fetch(`${API_BASE}/api/cove/history?${params}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      msg = body.message || body.error || msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as CoveHistoryPage;
}

export async function fetchHistoryEvent(eventId: string): Promise<CoveHistoryEventRow> {
  const res = await fetch(`${API_BASE}/api/cove/history/${eventId}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      msg = body.message || body.error || msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as CoveHistoryEventRow;
}

// ---------------------------------------------------------------------------
// TanStack Query hook — infinite scroll
// ---------------------------------------------------------------------------

export interface UseHistoryOptions {
  game?: GameType;
  outcome?: 'win' | 'loss';
  limit?: number;
}

export function useHistory(opts: UseHistoryOptions = {}) {
  return useInfiniteQuery({
    queryKey: ['cove-history', opts.game, opts.outcome, opts.limit],
    queryFn: ({ pageParam }) =>
      fetchHistory({
        game: opts.game,
        outcome: opts.outcome,
        cursor: pageParam as string | undefined,
        limit: opts.limit,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
