/**
 * ClawToken audit ledger helpers.
 *
 * Every write to `avatars.clawTokens` MUST go through `creditClawTokens()` or
 * `debitClawTokens()`. These helpers atomically:
 *   1. SELECT the current avatars row FOR UPDATE (row lock — prevents races)
 *   2. Compute the new balance (credit: add; debit: subtract, assert >= 0)
 *   3. UPDATE avatars.clawTokens
 *   4. INSERT a claw_token_transactions row with the new balanceAfter
 *
 * All four steps run in a single DB transaction. If any step fails, the
 * whole thing rolls back — invariant: `avatars.clawTokens` always matches the
 * latest `balanceAfter` in the ledger.
 *
 * Existing code that did `UPDATE avatars SET claw_tokens = claw_tokens + N` is
 * migrated to call these helpers instead. Grep for any remaining direct
 * updates — they're bugs.
 */

import { eq, sql } from 'drizzle-orm';
import { db, avatars, clawTokenTransactions } from '@clawville/database';
import { logEvent } from './event-logger';

/**
 * Drizzle transaction type — passing this lets the helpers compose into
 * a larger atomic block (e.g. bazaar transfers, auction settlement).
 * When omitted, the helper opens its own transaction.
 */
type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ClawTokenSource =
  | 'api'
  | 'simulation'
  | 'quest'
  | 'bounty'
  | 'daily_login'
  | 'admin'
  | 'x402'
  | 'system';

export interface LedgerCreditInput {
  avatarId: string;
  /** Positive integer — number of ClawTokens to add */
  amount: number;
  /** Short reason string, e.g. 'autonomous_visit', 'daily_login', 'quest_complete' */
  reason: string;
  source: ClawTokenSource;
  /** Optional reason-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface LedgerDebitInput {
  avatarId: string;
  /** Positive integer — number of ClawTokens to subtract */
  amount: number;
  reason: string;
  source: ClawTokenSource;
  metadata?: Record<string, unknown>;
}

export interface LedgerResult {
  balanceAfter: number;
  ledgerId: string;
}

export class InsufficientTokensError extends Error {
  constructor(
    public readonly avatarId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      `Avatar ${avatarId} has ${available} ClawTokens, cannot debit ${requested}`,
    );
    this.name = 'InsufficientTokensError';
  }
}

async function creditInTx(tx: LedgerTx, input: LedgerCreditInput): Promise<LedgerResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(`creditClawTokens amount must be a positive integer, got ${input.amount}`);
  }

  // Row-lock the avatar and read current balance + userId
  const [row] = await tx.execute<{ user_id: string; claw_tokens: number }>(
    sql`SELECT user_id, claw_tokens FROM avatars WHERE id = ${input.avatarId} FOR UPDATE`,
  );

  if (!row) {
    throw new Error(`creditClawTokens: avatar ${input.avatarId} not found`);
  }

  const balanceAfter = row.claw_tokens + input.amount;

  await tx.update(avatars).set({ clawTokens: balanceAfter }).where(eq(avatars.id, input.avatarId));

  const [ledger] = await tx
    .insert(clawTokenTransactions)
    .values({
      avatarId: input.avatarId,
      userId: row.user_id,
      amount: input.amount,
      balanceAfter,
      reason: input.reason,
      source: input.source,
      metadata: input.metadata ?? {},
    })
    .returning({ id: clawTokenTransactions.id });

  return { balanceAfter, ledgerId: ledger.id };
}

async function debitInTx(tx: LedgerTx, input: LedgerDebitInput): Promise<LedgerResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(`debitClawTokens amount must be a positive integer, got ${input.amount}`);
  }

  const [row] = await tx.execute<{ user_id: string; claw_tokens: number }>(
    sql`SELECT user_id, claw_tokens FROM avatars WHERE id = ${input.avatarId} FOR UPDATE`,
  );

  if (!row) {
    throw new Error(`debitClawTokens: avatar ${input.avatarId} not found`);
  }

  if (row.claw_tokens < input.amount) {
    throw new InsufficientTokensError(input.avatarId, row.claw_tokens, input.amount);
  }

  const balanceAfter = row.claw_tokens - input.amount;

  await tx.update(avatars).set({ clawTokens: balanceAfter }).where(eq(avatars.id, input.avatarId));

  const [ledger] = await tx
    .insert(clawTokenTransactions)
    .values({
      avatarId: input.avatarId,
      userId: row.user_id,
      amount: -input.amount, // negative for debits in the signed ledger
      balanceAfter,
      reason: input.reason,
      source: input.source,
      metadata: input.metadata ?? {},
    })
    .returning({ id: clawTokenTransactions.id });

  return { balanceAfter, ledgerId: ledger.id };
}

/**
 * Credit ClawTokens to an avatar. Row-locked, atomic with ledger insert.
 *
 * Pass `tx` to compose into a larger transaction (e.g. bazaar/auction
 * transfers where both buyer debit and seller credit must succeed
 * together). If omitted, opens its own transaction.
 */
export async function creditClawTokens(
  input: LedgerCreditInput,
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (tx) return creditInTx(tx, input);
  return db.transaction((innerTx) => creditInTx(innerTx, input));
}

/**
 * Debit ClawTokens from an avatar. Throws InsufficientTokensError if balance
 * too low. Pass `tx` to compose into a larger transaction.
 */
export async function debitClawTokens(
  input: LedgerDebitInput,
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (tx) return debitInTx(tx, input);
  return db.transaction((innerTx) => debitInTx(innerTx, input));
}

/**
 * Atomic transfer between two avatars — one transaction, both or neither.
 * Use for bazaar sales, auction settlements, bounty escrow release, etc.
 */
export async function transferClawTokens(input: {
  fromAvatarId: string;
  toAvatarId: string;
  amount: number;
  reason: string;
  source: ClawTokenSource;
  metadata?: Record<string, unknown>;
}): Promise<{ fromBalance: number; toBalance: number }> {
  const result = await db.transaction(async (tx) => {
    const debit = await debitInTx(tx, {
      avatarId: input.fromAvatarId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      metadata: { ...input.metadata, transferTo: input.toAvatarId },
    });
    const credit = await creditInTx(tx, {
      avatarId: input.toAvatarId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      metadata: { ...input.metadata, transferFrom: input.fromAvatarId },
    });
    return { fromBalance: debit.balanceAfter, toBalance: credit.balanceAfter };
  });

  // Agent↔agent settlement telemetry — fires only after the atomic transfer
  // succeeds. Peer-to-peer transfers are currently paused (skill marketplace
  // write handlers return 503) but ledger infra still supports it; the event
  // keeps us informed if/when peer flows resume.
  void logEvent({
    eventType: 'tokens.settled',
    avatarId: input.toAvatarId,
    payload: {
      amount: input.amount,
      fromAvatarId: input.fromAvatarId,
      toAvatarId: input.toAvatarId,
      reason: input.reason,
      source: input.source,
    },
  });

  return result;
}
