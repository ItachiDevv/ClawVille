/**
 * NeoToken audit ledger helpers.
 *
 * Every write to `pets.neoTokens` MUST go through `creditNeoTokens()` or
 * `debitNeoTokens()`. These helpers atomically:
 *   1. SELECT the current pets row FOR UPDATE (row lock — prevents races)
 *   2. Compute the new balance (credit: add; debit: subtract, assert >= 0)
 *   3. UPDATE pets.neoTokens
 *   4. INSERT a neo_token_transactions row with the new balanceAfter
 *
 * All four steps run in a single DB transaction. If any step fails, the
 * whole thing rolls back — invariant: `pets.neoTokens` always matches the
 * latest `balanceAfter` in the ledger.
 *
 * Existing code that did `UPDATE pets SET neo_tokens = neo_tokens + N` is
 * migrated to call these helpers instead. Grep for any remaining direct
 * updates — they're bugs.
 */

import { eq, sql } from 'drizzle-orm';
import { db, pets, neoTokenTransactions } from '@clawville/database';

/**
 * Drizzle transaction type — passing this lets the helpers compose into
 * a larger atomic block (e.g. bazaar transfers, auction settlement).
 * When omitted, the helper opens its own transaction.
 */
type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NeoTokenSource =
  | 'api'
  | 'simulation'
  | 'quest'
  | 'bounty'
  | 'daily_login'
  | 'admin'
  | 'x402'
  | 'system';

export interface LedgerCreditInput {
  petId: string;
  /** Positive integer — number of NeoTokens to add */
  amount: number;
  /** Short reason string, e.g. 'autonomous_visit', 'daily_login', 'quest_complete' */
  reason: string;
  source: NeoTokenSource;
  /** Optional reason-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface LedgerDebitInput {
  petId: string;
  /** Positive integer — number of NeoTokens to subtract */
  amount: number;
  reason: string;
  source: NeoTokenSource;
  metadata?: Record<string, unknown>;
}

export interface LedgerResult {
  balanceAfter: number;
  ledgerId: string;
}

export class InsufficientTokensError extends Error {
  constructor(
    public readonly petId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      `Pet ${petId} has ${available} NeoTokens, cannot debit ${requested}`,
    );
    this.name = 'InsufficientTokensError';
  }
}

async function creditInTx(tx: LedgerTx, input: LedgerCreditInput): Promise<LedgerResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(`creditNeoTokens amount must be a positive integer, got ${input.amount}`);
  }

  // Row-lock the pet and read current balance + userId
  const [row] = await tx.execute<{ user_id: string; neo_tokens: number }>(
    sql`SELECT user_id, neo_tokens FROM pets WHERE id = ${input.petId} FOR UPDATE`,
  );

  if (!row) {
    throw new Error(`creditNeoTokens: pet ${input.petId} not found`);
  }

  const balanceAfter = row.neo_tokens + input.amount;

  await tx.update(pets).set({ neoTokens: balanceAfter }).where(eq(pets.id, input.petId));

  const [ledger] = await tx
    .insert(neoTokenTransactions)
    .values({
      petId: input.petId,
      userId: row.user_id,
      amount: input.amount,
      balanceAfter,
      reason: input.reason,
      source: input.source,
      metadata: input.metadata ?? {},
    })
    .returning({ id: neoTokenTransactions.id });

  return { balanceAfter, ledgerId: ledger.id };
}

async function debitInTx(tx: LedgerTx, input: LedgerDebitInput): Promise<LedgerResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(`debitNeoTokens amount must be a positive integer, got ${input.amount}`);
  }

  const [row] = await tx.execute<{ user_id: string; neo_tokens: number }>(
    sql`SELECT user_id, neo_tokens FROM pets WHERE id = ${input.petId} FOR UPDATE`,
  );

  if (!row) {
    throw new Error(`debitNeoTokens: pet ${input.petId} not found`);
  }

  if (row.neo_tokens < input.amount) {
    throw new InsufficientTokensError(input.petId, row.neo_tokens, input.amount);
  }

  const balanceAfter = row.neo_tokens - input.amount;

  await tx.update(pets).set({ neoTokens: balanceAfter }).where(eq(pets.id, input.petId));

  const [ledger] = await tx
    .insert(neoTokenTransactions)
    .values({
      petId: input.petId,
      userId: row.user_id,
      amount: -input.amount, // negative for debits in the signed ledger
      balanceAfter,
      reason: input.reason,
      source: input.source,
      metadata: input.metadata ?? {},
    })
    .returning({ id: neoTokenTransactions.id });

  return { balanceAfter, ledgerId: ledger.id };
}

/**
 * Credit NeoTokens to a pet. Row-locked, atomic with ledger insert.
 *
 * Pass `tx` to compose into a larger transaction (e.g. bazaar/auction
 * transfers where both buyer debit and seller credit must succeed
 * together). If omitted, opens its own transaction.
 */
export async function creditNeoTokens(
  input: LedgerCreditInput,
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (tx) return creditInTx(tx, input);
  return db.transaction((innerTx) => creditInTx(innerTx, input));
}

/**
 * Debit NeoTokens from a pet. Throws InsufficientTokensError if balance
 * too low. Pass `tx` to compose into a larger transaction.
 */
export async function debitNeoTokens(
  input: LedgerDebitInput,
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (tx) return debitInTx(tx, input);
  return db.transaction((innerTx) => debitInTx(innerTx, input));
}

/**
 * Atomic transfer between two pets — one transaction, both or neither.
 * Use for bazaar sales, auction settlements, bounty escrow release, etc.
 */
export async function transferNeoTokens(input: {
  fromPetId: string;
  toPetId: string;
  amount: number;
  reason: string;
  source: NeoTokenSource;
  metadata?: Record<string, unknown>;
}): Promise<{ fromBalance: number; toBalance: number }> {
  return db.transaction(async (tx) => {
    const debit = await debitInTx(tx, {
      petId: input.fromPetId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      metadata: { ...input.metadata, transferTo: input.toPetId },
    });
    const credit = await creditInTx(tx, {
      petId: input.toPetId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      metadata: { ...input.metadata, transferFrom: input.fromPetId },
    });
    return { fromBalance: debit.balanceAfter, toBalance: credit.balanceAfter };
  });
}
