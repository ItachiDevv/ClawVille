import { describe, expect, it } from 'bun:test';
import { type SQL } from 'drizzle-orm';
import { SpecialEventSettlementWorker } from '../special-event-settlement-worker';

function renderSql(q: SQL): { text: string; params: unknown[] } {
  const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks ?? [];
  let text = '';
  const params: unknown[] = [];
  for (const ch of chunks) {
    const name = (ch as { constructor?: { name?: string } })?.constructor?.name;
    if (name === 'StringChunk') {
      text += ((ch as { value: string[] }).value ?? []).join('');
    } else if (name === 'SQL') {
      const sub = renderSql(ch as SQL);
      text += sub.text;
      params.push(...sub.params);
    } else {
      params.push(ch);
      text += '?';
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), params };
}

class FakeWorkerDb {
  candidates: string[] = [];
  scans = 0;
  scanError: Error | null = null;
  lastSql = '';

  async execute<T>(q: SQL): Promise<T[]> {
    this.scans++;
    if (this.scanError) throw this.scanError;
    const rendered = renderSql(q);
    this.lastSql = rendered.text;
    const limit = Number(rendered.params.at(-1));
    return this.candidates
      .slice(0, limit)
      .map((tournamentId) => ({ tournament_id: tournamentId })) as T[];
  }
}

function fakeOutcome(tournamentId: string) {
  return {
    alreadySettled: false,
    tournamentId,
    results: [],
  };
}

describe('SpecialEventSettlementWorker', () => {
  it('automatically repairs a fail-once completion callback during the boot pass', async () => {
    const db = new FakeWorkerDb();
    db.candidates = ['tournament-1'];
    let calls = 0;
    const manager = {
      settleEventForTournament: async (tournamentId: string) => {
        calls++;
        if (calls === 1) throw new Error('transient parent write failure');
        return fakeOutcome(tournamentId);
      },
    };

    // TournamentManager's immediate callback is fail-soft; model its transient
    // failure, then prove the worker's automatic boot pass replays the exact id.
    await expect(manager.settleEventForTournament('tournament-1')).rejects.toThrow(
      'transient parent write failure',
    );
    const worker = new SpecialEventSettlementWorker({ db, manager, pollMs: 60_000 });
    await worker.start();
    worker.stop();

    expect(calls).toBe(2);
    expect(db.scans).toBe(1);
    expect(worker.isStarted()).toBe(false);
    expect(db.lastSql).toContain("t.status = 'completed'");
    expect(db.lastSql).toContain("e.status = 'live'");
  });

  it('bounds each pass and continues after one event fails', async () => {
    const db = new FakeWorkerDb();
    db.candidates = ['bad', 'good', 'deferred'];
    const attempted: string[] = [];
    const errors: string[] = [];
    const manager = {
      settleEventForTournament: async (tournamentId: string) => {
        attempted.push(tournamentId);
        if (tournamentId === 'bad') throw new Error('row failed');
        return fakeOutcome(tournamentId);
      },
    };
    const worker = new SpecialEventSettlementWorker({
      db,
      manager,
      batchSize: 2,
      logError: (message) => errors.push(message),
    });

    const result = await worker.runOnce();

    expect(result).toEqual({ scanned: 2, reconciled: 1, failed: 1, skippedOverlap: false });
    expect(attempted).toEqual(['bad', 'good']);
    expect(errors).toHaveLength(1);
  });

  it('skips an overlapping pass while the current reconciliation is in flight', async () => {
    const db = new FakeWorkerDb();
    db.candidates = ['slow'];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const manager = {
      settleEventForTournament: async (tournamentId: string) => {
        entered();
        await blocked;
        return fakeOutcome(tournamentId);
      },
    };
    const worker = new SpecialEventSettlementWorker({ db, manager });

    const first = worker.runOnce();
    await started;
    const overlap = await worker.runOnce();
    release();
    const completed = await first;

    expect(overlap).toEqual({ scanned: 0, reconciled: 0, failed: 0, skippedOverlap: true });
    expect(completed.reconciled).toBe(1);
    expect(db.scans).toBe(1);
  });

  it('releases the overlap guard after a scan error so a later pass can recover', async () => {
    const db = new FakeWorkerDb();
    db.scanError = new Error('database unavailable');
    const errors: string[] = [];
    const manager = {
      settleEventForTournament: async (tournamentId: string) => fakeOutcome(tournamentId),
    };
    const worker = new SpecialEventSettlementWorker({
      db,
      manager,
      logError: (message) => errors.push(message),
    });

    const failed = await worker.runOnce();
    db.scanError = null;
    db.candidates = ['retry'];
    const recovered = await worker.runOnce();

    expect(failed).toEqual({ scanned: 0, reconciled: 0, failed: 1, skippedOverlap: false });
    expect(recovered).toEqual({ scanned: 1, reconciled: 1, failed: 0, skippedOverlap: false });
    expect(errors).toHaveLength(1);
  });
});
