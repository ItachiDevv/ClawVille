/**
 * Shared SPL / Token-2022 balance reader (Tokenomics Phase A, 2026-07-07).
 *
 * EXTRACTED from the closure that used to live inside
 * `special-event-manager.ts defaultEventRpc().getTokenBalance` so BOTH the
 * special-event hold-gate AND the CLV linked-wallet balance service read a
 * wallet's token balance through ONE audited helper instead of duplicating the
 * token-account parse (the founder's "extract/share, don't duplicate" rule).
 *
 * `getTokenAccountsByOwner(owner, { mint }, config)` filters by MINT, so it
 * finds the account regardless of which token program owns the mint — it works
 * for classic SPL AND Token-2022 mints (CLV is Token-2022). The raw public API
 * is required because web3.js 1.x's parsed helper accepts only a Commitment and
 * cannot carry the money-path `minContextSlot` fence. We validate every base
 * token account, sum its atomic amount, and read decimals from the validated
 * mint account.
 *
 * READ-ONLY: never signs, never sends. All amounts are exact integers as bigint;
 * `uiAmount` is a convenience float for display / coarse threshold checks — do
 * precise threshold comparisons against `amountAtomic` (integer) to avoid float
 * error on 9-decimal balances.
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';

export interface SplTokenBalance {
  /** Summed balance across the owner's token accounts for this mint, in atomic base units. */
  amountAtomic: bigint;
  /** Mint decimals (0 when the owner holds no account of this mint). */
  decimals: number;
  /** `amountAtomic / 10^decimals` as a float — display/coarse-threshold only. */
  uiAmount: number;
  /** RPC context used for this observation; proves minContextSlot ordering. */
  contextSlot: number;
}

/**
 * Check whether the canonical associated token account exists for an owner.
 * `null` means derivation or RPC failed, so callers can fail open on
 * infrastructure without confusing an indeterminate probe with definite
 * absence.
 */
export async function readAssociatedTokenAccountExists(
  connection: Connection,
  mint: string,
  ownerPubkey: string,
): Promise<boolean | null> {
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      new PublicKey(ownerPubkey),
      true,
    );
    return (await connection.getAccountInfo(ata, 'confirmed')) !== null;
  } catch {
    return null;
  }
}

export function assertMinimumContextSlot(actualSlot: number, minContextSlot?: number): void {
  if (minContextSlot !== undefined && actualSlot < minContextSlot) {
    throw new Error(`rpc_context_slot_stale:${actualSlot}<${minContextSlot}`);
  }
}

/**
 * Read `ownerPubkey`'s balance of `mint` over the given RPC `connection`.
 * Returns a zero balance (amountAtomic 0n, decimals 0) when the owner has no
 * token account for the mint. Throws on RPC/transport, stale-context, or
 * malformed account data — callers that must degrade gracefully should
 * try/catch.
 */
export async function readSplTokenBalance(
  connection: Connection,
  mint: string,
  ownerPubkey: string,
  options: { minContextSlot?: number } = {},
): Promise<SplTokenBalance> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const token2022Program = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  const mintPubkey = new PublicKey(mint);
  const owner = new PublicKey(ownerPubkey);
  const rpcConfig = {
    commitment: 'confirmed' as const,
    ...(options.minContextSlot === undefined
      ? {}
      : { minContextSlot: options.minContextSlot }),
  };
  const res = await connection.getTokenAccountsByOwner(
    owner,
    { mint: mintPubkey },
    rpcConfig,
  );
  assertMinimumContextSlot(res.context.slot, options.minContextSlot);

  let amountAtomic = 0n;
  let decimals = 0;
  if (res.value.length > 0) {
    const mintInfo = await connection.getAccountInfoAndContext(mintPubkey, rpcConfig);
    assertMinimumContextSlot(mintInfo.context.slot, options.minContextSlot);
    if (
      !mintInfo.value ||
      (!mintInfo.value.owner.equals(tokenProgram) &&
        !mintInfo.value.owner.equals(token2022Program)) ||
      mintInfo.value.data.length < 46 ||
      mintInfo.value.data[45] !== 1
    ) {
      throw new Error('rpc_mint_account_invalid');
    }
    decimals = mintInfo.value.data[44];
    for (const { account } of res.value) {
      const data = Buffer.from(account.data);
      const state = data[108];
      if (
        !account.owner.equals(mintInfo.value.owner) ||
        data.length < 165 ||
        !data.subarray(0, 32).equals(mintPubkey.toBuffer()) ||
        !data.subarray(32, 64).equals(owner.toBuffer()) ||
        state !== 1 // AccountState::Initialized; frozen funds are not spendable backing
      ) {
        throw new Error('rpc_token_account_invalid');
      }
      amountAtomic += data.readBigUInt64LE(64);
    }
  }

  const uiAmount = decimals > 0 ? Number(amountAtomic) / 10 ** decimals : Number(amountAtomic);
  return { amountAtomic, decimals, uiAmount, contextSlot: res.context.slot };
}
