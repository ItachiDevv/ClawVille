import { sql } from 'drizzle-orm';

export const DEFAULT_AGENT_LAND_DAILY_SPEND_VCLAW = 10_000;

export function resolveAgentLandDailySpendVclaw(): number {
  const raw = process.env.AGENT_LAND_DAILY_SPEND_VCLAW?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_AGENT_LAND_DAILY_SPEND_VCLAW;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_LAND_DAILY_SPEND_VCLAW;
}

/** Exact ledger usage; callers run this under the existing avatar advisory lock. */
export function autonomousLandDailyUsageQuery(avatarId: string) {
  return sql`
    SELECT COALESCE(SUM(-amount), 0)::text AS used_vclaw
    FROM claw_token_transactions
    WHERE avatar_id = ${avatarId}
      AND amount < 0
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'
      AND metadata ->> 'autonomousLand' = 'true'
  `;
}

export function parseAutonomousLandDailyUsage(rows: Array<{ used_vclaw: string }>): number {
  const used = Number(rows[0]?.used_vclaw ?? '0');
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new Error('autonomous land daily usage is outside safe integer range');
  }
  return used;
}

export function autonomousLandCapAllows(used: number, requested: number): boolean {
  return requested >= 0 && used <= resolveAgentLandDailySpendVclaw() - requested;
}
