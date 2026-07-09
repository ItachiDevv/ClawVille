import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { users } from './users';

/**
 * CUSTODIAL WALLET WITHDRAWALS (2026-07-08) — durable exactly-once ledger for
 * users moving their OWN deposited on-chain assets (SOL / USDC / CLV) out of
 * their in-game custodial avatar wallet to a self-custody destination.
 *
 * DARK: the whole feature ships behind the default-OFF `WALLET_WITHDRAW_ENABLED`
 * flag — see `apps/api/src/services/wallet-withdraw-executor.ts` (the state
 * machine) and `apps/api/src/routes/wallet-withdraw.ts` (the surface).
 *
 * State machine (the x402-checkout / market-payout-executor discipline —
 * a withdrawal SIGNS with the user's custodial keypair, so a double-send is a
 * real double-withdrawal):
 *
 *   pending  → sending    ATOMIC CLAIM (`claim_id`) BEFORE any decrypt/sign/send.
 *   sending  + signature  CAPTURE-BEFORE-SEND: the deterministic first tx
 *                         signature persists in its OWN committed UPDATE
 *                         (partial-UNIQUE `withdrawals_txsig_unique`) BEFORE
 *                         the wire is touched.
 *   sending  → sent       send + confirm succeeded (`sent_at`; CHECK: a 'sent'
 *                         row always carries its signature).
 *   sending  → failed     DEFINITIVE failure (tx landed with an on-chain error
 *                         — no assets moved — or custody refused pre-sign).
 *   sending  → reconcile  AMBIGUOUS send/confirm — money-state UNKNOWN;
 *                         TERMINAL, NEVER auto-retried (operator resolves
 *                         against the chain via the captured signature).
 *   sending  → pending    pre-capture failure ONLY (guarded
 *                         `tx_signature IS NULL`) — nothing signed ⇒ nothing
 *                         sent ⇒ clean retry.
 *
 * Idempotency: `withdrawals_idem_unique` — a retried `POST /api/wallet/withdraw`
 * with the same `Idempotency-Key` replays the EXISTING row's state, never a
 * second withdrawal.
 *
 * E5 PARITY: `subject_type ∈ ('user','agent')`; both withdraw from THEIR OWN
 * avatar's custodial wallet (`avatar_id` middleware-resolved, never
 * body-supplied). Guests + non-ledger agent sessions never reach an INSERT.
 *
 * LEDGER-UNTOUCHED: `amount_atomic` is an on-chain base-unit integer
 * (lamports / µUSDC / CLV atomic) — NEVER a ClawToken amount; nothing in this
 * flow touches `avatars.clawTokens` or the CT ledger.
 *
 * Migration: `packages/database/migrations/0021_wallet_withdrawals.sql`
 * (idempotent guarded CREATE TYPE + CREATE TABLE IF NOT EXISTS; apply via
 * migrate-ci — NEVER db:push).
 */

export const withdrawalStatusEnum = pgEnum('withdrawal_status', [
  'pending', // inserted; awaiting the atomic claim
  'sending', // CLAIMED; decrypt/sign in-flight (tx_signature NULL) or CAPTURED awaiting confirm (tx_signature set)
  'sent', // confirmed on-chain; tx_signature ALWAYS present (CHECK)
  'reconcile', // ambiguous send/confirm — money-state UNKNOWN; TERMINAL, never auto-retried
  'failed', // definitive failure (on-chain err / custody refusal / cap) — terminal, auditable
]);

export const withdrawals = pgTable(
  'withdrawals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The caller kind that requested it: 'user' (Lucia human) | 'agent' (ledger-capable agent session). */
    subjectType: text('subject_type').notNull(),
    /** The subject's OWN avatar — the custodial wallet that signs (middleware-resolved, never body-supplied). */
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** The bound user (present for both kinds; agents carry their bound user). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 'SOL' | 'USDC' | 'CLV' (CHECK-enforced). */
    asset: text('asset').notNull(),
    /** On-chain base units as an exact integer string (lamports / µUSDC / CLV atomic). NEVER ClawTokens. */
    amountAtomic: numeric('amount_atomic', { precision: 30, scale: 0 }).notNull(),
    /** Base58 destination pubkey (validated on-curve + non-self before insert). */
    destination: varchar('destination', { length: 64 }).notNull(),
    status: withdrawalStatusEnum('status').notNull().default('pending'),
    /** Captured BEFORE send (deterministic first signature of the signed tx). Partial-UNIQUE. */
    txSignature: text('tx_signature'),
    /** The atomic-claim token — only its holder may capture/release/mark. NULL unless claimed. */
    claimId: uuid('claim_id'),
    /** When the current claim started — drives stale-claim resume takeover. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** Stamped when the send confirmed on-chain. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Terminal machine reason ('send_ambiguous', 'tx_failed_on_chain', …). */
    failureReason: text('failure_reason'),
    /** Client-supplied Idempotency-Key (required on POST; partial-UNIQUE per subject). */
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
    /** Always 'mainnet' — stamped from the executor's pinned network constant. */
    network: text('network').notNull().default('mainnet'),
    /** Fee/rent breakdown at validation time, agentId for agent subjects, etc. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** One on-chain send binds to exactly one withdrawal. Partial: ignores NULLs. */
    txSigUnique: uniqueIndex('withdrawals_txsig_unique')
      .on(t.txSignature)
      .where(sql`tx_signature IS NOT NULL`),
    /** Retry replay — same (subject, key) can never create a second withdrawal. */
    idemUnique: uniqueIndex('withdrawals_idem_unique')
      .on(t.subjectType, t.avatarId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    /** Resume/ops scan hot path (stale 'sending' claims). */
    statusCreatedIdx: index('withdrawals_status_created_idx').on(t.status, t.createdAt),
    /** Per-subject history reads. (Originally also served a daily-cap SUM —
     *  caps were removed 2026-07-09 by founder decision; index stays for history.) */
    avatarIdx: index('withdrawals_avatar_idx').on(t.avatarId, t.createdAt),
    subjectTypeValid: check(
      'withdrawals_subject_type_valid',
      sql`${t.subjectType} IN ('user', 'agent')`,
    ),
    assetValid: check('withdrawals_asset_valid', sql`${t.asset} IN ('SOL', 'USDC', 'CLV')`),
    /** A zero/negative withdrawal can never persist. */
    amountPositive: check('withdrawals_amount_positive', sql`${t.amountAtomic} > 0`),
    /** A 'sent' row ALWAYS carries the money proof. */
    sentHasSignature: check(
      'withdrawals_sent_has_signature',
      sql`${t.status} <> 'sent' OR ${t.txSignature} IS NOT NULL`,
    ),
  }),
);

export type WithdrawalRow = typeof withdrawals.$inferSelect;
export type NewWithdrawalRow = typeof withdrawals.$inferInsert;
export type WithdrawalStatus = (typeof withdrawalStatusEnum.enumValues)[number];
