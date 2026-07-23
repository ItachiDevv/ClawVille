import {
  x402SettlementReceipts,
  and,
  eq,
  type X402SettlementReceipt,
} from '@clawville/database';
import type { LedgerTx } from './claw-token-ledger';
import {
  assertSettlementAmountsConserved,
  legacySettlementAmounts,
  type X402SettlementAmounts,
} from './x402-settlement-accounting';

export type X402SettlementRail =
  | 'ct_topup'
  | 'x402_checkout'
  | 'agent_payment'
  | 'partner_storefront';

export interface ClaimX402SettlementInput {
  txSignature: string;
  rail: X402SettlementRail;
  kind: string;
  referenceId: string;
  subjectId: string;
  /** Original settlement amount; retained as gross for compatibility. */
  amountUsdcAtomic: bigint;
  grossUsdcAtomic?: bigint;
  platformFeeUsdcAtomic?: bigint;
  treasuryFeeUsdcAtomic?: bigint;
  netUsdcAtomic?: bigint;
}

export type ClaimX402SettlementResult =
  | { kind: 'claimed'; receipt: X402SettlementReceipt }
  | { kind: 'same_owner'; receipt: X402SettlementReceipt }
  | { kind: 'foreign_owner'; receipt: X402SettlementReceipt };

function amountsForClaim(
  input: ClaimX402SettlementInput,
): X402SettlementAmounts {
  const supplied = [
    input.grossUsdcAtomic,
    input.platformFeeUsdcAtomic,
    input.treasuryFeeUsdcAtomic,
    input.netUsdcAtomic,
  ];
  if (supplied.every((value) => value === undefined)) {
    return legacySettlementAmounts(input.amountUsdcAtomic);
  }
  if (supplied.some((value) => value === undefined)) {
    throw new Error('incomplete x402 settlement fee accounting');
  }

  const amounts: X402SettlementAmounts = {
    grossUsdcAtomic: input.grossUsdcAtomic!,
    platformFeeUsdcAtomic: input.platformFeeUsdcAtomic!,
    treasuryFeeUsdcAtomic: input.treasuryFeeUsdcAtomic!,
    netUsdcAtomic: input.netUsdcAtomic!,
  };
  assertSettlementAmountsConserved(amounts);
  if (amounts.grossUsdcAtomic !== input.amountUsdcAtomic) {
    throw new Error('x402 receipt amount must equal settlement gross');
  }
  return amounts;
}

function amountsForReceipt(
  receipt: X402SettlementReceipt,
): X402SettlementAmounts {
  if (
    receipt.grossUsdcAtomic === null ||
    receipt.platformFeeUsdcAtomic === null ||
    receipt.treasuryFeeUsdcAtomic === null ||
    receipt.netUsdcAtomic === null
  ) {
    return legacySettlementAmounts(receipt.amountUsdcAtomic);
  }
  return {
    grossUsdcAtomic: receipt.grossUsdcAtomic,
    platformFeeUsdcAtomic: receipt.platformFeeUsdcAtomic,
    treasuryFeeUsdcAtomic: receipt.treasuryFeeUsdcAtomic,
    netUsdcAtomic: receipt.netUsdcAtomic,
  };
}

export function receiptMatchesOwner(
  receipt: X402SettlementReceipt,
  input: ClaimX402SettlementInput,
): boolean {
  const amounts = amountsForClaim(input);
  const storedAmounts = amountsForReceipt(receipt);
  return (
    receipt.txSignature === input.txSignature &&
    receipt.rail === input.rail &&
    receipt.kind === input.kind &&
    receipt.referenceId === input.referenceId &&
    receipt.subjectId === input.subjectId &&
    receipt.amountUsdcAtomic === input.amountUsdcAtomic &&
    storedAmounts.grossUsdcAtomic === amounts.grossUsdcAtomic &&
    storedAmounts.platformFeeUsdcAtomic === amounts.platformFeeUsdcAtomic &&
    storedAmounts.treasuryFeeUsdcAtomic === amounts.treasuryFeeUsdcAtomic &&
    storedAmounts.netUsdcAtomic === amounts.netUsdcAtomic
  );
}

/**
 * Claim global ownership of one x402 signature on the caller's transaction.
 * A migration-backfilled captured row may already own its own receipt, so an
 * exact (rail, referenceId) match is resumable; any other owner is a hard
 * cross-rail conflict.
 */
export async function claimX402Settlement(
  input: ClaimX402SettlementInput,
  tx: LedgerTx,
): Promise<ClaimX402SettlementResult> {
  if (
    !input.txSignature ||
    !input.referenceId ||
    !input.subjectId ||
    input.amountUsdcAtomic <= 0n
  ) {
    throw new Error('invalid x402 settlement receipt claim');
  }
  const amounts = amountsForClaim(input);
  const values = { ...input, ...amounts };
  const [inserted] = await tx
    .insert(x402SettlementReceipts)
    .values(values)
    .onConflictDoNothing({ target: x402SettlementReceipts.txSignature })
    .returning();
  if (inserted) return { kind: 'claimed', receipt: inserted };

  const [existing] = await tx
    .select()
    .from(x402SettlementReceipts)
    .where(
      and(
        eq(x402SettlementReceipts.txSignature, input.txSignature),
        eq(x402SettlementReceipts.rail, input.rail),
        eq(x402SettlementReceipts.kind, input.kind),
        eq(x402SettlementReceipts.referenceId, input.referenceId),
        eq(x402SettlementReceipts.subjectId, input.subjectId),
        eq(x402SettlementReceipts.amountUsdcAtomic, input.amountUsdcAtomic),
      ),
    )
    .limit(1);
  if (existing && receiptMatchesOwner(existing, input)) {
    return { kind: 'same_owner', receipt: existing };
  }

  const [foreign] = await tx
    .select()
    .from(x402SettlementReceipts)
    .where(eq(x402SettlementReceipts.txSignature, input.txSignature))
    .limit(1);
  if (!foreign) {
    throw new Error(
      'x402 settlement receipt conflict disappeared inside transaction',
    );
  }
  return { kind: 'foreign_owner', receipt: foreign };
}

/** Read-side authority used by reconciliation probes. */
export async function isX402SettlementClaimed(
  txSignature: string,
): Promise<boolean> {
  const { db } = await import('@clawville/database');
  const [row] = await db
    .select({ txSignature: x402SettlementReceipts.txSignature })
    .from(x402SettlementReceipts)
    .where(eq(x402SettlementReceipts.txSignature, txSignature))
    .limit(1);
  return Boolean(row);
}
