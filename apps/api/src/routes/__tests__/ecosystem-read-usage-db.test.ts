/**
 * The read budget against DATABASE_URL (migration 0098): one atomic upsert per
 * call, never above the limit, one row per avatar per UTC day.
 *
 * Skips when DATABASE_URL is absent or migration 0098 is not applied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as dbMod from '@clawville/database';
import { consumeReadBudget } from '../../services/ecosystem-reads';

const { db, sql } = dbMod;

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('fixture query returned no row');
  return row;
}

let schemaReady = false;
if (process.env.DATABASE_URL) {
  try {
    const t = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'ecosystem_read_usage'`,
    );
    schemaReady = Number(first(t).n) === 1;
  } catch {
    schemaReady = false;
  }
  if (!schemaReady) console.warn('[ecosystem-read-usage-db] SKIPPING: migration 0098 is not applied to this DATABASE_URL.');
}
const describeIfSchema = schemaReady ? describe : describe.skip;

describeIfSchema('consumeReadBudget', () => {
  let userId = '';
  let avatarId = '';

  beforeAll(async () => {
    const tag = `budget${randomBytes(6).toString('hex')}`;
    userId = first(await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name) VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Read budget DB Test') RETURNING id`,
    )).id;
    avatarId = first(await db.execute<{ id: string }>(
      sql`INSERT INTO avatars (user_id, name, species, color, gender, archetype, personality, stats, claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
            ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
            ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb, 0, 0, 0, 0, true, false)
          RETURNING id`,
    )).id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM ecosystem_read_usage WHERE avatar_id = ${avatarId}`);
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  });

  it('20 concurrent calls with a limit of 7 give exactly 7 units and one row', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeReadBudget(avatarId, 7)));
    const granted = results.filter((value) => value !== null).sort((a, b) => a! - b!);
    expect(granted).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const row = first(await db.execute<{ n: number | string; calls: number; today: boolean }>(sql`
      SELECT COUNT(*)::int AS n, MAX(calls)::int AS calls,
             BOOL_AND(day = (now() AT TIME ZONE 'UTC')::date) AS today
      FROM ecosystem_read_usage WHERE avatar_id = ${avatarId}`));
    expect(Number(row.n)).toBe(1);
    expect(Number(row.calls)).toBe(7);
    expect(row.today).toBe(true);
    expect(await consumeReadBudget(avatarId, 7)).toBeNull();
  });
});
