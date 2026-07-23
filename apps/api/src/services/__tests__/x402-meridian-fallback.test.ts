import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import type { PaymentRequirements } from '@x402/core/types';
import {
  executePreparedExactPayment,
  type PreparedCustodialExactPayment,
} from '../custodial-x402';
import { buildMockFacilitator } from '../x402-mock-facilitator';
import { buildMockMeridian } from '../x402-mock-meridian';
import {
  SOLANA_DEVNET_CAIP2,
  USDC_MINT_DEVNET,
} from '../x402-payai';
import type { PreparedMeridianPayment } from '../x402-meridian';
import { calculateMeridianSettlementAmounts } from '../x402-settlement-accounting';

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(21));
const PAY_TO = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey.toBase58();
const FEE_PAYER = Keypair.fromSeed(
  new Uint8Array(32).fill(23),
).publicKey.toBase58();
const payAiRequirements: PaymentRequirements = {
  scheme: 'exact',
  network: SOLANA_DEVNET_CAIP2,
  amount: '20000',
  asset: USDC_MINT_DEVNET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { feePayer: FEE_PAYER },
};

function payAiHeader(directive: 'verify-error' | 'verify-invalid'): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: payAiRequirements,
      payload: { payer: PAYER.publicKey.toBase58(), __mock: directive },
    }),
    'utf8',
  ).toString('base64');
}

function prepared(
  directive: 'verify-error' | 'verify-invalid',
): PreparedCustodialExactPayment {
  const meridianRequirements = {
    scheme: 'exact',
    network: 'solana-devnet',
    asset: USDC_MINT_DEVNET,
    payTo: PAY_TO,
    maxAmountRequired: '20000',
    resource: 'clawville://meridian-fallback-test',
    description: 'Meridian fallback test',
    mimeType: 'application/json',
    maxTimeoutSeconds: 120,
    extra: {
      name: 'USDC',
      decimals: 6,
      feePayer: FEE_PAYER,
      creditedRecipient: PAY_TO,
      platformFeeBps: 0,
    },
  } as const;
  const paymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'solana-devnet',
    payload: {
      transaction: 'fallback-test-transaction',
      payer: PAYER.publicKey.toBase58(),
    },
  };
  const meridian = {
    paymentHeader: Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString(
      'base64',
    ),
    paymentPayload,
    requirements: meridianRequirements,
    payerPubkey: PAYER.publicKey.toBase58(),
    network: 'devnet',
    amounts: calculateMeridianSettlementAmounts(20_000n, 0),
  } as unknown as PreparedMeridianPayment;
  return {
    paymentHeader: payAiHeader(directive),
    requirements: payAiRequirements,
    payerPubkey: PAYER.publicKey.toBase58(),
    feePayer: FEE_PAYER,
    network: 'devnet',
    meridian,
  };
}

describe('PayAI-primary Meridian fallback execution seam', () => {
  let payAiServer: ReturnType<typeof Bun.serve>;
  let meridianServer: ReturnType<typeof Bun.serve>;
  let payAiPaths: string[] = [];
  let meridianPaths: string[] = [];
  const priorEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    const payAi = buildMockFacilitator({ log: false });
    payAiServer = Bun.serve({
      port: 0,
      fetch(request) {
        payAiPaths.push(new URL(request.url).pathname);
        return payAi.fetch(request);
      },
    });
    const meridian = buildMockMeridian({ log: false });
    meridianServer = Bun.serve({
      port: 0,
      fetch(request) {
        meridianPaths.push(new URL(request.url).pathname);
        return meridian.fetch(request);
      },
    });
    for (const [key, value] of Object.entries({
      X402_ENABLED: 'true',
      CLAWVILLE_MERCHANT_WALLET_PUBKEY: PAY_TO,
      X402_FACILITATOR_URL: `http://127.0.0.1:${payAiServer.port}`,
      MERIDIAN_FACILITATOR_URL: `http://127.0.0.1:${meridianServer.port}`,
      MERIDIAN_API_KEY: 'test-only-meridian-key',
      MERIDIAN_PLATFORM_FEE_BPS: '0',
    })) {
      priorEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  beforeEach(() => {
    payAiPaths = [];
    meridianPaths = [];
  });

  afterAll(() => {
    payAiServer.stop(true);
    meridianServer.stop(true);
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses Meridian after a PayAI verify HTTP 500', async () => {
    const result = await executePreparedExactPayment(prepared('verify-error'));
    expect(result).toMatchObject({
      kind: 'meridian_settled',
      payAi: { attempted: true, providerFailure: true },
    });
    if (result.kind === 'meridian_settled') {
      expect(result.signature.length).toBeGreaterThan(0);
    }
    expect(payAiPaths).toEqual(['/verify']);
    expect(meridianPaths).toEqual(['/v1/verify', '/v1/settle']);
  });

  it('does not fall back after PayAI rejects an invalid payment', async () => {
    const result = await executePreparedExactPayment(prepared('verify-invalid'));
    expect(result).toMatchObject({
      kind: 'definitive_failure',
      stage: 'verify',
    });
    expect(payAiPaths).toEqual(['/verify']);
    expect(meridianPaths).toEqual([]);
  });

  it('skips PayAI entirely for a direct Meridian settlement', async () => {
    const result = await executePreparedExactPayment(
      prepared('verify-error'),
      { skipPayAi: true },
    );
    expect(result).toMatchObject({
      kind: 'meridian_settled',
      payAi: { attempted: false, providerFailure: false },
    });
    expect(payAiPaths).toEqual([]);
    expect(meridianPaths).toEqual(['/v1/verify', '/v1/settle']);
  });

  it('direct Meridian verify-only is non-ambiguous and never settles', async () => {
    const result = await executePreparedExactPayment(
      prepared('verify-error'),
      { skipPayAi: true, verifyOnly: true },
    );
    expect(result).toMatchObject({
      kind: 'verify_only',
      payAi: { attempted: false, providerFailure: false },
    });
    expect(payAiPaths).toEqual([]);
    expect(meridianPaths).toEqual(['/v1/verify']);
  });
});
