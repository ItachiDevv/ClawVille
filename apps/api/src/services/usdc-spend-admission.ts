import { db, sql } from '@clawville/database';

export const POSTER_USDC_SPEND_LOCK_PREFIX = 'custodial-usdc-spend:';

export type PosterUsdcSpendTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class PosterUsdcSpendAdmissionError extends Error {
  constructor(
    readonly code:
      | 'wallet_missing'
      | 'balance_unavailable'
      | 'bounty_hold_missing'
      | 'bounty_hold_mismatch'
      | 'insufficient_usdc',
    message: string,
    readonly detail?: Record<string, string>,
  ) {
    super(message);
    this.name = 'PosterUsdcSpendAdmissionError';
  }
}

/**
 * The one lock shared by every operation that can reserve or spend a poster's
 * custodial USDC. Keep this key stable: changing it would split the money
 * critical section during a rolling deploy.
 */
export async function lockPosterUsdcSpend(
  tx: PosterUsdcSpendTx,
  posterAvatarId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${POSTER_USDC_SPEND_LOCK_PREFIX}${posterAvatarId}`}, 0)
    )
  `);
}

export interface PosterUsdcSpendAdmission {
  walletPublicKey: string;
  balanceAtomic: bigint;
  openHoldsAtomic: bigint;
  outgoingLiabilitiesAtomic: bigint;
  consumedHoldAtomic: bigint;
  requiredAtomic: bigint;
}

/**
 * Must be called inside the transaction that commits the new hold/payment/
 * withdrawal. Admission is fail-closed and uses exact base-unit arithmetic.
 *
 * A bounty settlement names its own hold. That hold must exactly equal the
 * payment and is credited once for this admission; all other holds remain
 * reserved. In-flight payment rows backed by a still-open named hold are not
 * counted twice, while ordinary pending/settling sends and every ambiguous
 * reconcile row remain liabilities. A reconcile agent payment is removable
 * only when cap_exempt proves it was never broadcast; withdrawal reconciliation
 * has no equivalent proof marker and therefore always remains reserved.
 */
export async function admitPosterUsdcSpend(
  tx: PosterUsdcSpendTx,
  input: {
    posterAvatarId: string;
    amountAtomic: bigint;
    consumeBountyHoldId?: string;
    readBalance: (publicKey: string) => Promise<bigint>;
  },
): Promise<PosterUsdcSpendAdmission> {
  if (input.amountAtomic <= 0n) throw new Error('USDC spend admission amount must be positive');
  await lockPosterUsdcSpend(tx, input.posterAvatarId);

  const walletRows = await tx.execute<{ public_key: string }>(sql`
    SELECT public_key
    FROM wallets
    WHERE subject_type = 'avatar' AND subject_id = ${input.posterAvatarId}
    LIMIT 1
  `);
  const wallet = Array.from(walletRows as Iterable<{ public_key: string }>)[0];
  if (!wallet) {
    throw new PosterUsdcSpendAdmissionError(
      'wallet_missing',
      'A custodial wallet is required for this USDC operation.',
    );
  }

  const stateRows = await tx.execute<{
    open_holds: string;
    outgoing_liabilities: string;
    consumed_hold: string | null;
  }>(sql`
    SELECT
      COALESCE((
        SELECT SUM(h.amount_base_units)
        FROM bounty_usdc_holds h
        WHERE h.poster_avatar_id = ${input.posterAvatarId}
          AND h.status = 'open'
      ), 0)::text AS open_holds,
      (
        COALESCE((
          SELECT SUM(p.usdc_atomic)
          FROM agent_payments p
          LEFT JOIN bounty_usdc_holds backing
            ON backing.bounty_id = p.bounty_hold_id
           AND backing.poster_avatar_id = p.sender_avatar_id
           AND backing.status = 'open'
          WHERE p.sender_avatar_id = ${input.posterAvatarId}
            AND (
              p.status IN ('pending', 'settling')
              OR (p.status = 'reconcile' AND p.cap_exempt IS NOT TRUE)
            )
            AND backing.bounty_id IS NULL
        ), 0)
        + COALESCE((
          SELECT SUM(w.amount_atomic)
          FROM withdrawals w
          WHERE w.avatar_id = ${input.posterAvatarId}
            AND w.asset = 'USDC'
            AND w.status IN ('pending', 'sending', 'reconcile')
        ), 0)
      )::text AS outgoing_liabilities,
      ${input.consumeBountyHoldId
        ? sql`(
            SELECT h.amount_base_units::text
            FROM bounty_usdc_holds h
            WHERE h.bounty_id = ${input.consumeBountyHoldId}
              AND h.poster_avatar_id = ${input.posterAvatarId}
              AND h.status = 'open'
          )`
        : sql`NULL::text`} AS consumed_hold
  `);
  const state = Array.from(stateRows as Iterable<{
    open_holds: string;
    outgoing_liabilities: string;
    consumed_hold: string | null;
  }>)[0];
  if (!state) throw new PosterUsdcSpendAdmissionError('balance_unavailable', 'USDC reservations could not be verified.');

  const openHoldsAtomic = BigInt(state.open_holds);
  const outgoingLiabilitiesAtomic = BigInt(state.outgoing_liabilities);
  const consumedHoldAtomic = state.consumed_hold === null ? 0n : BigInt(state.consumed_hold);
  if (input.consumeBountyHoldId && state.consumed_hold === null) {
    throw new PosterUsdcSpendAdmissionError(
      'bounty_hold_missing',
      'The Tier-1 bounty payment has no live backing hold.',
    );
  }
  if (input.consumeBountyHoldId && consumedHoldAtomic !== input.amountAtomic) {
    throw new PosterUsdcSpendAdmissionError(
      'bounty_hold_mismatch',
      'The Tier-1 bounty payment does not exactly match its backing hold.',
      { holdBaseUnits: consumedHoldAtomic.toString(), paymentBaseUnits: input.amountAtomic.toString() },
    );
  }

  let balanceAtomic: bigint;
  try {
    balanceAtomic = await input.readBalance(wallet.public_key);
  } catch {
    throw new PosterUsdcSpendAdmissionError(
      'balance_unavailable',
      'The custodial USDC balance could not be verified. The operation was refused.',
    );
  }

  const requiredAtomic = openHoldsAtomic
    + outgoingLiabilitiesAtomic
    + input.amountAtomic
    - consumedHoldAtomic;
  if (balanceAtomic < requiredAtomic) {
    throw new PosterUsdcSpendAdmissionError(
      'insufficient_usdc',
      'The custodial USDC balance does not cover open bounty holds and outgoing payments.',
      {
        balanceBaseUnits: balanceAtomic.toString(),
        openHoldsBaseUnits: openHoldsAtomic.toString(),
        outgoingLiabilitiesBaseUnits: outgoingLiabilitiesAtomic.toString(),
        consumedHoldBaseUnits: consumedHoldAtomic.toString(),
        requiredBaseUnits: requiredAtomic.toString(),
      },
    );
  }

  return {
    walletPublicKey: wallet.public_key,
    balanceAtomic,
    openHoldsAtomic,
    outgoingLiabilitiesAtomic,
    consumedHoldAtomic,
    requiredAtomic,
  };
}
