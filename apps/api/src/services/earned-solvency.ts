/** Pure EARNED backing solvency arithmetic shared by E1 admission and E3 audit. */
import { createHash } from 'crypto';
import { sql } from '@clawville/database';

export type EarnedBackingIntegrityCounts = {
  mismatch_count: string;
  missing_event_count: string;
  missing_backing_count: string;
  wrong_custody_count: string;
  original_amount_count: string;
  remaining_amount_count: string;
  event_lot_count: string;
  event_gross_count: string;
  event_ledger_count: string;
  event_avatar_count: string;
  missing_ledger_count: string;
  ledger_provenance_count: string;
  ledger_amount_count: string;
  ledger_avatar_count: string;
  none_positive_count: string;
};

/** Shared fail-closed structure check. LEFT JOINs are deliberate: malformed
 * rows must be counted, never disappear from a solvency INNER JOIN. */
export function earnedBackingIntegrityQuery(custodyWalletId: string) {
  return sql`SELECT
      COUNT(*) FILTER (WHERE
        (l.backing_kind = 'backed' AND (
          e.id IS NULL OR b.id IS NULL OR b.custody_wallet_id IS DISTINCT FROM ${custodyWalletId}
          OR b.original_usdc_atomic IS DISTINCT FROM l.original_vclaw::numeric * 10000
          OR b.remaining_usdc_atomic IS DISTINCT FROM l.remaining_vclaw::numeric * 10000
          OR e.vclaw_minted IS DISTINCT FROM l.original_vclaw
          OR e.gross_usdc_atomic IS DISTINCT FROM l.original_vclaw::numeric * 10000
          OR e.ledger_id IS DISTINCT FROM l.ledger_id
          OR e.earner_avatar_id IS DISTINCT FROM l.avatar_id
          OR ct.id IS NULL OR ct.provenance IS DISTINCT FROM 'earned'
          OR ct.amount IS DISTINCT FROM l.original_vclaw
          OR ct.avatar_id IS DISTINCT FROM l.avatar_id
        )) OR (l.backing_kind = 'none' AND b.id IS NOT NULL
          AND b.remaining_usdc_atomic <> 0)
      )::text AS mismatch_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND e.id IS NULL)::text AS missing_event_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND b.id IS NULL)::text AS missing_backing_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND b.id IS NOT NULL AND b.custody_wallet_id IS DISTINCT FROM ${custodyWalletId})::text AS wrong_custody_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND b.id IS NOT NULL AND b.original_usdc_atomic IS DISTINCT FROM l.original_vclaw::numeric * 10000)::text AS original_amount_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND b.id IS NOT NULL AND b.remaining_usdc_atomic IS DISTINCT FROM l.remaining_vclaw::numeric * 10000)::text AS remaining_amount_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND e.id IS NOT NULL AND e.vclaw_minted IS DISTINCT FROM l.original_vclaw)::text AS event_lot_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND e.id IS NOT NULL AND e.gross_usdc_atomic IS DISTINCT FROM l.original_vclaw::numeric * 10000)::text AS event_gross_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND e.id IS NOT NULL AND e.ledger_id IS DISTINCT FROM l.ledger_id)::text AS event_ledger_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND e.id IS NOT NULL AND e.earner_avatar_id IS DISTINCT FROM l.avatar_id)::text AS event_avatar_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND ct.id IS NULL)::text AS missing_ledger_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND ct.id IS NOT NULL AND ct.provenance IS DISTINCT FROM 'earned')::text AS ledger_provenance_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND ct.id IS NOT NULL AND ct.amount IS DISTINCT FROM l.original_vclaw)::text AS ledger_amount_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'backed' AND ct.id IS NOT NULL AND ct.avatar_id IS DISTINCT FROM l.avatar_id)::text AS ledger_avatar_count,
      COUNT(*) FILTER (WHERE l.backing_kind = 'none' AND b.id IS NOT NULL AND b.remaining_usdc_atomic <> 0)::text AS none_positive_count
    FROM earned_mint_lots l
    LEFT JOIN earned_backing b ON b.mint_lot_id = l.id
    LEFT JOIN earn_events e ON e.id = l.earn_event_id
    LEFT JOIN claw_token_transactions ct ON ct.id = l.ledger_id`;
}

const INTEGRITY_REASON_FIELDS = {
  missing_event_count: 'backed_without_event',
  missing_backing_count: 'backed_without_backing',
  wrong_custody_count: 'backing_wrong_custody',
  original_amount_count: 'backing_original_amount_mismatch',
  remaining_amount_count: 'backing_remaining_amount_mismatch',
  event_lot_count: 'event_lot_amount_mismatch',
  event_gross_count: 'event_gross_amount_mismatch',
  event_ledger_count: 'event_lot_ledger_mismatch',
  event_avatar_count: 'event_lot_avatar_mismatch',
  missing_ledger_count: 'backed_lot_without_ledger',
  ledger_provenance_count: 'ledger_provenance_mismatch',
  ledger_amount_count: 'ledger_lot_amount_mismatch',
  ledger_avatar_count: 'ledger_lot_avatar_mismatch',
  none_positive_count: 'none_lot_has_positive_backing',
} as const;

export function summarizeEarnedBackingIntegrity(
  row: EarnedBackingIntegrityCounts | undefined,
): { mismatchCount: number; reasons: string[] } {
  if (!row) return { mismatchCount: 1, reasons: ['backing_integrity_query_missing'] };
  const mismatchCount = Number.parseInt(row.mismatch_count, 10);
  if (!Number.isSafeInteger(mismatchCount) || mismatchCount < 0) {
    return { mismatchCount: 1, reasons: ['backing_integrity_query_invalid'] };
  }
  const reasons: string[] = [];
  for (const [field, reason] of Object.entries(INTEGRITY_REASON_FIELDS)) {
    const value = Number.parseInt(row[field as keyof EarnedBackingIntegrityCounts], 10);
    if (!Number.isSafeInteger(value) || value < 0) {
      return { mismatchCount: Math.max(1, mismatchCount), reasons: ['backing_integrity_query_invalid'] };
    }
    if (value > 0) reasons.push(`${reason}:${value}`);
  }
  if (mismatchCount > 0 && reasons.length === 0) reasons.push('backing_integrity_mismatch');
  return { mismatchCount, reasons };
}

/**
 * E1 reservation and E3 custody funding MUST use this exact lock identity.
 * The in-process mutex narrows same-process races; the advisory lock is the
 * cross-process authority and is always acquired inside the money tx.
 */
export function earnedBackingCustodyMutexKey(custodyWalletId: string): string {
  return `earned-backing-custody:${custodyWalletId}`;
}

export function earnedBackingCustodyLockKey(custodyWalletId: string): bigint {
  const digest = createHash('sha256')
    .update(earnedBackingCustodyMutexKey(custodyWalletId))
    .digest();
  return digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}
export type EarnedFundingPrincipal = {
  redemptionId: string;
  buyUsdcAtomic: string;
  fundingStatus: string | null;
  fundingSignature: string | null;
  fundingConfirmedSlot: number | null;
};

export function calculateEarnedBackingSolvency(input: {
  onchainUsdcAtomic: bigint;
  outstandingBackingUsdcAtomic: bigint;
  retainedExitFeesUsdcAtomic: bigint;
  principals: EarnedFundingPrincipal[];
  /** E1 admission reserves the prospective mint atomically under the custody lock. */
  newBackingUsdcAtomic?: bigint;
}): {
  unsweptBuyPrincipalUsdcAtomic: bigint;
  requiredUsdcAtomic: bigint;
  indeterminateReasons: string[];
  solvent: boolean;
} {
  let unswept = 0n;
  const indeterminateReasons: string[] = [];
  for (const principal of input.principals) {
    if (principal.fundingStatus === 'swept') {
      if (principal.fundingSignature === null) {
        indeterminateReasons.push(`${principal.redemptionId}:swept_without_signature`);
      }
      if (!Number.isSafeInteger(principal.fundingConfirmedSlot)
        || Number(principal.fundingConfirmedSlot) <= 0) {
        indeterminateReasons.push(`${principal.redemptionId}:swept_without_confirmed_slot`);
      }
      continue;
    }
    const capturedUnknown =
      principal.fundingSignature !== null &&
      (principal.fundingStatus === 'sweeping' || principal.fundingStatus === 'reconcile');
    if (capturedUnknown) {
      indeterminateReasons.push(`${principal.redemptionId}:${principal.fundingStatus}`);
    } else {
      unswept += BigInt(principal.buyUsdcAtomic);
    }
  }
  const required =
    input.outstandingBackingUsdcAtomic
    + input.retainedExitFeesUsdcAtomic
    + unswept
    + (input.newBackingUsdcAtomic ?? 0n);
  return {
    unsweptBuyPrincipalUsdcAtomic: unswept,
    requiredUsdcAtomic: required,
    indeterminateReasons,
    solvent: indeterminateReasons.length === 0 && input.onchainUsdcAtomic >= required,
  };
}
