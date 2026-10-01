import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Real-PostgreSQL check that migration 0073 writes EXACTLY what the app writes
 * (connect-sec round 4, audit S3). `mintSessionTicket` stores
 * `ticketIdentityKeyDigest(type, key)` = 'sha256:' + hex sha256("type:key")
 * (JS, UTF-8); 0073 rewrites older raw rows with
 * encode(sha256(convert_to(type || ':' || key, 'UTF8')), 'hex'). If either side
 * drifts (encoding, separator, prefix, hex case), the two audit forms no longer
 * match and only this test notices. The SQL is read from the migration file,
 * so an edit to 0073 is tested as written. A second run must change 0 rows.
 *
 * Runs a table-wide UPDATE, so it needs DATABASE_URL on a LOCAL host AND an
 * opt-in: CI === 'true' (the gates.yml Postgres service) or
 * CONNECT_SEC_DB_TEST=1. Its rows use fresh ids and are removed afterwards.
 */
const databaseUrl = process.env.DATABASE_URL ?? '';
const optedIn = process.env.CI === 'true' || process.env.CONNECT_SEC_DB_TEST === '1';
const localDatabase = /^postgres(ql)?:\/\/[^/]*@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(databaseUrl);
const describeIfDb = optedIn && localDatabase ? describe : describe.skip;

const MIGRATION_PATH = resolve(
  import.meta.dir,
  '../../../../../packages/database/migrations/0073_session_ticket_identity_hash.sql',
);

const USER_ID = randomUUID();
/** Raw keys in the shapes the real writers pass to mintSessionTicket. */
const RAW_ROWS: Array<{ label: string; identityType: string; identityKey: string }> = [
  { label: 'raw ascii', identityType: 'custom', identityKey: 'owner-identity-secret' },
  // A raw key that is itself 64 lowercase hex: the 'sha256:' prefix test keeps it in scope.
  { label: '64-hex raw', identityType: 'custom', identityKey: 'a'.repeat(32) + '0123456789abcdef0123456789abcdef' },
  { label: 'unicode', identityType: 'hermes', identityKey: 'ключ-é-鍵-🔑' },
  // agent-gateway.ts connect: miladyAgentId fallback (a uuid) under the milady type.
  { label: 'gateway milady id', identityType: 'milady', identityKey: randomUUID() },
  // portal.ts: 'portal-hatcher' with 'hatcher:<id>' (a colon inside the key).
  { label: 'portal hatcher', identityType: 'portal-hatcher', identityKey: `hatcher:${randomUUID()}` },
  // agent-gateway.ts reconnect: the user id under 'reconnect'.
  { label: 'reconnect', identityType: 'reconnect', identityKey: randomUUID() },
];

describeIfDb('migration 0073 matches ticketIdentityKeyDigest on PostgreSQL', () => {
  let database: typeof import('@clawville/database');
  let ticketIdentityKeyDigest: typeof import('../session-ticket-service')['ticketIdentityKeyDigest'];
  const tickets = RAW_ROWS.map(() => `sess-c7-${randomUUID()}`);
  const hashedTicket = `sess-c7-hashed-${randomUUID()}`;

  beforeAll(async () => {
    database = await import('@clawville/database');
    ({ ticketIdentityKeyDigest } = await import('../session-ticket-service'));
    const { db, sql, agentSessionTickets } = database;
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (${USER_ID}::uuid, ${`ticket-${USER_ID}@clawville-test.invalid`}, ${`disabled-${USER_ID}`}, 'Ticket Hash DB Test')
    `);
    const expiresAt = new Date(Date.now() + 600_000);
    await db.insert(agentSessionTickets).values([
      // Pre-0073 rows: the raw key, as the old writer stored it.
      ...RAW_ROWS.map((row, index) => ({
        ticket: tickets[index],
        userId: USER_ID,
        identityType: row.identityType,
        identityKey: row.identityKey,
        expiresAt,
      })),
      // A row the current writer stored: already hashed, must stay as is.
      {
        ticket: hashedTicket,
        userId: USER_ID,
        identityType: 'custom',
        identityKey: ticketIdentityKeyDigest('custom', 'already-hashed-key'),
        expiresAt,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!database) return;
    const { db, sql } = database;
    // ON DELETE CASCADE removes this user's tickets.
    await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}::uuid`);
  }, 60_000);

  async function runMigration(): Promise<number> {
    const { db, sql } = database;
    const text = readFileSync(MIGRATION_PATH, 'utf8');
    const result = (await db.execute(sql.raw(text))) as unknown as { count: number };
    return result.count;
  }

  async function storedKeys(): Promise<Map<string, string | null>> {
    const { db, agentSessionTickets, inArray } = database;
    const rows = await db
      .select({ ticket: agentSessionTickets.ticket, identityKey: agentSessionTickets.identityKey })
      .from(agentSessionTickets)
      .where(inArray(agentSessionTickets.ticket, [...tickets, hashedTicket]));
    return new Map(rows.map((row) => [row.ticket, row.identityKey]));
  }

  test('first run rewrites every raw key to the app digest byte for byte; a second run changes 0 rows', async () => {
    const firstCount = await runMigration();
    // Table-wide UPDATE: at least this file's raw rows.
    expect(firstCount).toBeGreaterThanOrEqual(RAW_ROWS.length);

    const stored = await storedKeys();
    RAW_ROWS.forEach((row, index) => {
      const actual = stored.get(tickets[index]);
      const expected = ticketIdentityKeyDigest(row.identityType, row.identityKey);
      expect({ label: row.label, value: actual }).toEqual({ label: row.label, value: expected });
      expect(Buffer.from(actual ?? '', 'utf8').equals(Buffer.from(expected, 'utf8'))).toBe(true);
      expect(actual).not.toContain(row.identityKey);
    });
    expect(stored.get(hashedTicket)).toBe(ticketIdentityKeyDigest('custom', 'already-hashed-key'));

    const secondCount = await runMigration();
    expect(secondCount).toBe(0);
    expect(await storedKeys()).toEqual(stored);
  });
});
