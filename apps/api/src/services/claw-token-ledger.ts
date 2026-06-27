/**
 * ClawToken (vCLAW) audit ledger helpers.
 *
 * Every write to `avatars.clawTokens` MUST go through `creditClawTokens()`,
 * `debitClawTokens()`, `transferClawTokens()`, or `mintEarned()`. These helpers
 * atomically:
 *   1. SELECT the current avatars row FOR UPDATE (row lock — prevents races)
 *   2. Compute the new total balance + the new per-tag balances
 *   3. UPDATE avatars.clawTokens AND the three per-tag balance columns together
 *   4. INSERT one (or, for a multi-tag debit, several) claw_token_transactions
 *      rows with the new total balanceAfter + the provenance tag mutated
 *
 * All steps run in a single DB transaction. If any step fails, the whole thing
 * rolls back. INVARIANTS held atomically:
 *   - `avatars.clawTokens` always matches the latest total `balanceAfter`.
 *   - `claw_tokens == soft_balance + bought_balance + earned_balance` (also a
 *     Postgres CHECK, `avatars_vclaw_balance_sum`, as defense-in-depth).
 *
 * ── vCLAW PROVENANCE (Tokenomics F1, 2026-06-27) ──────────────────────────────
 * Three cashability tags on one visible balance (plan §3):
 *   - SOFT   — play money + EVERY internal peer-transfer receipt. Not cashable.
 *   - BOUGHT — on-ramp purchases. Not cashable (V-Bucks). Carries a usd_basis.
 *   - EARNED — real external-customer agent labor. The ONLY cashable tag. Carries
 *              a usd_basis.
 *
 * EARNED CHOKEPOINT (plan §3.1 — the laundering defense): `earned` is written in
 * EXACTLY ONE place, `mintEarned()`. It is ENFORCED, not by convention:
 *   1. type-level — the public `creditClawTokens` provenance param is the union
 *      `'soft' | 'bought'`; `'earned'` is not representable in its input type, so
 *      no caller can even express it.
 *   2. runtime    — the single private `applyCreditInTx` requires an internal
 *      `__earnedToken` to write `earned`; only `mintEarned` holds that token. A
 *      runtime throw fires if `earned` is ever reached without it (belt-and-
 *      suspenders against a future refactor that widens the public type).
 *   3. test       — `claw-token-ledger.test.ts` proves no exported function other
 *      than `mintEarned` can produce an `earned` row or move `earned_balance`.
 *
 * Spend debit order: SOFT → BOUGHT → EARNED (burn non-cashable first; always
 * preserve the user's cashable balance). A debit spanning multiple tags emits ONE
 * ledger row per tag burned (each with its own negative amount + provenance, and a
 * running total `balanceAfter`).
 *
 * GATED-OFF: nothing is cashable in F1 (no cash-out path exists). Tagging is
 * additive — existing credit/debit/transfer callers keep behaving unchanged
 * (default credit tag = SOFT). Do NOT change routes / the on-ramp here.
 */

import { db, avatars, clawTokenTransactions, eq, sql } from '@clawville/database';
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
  | 'exchange'
  | 'daily_login'
  | 'admin'
  | 'x402'
  | 'system';

/**
 * The cashability tag a credit mints. PUBLIC credit callers may ONLY mint SOFT or
 * BOUGHT — `'earned'` is deliberately absent so it is UNREPRESENTABLE here. EARNED
 * is minted exclusively by `mintEarned()`. (plan §3.1 chokepoint.)
 */
export type CreditProvenance = 'soft' | 'bought';

/** The full provenance set — used by the ledger row + the spend allocator. */
export type LedgerProvenance = 'soft' | 'bought' | 'earned';

/** Per-tag balance triple. Always satisfies `sum === avatars.clawTokens`. */
interface TagBalances {
  soft: number;
  bought: number;
  earned: number;
}

/**
 * Internal capability token. `applyCreditInTx` requires this exact reference to
 * write an `earned` row / increment `earned_balance`. Only `mintEarned` closes
 * over it, so no other code path — present or future — can mint EARNED without
 * being routed through `mintEarned`. Module-private; never exported.
 */
const EARNED_TOKEN: unique symbol = Symbol('mintEarned-only');
type EarnedToken = typeof EARNED_TOKEN;

export interface LedgerCreditInput {
  avatarId: string;
  /** Positive integer — number of ClawTokens to add */
  amount: number;
  /** Short reason string, e.g. 'autonomous_visit', 'daily_login', 'quest_complete' */
  reason: string;
  source: ClawTokenSource;
  /**
   * Cashability tag to mint. Defaults to `'soft'` so every legacy caller behaves
   * unchanged. The on-ramp passes `'bought'`. `'earned'` is not accepted here (use
   * `mintEarned`); the type makes it unrepresentable.
   */
  provenance?: CreditProvenance;
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

/**
 * Row shape the FOR-UPDATE select returns. Per-tag columns are NOT NULL with a 0
 * default in the schema, but a row written before the F1 backfill ran could in
 * principle still read 0s while `claw_tokens` is non-zero; we reconcile that case
 * defensively (see `readLockedBalances`).
 */
type LockedAvatarRow = {
  user_id: string;
  claw_tokens: number;
  soft_balance: number;
  bought_balance: number;
  earned_balance: number;
};

/**
 * Row-lock the avatar and read the total + per-tag balances. If the per-tag sum
 * does not equal `claw_tokens` (only possible for a row the F1 backfill has not
 * reached, since the CHECK constraint forbids it for every post-backfill write),
 * treat the entire balance as SOFT for this operation — legacy CT is SOFT by the
 * backfill rule, so this is the same classification, applied lazily. This keeps
 * the helper correct even on a row the migration's UPDATE somehow skipped, and
 * the post-write CHECK still guarantees the row is consistent afterwards.
 */
async function readLockedBalances(
  tx: LedgerTx,
  avatarId: string,
  op: 'credit' | 'debit',
): Promise<{ userId: string; total: number; tags: TagBalances }> {
  const [row] = await tx.execute<LockedAvatarRow>(
    sql`SELECT user_id, claw_tokens, soft_balance, bought_balance, earned_balance
        FROM avatars WHERE id = ${avatarId} FOR UPDATE`,
  );

  if (!row) {
    throw new Error(`${op}ClawTokens: avatar ${avatarId} not found`);
  }

  const total = Number(row.claw_tokens);
  let tags: TagBalances = {
    soft: Number(row.soft_balance),
    bought: Number(row.bought_balance),
    earned: Number(row.earned_balance),
  };

  // Lazy backfill reconciliation: a not-yet-migrated row reads tags that don't
  // sum to the total. Legacy CT is SOFT (the backfill rule), so fold the whole
  // balance into SOFT for this op. The write below re-derives all three columns
  // from this corrected base, so the row leaves consistent.
  if (tags.soft + tags.bought + tags.earned !== total) {
    tags = { soft: total, bought: 0, earned: 0 };
  }

  return { userId: row.user_id, total, tags };
}

/**
 * Persist the new total + per-tag balances under the held row lock. ONE UPDATE
 * mutates `claw_tokens` and all three tag columns together so the sum invariant
 * (and its CHECK) can never observe a torn state.
 */
async function writeBalances(
  tx: LedgerTx,
  avatarId: string,
  total: number,
  tags: TagBalances,
): Promise<void> {
  await tx
    .update(avatars)
    .set({
      clawTokens: total,
      softBalance: tags.soft,
      boughtBalance: tags.bought,
      earnedBalance: tags.earned,
    })
    .where(eq(avatars.id, avatarId));
}

/**
 * THE SINGLE credit primitive. Adds `amount` to the given tag's balance and the
 * total, then inserts one ledger row stamped with that tag. `__earnedToken` is
 * required to mint `'earned'`; only `mintEarned` supplies it (the chokepoint).
 */
async function applyCreditInTx(
  tx: LedgerTx,
  input: {
    avatarId: string;
    amount: number;
    reason: string;
    source: ClawTokenSource;
    provenance: LedgerProvenance;
    usdBasis?: string | null;
    fpHash?: string | null;
    ipPrefixHash?: string | null;
    metadata?: Record<string, unknown>;
  },
  __earnedToken?: EarnedToken,
): Promise<LedgerResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(`creditClawTokens amount must be a positive integer, got ${input.amount}`);
  }

  // ── RUNTIME CHOKEPOINT ENFORCEMENT (belt-and-suspenders, plan §3.1) ──────────
  // Writing EARNED requires the internal capability token. The public credit type
  // already forbids 'earned', so this only fires if a future refactor widens the
  // type or a caller force-casts — in which case we crash loud rather than silently
  // mint a cashable balance through a non-`mintEarned` path.
  if (input.provenance === 'earned' && __earnedToken !== EARNED_TOKEN) {
    throw new Error(
      'EARNED provenance may only be minted via mintEarned() — refusing to write a cashable balance through creditClawTokens',
    );
  }

  const { userId, total, tags } = await readLockedBalances(tx, input.avatarId, 'credit');

  const balanceAfter = total + input.amount;
  const nextTags: TagBalances = { ...tags };
  nextTags[input.provenance] += input.amount;

  await writeBalances(tx, input.avatarId, balanceAfter, nextTags);

  const [ledger] = await tx
    .insert(clawTokenTransactions)
    .values({
      avatarId: input.avatarId,
      userId,
      amount: input.amount,
      balanceAfter,
      reason: input.reason,
      source: input.source,
      provenance: input.provenance,
      usdBasis: input.usdBasis ?? null,
      fpHash: input.fpHash ?? null,
      ipPrefixHash: input.ipPrefixHash ?? null,
      metadata: input.metadata ?? {},
    })
    .returning({ id: clawTokenTransactions.id });

  return { balanceAfter, ledgerId: ledger.id };
}

/** Internal credit used by the public `creditClawTokens` (SOFT/BOUGHT only). */
async function creditInTx(tx: LedgerTx, input: LedgerCreditInput): Promise<LedgerResult> {
  return applyCreditInTx(tx, {
    avatarId: input.avatarId,
    amount: input.amount,
    reason: input.reason,
    source: input.source,
    provenance: input.provenance ?? 'soft',
    metadata: input.metadata,
  });
}

/**
 * The deterministic spend allocator: burn SOFT → BOUGHT → EARNED (non-cashable
 * first; preserve the cashable balance for the user). Returns the per-tag amounts
 * to burn. Caller has already asserted `total >= amount`.
 */
function allocateDebit(amount: number, tags: TagBalances): TagBalances {
  let remaining = amount;
  const burn = (have: number): number => {
    const take = Math.min(have, remaining);
    remaining -= take;
    return take;
  };
  // Strict order: SOFT first, then BOUGHT, then EARNED.
  const soft = burn(tags.soft);
  const bought = burn(tags.bought);
  const earned = burn(tags.earned);
  // Defensive: with `total >= amount` asserted by the caller this is always 0.
  if (remaining !== 0) {
    throw new Error(`allocateDebit: failed to fully allocate (remaining=${remaining})`);
  }
  return { soft, bought, earned };
}

/**
 * Debit primitive. Burns across tags in SOFT→BOUGHT→EARNED order and emits ONE
 * ledger row PER tag actually burned (each a negative amount with its own
 * provenance; `balanceAfter` is the running TOTAL after that row). Returns the
 * final total + the ledgerId of the LAST row inserted (so existing single-row
 * callers still get a `ledgerId`).
 */
async function debitInTx(tx: LedgerTx, input: LedgerDebitInput): Promise<LedgerResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error(`debitClawTokens amount must be a positive integer, got ${input.amount}`);
  }

  const { userId, total, tags } = await readLockedBalances(tx, input.avatarId, 'debit');

  if (total < input.amount) {
    throw new InsufficientTokensError(input.avatarId, total, input.amount);
  }

  const burned = allocateDebit(input.amount, tags);
  const nextTags: TagBalances = {
    soft: tags.soft - burned.soft,
    bought: tags.bought - burned.bought,
    earned: tags.earned - burned.earned,
  };
  const finalTotal = total - input.amount;

  // Update the avatar ONCE to the final state (atomic with the row lock).
  await writeBalances(tx, input.avatarId, finalTotal, nextTags);

  // Emit one ledger row per tag burned, in burn order, with a running total
  // balanceAfter so the audit trail reads as a sequence of partial burns.
  const order: LedgerProvenance[] = ['soft', 'bought', 'earned'];
  let runningTotal = total;
  let lastLedgerId: string | null = null;
  for (const tag of order) {
    const burnedAmt = burned[tag];
    if (burnedAmt <= 0) continue;
    runningTotal -= burnedAmt;
    const [ledger] = await tx
      .insert(clawTokenTransactions)
      .values({
        avatarId: input.avatarId,
        userId,
        amount: -burnedAmt, // negative for debits in the signed ledger
        balanceAfter: runningTotal,
        reason: input.reason,
        source: input.source,
        provenance: tag,
        metadata: input.metadata ?? {},
      })
      .returning({ id: clawTokenTransactions.id });
    lastLedgerId = ledger.id;
  }

  // `allocateDebit` guarantees the burns sum to `amount` > 0, so at least one tag
  // burned and `lastLedgerId` is set. Assert rather than return an empty-string
  // pseudo-UUID if a future refactor ever permits a zero-amount debit.
  if (lastLedgerId === null) {
    throw new Error('debitInTx invariant: no ledger row written for a non-zero debit');
  }
  return { balanceAfter: finalTotal, ledgerId: lastLedgerId };
}

/**
 * Credit ClawTokens to an avatar. Row-locked, atomic with ledger insert.
 *
 * Mints SOFT by default; pass `provenance: 'bought'` for on-ramp purchases. The
 * type forbids `'earned'` — that is `mintEarned`'s exclusive job (plan §3.1).
 *
 * Pass `tx` to compose into a larger transaction (e.g. bazaar/auction transfers
 * where both buyer debit and seller credit must succeed together). If omitted,
 * opens its own transaction.
 */
export async function creditClawTokens(
  input: LedgerCreditInput,
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (tx) return creditInTx(tx, input);
  return db.transaction((innerTx) => creditInTx(innerTx, input));
}

/**
 * Debit ClawTokens from an avatar. Throws InsufficientTokensError if the TOTAL
 * balance is too low. Burns SOFT→BOUGHT→EARNED and records the burned tag(s).
 * Pass `tx` to compose into a larger transaction.
 */
export async function debitClawTokens(
  input: LedgerDebitInput,
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (tx) return debitInTx(tx, input);
  return db.transaction((innerTx) => debitInTx(innerTx, input));
}

/**
 * EARNED MINT — the ONE code path that writes `provenance='earned'` / increments
 * `earned_balance` (plan §3.1 chokepoint). Called only from the external-
 * settlement path (escrow release / x402 credit) where a real outside dollar is
 * confirmed inbound. Stamps `usd_basis` = the full USDC received (fee is taken
 * LATER, at the cash-out exit — Kintara-style; plan §3.2/§5). Stores the anti-
 * abuse fp/ip hashes if supplied (enforcement is a later feature, plan §6).
 *
 * GATED-OFF in F1: minting EARNED does NOT make anything cashable — no cash-out
 * path exists yet. This is the ledger-side prerequisite for plan §12 gate 1.
 *
 * Pass `tx` to compose into the settlement transaction.
 */
export async function mintEarned(
  input: {
    avatarId: string;
    /** Positive integer — number of vCLAW to mint as EARNED */
    amount: number;
    reason: string;
    source: ClawTokenSource;
    /**
     * The real USDC the external customer paid, in full, as a decimal string
     * (numeric(20,6)). Required — an EARNED mint without a USD basis would have no
     * cashable claim. Caller stringifies (e.g. `"12.500000"`).
     */
    usdBasis: string;
    /** Anti-abuse fingerprint hashes (salted sha256), if available. */
    fpHash?: string | null;
    ipPrefixHash?: string | null;
    metadata?: Record<string, unknown>;
  },
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (typeof input.usdBasis !== 'string' || input.usdBasis.trim() === '') {
    throw new Error('mintEarned requires a non-empty usdBasis string');
  }

  const run = (innerTx: LedgerTx) =>
    applyCreditInTx(
      innerTx,
      {
        avatarId: input.avatarId,
        amount: input.amount,
        reason: input.reason,
        source: input.source,
        provenance: 'earned',
        usdBasis: input.usdBasis,
        fpHash: input.fpHash ?? null,
        ipPrefixHash: input.ipPrefixHash ?? null,
        metadata: input.metadata,
      },
      EARNED_TOKEN, // the capability token — only this call site holds it
    );

  if (tx) return run(tx);
  return db.transaction((innerTx) => run(innerTx));
}

/**
 * Atomic transfer between two avatars — one transaction, both or neither.
 * Use for bazaar sales, auction settlements, bounty escrow release, etc.
 *
 * PROVENANCE (plan §3.1, §5): the payer's debit burns SOFT→BOUGHT→EARNED, but the
 * RECEIVER is ALWAYS credited SOFT, regardless of which tag(s) the payer spent.
 * Internal recirculation can NEVER become cashable — this is the laundering
 * defense. There is no parameter to override the receiver tag.
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
    // Receiver ALWAYS gets SOFT — non-cashable recirculation, by construction.
    const credit = await creditInTx(tx, {
      avatarId: input.toAvatarId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      provenance: 'soft',
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
