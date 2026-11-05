import { describe, expect, it } from 'bun:test';
import { decideRow, type ChainReader } from '../vendor-ledger-reconcile';

const CREATED = '2026-11-05T06:00:00Z';
const createdSec = Date.parse(CREATED) / 1000;
const row = (over: Partial<Parameters<typeof decideRow>[1]> = {}) => ({
  id: 'r1', status: 'ambiguous' as const, payer_wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', payer_signature: 'OURSIG', created_at: CREATED, ...over,
});

function chain(pages: Array<Array<{ signature: string; blockTime: number | null }>>, txs: Record<string, { signatures: string[]; failed: boolean }>): ChainReader {
  let call = 0;
  return {
    signaturesFor: async () => pages[call++] ?? [],
    transaction: async (sig) => txs[sig] ?? null,
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
    expect(await decideRow(chain(pages, { T2: { signatures: ['FEE', 'OURSIG'], failed: true } }), row()))
      .toEqual({ id: 'r1', to: 'failed', reason: 'landed_with_error', tx: 'T2' });
  });

  it('marks not_landed only once the scan reaches transactions older than the row', async () => {
    const reached = [[{ signature: 'T1', blockTime: createdSec + 5 }, { signature: 'OLD', blockTime: createdSec - 600 }]];
    expect(await decideRow(chain(reached, {}), row())).toEqual({ id: 'r1', to: 'failed', reason: 'not_landed' });
    const neverReached = Array.from({ length: 5 }, (_, i) => [{ signature: `N${i}`, blockTime: createdSec + 100 }]);
    expect(await decideRow(chain(neverReached, {}), row())).toEqual({ id: 'r1', to: 'unchanged', reason: 'scan_limit' });
  });
});
