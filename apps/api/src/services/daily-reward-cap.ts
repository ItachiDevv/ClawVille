/**
 * Durable per-avatar daily faucet caps (security pass, founder decision
 * 2026-10-04). Values: `DAILY_REWARD_CAPS` in `@clawville/shared`
 * (building_visit 10 paid arrivals, nori_chat 10 paid turns, activity 500 vCLAW).
 *
 * The cap is keyed by avatars.id and UTC day, so a human, a connected agent and
 * a hosted/autonomous agent that settle to the same avatar share ONE counter.
 * Over the cap the caller still performs the action; only the payout is 0 (or
 * the clamped remainder for activities).
 *
 * CONCURRENCY: `claimDailyRewardCap` must run inside the SAME transaction as
 * the ledger credit (pattern: `creditBuildingChatRewardOncePerDay` in
 * building-reward.ts). It row-locks the avatar first (the row `creditClawTokens`
 * locks, so every reward path takes avatar -> counter in one order), then claims
 * with ONE `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < cap RETURNING`.
 * ON CONFLICT DO UPDATE locks and re-reads the latest committed counter row, so
 * concurrent claims serialize and `used` never passes the cap. A failed credit
 * rolls the claim back with the transaction.
 *
 * RAW SQL ON PURPOSE: this module binds no drizzle table object, so the many
 * test files that mock `@clawville/database` with a fixed table list keep
 * loading the reward paths that import it.
 */

import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { DAILY_REWARD_CAPS, type DailyRewardCapKind } from '@clawville/shared';
import {
  creditClawTokens,
  type LedgerCreditInput,
  type LedgerTx,
} from './claw-token-ledger';

export { DAILY_REWARD_CAPS, type DailyRewardCapKind };

/** The only tx surface the claim touches (a drizzle tx is a superset). */
export type DailyRewardCapTx = Pick<LedgerTx, 'execute'>;

/** UTC reward day as a 'YYYY-MM-DD' string (never bind a JS Date to raw sql). */
export function utcRewardDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Claim up to `amount` of today's `kind` allowance for `avatarId`. Returns the
 * granted amount: `amount` when the allowance covers it, the remainder when it
 * covers part of it, and 0 when the cap is already reached, the amount is not a
 * positive integer, or the avatar row does not exist. Call it inside the tx
 * that credits the granted amount.
 */
export async function claimDailyRewardCap(
  tx: DailyRewardCapTx,
  opts: { avatarId: string; kind: DailyRewardCapKind; amount: number; now?: Date },
): Promise<number> {
  const cap = DAILY_REWARD_CAPS[opts.kind];
  const want = Number.isFinite(opts.amount) ? Math.floor(opts.amount) : 0;
  if (!(want > 0) || !(cap > 0)) return 0;
  const rewardDay = utcRewardDay(opts.now);

  // Lock order avatar -> counter, the same order on every reward path.
  const [avatarRow] = await tx.execute<{ present: number }>(
    sql`SELECT 1 AS present FROM avatars WHERE id = ${opts.avatarId}::uuid FOR UPDATE`,
  );
  if (!avatarRow) return 0;

  const [row] = await tx.execute<{ granted: number }>(sql`
    INSERT INTO daily_reward_caps AS c
      (avatar_id, reward_day, kind, used, last_granted, updated_at)
    VALUES (
      ${opts.avatarId}::uuid, ${rewardDay}::date, ${opts.kind}::text,
      LEAST(${want}::int, ${cap}::int), LEAST(${want}::int, ${cap}::int), now()
    )
    ON CONFLICT (avatar_id, reward_day, kind) DO UPDATE
      SET last_granted = LEAST(EXCLUDED.last_granted, ${cap}::int - c.used),
          used = c.used + LEAST(EXCLUDED.last_granted, ${cap}::int - c.used),
          updated_at = now()
      WHERE c.used < ${cap}::int
    RETURNING c.last_granted AS granted`);

  // No row: the WHERE refused the update (cap already reached).
  const granted = Number(row?.granted);
  if (!Number.isFinite(granted) || granted <= 0) return 0;
  return Math.min(want, Math.floor(granted));
}

/** Injectable seams (tests only). Production uses db.transaction + the ledger. */
export interface DailyRewardCapDeps {
  transaction: <T>(fn: (tx: LedgerTx) => Promise<T>) => Promise<T>;
  credit: typeof creditClawTokens;
}

const defaultDeps: DailyRewardCapDeps = {
  transaction: (fn) => db.transaction(fn),
  credit: creditClawTokens,
};

/**
 * Claim today's allowance and credit the granted amount in ONE transaction.
 * Returns the vCLAW actually credited (0 when the cap is reached). A ledger
 * failure throws and rolls the claim back.
 */
export async function creditWithDailyRewardCap(
  opts: { kind: DailyRewardCapKind; credit: LedgerCreditInput; now?: Date },
  deps: DailyRewardCapDeps = defaultDeps,
): Promise<number> {
  return deps.transaction(async (tx) => {
    const granted = await claimDailyRewardCap(tx, {
      avatarId: opts.credit.avatarId,
      kind: opts.kind,
      amount: opts.credit.amount,
      now: opts.now,
    });
    if (granted <= 0) return 0;
    await deps.credit({ ...opts.credit, amount: granted }, tx);
    return granted;
  });
}
