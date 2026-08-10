// B1 REAL-SENDER wiring proof — MUST run BEFORE any suite that calls
// mock.module('../sap-client', ...) (escrow-v2-gate.test.ts does): Bun module
// mocks leak across files within one test process, and this test needs the
// REAL sendPreparedSapTransaction. The `a0-` prefix makes it sort (and run)
// first in directory runs; it also passes standalone.
import { describe, it, expect, spyOn } from 'bun:test';
import { Connection } from '@solana/web3.js';

// Prime the SAP env BEFORE the real module loads: sap-client caches its config
// on first use, and this file runs first — a 'disabled' cache here would leak
// into every later suite that relies on an enabled devnet config.
process.env.SAP_ENABLED = 'true';
process.env.SAP_ESCROW_ENABLED = 'true';
process.env.SAP_USDC_ESCROW_ENABLED = 'true';
process.env.SAP_PAYAI_SETTLEMENT_ENABLED = 'true';
process.env.SAP_DRY_RUN = 'true';
process.env.SAP_CLUSTER = 'devnet';

import { sendPreparedSapTransaction } from '../sap-client';

describe('sendPreparedSapTransaction (real module)', () => {
  it('B1 — the real captured-byte sender quarantines every non-preflight send exception', async () => {
    const genesis = spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(
      'devnet-genesis-for-test',
    );
    const send = spyOn(Connection.prototype, 'sendRawTransaction').mockRejectedValue(
      new Error('upstream accepted bytes then returned a non-RPC-classified proxy error'),
    );
    try {
      const failure = await sendPreparedSapTransaction('withdrawEscrowV2Usdc', {
        signature: 'captured-local-signature',
        serializedTransaction: Buffer.from('captured-bytes').toString('base64'),
        blockhash: 'captured-blockhash',
        lastValidBlockHeight: 123,
        accounts: { escrow: 'captured-escrow' },
      });
      expect(failure).toMatchObject({
        ok: false,
        broadcast: true,
        landed: 'unknown',
        signature: 'captured-local-signature',
      });
    } finally {
      send.mockRestore();
      genesis.mockRestore();
    }
  });
});
