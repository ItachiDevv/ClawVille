import { sql } from 'drizzle-orm';

export const DEFAULT_AGENT_COVE_PLAY_DAILY_WAGER_VCLAW = 1_000;
export const AGENT_COVE_PLAY_DAILY_WAGER_FLOOR_VCLAW = 20;

export function resolveAgentCovePlayDailyWagerVclaw(): number {
  const raw = process.env.AGENT_COVE_PLAY_DAILY_WAGER_VCLAW?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= AGENT_COVE_PLAY_DAILY_WAGER_FLOOR_VCLAW
    ? parsed
    : DEFAULT_AGENT_COVE_PLAY_DAILY_WAGER_VCLAW;
}

export function autonomousCoveDailyAdvisoryKey(avatarId: string): string {
  return `agent-cove-play-daily:${avatarId}`;
}

export function autonomousCoveDailyUsageQuery(avatarId: string) {
  return sql`
    SELECT COALESCE(SUM(-amount), 0)::text AS used_vclaw
    FROM claw_token_transactions
    WHERE avatar_id = ${avatarId}
      AND amount < 0
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'
      AND metadata ->> 'autonomousCove' = 'true'
  `;
}

export function parseAutonomousCoveDailyUsage(rows: Array<{ used_vclaw: string }>): number {
  const usedToday = Number(rows[0]?.used_vclaw ?? '0');
  if (!Number.isSafeInteger(usedToday) || usedToday < 0) {
    throw new Error('autonomous cove daily wager usage is outside safe integer range');
  }
  return usedToday;
}

export function autonomousCoveDailyCapMessage(
  usedToday: number,
  requested: number,
): string | null {
  const dailyCap = resolveAgentCovePlayDailyWagerVclaw();
  return usedToday > dailyCap - requested
    ? `agent_cove_daily_wager_cap_exceeded: cap=${dailyCap}, used=${usedToday}, requested=${requested}`
    : null;
}
