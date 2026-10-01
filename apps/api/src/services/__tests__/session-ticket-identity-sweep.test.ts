import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * connect-sec round 4 (2026-10-01, Codex C4): the API re-runs the migration
 * 0073 UPDATE at boot and 15 minutes later. DB-free: the statement runner and
 * the timer are seams. The PostgreSQL proof that this SQL equals the app
 * digest is session-ticket-identity-hash.db.test.ts (opt-in, local DB).
 */

import {
  SESSION_TICKET_IDENTITY_SWEEP_DELAY_MS,
  SESSION_TICKET_IDENTITY_SWEEP_SQL,
  __resetSessionTicketIdentitySweepForTests,
  runSessionTicketIdentitySweep,
  sessionTicketIdentitySweepSeams,
  startSessionTicketIdentitySweep,
} from '../session-ticket-identity-sweep';

const MIGRATION_PATH = resolve(
  import.meta.dir,
  '../../../../../packages/database/migrations/0073_session_ticket_identity_hash.sql',
);

const realSeams = { ...sessionTicketIdentitySweepSeams };
const realLog = console.log;
const realError = console.error;

let executed: string[] = [];
let results: Array<number | Error> = [];
let scheduled: Array<{ run: () => void; delayMs: number }> = [];
let logs: string[] = [];
let errors: string[] = [];

/** Let the fire-and-forget run settle. */
const flush = () => new Promise((resolveFlush) => setTimeout(resolveFlush, 0));

beforeEach(() => {
  __resetSessionTicketIdentitySweepForTests();
  executed = [];
  results = [];
  scheduled = [];
  logs = [];
  errors = [];
  sessionTicketIdentitySweepSeams.execute = async (statement: string) => {
    executed.push(statement);
    const next = results.shift() ?? 0;
    if (next instanceof Error) throw next;
    return next;
  };
  sessionTicketIdentitySweepSeams.schedule = (run, delayMs) => {
    scheduled.push({ run, delayMs });
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
});

afterAll(() => {
  Object.assign(sessionTicketIdentitySweepSeams, realSeams);
  console.log = realLog;
  console.error = realError;
  __resetSessionTicketIdentitySweepForTests();
});

describe('session-ticket identity sweep (0073 re-run)', () => {
  test('the SQL is the 0073 UPDATE statement, character for character', () => {
    const statement = readFileSync(MIGRATION_PATH, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
      .trim();
    expect(SESSION_TICKET_IDENTITY_SWEEP_SQL).toBe(statement);
    // The idempotence predicate and the digest form stay in the statement.
    expect(SESSION_TICKET_IDENTITY_SWEEP_SQL).toContain(`"identity_key" !~ '^sha256:[0-9a-f]{64}$'`);
    expect(SESSION_TICKET_IDENTITY_SWEEP_SQL).toContain(
      `'sha256:' || encode(sha256(convert_to("identity_type" || ':' || "identity_key", 'UTF8')), 'hex')`,
    );
  });

  test('start runs once now and once 15 minutes later, and logs each row count', async () => {
    results = [3, 0];
    startSessionTicketIdentitySweep();
    await flush();

    expect(executed).toEqual([SESSION_TICKET_IDENTITY_SWEEP_SQL]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(15 * 60 * 1000);
    expect(SESSION_TICKET_IDENTITY_SWEEP_DELAY_MS).toBe(15 * 60 * 1000);
    expect(logs.some((line) => line.includes('boot run: hashed 3 raw agent_session_tickets.identity_key row(s)'))).toBe(true);

    scheduled[0].run();
    await flush();

    expect(executed).toEqual([SESSION_TICKET_IDENTITY_SWEEP_SQL, SESSION_TICKET_IDENTITY_SWEEP_SQL]);
    expect(logs.some((line) => line.includes('15-minute run: hashed 0 raw agent_session_tickets.identity_key row(s)'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a second start call does not schedule more runs', async () => {
    startSessionTicketIdentitySweep();
    startSessionTicketIdentitySweep();
    await flush();
    expect(executed).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  test('a failed boot run logs, never throws, and the 15-minute run still runs', async () => {
    results = [new Error('connection refused'), 2];
    expect(() => startSessionTicketIdentitySweep()).not.toThrow();
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('boot run: 0073 re-run failed (non-fatal');
    expect(errors[0]).toContain('connection refused');

    scheduled[0].run();
    await flush();
    expect(executed).toHaveLength(2);
    expect(logs.some((line) => line.includes('15-minute run: hashed 2 raw'))).toBe(true);
  });

  test('runSessionTicketIdentitySweep resolves null on error and the count on success', async () => {
    results = [new Error('statement timeout'), 5];
    await expect(runSessionTicketIdentitySweep('manual')).resolves.toBeNull();
    await expect(runSessionTicketIdentitySweep('manual')).resolves.toBe(5);
  });
});
