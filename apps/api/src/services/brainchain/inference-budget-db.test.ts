import { getBrainchainFixtureSettings } from './test-fixtures/database';
/** Existing isolated PostgreSQL fixture only. No external provider or root spend occurs. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { DurableInferenceProxy } from './inference-proxy';

describe.skipIf(process.env.BRAINCHAIN_DB_FIXTURE !== '1')('durable compute envelope ownership', () => {
  let fixture: ReturnType<typeof postgres>; let service: DurableInferenceProxy;
  const jobId = randomUUID();
  const approval = (provider: 'openai' | 'openrouter', limitMicros = 4_000_000n) => ({ jobId, provider,
    rootReservationId: `fixture-${randomUUID()}`, approvalRef: 'provider-free-fixture', limitMicros, expiresAt: new Date(Date.now() + 60_000) });
  beforeAll(async () => {
    const root = resolve(import.meta.dir, '../../../../..');
    const settings=await getBrainchainFixtureSettings();
    fixture = postgres({...settings.options, max: 12, onnotice: () => {} });
    const migration = await readFile(resolve(root, 'packages/database/migrations/0103_brainchain_compute_reservations.sql'), 'utf8');
    await fixture.unsafe(migration); await fixture.unsafe(migration);
    service = new DurableInferenceProxy(fixture, [], [], { verifyReservation: async () => {} });
  });
  afterAll(async () => { await fixture?.end(); });
  test('simultaneous root envelopes respect separate provider caps across a process restart', async () => {
    for (const provider of ['openai', 'openrouter'] as const) {
      const races = await Promise.allSettled(Array.from({ length: 6 }, () => service.approveEnvelope(approval(provider))));
      expect(races.filter(row => row.status === 'fulfilled')).toHaveLength(2);
      const [budget] = await fixture`SELECT * FROM brainchain_compute_budgets WHERE job_id=${jobId} AND provider=${provider}`;
      expect(budget!.allocated_micros).toBe('8000000'); expect(budget!.cap_micros).toBe('10000000');
    }
    const restarted = new DurableInferenceProxy(fixture, [], [], { verifyReservation: async () => {} });
    await expect(restarted.approveEnvelope(approval('openai'))).rejects.toMatchObject({ code: 'budget_refused' });
    expect((await fixture`SELECT SUM(allocated_micros) AS total FROM brainchain_compute_budgets WHERE job_id=${jobId}`)[0]!.total).toBe('16000000');
  });
  test('root reservation replay is idempotent and changed approval bytes refuse', async () => {
    const input = { ...approval('openai', 1n), jobId: randomUUID() };
    const first = await service.approveEnvelope(input); const second = await service.approveEnvelope(input);
    expect(first).toEqual(second);
    await expect(service.approveEnvelope({ ...input, limitMicros: 2n })).rejects.toMatchObject({ code: 'budget_refused' });
    const closed = await service.closeEnvelope(first.id); expect(closed.releasedMicros).toBe('1');
    expect(await service.closeEnvelope(first.id)).toEqual(closed);
    expect((await fixture`SELECT allocated_micros FROM brainchain_compute_budgets WHERE job_id=${input.jobId}`)[0]!.allocated_micros).toBe('0');
  });
  test('missing root ledger authority and mutable root reservation fields refuse', async () => {
    await expect(new DurableInferenceProxy(fixture, [], []).approveEnvelope(approval('openai', 1n))).rejects.toMatchObject({ code: 'budget_refused' });
    const input = { ...approval('openrouter', 1n), jobId: randomUUID() }; const envelope = await service.approveEnvelope(input);
    await expect((async () => { await fixture`UPDATE brainchain_compute_envelopes SET limit_micros=2 WHERE id=${envelope.id}`; })()).rejects.toThrow('immutable');
    await expect((async () => { await fixture`UPDATE brainchain_compute_budgets SET cap_micros=20000000 WHERE job_id=${input.jobId}`; })()).rejects.toThrow('immutable');
  });
  test('expiry uses database wall time after a budget lock wait', async () => {
    const input = { ...approval('openai', 1n), jobId: randomUUID() };
    await service.approveEnvelope(input);
    let unlock!: () => void; let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; }); const finish = new Promise<void>(resolve => { unlock = resolve; });
    const holder = fixture.begin(async tx => { await tx`SELECT id FROM brainchain_compute_budgets WHERE job_id=${input.jobId} FOR UPDATE`; locked(); await finish; });
    await acquired;
    const pending = service.approveEnvelope({ ...input, rootReservationId: `fixture-${randomUUID()}`, expiresAt: new Date(Date.now() + 300) });
    const outcome = pending.then(() => 'accepted', error => String(error.code));
    await Bun.sleep(450); unlock(); await holder;
    expect(await outcome).toBe('expired');
    expect((await fixture`SELECT allocated_micros FROM brainchain_compute_budgets WHERE job_id=${input.jobId}`)[0]!.allocated_micros).toBe('1');
  });
});
