/**
 * Phase 6.4.0 — blackjack API client (mock endpoint only).
 *
 * Phase 6.4.1 replaces `playMockHand` with real
 * deal / hit / stand / double / split / surrender calls.
 */

import type { PlayMockHandResponse } from './blackjack-types';

const API_BASE =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_URL ?? '')
    : '';

export async function playMockHand(betAmount: number): Promise<PlayMockHandResponse> {
  const res = await fetch(`${API_BASE}/api/cove/blackjack/play-mock-hand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ betAmount }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown error');
    throw new Error(`blackjack mock hand failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<PlayMockHandResponse>;
}
