'use client';

/**
 * useWalletLink — read the caller's linked self-custody wallet + its cached CLV
 * balance (Tokenomics Phase A, GET /api/wallet/link via api.getWalletLink).
 *
 * Shared cache key ['wallet-link'] so the wallet modal (which also mutates it
 * on link) and any read-only consumer (e.g. the Land Office pre-click
 * qualification: is the human's wallet linked, and does it hold enough CLV?)
 * stay in ONE cache — a successful link in the modal is instantly visible to a
 * consumer, and vice-versa after invalidation.
 *
 * Returns the raw react-query result PLUS flattened convenience fields:
 *   - linked        — true only when a wallet pubkey is actually present
 *   - walletPubkey  — the linked pubkey, or null
 *   - clv           — the full ClvBalanceResult, or null
 *   - clvUiAmount   — human CLV amount, or null when the on-chain read failed
 *   - clvAvailable  — whether the balance read succeeded
 *
 * `enabled` (default true) lets a caller skip the read for a viewer the route
 * always refuses: GET /api/wallet/link answers a guest or a logged-out visitor
 * with 401, which the browser logs as a console error (Trading Floor tab,
 * browser verify 2026-10-01 F1).
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useWalletLink({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ['wallet-link'],
    queryFn: api.getWalletLink,
    enabled,
    retry: false,
    staleTime: 60_000,
  });

  const d = query.data;
  return {
    ...query,
    linked: !!(d?.linked && d.walletPubkey),
    walletPubkey: d?.walletPubkey ?? null,
    clv: d?.clv ?? null,
    clvUiAmount: d?.clv?.available ? d.clv.uiAmount : null,
    clvAvailable: !!d?.clv?.available,
  };
}
