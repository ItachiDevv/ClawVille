/**
 * PayAI exact-SVM payer-plumbing conformance locks.
 *
 * The golden vector exercises the real @x402/core + @x402/svm client path via
 * prepareCustodialExactPayment. A local JSON-RPC fixture supplies only mint
 * metadata and a recent blockhash; no facilitator or chain is contacted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import type { PaymentRequirements } from '@x402/core/types';
import { buildMockFacilitator } from '../x402-mock-facilitator';
import {
  SOLANA_DEVNET_CAIP2,
  USDC_MINT_DEVNET,
  settlePartnerPurchase,
  verifyAndSettle,
} from '../x402-payai';
import { prepareCustodialExactPayment } from '../custodial-x402';
import { payAgent, type AgentPayDeps } from '../agent-pay';

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(1));
const PAY_TO = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: SOLANA_DEVNET_CAIP2,
  amount: '125000',
  asset: USDC_MINT_DEVNET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { feePayer: FEE_PAYER, purpose: 'payai-conformance' },
};

const paymentHeader = (directive?: string) => Buffer.from(JSON.stringify({
  x402Version: 2,
  accepted: requirements,
  payload: {
    payer: PAYER.publicKey.toBase58(),
    ...(directive ? { __mock: directive } : {}),
  },
}), 'utf8').toString('base64');

function mintAccountData(): string {
  // SPL Mint layout: authority COption(36), supply u64(8), decimals u8,
  // initialized u8, freeze-authority COption(36) = 82 bytes.
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  return data.toString('base64');
}

interface GoldenWireFixture {
  x402Version: number;
  accepted: PaymentRequirements;
  payload: { transaction: string };
}

async function loadGoldenFixture(): Promise<GoldenWireFixture> {
  const raw = await Bun.file(new URL(
    './fixtures/x402-payai-exact-svm-wire.fixture.jsonc',
    import.meta.url,
  )).text();
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as GoldenWireFixture;
}

describe('PayAI exact-SVM golden wire vector', () => {
  let rpcServer: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    rpcServer = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as { id: number; method: string };
        if (body.method === 'getAccountInfo') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              context: { slot: 1 },
              value: {
                data: [mintAccountData(), 'base64'],
                executable: false,
                lamports: 1,
                owner: TOKEN_PROGRAM,
                rentEpoch: 0,
                space: 82,
              },
            },
          });
        }
        if (body.method === 'getLatestBlockhash') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              context: { slot: 1 },
              value: {
                blockhash: '11111111111111111111111111111111',
                lastValidBlockHeight: 100,
              },
            },
          });
        }
        return Response.json({
          jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' },
        });
      },
    });
  });

  afterAll(() => rpcServer.stop(true));

  it('matches the documented PayAI v2 accepted requirement shape', async () => {
    const prepared = await prepareCustodialExactPayment({
      payerSecretKey: PAYER.secretKey,
      payerPubkey: PAYER.publicKey.toBase58(),
      payTo: PAY_TO,
      amountBaseUnits: 125_000n,
      network: 'devnet',
      rpcUrl: `http://127.0.0.1:${rpcServer.port}`,
      feePayer: FEE_PAYER,
      resource: { url: 'https://api.clawville.world/payai-conformance' },
      purpose: 'payai-conformance',
    });
    const decoded = JSON.parse(
      Buffer.from(prepared.paymentHeader, 'base64').toString('utf8'),
    ) as {
      x402Version: number;
      accepted: PaymentRequirements;
      payload: { transaction?: unknown };
    };
    expect(typeof decoded.payload.transaction).toBe('string');
    expect((decoded.payload.transaction as string).length).toBeGreaterThan(0);
    expect({
      x402Version: decoded.x402Version,
      accepted: decoded.accepted,
      payload: { transaction: '<base64-partially-signed-svm-transaction>' },
    }).toEqual(await loadGoldenFixture());
  });
});

describe('PayAI verify-to-settle sequencing against the in-repo mock facilitator', () => {
  let facilitatorServer: ReturnType<typeof Bun.serve>;
  let requestPaths: string[] = [];
  const priorEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    const mock = buildMockFacilitator({ log: false });
    facilitatorServer = Bun.serve({
      port: 0,
      fetch(request) {
        requestPaths.push(new URL(request.url).pathname);
        return mock.fetch(request);
      },
    });
    for (const [key, value] of Object.entries({
      X402_ENABLED: 'true',
      CLAWVILLE_MERCHANT_WALLET_PUBKEY: PAY_TO,
      X402_FACILITATOR_URL: `http://127.0.0.1:${facilitatorServer.port}`,
    })) {
      priorEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  beforeEach(() => {
    requestPaths = [];
  });

  afterAll(() => {
    facilitatorServer.stop(true);
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const directive of ['verify-error-400', 'verify-error'] as const) {
    it(`maps ${directive} to settled:false without throwing or settling`, async () => {
      const result = await verifyAndSettle({
        paymentHeader: paymentHeader(directive),
        requirements,
      });
      expect(result).toMatchObject({
        settled: false,
        isValid: false,
        txSignature: null,
        failureReason: 'facilitator_verify_error',
      });
      expect(requestPaths).toEqual(['/verify']);
    });
  }

  it('gates settle when verify returns isValid:false', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('verify-invalid'),
      requirements,
    });
    expect(result).toMatchObject({ settled: false, isValid: false });
    expect(requestPaths).toEqual(['/verify']);
  });

  for (const directive of ['settle-error-400', 'settle-error'] as const) {
    it(`maps ${directive} to settled:false after a passing verify`, async () => {
      const result = await verifyAndSettle({
        paymentHeader: paymentHeader(directive),
        requirements,
      });
      expect(result).toMatchObject({
        settled: false,
        isValid: true,
        txSignature: null,
        failureReason: 'facilitator_settle_error',
      });
      expect(result.noBroadcast).toBeUndefined();
      expect(requestPaths).toEqual(['/verify', '/settle']);
    });
  }

  it('marks the allowlisted free_tier_exhausted rejection as no-broadcast', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('settle-rejected-structured'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'facilitator_settle_error',
      noBroadcast: true,
    });
    expect(requestPaths).toEqual(['/verify', '/settle']);
  });

  it('matches an allowlisted typed rejection through its message when errorReason is absent', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('settle-rejected-free-tier-message'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'facilitator_settle_error',
      noBroadcast: true,
    });
    expect(requestPaths).toEqual(['/verify', '/settle']);
  });

  for (const directive of [
    'settle-rejected-unknown',
    'settle-rejected-suffixed',
    'settle-rejected-no-reason',
  ] as const) {
    it(`keeps a signature-less typed ${directive} rejection ambiguous`, async () => {
      const result = await verifyAndSettle({
        paymentHeader: paymentHeader(directive),
        requirements,
      });
      expect(result).toMatchObject({
        settled: false,
        isValid: true,
        txSignature: null,
        failureReason: 'facilitator_settle_error',
      });
      expect(result.noBroadcast).toBeUndefined();
      expect(requestPaths).toEqual(['/verify', '/settle']);
    });
  }

  it('keeps a signature-less success:false response with an unknown reason ambiguous', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('settle-fail'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'mock_forced_settlement_failure',
    });
    expect(result.noBroadcast).toBeUndefined();
    expect(requestPaths).toEqual(['/verify', '/settle']);
  });

  it('does not trust allowlist text from a generic post-settle HTTP error', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('settle-error-free-tier-message'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'facilitator_settle_error',
    });
    expect(result.noBroadcast).toBeUndefined();
    expect(requestPaths).toEqual(['/verify', '/settle']);
  });

  it('keeps a signature-bearing settle rejection ambiguous', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('settle-rejected-with-signature'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: 'MockObservedSignature111111111111111111111111111111111111111111',
      failureReason: 'facilitator_settle_error',
    });
    expect(result.noBroadcast).toBeUndefined();
    expect(requestPaths).toEqual(['/verify', '/settle']);
  });

  it('treats success:true with an empty transaction signature as unsettled', async () => {
    const result = await verifyAndSettle({
      paymentHeader: paymentHeader('settle-empty-signature'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'settlement_failed',
    });
    expect(result.raw.settle?.success).toBe(true);
    expect(result.noBroadcast).toBeUndefined();
    expect(requestPaths).toEqual(['/verify', '/settle']);
  });

  it('forwards partner verifyOnly:true and never reaches settle', async () => {
    const result = await settlePartnerPurchase({
      paymentHeader: paymentHeader(),
      requirements,
      expectedPayoutPubkey: PAY_TO,
      verifyOnly: true,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'verify_only_mode',
    });
    expect(requestPaths).toEqual(['/verify']);
  });
});

describe('agent-pay policy seam', () => {
  it('refuses an above-cap payment before the signer-preparation seam is reached', async () => {
    let signerConstructionAttempts = 0;
    const prepare: NonNullable<AgentPayDeps['prepare']> = async () => {
      signerConstructionAttempts += 1;
      throw new Error('signer construction must not be reached');
    };
    const priorCap = process.env.AGENT_PAY_MAX_USD_CENTS;
    process.env.AGENT_PAY_MAX_USD_CENTS = '1000';
    try {
      const result = await payAgent({
        senderAvatarId: 'sender-avatar',
        recipient: { kind: 'avatar', avatarId: 'recipient-avatar' },
        usdCents: 1001,
        idempotencyKey: 'payai-cap-before-signer',
      }, { prepare });
      expect(result).toEqual({ ok: false, code: 'amount_above_max' });
      expect(signerConstructionAttempts).toBe(0);
    } finally {
      if (priorCap === undefined) delete process.env.AGENT_PAY_MAX_USD_CENTS;
      else process.env.AGENT_PAY_MAX_USD_CENTS = priorCap;
    }
  });
});
