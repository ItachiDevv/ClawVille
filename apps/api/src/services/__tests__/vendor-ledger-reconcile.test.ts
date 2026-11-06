import { describe, expect, it } from 'bun:test';
import { decideRow, type ChainReader } from '../vendor-ledger-reconcile';

const CREATED = '2026-11-05T06:00:00Z';
const createdSec = Date.parse(CREATED) / 1000;
const row = (over: Partial<Parameters<typeof decideRow>[1]> = {}) => ({
  id: 'r1', status: 'ambiguous' as const, payer_wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', payer_signature: 'OURSIG', created_at: CREATED, signed_at: '2026-11-05T06:00:02Z', reconcile_attempts: 0, ...over,
});

function chain(pages: Array<Array<{ signature: string; blockTime: number | null }>>, txs: Record<string, { signatures: string[]; failed: boolean }>): ChainReader & { reads: string[] } {
  let call = 0;
  const reads: string[] = [];
  return {
    reads,
    signaturesFor: async () => pages[call++] ?? [],
    transaction: async (sig) => {
      reads.push(sig);
      return txs[sig] ?? null;
    },
  };
}

describe('decideRow', () => {
  it('marks a row that was never sent as failed, and leaves an ambiguous row without a signature alone', async () => {
    expect(await decideRow(chain([], {}), row({ status: 'pending', payer_signature: null }))).toEqual({ id: 'r1', to: 'failed', reason: 'never_sent' });
    expect(await decideRow(chain([], {}), row({ payer_signature: null }))).toMatchObject({ to: 'unchanged' });
  });

  it('finds our signature in a landed transaction: paid, or failed on a chain error', async () => {
    const pages = [[{ signature: 'T1', blockTime: createdSec + 30 }, { signature: 'T2', blockTime: createdSec + 10 }]];
    expect(await decideRow(chain(pages, { T1: { signatures: ['FEE', 'OTHER'], failed: false }, T2: { signatures: ['FEE', 'OURSIG'], failed: false } }), row()))
      .toEqual({ id: 'r1', to: 'paid', tx: 'T2' });
    expect(await decideRow(chain(pages, { T1: { signatures: ['FEE', 'OTHER'], failed: false }, T2: { signatures: ['FEE', 'OURSIG'], failed: true } }), row()))
      .toEqual({ id: 'r1', to: 'failed', reason: 'landed_with_error', tx: 'T2' });
  });

  it('marks not_landed only once the scan reaches transactions older than the row, with every window transaction read', async () => {
    const reached = [[{ signature: 'T1', blockTime: createdSec + 5 }, { signature: 'OLD', blockTime: createdSec - 600 }]];
    expect(await decideRow(chain(reached, { T1: { signatures: ['FEE', 'OTHER'], failed: false } }), row()))
      .toEqual({ id: 'r1', to: 'failed', reason: 'not_landed' });
    const neverReached = Array.from({ length: 5 }, (_, i) => [{ signature: `N${i}`, blockTime: createdSec + 100 }]);
    expect(await decideRow(chain(neverReached, {}), row())).toEqual({ id: 'r1', to: 'unchanged', reason: 'scan_limit' });
  });

  it('never marks a row failed when the RPC cannot return a window transaction (it may hold our payment)', async () => {
    const pages = [[{ signature: 'T1', blockTime: createdSec + 5 }, { signature: 'OLD', blockTime: createdSec - 600 }]];
    expect(await decideRow(chain(pages, {}), row())).toEqual({ id: 'r1', to: 'unchanged', reason: 'chain_unavailable' });
  });

  it('never marks a row failed on an empty history page', async () => {
    expect(await decideRow(chain([[]], {}), row())).toEqual({ id: 'r1', to: 'unchanged', reason: 'history_incomplete' });
    const shortHistory = [[{ signature: 'T1', blockTime: createdSec + 5 }], []];
    expect(await decideRow(chain(shortHistory, { T1: { signatures: ['FEE', 'OTHER'], failed: false } }), row()))
      .toEqual({ id: 'r1', to: 'unchanged', reason: 'history_incomplete' });
  });

  it('a payment that lands late after a slow signing is still found (the window starts at signed_at)', async () => {
    const late = [[
      { signature: 'T1', blockTime: createdSec + 900 },
      { signature: 'OLD', blockTime: createdSec - 600 },
    ]];
    const signedLate = row({ signed_at: new Date((createdSec + 860) * 1000).toISOString() });
    expect(await decideRow(chain(late, { T1: { signatures: ['FEE', 'OURSIG'], failed: false } }), signedLate))
      .toEqual({ id: 'r1', to: 'paid', tx: 'T1' });
    // A row from before migration 0091 (no signed_at) reads every newer transaction.
    expect(await decideRow(chain(late, { T1: { signatures: ['FEE', 'OURSIG'], failed: false } }), row({ signed_at: null })))
      .toEqual({ id: 'r1', to: 'paid', tx: 'T1' });
  });

  it('reads only transactions inside the landing window', async () => {
    const busy = [[
      ...Array.from({ length: 50 }, (_, i) => ({ signature: `NEW${i}`, blockTime: createdSec + 3600 })),
      { signature: 'T1', blockTime: createdSec + 20 },
      { signature: 'OLD', blockTime: createdSec - 600 },
    ]];
    const reader = chain(busy, { T1: { signatures: ['FEE', 'OURSIG'], failed: false } });
    expect(await decideRow(reader, row())).toEqual({ id: 'r1', to: 'paid', tx: 'T1' });
    expect(reader.reads).toEqual(['T1']);
  });
});
