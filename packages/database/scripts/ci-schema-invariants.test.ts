import { describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import expected from './ci-schema-invariants.expected.json';
import { assertDisposableCiDatabase } from './ci-restore-schema-invariants';

const url = process.env.MIGRATION_DATABASE_URL;
const normalize = (definition: string): string => definition
  .replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, 'CREATE $1INDEX _ ON ')
  .replaceAll('public.', '').replaceAll('"', '').replace(/\s+/g, ' ').trim();

describe('CI schema restore boundary', () => {
  test('rejects non-local or non-disposable database targets', () => {
    for (const candidate of [
      'postgres://postgres:test@db.example.com:5432/clawville_test',
      'postgres://postgres:test@localhost:5432/production',
      'postgres://postgres:test@127.0.0.1:5432/postgres',
    ]) expect(() => assertDisposableCiDatabase(candidate)).toThrow();
  });
});

describe.skipIf(!url)('empirical staging invariants retained by fresh CI replay', () => {
  test('concurrent approval of two attempts permits only one approved row', async () => {
    assertDisposableCiDatabase(url!);
    const client = postgres(url!, { max: 2, prepare: false, connect_timeout: 15 });
    const userId = crypto.randomUUID();
    const avatarId = crypto.randomUUID();
    const bountyId = crypto.randomUUID();
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    try {
      await client`INSERT INTO users (id, email) VALUES (${userId}, ${`ci-bounty-${userId}@example.invalid`})`;
      await client`INSERT INTO avatars
        (id, user_id, name, species, color, gender, archetype, personality, stats)
        VALUES (${avatarId}, ${userId}, ${`ci-${avatarId}`}, 'cat', 'green', 'male',
          'brave-adventurer', '{}'::jsonb, '{}'::jsonb)`;
      await client`INSERT INTO bounties (id, creator_id, title, description, token_reward)
        VALUES (${bountyId}, ${avatarId}, 'CI invariant probe', 'No payout or ledger operation', 0)`;
      await client`INSERT INTO bounty_attempts (id, bounty_id, hunter_id, status)
        VALUES (${first}, ${bountyId}, ${avatarId}, 'submitted'),
               (${second}, ${bountyId}, ${avatarId}, 'submitted')`;
      const results = await Promise.allSettled([first, second].map((id) =>
        client`UPDATE bounty_attempts SET status='approved' WHERE id=${id} RETURNING id`));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('23505');
      const [counts] = await client<{ approved: number; submitted: number }[]>`
        SELECT count(*) FILTER (WHERE status='approved')::int AS approved,
          count(*) FILTER (WHERE status='submitted')::int AS submitted
        FROM bounty_attempts WHERE bounty_id=${bountyId}`;
      expect(counts).toEqual({ approved: 1, submitted: 1 });
    } finally {
      try { await client`DELETE FROM users WHERE id=${userId}`; }
      finally { await client.end({ timeout: 5 }); }
    }
  });

  test('all 14 previously missing artifacts have the same definitions and validated state', async () => {
    assertDisposableCiDatabase(url!);
    const client = postgres(url!, { max: 1, prepare: false, connect_timeout: 15 });
    try {
      const actual = await client<{ table_name: string; definition: string; validated: boolean }[]>`
        SELECT t.relname AS table_name, pg_get_constraintdef(c.oid, true) AS definition,
          c.convalidated AS validated
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
        UNION ALL
        SELECT t.relname, pg_get_indexdef(i.indexrelid), i.indisvalid
        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
      `;
      expect(expected).toHaveLength(14);
      for (const artifact of expected) {
        const found = actual.find((row) => row.table_name === artifact.table_name
          && normalize(row.definition) === normalize(artifact.definition));
        expect(found, `${artifact.table_name}.${artifact.artifact_name}`).toBeDefined();
        expect(found?.validated, artifact.artifact_name).toBe(true);
      }
    } finally { await client.end({ timeout: 5 }); }
  });
});
