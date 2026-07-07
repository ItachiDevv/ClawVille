/**
 * Shared SPL / Token-2022 balance reader (Tokenomics Phase A, 2026-07-07).
 *
 * EXTRACTED from the closure that used to live inside
 * `special-event-manager.ts defaultEventRpc().getTokenBalance` so BOTH the
 * special-event hold-gate AND the CLV linked-wallet balance service read a
 * wallet's token balance through ONE audited helper instead of duplicating the
 * `getParsedTokenAccountsByOwner` parse (the founder's "extract/share, don't
 * duplicate" rule).
 *
 * `getParsedTokenAccountsByOwner(owner, { mint })` filters by MINT, so it finds
 * the account regardless of which token program owns the mint — it works for
 * classic SPL AND Token-2022 mints (CLV is Token-2022). A wallet can hold the
 * same mint across multiple token accounts (rare); we SUM the atomic amounts and
 * take the decimals from whichever account reports them.
 *
 * READ-ONLY: never signs, never sends. All amounts are exact integers as bigint;
 * `uiAmount` is a convenience float for display / coarse threshold checks — do
 * precise threshold comparisons against `amountAtomic` (integer) to avoid float
 * error on 9-decimal balances.
 */

import type { Connection } from '@solana/web3.js';

export interface SplTokenBalance {
  /** Summed balance across the owner's token accounts for this mint, in atomic base units. */
  amountAtomic: bigint;
  /** Mint decimals (0 when the owner holds no account of this mint). */
  decimals: number;
  /** `amountAtomic / 10^decimals` as a float — display/coarse-threshold only. */
  uiAmount: number;
}

/**
 * Read `ownerPubkey`'s balance of `mint` over the given RPC `connection`.
 * Returns a zero balance (amountAtomic 0n, decimals 0) when the owner has no
 * token account for the mint. Throws only on an RPC/transport failure — callers
 * that must degrade gracefully should try/catch.
 */
export async function readSplTokenBalance(
  connection: Connection,
  mint: string,
  ownerPubkey: string,
): Promise<SplTokenBalance> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(ownerPubkey), {
    mint: new PublicKey(mint),
  });

  let amountAtomic = 0n;
  let decimals = 0;
  for (const { account } of res.value) {
    const parsed = account.data as unknown as {
      parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } };
    };
    const ta = parsed.parsed?.info?.tokenAmount;
    if (ta?.amount) amountAtomic += BigInt(ta.amount);
    if (typeof ta?.decimals === 'number') decimals = ta.decimals;
  }

  const uiAmount = decimals > 0 ? Number(amountAtomic) / 10 ** decimals : Number(amountAtomic);
  return { amountAtomic, decimals, uiAmount };
}
