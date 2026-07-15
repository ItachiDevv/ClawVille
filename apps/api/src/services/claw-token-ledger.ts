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
 *   - EARNED — agent-labor/accounting units. Only separately house-backed,
 *              verified, vested EARNED lots can enter the gated exit rail.
 *              Unbacked EARNED remains spendable in-game but is not cashable.
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
 * E3 is built but default-OFF behind TOKENOMICS_REDEEM_ENABLED. The provenance
 * tag alone never grants cashability: backing, verification, vesting, and
 * claw-back state are checked transactionally by the redemption debit path.
 */

import { randomUUID } from 'crypto';
import {
  db,
  avatars,
  clawTokenTransactions,
  earnedMintLots,
  earnedBackings,
  earnedLotConsumptions,
  earnedAccountedLedger,
  earnClawbacks,
  eq,
  sql,
} from '@clawville/database';
import { logEvent } from './event-logger';
// Covenant action-record stream (2026-07-13): every credit/debit appends one
// record IN THE SAME TX — the two primitives below are the complete vCLAW
// choke point, so this is total economy coverage with zero caller churn.
// (`covenant-action-recorder` imports only `type LedgerTx` back from this
// module — type-only, erased at runtime, so there is no import cycle.)
import {
  recordCovenantAction,
  type CovenantActorKind,
} from './covenant-action-recorder';

/**
 * Drizzle transaction type — passing this lets the helpers compose into
 * a larger atomic block (e.g. peer transfers, escrow settlement).
 * When omitted, the helper opens its own transaction.
 *
 * EXPORTED (Tokenomics C3, 2026-07-07 — type-only, zero runtime change) so
 * sibling settle-composable seams (`clv-swap-executor.ts enqueueClvBuy`) share
 * THIS exact transaction type instead of re-deriving a drifting copy.
 */
export type LedgerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  /**
   * The USD basis to stamp on the ledger row, as a decimal string (numeric(20,6)),
   * e.g. `"10.00"`. ONLY meaningful for a `'bought'` credit (the dollars the buyer
   * paid on the on-ramp) — a `BOUGHT` row without a basis would lose the accounting
   * record of the V-Bucks revenue. Ignored (and rejected, see below) for `'soft'`:
   * SOFT is play money with no dollar behind it. EARNED's basis is set exclusively
   * by `mintEarned`, never here. Defaults to null.
   */
  usdBasis?: string | null;
  /** Optional reason-specific metadata */
  metadata?: Record<string, unknown>;
  /**
   * Covenant actor attribution — pass ONLY when the caller resolved WHO drove
   * the action ('human' cookie / 'agent' session / 'system' sim / 'admin').
   * Defaults to null (unattributed) — never guessed. Stamped on the covenant
   * action record, not the ledger row.
   */
  actorKind?: CovenantActorKind | null;
}

export interface LedgerDebitInput {
  avatarId: string;
  /** Positive integer — number of ClawTokens to subtract */
  amount: number;
  reason: string;
  source: ClawTokenSource;
  metadata?: Record<string, unknown>;
  /** Covenant actor attribution — see LedgerCreditInput.actorKind. */
  actorKind?: CovenantActorKind | null;
}

export interface LedgerResult {
  balanceAfter: number;
  ledgerId: string;
}

/**
 * Every EARNED mint must declare whether the house actually holds its dollars.
 * `none` is spendable but structurally absent from the physical backing ledger.
 */
export type EarnedBackingDeclaration =
  | {
      kind: 'none';
      /** Unique mint identity, e.g. `agent-pay:<payment uuid>`. */
      mintRef: string;
      reason: string;
    }
  | {
      kind: 'backed';
      mintRef: string;
      earnEventId: string;
      custodyWalletId: string;
      /** Unique outside settlement reference; one inbound dollar backs one mint. */
      sourceRef: string;
      /** Exact physical backing. Must equal amount * 10,000 micro-USDC. */
      usdcAtomic: string;
    };

export interface EarnedRedemptionAllocation {
  mintLotId: string;
  vclawAmount: number;
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
    actorKind?: CovenantActorKind | null;
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

  // Covenant record — same tx as the balance write + ledger row: the credit
  // and its covenant record commit or roll back together.
  await recordCovenantAction(
    {
      action: 'economy.credit',
      subjectType: 'avatar',
      subjectId: input.avatarId,
      actorKind: input.actorKind ?? null,
      payload: {
        ledgerId: ledger.id,
        amount: input.amount,
        balanceAfter,
        reason: input.reason,
        source: input.source,
        provenance: input.provenance,
        ...(input.usdBasis != null ? { usdBasis: input.usdBasis } : {}),
        ...(input.metadata && Object.keys(input.metadata).length > 0
          ? { metadata: input.metadata }
          : {}),
      },
    },
    tx,
  );

  return { balanceAfter, ledgerId: ledger.id };
}

/** Internal credit used by the public `creditClawTokens` (SOFT/BOUGHT only). */
async function creditInTx(tx: LedgerTx, input: LedgerCreditInput): Promise<LedgerResult> {
  const provenance: CreditProvenance = input.provenance ?? 'soft';
  // usd_basis is a BOUGHT-only accounting field (the dollars the buyer paid).
  // Refuse to stamp it on a SOFT credit — SOFT is play money with no dollar
  // behind it, and a SOFT row carrying a usd_basis would corrupt the V-Bucks
  // revenue ledger + EARNED's "basis ⇒ real money" reading. (EARNED's basis is
  // set only by mintEarned, never through this public path.)
  if (input.usdBasis != null && provenance !== 'bought') {
    throw new Error(
      `creditClawTokens: usdBasis is only valid for a 'bought' credit, got provenance='${provenance}'`,
    );
  }
  return applyCreditInTx(tx, {
    avatarId: input.avatarId,
    amount: input.amount,
    reason: input.reason,
    source: input.source,
    provenance,
    usdBasis: input.usdBasis ?? null,
    metadata: input.metadata,
    actorKind: input.actorKind ?? null,
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

type LockedEarnedLot = {
  id: string;
  backing_kind: 'backed' | 'none';
  remaining_vclaw: number;
};

/**
 * Attribute an EARNED burn to mint lots while the avatar row lock is held.
 * Ordinary spends preserve redeemable units as long as possible:
 * unbacked -> rejected/clawed -> pending -> unvested -> verified+vested.
 */
async function consumeEarnedLots(
  tx: LedgerTx,
  input: {
    avatarId: string;
    amount: number;
    ledgerDebitId: string;
    kind: 'spend' | 'redemption' | 'clawback';
    referenceId?: string | null;
    exactAllocations?: EarnedRedemptionAllocation[];
    /** Claw-back consumes the fraudulent event lot before all other lots. */
    preferredMintLotId?: string | null;
    /** Cutover replay may consume one old debit in multiple phases. */
    markAccounted?: boolean;
  },
): Promise<{ backedUsdcAtomic: bigint }> {
  let lots: LockedEarnedLot[];
  if (input.exactAllocations) {
    const ids = input.exactAllocations.map((a) => a.mintLotId);
    if (new Set(ids).size !== ids.length) {
      throw new Error('EARNED lot allocations contain a duplicate mintLotId');
    }
    lots = [];
    for (const allocation of input.exactAllocations) {
      const [lot] = await tx.execute<LockedEarnedLot>(
        sql`SELECT l.id, l.backing_kind, l.remaining_vclaw
            FROM earned_mint_lots l
            JOIN earned_backing b ON b.mint_lot_id = l.id
            JOIN earn_events e ON e.id = l.earn_event_id
            WHERE l.id = ${allocation.mintLotId}
              AND l.avatar_id = ${input.avatarId}
              AND l.backing_kind = 'backed'
              AND e.payer_verification = 'verified'
              AND e.vests_at <= now()
              AND e.clawed_back_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM wallets w
                WHERE w.public_key IN (e.payer_wallet, e.first_funder_wallet)
              )
              AND NOT EXISTS (
                SELECT 1 FROM treasury_wallets tw
                WHERE tw.public_key IN (e.payer_wallet, e.first_funder_wallet)
              )
              AND NOT EXISTS (
                SELECT 1 FROM vanity_keypairs vk
                WHERE vk.public_key IN (e.payer_wallet, e.first_funder_wallet)
              )
              AND NOT EXISTS (
                SELECT 1 FROM avatars av
                WHERE av.wallet_address IN (e.payer_wallet, e.first_funder_wallet)
              )
              AND NOT EXISTS (
                SELECT 1 FROM openclaw_bots ob
                WHERE ob.wallet_address IN (e.payer_wallet, e.first_funder_wallet)
              )
              AND NOT EXISTS (
                SELECT 1 FROM users u
                WHERE u.identity_pubkey IN (e.payer_wallet, e.first_funder_wallet)
                   OR u.linked_wallet_pubkey IN (e.payer_wallet, e.first_funder_wallet)
              )
            FOR UPDATE OF l`,
      );
      if (!lot || Number(lot.remaining_vclaw) < allocation.vclawAmount) {
        throw new Error(`EARNED redemption allocation ${allocation.mintLotId} is no longer eligible`);
      }
      lots.push({ ...lot, remaining_vclaw: allocation.vclawAmount });
    }
  } else {
    lots = await tx.execute<LockedEarnedLot>(
      sql`SELECT l.id, l.backing_kind, l.remaining_vclaw
          FROM earned_mint_lots l
          LEFT JOIN earn_events e ON e.id = l.earn_event_id
          WHERE l.avatar_id = ${input.avatarId} AND l.remaining_vclaw > 0
          ORDER BY
            CASE WHEN l.id = ${input.preferredMintLotId ?? null} THEN -1
                 WHEN l.backing_kind = 'none' THEN 0
                 WHEN e.clawed_back_at IS NOT NULL OR e.payer_verification = 'rejected' THEN 1
                 WHEN e.payer_verification = 'pending' THEN 2
                 WHEN e.vests_at > now() THEN 3
                 ELSE 4 END,
            l.created_at, l.id
          FOR UPDATE OF l`,
    );
  }

  let remaining = input.amount;
  let backedUsdcAtomic = 0n;
  for (const lot of lots) {
    if (remaining === 0) break;
    const requested = input.exactAllocations
      ? Number(lot.remaining_vclaw)
      : Math.min(Number(lot.remaining_vclaw), remaining);
    if (!Number.isInteger(requested) || requested <= 0 || requested > remaining) {
      throw new Error('EARNED lot allocation is malformed');
    }

    const [updated] = await tx.execute<{ id: string }>(
      sql`UPDATE earned_mint_lots
          SET remaining_vclaw = remaining_vclaw - ${requested},
              exhausted_at = CASE WHEN remaining_vclaw = ${requested} THEN now() ELSE exhausted_at END
          WHERE id = ${lot.id} AND remaining_vclaw >= ${requested}
          RETURNING id`,
    );
    if (!updated) throw new Error(`EARNED lot ${lot.id} changed under avatar lock`);

    const backingAtomic = lot.backing_kind === 'backed' ? BigInt(requested) * 10_000n : 0n;
    if (lot.backing_kind === 'backed') {
      const [backing] = await tx.execute<{ id: string }>(
        sql`UPDATE earned_backing
            SET remaining_usdc_atomic = remaining_usdc_atomic - ${backingAtomic.toString()},
                consumed_usdc_atomic = consumed_usdc_atomic
                  + CASE WHEN ${input.kind} = 'redemption'
                         THEN ${backingAtomic.toString()} ELSE 0 END,
                released_usdc_atomic = released_usdc_atomic
                  + CASE WHEN ${input.kind} <> 'redemption'
                         THEN ${backingAtomic.toString()} ELSE 0 END,
                updated_at = now()
            WHERE mint_lot_id = ${lot.id}
              AND remaining_usdc_atomic >= ${backingAtomic.toString()}
            RETURNING id`,
      );
      if (!backing) throw new Error(`physical backing for EARNED lot ${lot.id} is missing or short`);
      backedUsdcAtomic += backingAtomic;
    }

    await tx.insert(earnedLotConsumptions).values({
      mintLotId: lot.id,
      ledgerDebitId: input.ledgerDebitId,
      kind: input.kind,
      vclawAmount: requested,
      usdcAtomic: backingAtomic.toString(),
      referenceId: input.referenceId ?? null,
    });
    remaining -= requested;
  }

  if (remaining !== 0) {
    throw new Error(
      `EARNED lot invariant: avatar ${input.avatarId} is short ${remaining} attributed unit(s)`,
    );
  }
  if (input.markAccounted !== false) {
    await tx.insert(earnedAccountedLedger).values({
      ledgerId: input.ledgerDebitId,
      kind: input.kind,
    }).onConflictDoNothing();
  }
  return { backedUsdcAtomic };
}

/**
 * Bridge the migration->deploy window exactly. Migration marks every historical
 * EARNED ledger row while old writers are table-blocked; new dual-writes mark
 * atomically. Anything unmarked was committed by an old app after migration.
 *
 * House-favorable replay is deliberate: apply every old debit against existing
 * lots first (unbacked before backed), then add old positive credits as `none`,
 * and use those only for debit excess. This prevents an equal-sum old spend +
 * old agent-pay mint from substituting new unbacked units for backed liability.
 */
export async function reconcileUnaccountedEarnedLedger(
  tx: LedgerTx,
  avatarId: string,
): Promise<void> {
  const [avatar] = await tx.execute<{ earned_balance: number }>(
    sql`SELECT earned_balance FROM avatars WHERE id = ${avatarId} FOR UPDATE`,
  );
  if (!avatar) throw new Error(`EARNED cutover reconciliation: avatar ${avatarId} not found`);

  const debits = await tx.execute<{ id: string; amount: number }>(sql`SELECT t.id, -t.amount AS amount
      FROM claw_token_transactions t
      LEFT JOIN earned_accounted_ledger a ON a.ledger_id = t.id
      WHERE t.avatar_id = ${avatarId} AND t.provenance = 'earned'
        AND t.amount < 0 AND a.ledger_id IS NULL
      ORDER BY t.created_at, t.id FOR UPDATE OF t`);
  const pending: Array<{ id: string; amount: number }> = [];
  for (const debit of debits) {
    const [availableRow] = await tx.execute<{ amount: string }>(
      sql`SELECT COALESCE(SUM(remaining_vclaw), 0)::text AS amount
          FROM earned_mint_lots WHERE avatar_id = ${avatarId}`,
    );
    const available = Number(availableRow?.amount ?? '0');
    const take = Math.min(Number(debit.amount), available);
    if (take > 0) {
      await consumeEarnedLots(tx, {
        avatarId,
        amount: take,
        ledgerDebitId: debit.id,
        kind: 'spend',
        markAccounted: false,
      });
    }
    const excess = Number(debit.amount) - take;
    if (excess > 0) pending.push({ id: debit.id, amount: excess });
    else {
      await tx.insert(earnedAccountedLedger).values({
        ledgerId: debit.id,
        kind: 'spend',
      }).onConflictDoNothing();
    }
  }

  const credits = await tx.execute<{ id: string; amount: number }>(sql`SELECT t.id, t.amount
      FROM claw_token_transactions t
      LEFT JOIN earned_accounted_ledger a ON a.ledger_id = t.id
      WHERE t.avatar_id = ${avatarId} AND t.provenance = 'earned'
        AND t.amount > 0 AND a.ledger_id IS NULL
      ORDER BY t.created_at, t.id FOR UPDATE OF t`);
  for (const credit of credits) {
    await tx.execute(sql`INSERT INTO earned_mint_lots
        (ledger_id, avatar_id, backing_kind, mint_ref, original_vclaw,
         remaining_vclaw, metadata)
        VALUES (${credit.id}, ${avatarId}, 'none', ${`cutover-ledger:${credit.id}`},
                ${credit.amount}, ${credit.amount},
                '{"cutoverOldWriter":true}'::jsonb)
        ON CONFLICT (ledger_id) DO NOTHING`);
    await tx.insert(earnedAccountedLedger).values({
      ledgerId: credit.id,
      kind: 'mint',
    }).onConflictDoNothing();
  }

  for (const debit of pending) {
    await consumeEarnedLots(tx, {
      avatarId,
      amount: debit.amount,
      ledgerDebitId: debit.id,
      kind: 'spend',
      markAccounted: false,
    });
    await tx.insert(earnedAccountedLedger).values({
      ledgerId: debit.id,
      kind: 'spend',
    }).onConflictDoNothing();
  }

  const [lotTotal] = await tx.execute<{ amount: string }>(
    sql`SELECT COALESCE(SUM(remaining_vclaw), 0)::text AS amount
        FROM earned_mint_lots WHERE avatar_id = ${avatarId}`,
  );
  if (BigInt(lotTotal?.amount ?? '0') !== BigInt(avatar.earned_balance)) {
    throw new Error(
      `EARNED cutover reconciliation mismatch for ${avatarId}: lots=${lotTotal?.amount ?? '0'} aggregate=${avatar.earned_balance}`,
    );
  }
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
  if (burned.earned > 0) {
    await reconcileUnaccountedEarnedLedger(tx, input.avatarId);
  }
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
  const burnedLedger: Array<{ ledgerId: string; provenance: LedgerProvenance; amount: number }> =
    [];
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
    burnedLedger.push({ ledgerId: ledger.id, provenance: tag, amount: burnedAmt });
    if (tag === 'earned') {
      await consumeEarnedLots(tx, {
        avatarId: input.avatarId,
        amount: burnedAmt,
        ledgerDebitId: ledger.id,
        kind: 'spend',
      });
    }
  }

  // `allocateDebit` guarantees the burns sum to `amount` > 0, so at least one tag
  // burned and `lastLedgerId` is set. Assert rather than return an empty-string
  // pseudo-UUID if a future refactor ever permits a zero-amount debit.
  if (lastLedgerId === null) {
    throw new Error('debitInTx invariant: no ledger row written for a non-zero debit');
  }

  // Covenant record — ONE record for the whole debit (the ACTION is one spend;
  // the per-tag burn breakdown rides in the payload), same tx as the burn.
  await recordCovenantAction(
    {
      action: 'economy.debit',
      subjectType: 'avatar',
      subjectId: input.avatarId,
      actorKind: input.actorKind ?? null,
      payload: {
        amount: input.amount,
        balanceAfter: finalTotal,
        reason: input.reason,
        source: input.source,
        burns: burnedLedger,
        ...(input.metadata && Object.keys(input.metadata).length > 0
          ? { metadata: input.metadata }
          : {}),
      },
    },
    tx,
  );

  return { balanceAfter: finalTotal, ledgerId: lastLedgerId };
}

/**
 * Credit ClawTokens to an avatar. Row-locked, atomic with ledger insert.
 *
 * Mints SOFT by default; pass `provenance: 'bought'` for on-ramp purchases (and
 * `usdBasis` = the dollars paid, so the BOUGHT row records the V-Bucks revenue).
 * The type forbids `'earned'` — that is `mintEarned`'s exclusive job (plan §3.1).
 *
 * Pass `tx` to compose into a larger transaction (e.g. peer transfers where
 * both buyer debit and seller credit must succeed together). If omitted,
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
 * E3-only debit capability. Unlike `debitClawTokens`, this can touch ONLY the
 * EARNED tag and ONLY exact, still-eligible backed lots belonging to a durable
 * `earned_redemptions(status='requested')` row. A transaction is mandatory so
 * the caller's requested->debited CAS and backing consumption commit together.
 */
export async function debitEarnedForRedemption(
  input: {
    avatarId: string;
    amount: number;
    redemptionId: string;
    allocations: EarnedRedemptionAllocation[];
    metadata?: Record<string, unknown>;
    actorKind?: CovenantActorKind | null;
  },
  tx: LedgerTx,
): Promise<LedgerResult> {
  if (!tx) throw new Error('debitEarnedForRedemption requires the redemption transaction');
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error('debitEarnedForRedemption amount must be a positive integer');
  }
  const allocated = input.allocations.reduce((sum, item) => {
    if (!item.mintLotId || !Number.isInteger(item.vclawAmount) || item.vclawAmount <= 0) {
      throw new Error('debitEarnedForRedemption allocation is malformed');
    }
    return sum + item.vclawAmount;
  }, 0);
  if (allocated !== input.amount) {
    throw new Error(`debitEarnedForRedemption allocations ${allocated} != ${input.amount}`);
  }

  const [redemption] = await tx.execute<{ id: string }>(
    sql`SELECT id FROM earned_redemptions
        WHERE id = ${input.redemptionId}
          AND avatar_id = ${input.avatarId}
          AND status = 'requested'
          AND amount_vclaw = ${input.amount}
        FOR UPDATE`,
  );
  if (!redemption) {
    throw new Error('debitEarnedForRedemption durable request is missing or no longer requested');
  }

  const { userId, total, tags } = await readLockedBalances(tx, input.avatarId, 'debit');
  await reconcileUnaccountedEarnedLedger(tx, input.avatarId);
  if (tags.earned < input.amount) {
    throw new InsufficientTokensError(input.avatarId, tags.earned, input.amount);
  }
  const balanceAfter = total - input.amount;
  await writeBalances(tx, input.avatarId, balanceAfter, {
    ...tags,
    earned: tags.earned - input.amount,
  });

  const [ledger] = await tx
    .insert(clawTokenTransactions)
    .values({
      avatarId: input.avatarId,
      userId,
      amount: -input.amount,
      balanceAfter,
      reason: 'earned_redemption',
      source: 'x402',
      provenance: 'earned',
      metadata: { ...input.metadata, redemptionId: input.redemptionId },
    })
    .returning({ id: clawTokenTransactions.id });

  await consumeEarnedLots(tx, {
    avatarId: input.avatarId,
    amount: input.amount,
    ledgerDebitId: ledger.id,
    kind: 'redemption',
    referenceId: input.redemptionId,
    exactAllocations: input.allocations,
  });

  await recordCovenantAction(
    {
      action: 'economy.debit',
      subjectType: 'avatar',
      subjectId: input.avatarId,
      actorKind: input.actorKind ?? null,
      payload: {
        amount: input.amount,
        balanceAfter,
        reason: 'earned_redemption',
        source: 'x402',
        burns: [{ ledgerId: ledger.id, provenance: 'earned', amount: input.amount }],
        metadata: { ...input.metadata, redemptionId: input.redemptionId },
      },
    },
    tx,
  );
  return { balanceAfter, ledgerId: ledger.id };
}

export type EarnedClawbackResult = {
  clawbackId: string;
  earnEventId: string;
  requestedVclaw: number;
  debitedVclaw: number;
  deficitVclaw: number;
  releasedUsdcAtomic: string;
  ledgerDebitId: string | null;
  replay: boolean;
};

/** Admin-only caller seam: atomic target-first EARNED claw-back + deficit. */
export async function clawBackEarnedMint(input: {
  earnEventId: string;
  adminUserId: string;
  reason: string;
}, database: Pick<typeof db, 'transaction'> = db): Promise<EarnedClawbackResult> {
  if (!input.earnEventId || !input.adminUserId || !input.reason.trim()) {
    throw new Error('clawBackEarnedMint requires event, admin, and reason');
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.earnEventId}, 0))`);
    const [existing] = await tx.execute<{
      id: string; earn_event_id: string; requested_vclaw: number; debited_vclaw: number;
      deficit_vclaw: number; released_usdc_atomic: string; ledger_debit_id: string | null;
    }>(sql`SELECT id, earn_event_id, requested_vclaw, debited_vclaw,
                 deficit_vclaw, released_usdc_atomic, ledger_debit_id
          FROM earn_clawbacks WHERE earn_event_id = ${input.earnEventId} LIMIT 1`);
    if (existing) {
      return {
        clawbackId: existing.id,
        earnEventId: existing.earn_event_id,
        requestedVclaw: Number(existing.requested_vclaw),
        debitedVclaw: Number(existing.debited_vclaw),
        deficitVclaw: Number(existing.deficit_vclaw),
        releasedUsdcAtomic: String(existing.released_usdc_atomic),
        ledgerDebitId: existing.ledger_debit_id,
        replay: true,
      };
    }

    // Canonical lock order: durable/advisory -> avatar -> event/lot/backing.
    // This first read is intentionally UNLOCKED and is revalidated below.
    const [lookup] = await tx.execute<{ earner_avatar_id: string }>(
      sql`SELECT earner_avatar_id FROM earn_events WHERE id = ${input.earnEventId}`,
    );
    if (!lookup) throw new Error('earn event not found');
    const { userId, total, tags } = await readLockedBalances(tx, lookup.earner_avatar_id, 'debit');
    await reconcileUnaccountedEarnedLedger(tx, lookup.earner_avatar_id);
    const [event] = await tx.execute<{
      id: string; earner_avatar_id: string; vclaw_minted: number;
      mint_lot_id: string;
    }>(sql`SELECT e.id, e.earner_avatar_id, e.vclaw_minted, l.id AS mint_lot_id
          FROM earn_events e
          JOIN earned_mint_lots l ON l.earn_event_id = e.id
          WHERE e.id = ${input.earnEventId} AND e.earner_avatar_id = ${lookup.earner_avatar_id}
          FOR UPDATE OF e, l`);
    if (!event) throw new Error('earn event changed or has no mint lot');
    const requested = Number(event.vclaw_minted);
    const debited = Math.min(tags.earned, requested);
    const deficit = requested - debited;
    const clawbackId = randomUUID();
    let ledgerDebitId: string | null = null;
    let releasedByDebit = 0n;

    if (debited > 0) {
      const balanceAfter = total - debited;
      await writeBalances(tx, event.earner_avatar_id, balanceAfter, {
        ...tags,
        earned: tags.earned - debited,
      });
      const [ledger] = await tx.insert(clawTokenTransactions).values({
        avatarId: event.earner_avatar_id,
        userId,
        amount: -debited,
        balanceAfter,
        reason: 'earned_clawback',
        source: 'admin',
        provenance: 'earned',
        metadata: { earnEventId: event.id, clawbackId, reason: input.reason },
      }).returning({ id: clawTokenTransactions.id });
      ledgerDebitId = ledger.id;
      const consumed = await consumeEarnedLots(tx, {
        avatarId: event.earner_avatar_id,
        amount: debited,
        ledgerDebitId: ledger.id,
        kind: 'clawback',
        referenceId: clawbackId,
        preferredMintLotId: event.mint_lot_id,
      });
      releasedByDebit = consumed.backedUsdcAtomic;
      await recordCovenantAction({
        action: 'economy.debit',
        subjectType: 'avatar',
        subjectId: event.earner_avatar_id,
        actorKind: 'admin',
        payload: {
          amount: debited,
          balanceAfter,
          reason: 'earned_clawback',
          source: 'admin',
          burns: [{ ledgerId: ledger.id, provenance: 'earned', amount: debited }],
          metadata: { earnEventId: event.id, clawbackId, deficitVclaw: deficit },
        },
      }, tx);
    }

    // Redemption-consumed backing is never released again. Only the target's
    // still-outstanding remainder moves from liability to released surplus.
    const [targetAfterDebit] = await tx.execute<{ remaining: string }>(
      sql`SELECT remaining_usdc_atomic::text AS remaining FROM earned_backing
          WHERE mint_lot_id = ${event.mint_lot_id}`,
    );
    const additionallyReleased = BigInt(targetAfterDebit?.remaining ?? '0');
    await tx.execute(
      sql`UPDATE earned_backing
          SET released_usdc_atomic = released_usdc_atomic + remaining_usdc_atomic,
              remaining_usdc_atomic = 0, updated_at = now()
          WHERE mint_lot_id = ${event.mint_lot_id}`,
    );
    await tx.execute(
      sql`UPDATE earned_mint_lots
          SET remaining_vclaw = 0, exhausted_at = COALESCE(exhausted_at, now()),
              released_at = now(), release_reason = 'admin_clawback'
          WHERE id = ${event.mint_lot_id}`,
    );
    await tx.execute(
      sql`UPDATE earn_events
          SET payer_verification = 'rejected',
              verified_at = COALESCE(verified_at, now()),
              verification_reason = COALESCE(verification_reason, 'admin_clawback'),
              clawed_back_at = now(), clawback_reason = ${input.reason}
          WHERE id = ${event.id}`,
    );
    const releasedNow = (releasedByDebit + additionallyReleased).toString();
    await tx.insert(earnClawbacks).values({
      id: clawbackId,
      earnEventId: event.id,
      requestedVclaw: requested,
      debitedVclaw: debited,
      deficitVclaw: deficit,
      releasedUsdcAtomic: releasedNow,
      ledgerDebitId,
      reason: input.reason,
      adminUserId: input.adminUserId,
    });
    return {
      clawbackId,
      earnEventId: event.id,
      requestedVclaw: requested,
      debitedVclaw: debited,
      deficitVclaw: deficit,
      releasedUsdcAtomic: releasedNow,
      ledgerDebitId,
      replay: false,
    };
  });
}

/**
 * EARNED MINT — the ONE code path that writes `provenance='earned'` / increments
 * `earned_balance` chokepoint. Every caller explicitly declares either
 * house-held `backed` USDC or `none`. E1 external settlements use `backed` only
 * after exact custody proof; rail ④ agent-pay uses `none` because its USDC goes
 * directly to the recipient. Both are spendable, but only a verified, vested,
 * non-clawed backed lot can enter the default-off E3 redemption rail.
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
     * Accounting basis in decimal USD (numeric(20,6)). For `backed`, this must
     * equal the exact house-held micro-USDC. For `none`, it records the economic
     * event but never creates a redeemable claim.
     */
    usdBasis: string;
    /** Mandatory proof declaration: backed house custody or explicit `none`. */
    backing: EarnedBackingDeclaration;
    /** Anti-abuse fingerprint hashes (salted sha256), if available. */
    fpHash?: string | null;
    ipPrefixHash?: string | null;
    metadata?: Record<string, unknown>;
    /** Covenant actor attribution — see LedgerCreditInput.actorKind. */
    actorKind?: CovenantActorKind | null;
  },
  tx?: LedgerTx,
): Promise<LedgerResult> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new Error('mintEarned amount must be a positive safe integer');
  }
  if (typeof input.usdBasis !== 'string' || input.usdBasis.trim() === '') {
    throw new Error('mintEarned requires a non-empty usdBasis string');
  }
  if (!input.backing || !input.backing.mintRef?.trim()) {
    throw new Error('mintEarned requires an explicit backing declaration and mintRef');
  }
  if (input.backing.kind === 'backed') {
    if (!/^\d+$/.test(input.backing.usdcAtomic)) {
      throw new Error('mintEarned backed usdcAtomic must be an integer string');
    }
    const expected = BigInt(input.amount) * 10_000n;
    if (BigInt(input.backing.usdcAtomic) !== expected) {
      throw new Error(
        `mintEarned backing mismatch: ${input.backing.usdcAtomic} != ${expected} micro-USDC`,
      );
    }
    if (!input.backing.earnEventId || !input.backing.custodyWalletId || !input.backing.sourceRef) {
      throw new Error('mintEarned backed declaration is incomplete');
    }
    const usdMatch = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.usdBasis.trim());
    if (!usdMatch) {
      throw new Error('mintEarned backed usdBasis must be an exact decimal with at most 6 places');
    }
    const basisAtomic = BigInt(usdMatch[1]) * 1_000_000n
      + BigInt((usdMatch[2] ?? '').padEnd(6, '0'));
    if (basisAtomic !== expected) {
      throw new Error(
        `mintEarned usdBasis mismatch: ${basisAtomic} != ${expected} micro-USDC backing`,
      );
    }
  }

  const run = async (innerTx: LedgerTx) => {
    await reconcileUnaccountedEarnedLedger(innerTx, input.avatarId);
    const credited = await applyCreditInTx(
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
        actorKind: input.actorKind ?? null,
      },
      EARNED_TOKEN, // the capability token — only this call site holds it
    );

    if (input.backing.kind === 'backed') {
      const [custody] = await innerTx.execute<{ id: string }>(
        sql`SELECT id FROM treasury_wallets
            WHERE id = ${input.backing.custodyWalletId}
              AND purpose = 'earned-backing'
            LIMIT 1`,
      );
      if (!custody) {
        throw new Error('mintEarned backing custody is not the earned-backing treasury wallet');
      }
    }

    const [lot] = await innerTx
      .insert(earnedMintLots)
      .values({
        ledgerId: credited.ledgerId,
        earnEventId: input.backing.kind === 'backed' ? input.backing.earnEventId : null,
        avatarId: input.avatarId,
        backingKind: input.backing.kind,
        mintRef: input.backing.mintRef,
        originalVclaw: input.amount,
        remainingVclaw: input.amount,
        metadata: input.backing.kind === 'none'
          ? { unbackedReason: input.backing.reason }
          : { settlementSourceRef: input.backing.sourceRef },
      })
      .returning({ id: earnedMintLots.id });
    if (!lot) throw new Error('mintEarned lot insert returned no row');

    if (input.backing.kind === 'backed') {
      await innerTx.insert(earnedBackings).values({
        mintLotId: lot.id,
        custodyWalletId: input.backing.custodyWalletId,
        sourceRef: input.backing.sourceRef,
        originalUsdcAtomic: input.backing.usdcAtomic,
        remainingUsdcAtomic: input.backing.usdcAtomic,
        consumedUsdcAtomic: '0',
        releasedUsdcAtomic: '0',
        metadata: { earnEventId: input.backing.earnEventId },
      });
    }
    await innerTx.insert(earnedAccountedLedger).values({
      ledgerId: credited.ledgerId,
      kind: 'mint',
    });

    return credited;
  };

  if (tx) return run(tx);
  return db.transaction((innerTx) => run(innerTx));
}

/**
 * Atomic transfer between two avatars — one transaction, both or neither.
 * Use for peer transfers, escrow settlements, bounty escrow release, etc.
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
  /** Covenant actor attribution for the INITIATOR (the debited side). */
  actorKind?: CovenantActorKind | null;
}): Promise<{ fromBalance: number; toBalance: number }> {
  const result = await db.transaction(async (tx) => {
    const debit = await debitInTx(tx, {
      avatarId: input.fromAvatarId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      metadata: { ...input.metadata, transferTo: input.toAvatarId },
      actorKind: input.actorKind ?? null,
    });
    // Receiver ALWAYS gets SOFT — non-cashable recirculation, by construction.
    // The receiver's covenant record stays unattributed (the initiator acted,
    // not the receiver) — the transferFrom metadata carries the linkage.
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
  // succeeds. Peer skill commerce (the only caller of this path) was removed
  // 2026-07-02, but `transferClawTokens` itself stays live ledger infra; the
  // event keeps us informed if/when a peer-transfer caller is added back.
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
