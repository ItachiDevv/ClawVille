import { describe, expect, it } from 'bun:test';
import { classifyChainError } from '../sap-client';

describe('classifyChainError SendTransactionError diagnostics', () => {
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
});
