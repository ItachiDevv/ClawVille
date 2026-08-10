import { describe, expect, it, spyOn } from 'bun:test';
import { Connection, SendTransactionError } from '@solana/web3.js';
import {
  classifyChainError,
  classifyConfirmedTransactionFailure,
  classifySignedSendError,
  sendPreparedSapTransaction,
} from '../sap-client';

describe('classifyChainError SendTransactionError diagnostics', () => {
  it('maps Anchor EscrowExpired 6076 to the typed escrow_expired code', () => {
    expect(
      classifyChainError(
        'settleCallsV2Usdc',
        new Error('Transaction simulation failed: custom program error: 0x17bc'),
      ),
    ).toMatchObject({ ok: false, code: 'escrow_expired' });
  });
  it('marks a confirmed Custom(6076) revert as landed and preserves escrow_expired', () => {
    const confirmed = {
      value: { err: { InstructionError: [0, { Custom: 6076 }] } },
    };
    expect(
      classifyConfirmedTransactionFailure(
        'settleCallsV2Usdc',
        confirmed.value.err,
        'confirmed-revert-signature',
      ),
    ).toMatchObject({
      ok: false,
      code: 'escrow_expired',
      broadcast: true,
      landed: 'confirmed_reverted',
      signature: 'confirmed-revert-signature',
    });
  });
  it('includes the transaction message and the last five logs', () => {
    const error = Object.assign(
      new Error(
        'Simulation failed. Catch the `SendTransactionError` and call `getLogs()` on it.',
      ),
      {
        transactionMessage:
          'Transaction results in an account (1) with insufficient funds for rent',
        logs: [
          'discarded old log',
          'Program log: instruction complete',
          'Program consumed 1000 compute units',
          'Program returned success',
          'Program log: post-execution rent check',
          'Runtime error: InsufficientFundsForRent',
        ],
      },
    );

    const result = classifyChainError('settleCallsV2Usdc', error);

    expect(result.code).toBe('on_chain_error');
    expect(result.message).toContain('insufficient funds for rent');
    expect(result.message).toContain('Runtime error: InsufficientFundsForRent');
    expect(result.message).not.toContain('discarded old log');
    expect(result.message.length).toBeLessThanOrEqual(600);
  });

  it('B1 — a post-sign send throw is ambiguous and retains the local signature', () => {
    expect(
      classifySignedSendError(
        'settleCallsV2Usdc',
        new Error('socket closed after upstream accepted the signed bytes'),
        'locally-derived-signature',
      ),
    ).toMatchObject({
      ok: false,
      broadcast: true,
      landed: 'unknown',
      signature: 'locally-derived-signature',
    });
  });


  it('B1 — an explicit simulation/preflight rejection remains non-broadcast', () => {
    const failure = classifySignedSendError(
      'settleCallsV2Usdc',
      new SendTransactionError({
        action: 'simulate',
        signature: 'preflight-signature',
        transactionMessage: 'custom program error: 0x17bc',
        logs: ['Program rejected in simulation'],
      }),
      'locally-derived-signature',
    );
    expect(failure.broadcast).toBeUndefined();
    expect(failure.signature).toBeUndefined();
  });
});
