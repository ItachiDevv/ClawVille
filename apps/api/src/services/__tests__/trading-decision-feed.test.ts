import { describe, expect, test } from 'bun:test';
import { buildTradeDecisionFrame } from '../trading-decision-feed';

describe('Trading Floor decision feed redaction', () => {
  test('publishes only the agent subject, bounded trade facts, and refusal code', () => {
    const sentinel = 'PRIVATE FREE TEXT SENTINEL';
    const frame = buildTradeDecisionFrame({
      row: {
        id: '11111111-1111-4111-8111-111111111111',
        avatarId: '22222222-2222-4222-8222-222222222222',
        origin: 'agent-tool',
        inputMint: 'input-mint',
        outputMint: 'output-mint',
        amountUsdMicros: '1250000',
        amountAtomic: '999999999',
        slippageBps: 150,
        verdict: 'armed_false',
        status: 'refused',
        reason: sentinel,
        detail: `${sentinel} detail`,
        signature: 'signature-sentinel',
        signedTxBytes: Buffer.from('secret-sentinel'),
        recentBlockhash: 'blockhash-sentinel',
        lastValidBlockHeight: 123,
        buildHash: 'hash-sentinel',
        localConfirmOutcome: null,
        localConfirmSlot: null,
        localConfirmedAt: null,
        directiveId: null,
        directiveOrdinal: null,
        operatorId: null,
        createdAt: new Date('2026-09-16T00:00:00.000Z'),
        settledAt: new Date('2026-09-16T00:00:01.000Z'),
      },
      agentId: 'agent-subject-id',
      avatarName: 'Fleet Agent',
      operatedByClawville: true,
    });

    expect(frame.subject.id).toBe('agent-subject-id');
    expect(frame.reason).toBe('armed_false');
    const wire = JSON.stringify(frame);
    for (const forbidden of [
      sentinel,
      'signature-sentinel',
      'secret-sentinel',
      '999999999',
      'blockhash-sentinel',
      'hash-sentinel',
      'amountAtomic',
      'walletPubkey',
      'wallet_pubkey',
      'signature',
      'quote',
      'equity',
      'float',
    ]) expect(wire).not.toContain(forbidden);
  });

  test('never exposes unknown verdict text as a refusal reason', () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      avatarId: '22222222-2222-4222-8222-222222222222',
      inputMint: 'input',
      outputMint: 'output',
      amountUsdMicros: '1000000',
      verdict: 'private verdict text',
      status: 'refused',
      createdAt: new Date('2026-09-16T00:00:00.000Z'),
      settledAt: null,
    } as never;
    expect(buildTradeDecisionFrame({ row, agentId: null, avatarName: null, operatedByClawville: false }).reason).toBeNull();
  });
});
