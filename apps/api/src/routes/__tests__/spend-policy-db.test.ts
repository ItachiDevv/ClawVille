/**
 * Executed spend-rules contract against DATABASE_URL (migration 0089): the
 * CHECK constraints, the upsert under concurrent writes, a missing row read as
 * unset, and the new `sessions.created_via` column.
 *
 * Skips cleanly when DATABASE_URL is absent OR migration 0089 is not applied to
 * the target database (the CI route lane migrates its test database first).
 * Fixtures are tagged and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as dbMod from '@clawville/database';
import { readSpendPolicy, writeSpendPolicy } from '../../services/spend-policy';

const { db, sql } = dbMod;

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('spend-policy DB fixture query returned no row');
  return row;
}

async function failureCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (err) {
    const failure = err as { code?: string; cause?: { code?: string } };
    return failure.code ?? failure.cause?.code;
  }
}

let schemaReady = false;
if (process.env.DATABASE_URL) {
  try {
    const tables = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name = 'user_spend_policies'`,
    );
    const cols = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'created_via'`,
    );
    schemaReady = Number(first(tables).n) === 1 && Number(first(cols).n) === 1;
  } catch {
    schemaReady = false;
  }
  if (!schemaReady) console.warn('[spend-policy-db] SKIPPING: migration 0089 is not applied to this DATABASE_URL yet.');
}

const describeIfSchema = schemaReady ? describe : describe.skip;

describeIfSchema('spend rules: executed DB contract', () => {
  const tag = `sp${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Spend Policy DB Test')
          RETURNING id`,
    );
    userId = first(users).id;
    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
             ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
             ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb,
             0, 0, 0, 0, true, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM user_spend_policies WHERE avatar_id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`).catch(() => {});
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('reads a missing row as unset caps', async () => {
    expect(await readSpendPolicy(avatarId)).toMatchObject({
      dailyCapUsdCents: null,
      perCallCapUsdCents: null,
      allowedVendors: [],
      configured: false,
    });
  });

  it('upserts one row per avatar, also under concurrent writes', async () => {
    const writes = await Promise.all(
      [100, 200, 300, 400].map((cents) =>
        writeSpendPolicy(avatarId, userId, {
          dailyCapUsdCents: cents,
          perCallCapUsdCents: 10,
          allowedVendors: ['studios'],
        })),
    );
    expect(writes.every((view) => view.configured)).toBe(true);
    const rows = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM user_spend_policies WHERE avatar_id = ${avatarId}`,
    );
    expect(Number(first(rows).n)).toBe(1);
    const view = await readSpendPolicy(avatarId);
    expect([100, 200, 300, 400]).toContain(view.dailyCapUsdCents ?? -1);
    expect(view).toMatchObject({ perCallCapUsdCents: 10, allowedVendors: ['studios'], configured: true });
  });

  it('can clear a cap back to unset', async () => {
    const view = await writeSpendPolicy(avatarId, userId, {
      dailyCapUsdCents: null,
      perCallCapUsdCents: 10,
      allowedVendors: [],
    });
    expect(view).toMatchObject({ dailyCapUsdCents: null, configured: false });
  });

  it('enforces the CHECK constraints in the database itself', async () => {
    const bad = [
      sql`UPDATE user_spend_policies SET daily_cap_usd_cents = 10, per_call_cap_usd_cents = 11 WHERE avatar_id = ${avatarId}`,
      sql`UPDATE user_spend_policies SET daily_cap_usd_cents = -1 WHERE avatar_id = ${avatarId}`,
      sql`UPDATE user_spend_policies SET per_call_cap_usd_cents = 100001 WHERE avatar_id = ${avatarId}`,
    ];
    for (const statement of bad) {
      expect(await failureCode(() => db.execute(statement))).toBe('23514');
    }
  });

  it('stores the session origin label', async () => {
    const id = `${tag}-session`;
    await db.execute(
      sql`INSERT INTO sessions (id, user_id, expires_at, created_via)
          VALUES (${id}, ${userId}, now() + interval '1 hour', 'agent_exchange')`,
    );
    const rows = await db.execute<{ created_via: string | null }>(
      sql`SELECT created_via FROM sessions WHERE id = ${id}`,
    );
    expect(first(rows).created_via).toBe('agent_exchange');
  });
});
