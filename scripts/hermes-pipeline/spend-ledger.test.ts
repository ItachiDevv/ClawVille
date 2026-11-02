/**
 * spend-ledger.mjs: the locked reserve-then-call ledger behind every paid generation script
 * (meshy-rest.mjs, hydra-turnaround.mjs). No network: every test works on a temp ledger.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-ignore -- plain .mjs module without type declarations
import { reserveSpend, updateSpendEntry, withFileLock, SpendRefusedError } from './spend-ledger.mjs';

const MODULE_URL = pathToFileURL(join(import.meta.dir, 'spend-ledger.mjs')).href;

let dir = '';
let ledgerPath = '';
const quietWarn = spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spend-ledger-test-'));
  ledgerPath = join(dir, 'spend.json');
  quietWarn.mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readLedger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'));

/** The hydra-turnaround spend.json shape (bookedUsd + calls[]), as the real file has it. */
function writeHydraLedger(bookedUsd: number, count: number) {
  const calls = Array.from({ length: count }, (_, i) => ({
    view: i % 2 ? 'front' : '3q',
    at: '2026-10-31T16:24:49.130Z',
    estUsd: 0.4,
    usage: { total_tokens: 9000 },
    ok: true,
  }));
  writeFileSync(ledgerPath, JSON.stringify({ bookedUsd, calls }, null, 2));
}

describe('reserveSpend refusals', () => {
  test('refuses without a cap (missing, zero, negative, NaN) and writes nothing', async () => {
    for (const cap of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const attempt = reserveSpend({ ledgerPath, amount: 0.4, cap, label: 'front' });
      await expect(attempt).rejects.toBeInstanceOf(SpendRefusedError);
      await expect(reserveSpend({ ledgerPath, amount: 0.4, cap, label: 'front' })).rejects.toThrow(
        "refusing paid 'front': no owner-approved spend cap",
      );
    }
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test('refuses when booked + estimate > cap and leaves the ledger byte-identical', async () => {
    writeHydraLedger(4.8, 12);
    const before = readFileSync(ledgerPath, 'utf8');
    await expect(reserveSpend({ ledgerPath, amount: 0.4, cap: 5, label: 'back' })).rejects.toThrow(
      `refusing paid 'back': booked 4.8 + estimate 0.4 > cap 5 (ledger ${ledgerPath})`,
    );
    expect(readFileSync(ledgerPath, 'utf8')).toBe(before);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  test('refuses an invalid ledger file instead of treating it as empty', async () => {
    writeFileSync(ledgerPath, JSON.stringify({ calls: [] }));
    await expect(reserveSpend({ ledgerPath, amount: 0.4, cap: 10, label: 'front' })).rejects.toThrow(
      'is not a valid { bookedUsd, calls[] } file',
    );
  });
});

describe('reserveSpend bookings', () => {
  test('books on the existing hydra spend.json format (bookedUsd + calls[]) and keeps old entries', async () => {
    writeHydraLedger(4.8, 12);
    const { total, id } = await reserveSpend({
      ledgerPath,
      amount: 0.4,
      cap: 5.2,
      label: 'back',
      entry: { view: 'back', estUsd: 0.4, usage: null, ok: false },
    });
    expect(total).toBe(5.2);
    const ledger = readLedger();
    expect(ledger.bookedUsd).toBe(5.2);
    expect(ledger.calls).toHaveLength(13);
    expect(ledger.calls[0]).toEqual({
      view: '3q',
      at: '2026-10-31T16:24:49.130Z',
      estUsd: 0.4,
      usage: { total_tokens: 9000 },
      ok: true,
    });
    expect(ledger.calls[12]).toMatchObject({ id, label: 'back', view: 'back', estUsd: 0.4, usage: null, ok: false });
    expect(typeof ledger.calls[12].at).toBe('string');
  });

  test('a custom total key and a migration seed are used when the ledger does not exist', async () => {
    const init = () => ({ bookedCredits: 59, calls: [{ id: 'seed-0', label: 'submit (seeded)', estCredits: 59 }] });
    await expect(
      reserveSpend({ ledgerPath, amount: 5, cap: 60, label: 'rig', totalKey: 'bookedCredits', init }),
    ).rejects.toThrow("refusing paid 'rig': booked 59 + estimate 5 > cap 60");
    const { total } = await reserveSpend({ ledgerPath, amount: 5, cap: 64, label: 'rig', totalKey: 'bookedCredits', init });
    expect(total).toBe(64);
    expect(readLedger().calls.map((c: { id: string }) => c.id)[0]).toBe('seed-0');
  });

  test('updateSpendEntry records the result without changing the total', async () => {
    const { id } = await reserveSpend({ ledgerPath, amount: 30, cap: 100, label: 'submit', totalKey: 'bookedCredits' });
    await updateSpendEntry({ ledgerPath, id, patch: { taskId: 'task-123' }, totalKey: 'bookedCredits' });
    const ledger = readLedger();
    expect(ledger.bookedCredits).toBe(30);
    expect(ledger.calls[0]).toMatchObject({ id, label: 'submit', taskId: 'task-123' });
  });
});

describe('concurrency', () => {
  test('in-process: of two parallel reservations only one fits, exactly one passes', async () => {
    writeHydraLedger(4.8, 12);
    const results = await Promise.allSettled([
      reserveSpend({ ledgerPath, amount: 0.4, cap: 5.2, label: 'a' }),
      reserveSpend({ ledgerPath, amount: 0.4, cap: 5.2, label: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason.message)).toContain('booked 5.2 + estimate 0.4 > cap 5.2');
    expect(readLedger().bookedUsd).toBe(5.2);
    expect(readLedger().calls).toHaveLength(13);
  });

  test('multi-process: 6 parallel processes against one ledger, room for 2 → exactly 2 pass', async () => {
    writeFileSync(ledgerPath, JSON.stringify({ bookedUsd: 0, calls: [] }));
    const runner = join(dir, 'runner.mjs');
    writeFileSync(
      runner,
      [
        `import { reserveSpend } from ${JSON.stringify(MODULE_URL)};`,
        `const [ledgerPath, label] = process.argv.slice(2);`,
        `try {`,
        `  const r = await reserveSpend({ ledgerPath, amount: 1, cap: 2, label });`,
        `  console.log('PASS ' + r.total);`,
        `} catch (e) { console.log('REFUSED ' + e.message); }`,
      ].join('\n'),
    );
    const outputs = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const proc = Bun.spawn([process.execPath, runner, ledgerPath, `p${i}`], { stdout: 'pipe', stderr: 'pipe' });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.trim();
      }),
    );
    expect(outputs.filter((o) => o.startsWith('PASS'))).toHaveLength(2);
    expect(outputs.filter((o) => o.startsWith('REFUSED') && o.includes('> cap 2'))).toHaveLength(4);
    const ledger = readLedger();
    expect(ledger.bookedUsd).toBe(2);
    expect(ledger.calls).toHaveLength(2);
  }, 30_000);
});

describe('lock handling', () => {
  test('an old lock is never broken automatically: refusal names its age and holder, lock stays', async () => {
    const lockPath = `${ledgerPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: '2026-10-31T00:00:00.000Z' }));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, old, old);
    const err = await reserveSpend({ ledgerPath, amount: 1, cap: 5, label: 'x', lockTimeoutMs: 150 }).catch((e) => e);
    expect(String(err.message)).toContain(`refusing: ledger lock ${lockPath} is held by another process (waited 150 ms)`);
    expect(String(err.message)).toMatch(/lock age \d+ s, holder .*999999/);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  test('the lock is removed when the locked work throws', async () => {
    const lockPath = `${ledgerPath}.lock`;
    await expect(withFileLock(lockPath, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a fresh lock held by another process is never broken: the reservation waits, then refuses', async () => {
    const lockPath = `${ledgerPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
    await expect(
      reserveSpend({ ledgerPath, amount: 1, cap: 5, label: 'x', lockTimeoutMs: 150 }),
    ).rejects.toThrow(`refusing: ledger lock ${lockPath} is held by another process (waited 150 ms)`);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(ledgerPath)).toBe(false);
  });
});

describe('atomic write', () => {
  test('many reservations leave one valid JSON ledger and no temp or lock files', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => reserveSpend({ ledgerPath, amount: 0.4, cap: 100, label: `v${i}` })),
    );
    const ledger = readLedger();
    expect(ledger.bookedUsd).toBe(8);
    expect(ledger.calls).toHaveLength(20);
    expect(new Set(ledger.calls.map((c: { id: string }) => c.id)).size).toBe(20);
    expect(readdirSync(dir)).toEqual(['spend.json']);
  });
});
