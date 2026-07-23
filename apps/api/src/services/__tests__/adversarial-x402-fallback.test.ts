import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { Keypair, Transaction } from '@solana/web3.js';
import type { PaymentRequirements } from '@x402/core/types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  executePreparedExactPayment,
  type PreparedCustodialExactPayment,
} from '../custodial-x402';
import { buildMockMeridian } from '../x402-mock-meridian';
import {
  prepareMeridianPayment,
  type MeridianSolanaFacilitatorConfig,
  type PreparedMeridianPayment,
} from '../x402-meridian';
import {
  SOLANA_DEVNET_CAIP2,
  USDC_MINT_DEVNET,
} from '../x402-payai';
import { calculateMeridianSettlementAmounts } from '../x402-settlement-accounting';
import {
  acquirePayAiCircuitPermit,
  readPayAiCircuitState,
  recordPayAiCircuitFailure,
  releasePayAiCircuitPermitWithoutObservation,
  resetPayAiFacilitatorCircuitForTests,
} from '../x402-facilitator-circuit';

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(31));
const PAY_TO = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey.toBase58();
const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(33)).publicKey.toBase58();

type PayAiDirective =
  | 'generic-503'
  | 'structured-503'
  | 'free-tier-thrown'
  | 'free-tier-returned'
  | 'payment-invalid';

function requirements(amount: bigint): PaymentRequirements {
  return {
    scheme: 'exact',
    network: SOLANA_DEVNET_CAIP2,
    amount: amount.toString(),
    asset: USDC_MINT_DEVNET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { feePayer: FEE_PAYER },
  };
}

function paymentHeader(amount: bigint, directive: PayAiDirective): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: requirements(amount),
    payload: {
      payer: PAYER.publicKey.toBase58(),
      __adversarial: directive,
      headerId: `${directive}:${amount}`,
    },
  }), 'utf8').toString('base64');
}

function meridianPayment(amount: bigint): PreparedMeridianPayment {
  const meridianRequirements = {
    scheme: 'exact',
    network: 'solana-devnet',
    asset: USDC_MINT_DEVNET,
    payTo: PAY_TO,
    maxAmountRequired: amount.toString(),
    resource: `clawville://adversarial-fallback/${amount}`,
    description: `Adversarial fallback ${amount}`,
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
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'solana-devnet',
    payload: {
      transaction: `adversarial-meridian-${amount}`,
      payer: PAYER.publicKey.toBase58(),
    },
  } as const;
  return {
    paymentHeader: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    paymentPayload: payload,
    requirements: meridianRequirements,
    payerPubkey: PAYER.publicKey.toBase58(),
    network: 'devnet',
    amounts: calculateMeridianSettlementAmounts(amount, 0),
  } as unknown as PreparedMeridianPayment;
}

function prepared(
  amount: bigint,
  directive: PayAiDirective,
  includeMeridian = true,
): PreparedCustodialExactPayment {
  return {
    ...(includeMeridian ? { meridian: meridianPayment(amount) } : {}),
    paymentHeader: paymentHeader(amount, directive),
    requirements: requirements(amount),
    payerPubkey: PAYER.publicKey.toBase58(),
    feePayer: FEE_PAYER,
    network: 'devnet',
  };
}

describe('adversarial x402 inbound fallback matrix', () => {
  let payAiServer: ReturnType<typeof Bun.serve>;
  let meridianServer: ReturnType<typeof Bun.serve>;
  let payAiPaths: string[] = [];
  let meridianPaths: string[] = [];
  const priorEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    payAiServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        payAiPaths.push(path);
        if (path !== '/verify') return new Response('unexpected', { status: 500 });
        const body = await request.json() as {
          paymentPayload?: { payload?: { __adversarial?: PayAiDirective } };
        };
        switch (body.paymentPayload?.payload?.__adversarial) {
          case 'generic-503':
            return Response.json({ error: 'upstream_unavailable' }, { status: 503 });
          case 'structured-503':
            return Response.json({
              isValid: false,
              invalidReason: 'upstream_unavailable',
              invalidMessage: 'structured provider outage',
            }, { status: 503 });
          case 'free-tier-thrown':
            return Response.json({
              isValid: false,
              invalidReason: 'free_tier_exhausted',
              invalidMessage: 'monthly settlement quota exhausted',
            }, { status: 402 });
          case 'free-tier-returned':
            return Response.json({
              isValid: false,
              invalidReason: 'free_tier_exhausted',
              invalidMessage: 'monthly settlement quota exhausted',
            });
          case 'payment-invalid':
            return Response.json({
              isValid: false,
              invalidReason: 'invalid_signature',
              invalidMessage: 'payment-specific rejection',
            });
          default:
            return Response.json({ error: 'missing directive' }, { status: 500 });
        }
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
      MERIDIAN_API_KEY: 'adversarial-only-key',
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

  for (const directive of [
    'generic-503',
    'structured-503',
    'free-tier-thrown',
    'free-tier-returned',
  ] as const) {
    it(`F1/F2 ${directive} falls back once and preserves PayAI failure observation`, async () => {
      const result = await executePreparedExactPayment(
        prepared(99_999n, directive),
      );

      expect(result).toMatchObject({
        kind: 'meridian_settled',
        payAi: { attempted: true, providerFailure: true },
      });
      expect(payAiPaths).toEqual(['/verify']);
      expect(meridianPaths).toEqual(['/v1/verify', '/v1/settle']);
      expect(payAiPaths.filter((path) => path === '/settle')).toHaveLength(0);
    });
  }

  it('payment-invalid cannot fall through to Meridian', async () => {
    const result = await executePreparedExactPayment(
      prepared(99_999n, 'payment-invalid'),
    );

    expect(result).toMatchObject({
      kind: 'definitive_failure',
      payAi: { attempted: true, providerFailure: false },
    });
    expect(payAiPaths).toEqual(['/verify']);
    expect(meridianPaths).toEqual([]);
  });

  it('verifyOnly never invokes either settle endpoint after a PayAI outage', async () => {
    const result = await executePreparedExactPayment(
      prepared(99_999n, 'generic-503'),
      { verifyOnly: true },
    );

    expect(result.kind).toBe('definitive_failure');
    expect(payAiPaths).toEqual(['/verify']);
    expect(meridianPaths).toEqual([]);
  });

  it('F3 skipPayAi goes directly to Meridian without a PayAI observation', async () => {
    const priorThreshold = process.env.AGENT_PAY_BREAKER_THRESHOLD;
    try {
      resetPayAiFacilitatorCircuitForTests();
      process.env.AGENT_PAY_BREAKER_THRESHOLD = '1';
      const permit = acquirePayAiCircuitPermit(0);
      recordPayAiCircuitFailure(permit!, 0, async () => {});
      const circuitBefore = readPayAiCircuitState();

      const result = await executePreparedExactPayment(
        prepared(99_999n, 'generic-503'),
        { skipPayAi: true },
      );

      expect(result).toMatchObject({
        kind: 'meridian_settled',
        payAi: { attempted: false, providerFailure: false },
      });
      expect(payAiPaths).toEqual([]);
      expect(meridianPaths).toEqual(['/v1/verify', '/v1/settle']);
      expect(readPayAiCircuitState()).toEqual(circuitBefore);
    } finally {
      resetPayAiFacilitatorCircuitForTests();
      if (priorThreshold === undefined) delete process.env.AGENT_PAY_BREAKER_THRESHOLD;
      else process.env.AGENT_PAY_BREAKER_THRESHOLD = priorThreshold;
    }
  });

  it('the outbound preparation function contains no Meridian candidate builder', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../custodial-x402.ts', import.meta.url)),
      'utf8',
    );
    const outboundBody = source.match(
      /export async function prepareCustodialExactPayment\([\s\S]*?\n\}/,
    )?.[0];
    expect(outboundBody).toBeDefined();
    expect(outboundBody).not.toContain('prepareMeridianPayment');
    expect(outboundBody).not.toContain('meridian =');
    expect(outboundBody).toContain('organization-pinned');
  });
});

describe('shared PayAI circuit', () => {
  const priorThreshold = process.env.AGENT_PAY_BREAKER_THRESHOLD;
  const priorCooldown = process.env.AGENT_PAY_BREAKER_COOLDOWN_MS;

  beforeEach(() => {
    resetPayAiFacilitatorCircuitForTests();
    process.env.AGENT_PAY_BREAKER_THRESHOLD = '1';
    process.env.AGENT_PAY_BREAKER_COOLDOWN_MS = '10000';
  });

  afterAll(() => {
    resetPayAiFacilitatorCircuitForTests();
    if (priorThreshold === undefined) delete process.env.AGENT_PAY_BREAKER_THRESHOLD;
    else process.env.AGENT_PAY_BREAKER_THRESHOLD = priorThreshold;
    if (priorCooldown === undefined) delete process.env.AGENT_PAY_BREAKER_COOLDOWN_MS;
    else process.env.AGENT_PAY_BREAKER_COOLDOWN_MS = priorCooldown;
  });

  it('F4 an unobserved half-open probe restarts the cooldown', () => {
    const initial = acquirePayAiCircuitPermit(0);
    expect(initial).not.toBeNull();
    recordPayAiCircuitFailure(initial!, 0, async () => {});

    const probe = acquirePayAiCircuitPermit(10_000);
    expect(probe?.probe).toBe(true);
    releasePayAiCircuitPermitWithoutObservation(probe!, 10_000);

    expect(readPayAiCircuitState()).toMatchObject({
      phase: 'open',
      openedAtMs: 10_000,
    });
    expect(acquirePayAiCircuitPermit(10_000)).toBeNull();
    expect(acquirePayAiCircuitPermit(19_999)).toBeNull();
    expect(acquirePayAiCircuitPermit(20_000)?.probe).toBe(true);
  });
});

interface MeridianFixture {
  facilitatorConfig: MeridianSolanaFacilitatorConfig;
}

async function loadMeridianFixture(): Promise<MeridianFixture> {
  const raw = await Bun.file(new URL(
    './fixtures/x402-meridian-solana.fixture.jsonc',
    import.meta.url,
  )).text();
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as MeridianFixture;
}

describe('F7 live-proven Meridian wire facts', () => {
  it('always emits description and a payer-partially-signed legacy transaction', async () => {
    const fixture = await loadMeridianFixture();
    const preparedPayment = await prepareMeridianPayment({
      payerSecretKey: PAYER.secretKey,
      payerPubkey: PAYER.publicKey.toBase58(),
      payTo: PAY_TO,
      grossAmountBaseUnits: 125_000n,
      network: 'devnet',
      resource: {
        url: 'https://api.clawville.world/adversarial-meridian-wire',
      },
      platformFeeBps: 0,
      facilitatorConfig: fixture.facilitatorConfig,
      recentBlockhash: '11111111111111111111111111111111',
      nowUnixSeconds: 1_700_000_000,
      nonce: new Uint8Array(32).fill(7),
    });

    expect(preparedPayment.requirements.description.length).toBeGreaterThan(0);
    const transaction = Transaction.from(Buffer.from(
      preparedPayment.paymentPayload.payload.transaction,
      'base64',
    ));
    expect(transaction.feePayer?.toBase58()).toBe(
      fixture.facilitatorConfig.facilitator,
    );
    expect(transaction.signatures.find(
      ({ publicKey }) => publicKey.equals(PAYER.publicKey),
    )?.signature).not.toBeNull();
  });
});
