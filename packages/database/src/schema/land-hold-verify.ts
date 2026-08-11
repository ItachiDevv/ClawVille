/**
 * Land hold-wallet ownership proof — DOOR 2 (exact-dust transfer challenge).
 *
 * Founder ruling 2026-08-10: proof of control over the declared hold wallet is
 * REQUIRED before the hold door opens ("optional proof is just not proof").
 * Door 1 is a free ed25519 signature over a server nonce and needs no table.
 * Door 2 exists so a user who will not connect a browser wallet is not locked
 * out: they send an EXACT unique dust amount of SOL from the declared wallet to
 * a ClawVille verify address WITH an SPL Memo naming the challenge id, we
 * attribute by exact amount + sender, require the memo as the sender's
 * statement of intent (amount + sender alone can be induced from a wallet the
 * claimant does not control), grant on FINALIZED commitment, then AUTO-REFUND.
 *
 * This is a REAL MAINNET SOL money path (CLV lives on mainnet), so the row
 * carries the same durable claim/capture discipline as the bounty gas sponsor:
 *   - `lamports` is UNIQUE among `status = 'pending'` rows, so exact-amount
 *     attribution is unambiguous even for two concurrent challenges from the
 *     SAME sender (the service regenerates on a 23505 collision);
 *   - `inbound_signature` is UNIQUE when present, so one on-chain transfer can
 *     satisfy at most one challenge and a replayed scan is a no-op;
 *   - `refund_claim_id` / `refund_claimed_at` are the capture-before-send lease
 *     pair (same CHECK shape as `bounty_gas_sponsorships_claim_lease_pair`), and
 *     an ambiguous refund outcome parks in `refund_state = 'reconcile'` rather
 *     than blindly retrying a double-send.
 *
 * A refund failure NEVER revokes verification: the grant is fail-CLOSED, the
 * refund is fail-SOFT. Migration `0060_land_hold_wallet_proof.sql` (idempotent,
 * applied by the CI migrate gate — NEVER db:push).
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  boolean,
  jsonb,
  date,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const landHoldWalletTransferChallenges = pgTable(
  'land_hold_wallet_transfer_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * RESTRICT, never CASCADE: this is a live money ledger. Deleting an account
     * mid-processing would strand inbound SOL at the verify address and destroy
     * the audit trail proving we owe it back. `walletPubkey` is the immutable
     * account-side snapshot carried on every row.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The DECLARED wallet that must be the sender of the dust transfer. */
    walletPubkey: varchar('wallet_pubkey', { length: 44 }).notNull(),
    /** Exact expected amount. Unique among pending rows — it IS the attribution key. */
    lamports: bigint('lamports', { mode: 'bigint' }).notNull(),
    /**
     * What we ACTUALLY received from `walletPubkey` in the attributed
     * transaction, summed across every leg. One transaction can carry the exact
     * amount more than once; refunding only `lamports` would keep the surplus.
     */
    inboundLamports: bigint('inbound_lamports', { mode: 'bigint' }),
    /** The ClawVille verify wallet (treasury_wallets purpose 'land-hold-verify'). */
    destinationPubkey: varchar('destination_pubkey', { length: 44 }).notNull(),
    /** 'pending' | 'observed' | 'verified' | 'expired' | 'failed' | 'rejected'. */
    status: text('status').notNull(),
    /**
     * Why an EXACT-amount inbound could not be proof: 'memo_missing' (no SPL
     * Memo naming this challenge, so the transfer states no intent and could
     * have been induced from a wallet the claimant does not control) or
     * 'source_not_signer' (a program signed for the source, e.g. a Squads
     * vault), or 'transfer_not_top_level' (the paying leg was CPI-emitted, so
     * the signer did not write it). Set exactly when status = 'rejected'; the
     * money is refunded either way.
     */
    rejectedReason: varchar('rejected_reason', { length: 32 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The attributed inbound transfer. UNIQUE when present. */
    inboundSignature: varchar('inbound_signature', { length: 128 }),
    /** 'none' | 'sending' | 'sent' | 'reconcile' | 'skipped'. */
    refundState: text('refund_state'),
    refundSignature: varchar('refund_signature', { length: 128 }),
    refundClaimId: uuid('refund_claim_id'),
    refundClaimedAt: timestamp('refund_claimed_at', { withTimezone: true }),
    /**
     * Immutable spend-window stamp written under the global cap lock when the
     * refund is AUTHORIZED. Spend counted by row creation let a deferred backlog
     * age out of the window and then blow past the cap all at once on resume.
     */
    refundCapDay: date('refund_cap_day'),
    refundCapLamports: bigint('refund_cap_lamports', { mode: 'bigint' }),
    refundAuthorizedAt: timestamp('refund_authorized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pendingLamportsUnique: uniqueIndex(
      'land_hold_wallet_transfer_challenges_pending_lamports_unique',
    )
      .on(t.lamports)
      .where(sql`${t.status} = 'pending'`),
    inboundSignatureUnique: uniqueIndex(
      'land_hold_wallet_transfer_challenges_inbound_signature_unique',
    )
      .on(t.inboundSignature)
      .where(sql`${t.inboundSignature} IS NOT NULL`),
    statusExpiresIdx: index(
      'land_hold_wallet_transfer_challenges_status_expires_idx',
    ).on(t.status, t.expiresAt),
    userCreatedIdx: index(
      'land_hold_wallet_transfer_challenges_user_created_idx',
    ).on(t.userId, t.createdAt),
    lamportsPositive: check(
      'land_hold_wallet_transfer_challenges_lamports_positive',
      sql`${t.lamports} > 0`,
    ),
    statusValid: check(
      'land_hold_wallet_transfer_challenges_status_valid',
      sql`${t.status} IN ('pending', 'observed', 'verified', 'expired', 'failed', 'rejected', 'unclaimed')`,
    ),
    rejectedReasonValid: check(
      'land_hold_wallet_transfer_challenges_rejected_reason_valid',
      sql`${t.rejectedReason} IS NULL OR ${t.rejectedReason} IN ('memo_missing', 'source_not_signer', 'transfer_not_top_level')`,
    ),
    rejectedReasonPair: check(
      'land_hold_wallet_transfer_challenges_rejected_reason_pair',
      sql`(${t.status} = 'rejected') = (${t.rejectedReason} IS NOT NULL)`,
    ),
    refundStateValid: check(
      'land_hold_wallet_transfer_challenges_refund_state_valid',
      sql`${t.refundState} IS NULL OR ${t.refundState} IN ('none', 'sending', 'sent', 'reconcile', 'skipped')`,
    ),
    refundClaimLeasePair: check(
      'land_hold_wallet_transfer_challenges_refund_claim_lease_pair',
      sql`(${t.refundClaimId} IS NULL) = (${t.refundClaimedAt} IS NULL)`,
    ),
    /**
     * Refund bytes are deterministic (fee payer, blockhash, destination,
     * amount), and amounts become reusable after a challenge closes, so two
     * backlogged refunds could produce the IDENTICAL signature — Solana deduped
     * the second while both rows recorded `sent`. The refund now carries a
     * per-challenge memo; this index is the database backstop.
     */
    refundSignatureUnique: uniqueIndex(
      'land_hold_wallet_transfer_challenges_refund_signature_unique',
    )
      .on(t.refundSignature)
      .where(sql`${t.refundSignature} IS NOT NULL`),
    refundCapDayIdx: index('land_hold_wallet_transfer_challenges_refund_cap_day_idx')
      .on(t.refundCapDay)
      .where(sql`${t.refundCapDay} IS NOT NULL`),
    inboundLamportsPositive: check(
      'land_hold_wallet_transfer_challenges_inbound_lamports_positive',
      sql`${t.inboundLamports} IS NULL OR ${t.inboundLamports} > 0`,
    ),
    refundCapStamp: check(
      'land_hold_wallet_transfer_challenges_refund_cap_stamp',
      sql`(${t.refundCapDay} IS NULL AND ${t.refundCapLamports} IS NULL
            AND ${t.refundAuthorizedAt} IS NULL)
        OR (${t.refundCapDay} IS NOT NULL AND ${t.refundCapLamports} IS NOT NULL
            AND ${t.refundAuthorizedAt} IS NOT NULL)`,
    ),
  }),
);

/**
 * DB-owned daily refund-fee cap policy — the sibling of `bounty_gas_cap_policies`
 * (migration 0057b). The first cap-consuming admission of a UTC day owns that
 * day's value under the global cap lock; a pod carrying a different env value
 * must agree with the recorded policy or its admission is refused and ops paged.
 */
export const landHoldVerifyCapPolicies = pgTable(
  'land_hold_verify_cap_policies',
  {
    capDay: date('cap_day').primaryKey(),
    capLamports: bigint('cap_lamports', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    capPositive: check('land_hold_verify_cap_policies_cap_positive', sql`${t.capLamports} > 0`),
  }),
);

/**
 * Durable scan ledger — the work queue behind cursor-paginated attribution.
 *
 * A single newest-page scan let cheap inbound spam ECLIPSE a real deposit: 25
 * one-lamport transfers newer than the payment were re-parsed every pass and the
 * payment at position 26 was never examined, so after its grace window the
 * user's SOL was neither attributed nor refunded. Recording every parsed
 * signature makes the work monotonic and restart-safe.
 */
export const landHoldWalletVerifyScans = pgTable(
  'land_hold_wallet_verify_scans',
  {
    destinationPubkey: varchar('destination_pubkey', { length: 44 }).notNull(),
    signature: varchar('signature', { length: 128 }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }),
    /**
     * Parsed transfer/memo/signer facts for THIS destination. Stored so a
     * challenge opened later can be matched against an earlier parse — a bare
     * "seen" flag would turn the ledger into a blindfold.
     */
    facts: jsonb('facts').notNull().default({}),
    /** True when this signature settled/attributed to a challenge. */
    matched: boolean('matched').notNull().default(false),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.destinationPubkey, t.signature] }),
    scannedAtIdx: index('land_hold_wallet_verify_scans_scanned_at_idx').on(t.scannedAt),
    destinationBlockTimeIdx: index(
      'land_hold_wallet_verify_scans_destination_block_time_idx',
    ).on(t.destinationPubkey, t.blockTime),
  }),
);

/**
 * User funds at a verify address that NO challenge row can return: another
 * sender's legs in a transaction we settled for someone else, dust paid to a
 * rotated verify address, or money that arrived, was never submitted, and is now
 * past every live challenge window.
 *
 * Exists because an ALERT must never be the only record of retained user funds.
 * Settlement is operator-driven; this row is the durable, queryable claim.
 */
export const landHoldWalletRefundObligations = pgTable(
  'land_hold_wallet_refund_obligations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    destinationPubkey: varchar('destination_pubkey', { length: 44 }).notNull(),
    signature: varchar('signature', { length: 128 }).notNull(),
    /** The wallet the funds must go back to. */
    recipientPubkey: varchar('recipient_pubkey', { length: 44 }).notNull(),
    lamports: bigint('lamports', { mode: 'bigint' }).notNull(),
    /** 'retained_leg' | 'destination_rotated' | 'unclaimed_inbound'. */
    reason: varchar('reason', { length: 32 }).notNull(),
    /** 'open' | 'settled' | 'void'. */
    state: text('state').notNull().default('open'),
    challengeId: uuid('challenge_id').references(() => landHoldWalletTransferChallenges.id, {
      onDelete: 'restrict',
    }),
    settledSignature: varchar('settled_signature', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /**
     * Re-observing the same retained funds must not create a second claim. The
     * DESTINATION is part of the key because one transaction can fund several
     * historical verify addresses, which are genuinely separate debts.
     */
    obligationUnique: uniqueIndex('land_hold_wallet_refund_obligations_unique').on(
      t.destinationPubkey,
      t.signature,
      t.recipientPubkey,
      t.reason,
    ),
    openIdx: index('land_hold_wallet_refund_obligations_open_idx')
      .on(t.state, t.createdAt)
      .where(sql`${t.state} = 'open'`),
    lamportsPositive: check(
      'land_hold_wallet_refund_obligations_lamports_positive',
      sql`${t.lamports} > 0`,
    ),
    reasonValid: check(
      'land_hold_wallet_refund_obligations_reason_valid',
      sql`${t.reason} IN ('retained_leg', 'destination_rotated', 'unclaimed_inbound')`,
    ),
    stateValid: check(
      'land_hold_wallet_refund_obligations_state_valid',
      sql`${t.state} IN ('open', 'settled', 'void')`,
    ),
  }),
);

export type LandHoldWalletTransferChallenge =
  typeof landHoldWalletTransferChallenges.$inferSelect;
export type NewLandHoldWalletTransferChallenge =
  typeof landHoldWalletTransferChallenges.$inferInsert;
