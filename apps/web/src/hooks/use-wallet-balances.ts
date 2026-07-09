'use client';

/**
 * useWalletBalances — the caller's IN-GAME CUSTODIAL wallet on-chain balances
 * (SOL / USDC / CLV) plus the withdraw dark-flag, via GET /api/wallet/balances
 * (apps/api routes/wallet-withdraw.ts — the read surface, live regardless of
 * `WALLET_WITHDRAW_ENABLED`; `data.withdrawEnabled` IS that flag).
 *
 * Shared cache key ['wallet-balances'] so the WithdrawCard (which invalidates
 * after a sent withdrawal) and any read-only consumer stay in ONE cache.
 * `refetchOnMount: 'always'` → the wallet modal re-reads fresh balances every
 * time it opens (the panel unmounts with the dialog), so a deposit that landed
 * while the modal was closed shows up without a manual refresh.
 *
 * Fail-soft: retry:false and callers branch on query.error — an ApiError with
 * code 'wallet_missing' (404) means the avatar has no custodial wallet row;
 * anything else is a transient read failure. Per-asset read blips arrive as
 * `balances[asset].available === false` on a 200, NOT as a query error.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useWalletBalances() {
  return useQuery({
    queryKey: ['wallet-balances'],
    queryFn: api.walletBalances,
    retry: false,
    staleTime: 15_000,
    refetchOnMount: 'always',
  });
}
