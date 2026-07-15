import { describe, expect, it } from 'bun:test';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import {
  assertMeteredAgentPaywallSafe,
  assertProductionFacilitatorAllowed,
} from '../x402-config';
import { receiptMatchesOwner } from '../x402-settlement-receipts';
import {
  independentUnavailableAfterPayerDecode,
  signedPayloadMessageMatchesChain,
} from '../x402-payai';

describe('production facilitator origin guard', () => {
  it('allows only the exact production origins over credential-free HTTPS', () => {
    expect(() => assertProductionFacilitatorAllowed(
      'https://facilitator.payai.network', 'production',
    )).not.toThrow();
    expect(() => assertProductionFacilitatorAllowed(
      'https://api.cdp.coinbase.com/platform/v2/x402', 'production',
    )).not.toThrow();
    for (const url of [
      'http://facilitator.payai.network',
      'https://facilitator.payai.network.evil.example',
      'https://user:pass@facilitator.payai.network',
      'https://127.0.0.1',
      'https://10.0.0.1',
    ]) {
      expect(() => assertProductionFacilitatorAllowed(url, 'production')).toThrow();
    }
  });

  it('does not constrain staging or local test facilitators', () => {
    expect(() => assertProductionFacilitatorAllowed('http://127.0.0.1:4000/mock', 'staging')).not.toThrow();
    expect(() => assertProductionFacilitatorAllowed('http://localhost:4000/mock', undefined)).not.toThrow();
  });
});

describe('metered-agent cross-rail replay gate', () => {
  it('refuses X402_ENABLED until metered settlements join the durable receipt registry', () => {
    expect(() => assertMeteredAgentPaywallSafe(true)).toThrow(
      /FEATURE_GATE metered_agent_receipt_registry/,
    );
    expect(() => assertMeteredAgentPaywallSafe(false)).not.toThrow();
  });
});

describe('global receipt owner identity', () => {
  const input = {
    txSignature: 'signature',
    rail: 'ct_topup' as const,
    kind: 'topup',
    referenceId: 'topup-1',
    subjectId: '00000000-0000-4000-8000-000000000001',
    amountUsdcAtomic: 1_000_000n,
  };
  const receipt = { ...input, createdAt: new Date('2026-07-15T00:00:00Z') };

  it('resumes only the exact same immutable owner', () => {
    expect(receiptMatchesOwner(receipt, input)).toBe(true);
    expect(receiptMatchesOwner(receipt, { ...input, kind: 'other' })).toBe(false);
    expect(receiptMatchesOwner(receipt, { ...input, referenceId: 'topup-2' })).toBe(false);
    expect(receiptMatchesOwner(receipt, { ...input, subjectId: '00000000-0000-4000-8000-000000000002' })).toBe(false);
    expect(receiptMatchesOwner(receipt, { ...input, amountUsdcAtomic: 2_000_000n })).toBe(false);
  });
});

describe('post-decode RPC setup failure', () => {
  it('retains the signed payer and refuses unbound capture when no payer was decoded', () => {
    const payer = 'SignedPayloadPayer111111111111111111111111111';
    expect(independentUnavailableAfterPayerDecode(payer)).toEqual({
      ok: false,
      reason: 'independent_chain_unavailable',
      payer,
    });
    expect(independentUnavailableAfterPayerDecode(null)).toEqual({
      ok: false,
      reason: 'independent_chain_mismatch',
      payer: null,
    });
  });
});

describe('independent settlement transaction binding', () => {
  it('accepts the submitted message and rejects an older matching-payer transaction', () => {
    const payer = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const buildTransaction = (recentBlockhash: string) => {
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash });
      tx.add(SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: 1,
      }));
      tx.sign(payer);
      return tx;
    };
    const submitted = buildTransaction(Keypair.generate().publicKey.toBase58());
    const older = buildTransaction(Keypair.generate().publicKey.toBase58());
    const payload = {
      x402Version: 2,
      accepted: {} as never,
      payload: { transaction: submitted.serialize().toString('base64') },
    } as Parameters<typeof signedPayloadMessageMatchesChain>[0];

    expect(signedPayloadMessageMatchesChain(payload, submitted.serializeMessage())).toBe(true);
    expect(signedPayloadMessageMatchesChain(payload, older.serializeMessage())).toBe(false);
  });
});
