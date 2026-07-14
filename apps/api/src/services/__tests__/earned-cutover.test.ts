import { describe, expect, it } from 'bun:test';
import { earnedAccountedLedger, earnedLotConsumptions } from '@clawville/database';
import { reconcileUnaccountedEarnedLedger } from '../claw-token-ledger';

type GapLedger = { id: string; amount: number; created: number };
type Lot = { id: string; backing_kind: 'backed' | 'none'; remaining_vclaw: number };

function renderSql(q: unknown): { text: string; params: unknown[] } {
  const out = { text: '', params: [] as unknown[] };
  const walk = (node: unknown): void => {
    for (const chunk of (node as { queryChunks?: unknown[] })?.queryChunks ?? []) {
      const name = (chunk as { constructor?: { name?: string } })?.constructor?.name;
      if (name === 'StringChunk') {
        const value = (chunk as { value: unknown }).value;
        out.text += Array.isArray(value) ? value.join('') : String(value);
      } else if (name === 'SQL') walk(chunk);
      else if (name === 'Param') {
        out.params.push((chunk as { value: unknown }).value);
        out.text += '?';
      } else if (name === 'String' || name === 'Number' || name === 'BigInt') {
        out.params.push((chunk as { valueOf(): unknown }).valueOf());
        out.text += '?';
      }
    }
  };
  walk(q);
  return out;
}

function harness(input: {
  aggregate: number;
  gap: GapLedger[];
  lots?: Lot[];
  backingAtomic?: Record<string, bigint>;
}) {
  const lots = [...(input.lots ?? [])];
  const backing = new Map<string, { remaining: bigint; released: bigint }>(
    Object.entries(input.backingAtomic ?? {}).map(([id, amount]) => [id, {
      remaining: amount, released: 0n,
    }]),
  );
  const accounted = new Map<string, string>();
  const consumptions: Array<{ lotId: string; ledgerId: string; amount: number }> = [];

  const execute = async (query: unknown): Promise<unknown[]> => {
    const { text, params } = renderSql(query);
    if (text.includes('SELECT earned_balance FROM avatars')) {
      return [{ earned_balance: input.aggregate }];
    }
    if (text.includes('FROM claw_token_transactions t') && text.includes('t.amount < 0')) {
      return input.gap.filter((row) => row.amount < 0 && !accounted.has(row.id))
        .sort((a, b) => a.created - b.created)
        .map((row) => ({ id: row.id, amount: -row.amount }));
    }
    if (text.includes('FROM claw_token_transactions t') && text.includes('t.amount > 0')) {
      return input.gap.filter((row) => row.amount > 0 && !accounted.has(row.id))
        .sort((a, b) => a.created - b.created)
        .map((row) => ({ id: row.id, amount: row.amount }));
    }
    if (text.includes('COALESCE(SUM(remaining_vclaw)')) {
      return [{ amount: lots.reduce((sum, lot) => sum + lot.remaining_vclaw, 0).toString() }];
    }
    if (text.includes('FROM earned_mint_lots l') && text.includes('FOR UPDATE OF l')) {
      return lots.filter((lot) => lot.remaining_vclaw > 0)
        .sort((a, b) => Number(a.backing_kind === 'backed') - Number(b.backing_kind === 'backed'));
    }
    if (text.includes('UPDATE earned_mint_lots') && text.includes('remaining_vclaw = remaining_vclaw -')) {
      const amount = Number(params[0]);
      const lot = lots.find((row) => row.id === String(params[2]));
      if (!lot || lot.remaining_vclaw < amount) return [];
      lot.remaining_vclaw -= amount;
      return [{ id: lot.id }];
    }
    if (text.includes('UPDATE earned_backing')) {
      const atomic = BigInt(String(params[0]));
      const lotId = String(params[5]);
      const row = backing.get(lotId);
      if (!row || row.remaining < atomic) return [];
      row.remaining -= atomic;
      row.released += atomic;
      return [{ id: `backing-${lotId}` }];
    }
    if (text.includes('INSERT INTO earned_mint_lots')) {
      lots.push({
        id: `lot-${String(params[0])}`,
        backing_kind: 'none',
        remaining_vclaw: Number(params[4]),
      });
      return [];
    }
    throw new Error(`unhandled cutover SQL: ${text.replace(/\s+/g, ' ').trim()}`);
  };

  const tx = {
    execute,
    insert(table: unknown) {
      return {
        values(payload: Record<string, unknown>) {
          if (table === earnedAccountedLedger) {
            return {
              async onConflictDoNothing() {
                if (!accounted.has(String(payload.ledgerId))) {
                  accounted.set(String(payload.ledgerId), String(payload.kind));
                }
              },
            };
          }
          if (table === earnedLotConsumptions) {
            consumptions.push({
              lotId: String(payload.mintLotId),
              ledgerId: String(payload.ledgerDebitId),
              amount: Number(payload.vclawAmount),
            });
            return Promise.resolve();
          }
          throw new Error('unexpected insert table');
        },
      };
    },
  };
  return { tx, lots, backing, accounted, consumptions };
}

describe('EARNED migration/deploy old-writer reconciliation', () => {
  it('turns an old-writer post-migration mint into an explicit unbacked lot', async () => {
    const h = harness({ aggregate: 50, gap: [{ id: 'mint-old', amount: 50, created: 1 }] });
    await reconcileUnaccountedEarnedLedger(h.tx as never, 'avatar-1');
    expect(h.lots).toEqual([{ id: 'lot-mint-old', backing_kind: 'none', remaining_vclaw: 50 }]);
    expect(h.accounted.get('mint-old')).toBe('mint');
  });

  it('replays an old-writer spend against existing backing and releases it', async () => {
    const h = harness({
      aggregate: 50,
      gap: [{ id: 'spend-old', amount: -50, created: 1 }],
      lots: [{ id: 'backed-1', backing_kind: 'backed', remaining_vclaw: 100 }],
      backingAtomic: { 'backed-1': 1_000_000n },
    });
    await reconcileUnaccountedEarnedLedger(h.tx as never, 'avatar-1');
    expect(h.lots[0]?.remaining_vclaw).toBe(50);
    expect(h.backing.get('backed-1')).toEqual({ remaining: 500_000n, released: 500_000n });
    expect(h.consumptions).toEqual([{ lotId: 'backed-1', ledgerId: 'spend-old', amount: 50 }]);
  });

  it('cannot hide a backed spend with an equal old unbacked mint', async () => {
    const h = harness({
      aggregate: 100,
      gap: [
        { id: 'mint-old', amount: 50, created: 1 },
        { id: 'spend-old', amount: -50, created: 2 },
      ],
      lots: [{ id: 'backed-1', backing_kind: 'backed', remaining_vclaw: 100 }],
      backingAtomic: { 'backed-1': 1_000_000n },
    });
    await reconcileUnaccountedEarnedLedger(h.tx as never, 'avatar-1');
    expect(h.lots).toEqual([
      { id: 'backed-1', backing_kind: 'backed', remaining_vclaw: 50 },
      { id: 'lot-mint-old', backing_kind: 'none', remaining_vclaw: 50 },
    ]);
    expect(h.backing.get('backed-1')).toEqual({ remaining: 500_000n, released: 500_000n });
    expect(h.accounted.get('spend-old')).toBe('spend');
    expect(h.accounted.get('mint-old')).toBe('mint');
  });
});
