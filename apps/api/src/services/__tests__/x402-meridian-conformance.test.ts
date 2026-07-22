/** Meridian v1/Solana program conformance locks from the 2026-07-22 capture. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import {
  MERIDIAN_PROGRAM_ID,
  buildMeridianTransferInstruction,
  deriveAssociatedTokenAddress,
  deriveMeridianPlatformTokenAccount,
  loadMeridianConfig,
  prepareMeridianPayment,
  verifyAndSettle,
  type MeridianPaymentRequirements,
  type MeridianSolanaFacilitatorConfig,
} from '../x402-meridian';
import { buildMockMeridian } from '../x402-mock-meridian';

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(1));
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const PLATFORM_OWNER = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const PLATFORM_TOKEN = 'H67ehh1Uj7wv9LfZvdXpZqPDRJt7hR9TNHTZKtLdR57L';

interface Fixture {
  facilitatorConfig: MeridianSolanaFacilitatorConfig;
  instruction: {
    dataLength: number;
    discriminator: number[];
    grossAmount: string;
    validAfter: string;
    validBefore: string;
    platformFeeBps: number;
    platformFeeAmount: string;
    treasuryFeeAmount: string;
    netAmount: string;
    accountRoles: string[];
  };
}

async function loadFixture(): Promise<Fixture> {
  const raw = await Bun.file(new URL(
    './fixtures/x402-meridian-solana.fixture.jsonc',
    import.meta.url,
  )).text();
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as Fixture;
}

describe('Meridian transfer_with_authorization capture fixture', () => {
  it('locks discriminator, 66-byte layout, accounts, and sequential fee split', async () => {
    const fixture = await loadFixture();
    const nonce = new Uint8Array(32).fill(7);
    const built = buildMeridianTransferInstruction({
      facilitatorConfig: fixture.facilitatorConfig,
      payerPubkey: PAYER.publicKey.toBase58(),
      recipient: RECIPIENT,
      grossAmountBaseUnits: BigInt(fixture.instruction.grossAmount),
      platformFeeBps: fixture.instruction.platformFeeBps,
      platformToken: PLATFORM_TOKEN,
      validAfterUnixSeconds: BigInt(fixture.instruction.validAfter),
      validBeforeUnixSeconds: BigInt(fixture.instruction.validBefore),
      nonce,
    });

    expect(built.instruction.programId.toBase58()).toBe(MERIDIAN_PROGRAM_ID);
    expect(built.instruction.data.length).toBe(fixture.instruction.dataLength);
    expect([...built.instruction.data.subarray(0, 8)]).toEqual(fixture.instruction.discriminator);
    expect(built.instruction.data.readBigUInt64LE(8).toString()).toBe(fixture.instruction.grossAmount);
    expect(built.instruction.data.readBigInt64LE(16).toString()).toBe(fixture.instruction.validAfter);
    expect(built.instruction.data.readBigInt64LE(24).toString()).toBe(fixture.instruction.validBefore);
    expect([...built.instruction.data.subarray(32, 64)]).toEqual([...nonce]);
    expect(built.instruction.data.readUInt16LE(64)).toBe(fixture.instruction.platformFeeBps);

    expect(built.instruction.keys).toHaveLength(fixture.instruction.accountRoles.length);
    expect(built.instruction.keys.map((key) => [key.isSigner, key.isWritable])).toEqual([
      [true, true],
      [true, false],
      [false, false],
      [false, false],
      [false, true],
      [false, true],
      [false, true],
      [false, true],
      [false, false],
    ]);
    expect(built.instruction.keys.map((key) => key.pubkey.toBase58())).toEqual([
      fixture.facilitatorConfig.facilitator,
      PAYER.publicKey.toBase58(),
      fixture.facilitatorConfig.configPda,
      fixture.facilitatorConfig.usdcMint,
      deriveAssociatedTokenAddress(PAYER.publicKey.toBase58(), fixture.facilitatorConfig.usdcMint).toBase58(),
      deriveAssociatedTokenAddress(RECIPIENT, fixture.facilitatorConfig.usdcMint).toBase58(),
      PLATFORM_TOKEN,
      fixture.facilitatorConfig.treasuryToken,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ]);
    expect({
      platform: built.amounts.platformFeeUsdcAtomic.toString(),
      treasury: built.amounts.treasuryFeeUsdcAtomic.toString(),
      net: built.amounts.netUsdcAtomic.toString(),
    }).toEqual({
      platform: fixture.instruction.platformFeeAmount,
      treasury: fixture.instruction.treasuryFeeAmount,
      net: fixture.instruction.netAmount,
    });
  });

  it('uses the program-id readonly placeholder at zero platform fee', async () => {
    const fixture = await loadFixture();
    const built = buildMeridianTransferInstruction({
      facilitatorConfig: fixture.facilitatorConfig,
      payerPubkey: PAYER.publicKey.toBase58(),
      recipient: RECIPIENT,
      grossAmountBaseUnits: 125_000n,
      platformFeeBps: 0,
      validAfterUnixSeconds: 0n,
      validBeforeUnixSeconds: 120n,
      nonce: new Uint8Array(32),
    });
    expect(built.instruction.keys[6]?.pubkey.toBase58()).toBe(MERIDIAN_PROGRAM_ID);
    expect(built.instruction.keys[6]?.isWritable).toBe(false);
  });

  it('derives the captured treasury USDC ATA with the platform-account helper', async () => {
    const fixture = await loadFixture();
    expect(deriveMeridianPlatformTokenAccount(
      fixture.facilitatorConfig.treasury,
      fixture.facilitatorConfig,
    )).toBe(fixture.facilitatorConfig.treasuryToken);
  });

  it('fails closed when a nonzero platform fee has no destination token account', async () => {
    const fixture = await loadFixture();
    expect(() => buildMeridianTransferInstruction({
      facilitatorConfig: fixture.facilitatorConfig,
      payerPubkey: PAYER.publicKey.toBase58(),
      recipient: RECIPIENT,
      grossAmountBaseUnits: 125_000n,
      platformFeeBps: 1,
      validAfterUnixSeconds: 0n,
      validBeforeUnixSeconds: 120n,
      nonce: new Uint8Array(32),
    })).toThrow('platform token account');
  });

  it('rejects a noncanonical mint even when it is a valid Solana public key', async () => {
    const fixture = await loadFixture();
    const wrongMintConfig = {
      ...fixture.facilitatorConfig,
      // Mainnet USDC is a valid pubkey but is invalid for the devnet config.
      usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };
    expect(() => buildMeridianTransferInstruction({
      facilitatorConfig: wrongMintConfig,
      payerPubkey: PAYER.publicKey.toBase58(),
      recipient: RECIPIENT,
      grossAmountBaseUnits: 125_000n,
      platformFeeBps: 0,
      validAfterUnixSeconds: 0n,
      validBeforeUnixSeconds: 120n,
      nonce: new Uint8Array(32),
    })).toThrow('non-USDC mint');
  });

  it('rejects treasury fee drift from the captured 100 bps accounting contract', async () => {
    const fixture = await loadFixture();
    const driftedConfig = JSON.parse(JSON.stringify({
      ...fixture.facilitatorConfig,
      treasuryFeeBps: 101,
    })) as MeridianSolanaFacilitatorConfig;
    expect(() => buildMeridianTransferInstruction({
      facilitatorConfig: driftedConfig,
      payerPubkey: PAYER.publicKey.toBase58(),
      recipient: RECIPIENT,
      grossAmountBaseUnits: 125_000n,
      platformFeeBps: 0,
      validAfterUnixSeconds: 0n,
      validBeforeUnixSeconds: 120n,
      nonce: new Uint8Array(32),
    })).toThrow();
  });
});

describe('Meridian v1 wire envelope', () => {
  it('builds a partially signed v1 transaction with plain network strings', async () => {
    const fixture = await loadFixture();
    const prepared = await prepareMeridianPayment({
      payerSecretKey: PAYER.secretKey,
      payerPubkey: PAYER.publicKey.toBase58(),
      payTo: RECIPIENT,
      grossAmountBaseUnits: 125_000n,
      network: 'devnet',
      resource: { url: 'https://api.clawville.world/meridian-conformance' },
      platformFeeBps: 0,
      facilitatorConfig: fixture.facilitatorConfig,
      recentBlockhash: '11111111111111111111111111111111',
      nowUnixSeconds: 1_700_000_000,
      nonce: new Uint8Array(32).fill(7),
    });

    const decoded = JSON.parse(Buffer.from(prepared.paymentHeader, 'base64').toString('utf8'));
    expect(decoded).toEqual(prepared.paymentPayload);
    expect(decoded.x402Version).toBe(1);
    expect(decoded.network).toBe('solana-devnet');
    expect(decoded.network).not.toContain(':');
    expect(prepared.requirements).toMatchObject({
      scheme: 'exact',
      network: 'solana-devnet',
      asset: fixture.facilitatorConfig.usdcMint,
      payTo: RECIPIENT,
      maxAmountRequired: '125000',
      extra: { platformFeeBps: 0, feePayer: fixture.facilitatorConfig.facilitator },
    });
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(decoded.payload.transaction, 'base64'),
    );
    expect(transaction.message.staticAccountKeys[0]?.toBase58()).toBe(
      fixture.facilitatorConfig.facilitator,
    );
    expect(transaction.signatures.some((value) => value.some((byte) => byte !== 0))).toBe(true);
  });

  it('derives the platform token account from a trusted owner when bps is nonzero', async () => {
    const fixture = await loadFixture();
    const prepared = await prepareMeridianPayment({
      payerSecretKey: PAYER.secretKey,
      payerPubkey: PAYER.publicKey.toBase58(),
      payTo: RECIPIENT,
      grossAmountBaseUnits: 125_000n,
      network: 'devnet',
      resource: { url: 'https://api.clawville.world/meridian-platform-fee' },
      platformFeeBps: 100,
      platformOwner: PLATFORM_OWNER,
      facilitatorConfig: fixture.facilitatorConfig,
      recentBlockhash: '11111111111111111111111111111111',
      nowUnixSeconds: 1_700_000_000,
      nonce: new Uint8Array(32).fill(8),
    });
    expect(prepared.instruction.keys[6]?.pubkey.toBase58()).toBe(
      deriveMeridianPlatformTokenAccount(PLATFORM_OWNER, fixture.facilitatorConfig),
    );
    expect(prepared.instruction.keys[6]?.isWritable).toBe(true);
    expect(prepared.requirements.extra.platformFeeBps).toBe(100);
  });
});

const requirements: MeridianPaymentRequirements = {
  scheme: 'exact',
  network: 'solana-devnet',
  asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  payTo: RECIPIENT,
  maxAmountRequired: '125000',
  resource: 'https://api.clawville.world/meridian-conformance',
  mimeType: 'application/json',
  maxTimeoutSeconds: 120,
  extra: {
    name: 'USDC',
    decimals: 6,
    feePayer: 'DhFm5NhZN5wXGyCAAS64Ae3Tdj8z8YkZGztDFfCpvt7b',
    creditedRecipient: RECIPIENT,
    platformFeeBps: 0,
  },
};

const header = (selected?: string) => Buffer.from(JSON.stringify({
  x402Version: 1,
  scheme: 'exact',
  network: 'solana-devnet',
  payload: {
    transaction: 'fixture-base64-transaction',
    payer: PAYER.publicKey.toBase58(),
    ...(selected ? { __mock: selected } : {}),
  },
}), 'utf8').toString('base64');

describe('Meridian verify-to-settle sequencing', () => {
  let server: ReturnType<typeof Bun.serve>;
  let requestPaths: string[] = [];
  let authHeaders: Array<string | null> = [];
  let requestBodies: unknown[] = [];
  const priorEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    const mock = buildMockMeridian({ log: false });
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPaths.push(new URL(request.url).pathname);
        authHeaders.push(request.headers.get('authorization'));
        requestBodies.push(await request.clone().json());
        return mock.fetch(request);
      },
    });
    for (const [key, value] of Object.entries({
      MERIDIAN_FACILITATOR_URL: `http://127.0.0.1:${server.port}`,
      MERIDIAN_API_KEY: 'pk_test_conformance',
      MERIDIAN_PLATFORM_FEE_BPS: '0',
    })) {
      priorEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  beforeEach(() => {
    requestPaths = [];
    authHeaders = [];
    requestBodies = [];
  });

  afterAll(() => {
    server.stop(true);
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('settles only after valid verify and sends the API key', async () => {
    const result = await verifyAndSettle({ paymentHeader: header(), requirements });
    expect(result).toMatchObject({ settled: true, isValid: true, outage: false });
    expect(result.txSignature?.length).toBeGreaterThan(0);
    expect(requestPaths).toEqual(['/v1/verify', '/v1/settle']);
    expect(authHeaders).toEqual(['Bearer pk_test_conformance', 'Bearer pk_test_conformance']);
    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies as Array<{
      paymentPayload: { x402Version: number; network: string };
      paymentRequirements: { network: string; extra: { platformFeeBps: number } };
    }>) {
      expect(body.paymentPayload.x402Version).toBe(1);
      expect(body.paymentPayload.network).toBe('solana-devnet');
      expect(body.paymentRequirements.network).toBe('solana-devnet');
      expect(body.paymentRequirements.extra.platformFeeBps).toBe(0);
    }
  });

  it('does not settle after a payment-invalid verify', async () => {
    const result = await verifyAndSettle({
      paymentHeader: header('verify-invalid'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: false,
      outage: false,
      failureReason: 'mock_forced_invalid',
    });
    expect(requestPaths).toEqual(['/v1/verify']);
  });

  it('classifies only HTTP 5xx as an outage while never throwing', async () => {
    const observed: Array<{ stage: string; status: number | null; outage: boolean }> = [];
    const outage = await verifyAndSettle({
      paymentHeader: header('verify-error'),
      requirements,
      onFacilitatorError(stage, error) {
        observed.push({
          stage,
          ...(error as { status: number | null; outage: boolean }),
        });
        throw new Error('observer failure must be swallowed');
      },
    });
    expect(outage).toMatchObject({
      settled: false,
      failureReason: 'facilitator_verify_error',
      outage: true,
      httpStatus: 500,
    });
    expect(observed).toEqual([{ stage: 'verify', status: 500, outage: true }]);
    requestPaths = [];
    const rejected = await verifyAndSettle({
      paymentHeader: header('verify-error-400'),
      requirements,
    });
    expect(rejected).toMatchObject({
      settled: false,
      failureReason: 'facilitator_verify_error',
      outage: false,
      httpStatus: 400,
    });
    expect(requestPaths).toEqual(['/v1/verify']);
  });

  it('requires a nonempty settlement signature', async () => {
    const result = await verifyAndSettle({
      paymentHeader: header('settle-empty-signature'),
      requirements,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      txSignature: null,
      failureReason: 'settlement_failed',
      outage: false,
    });
    expect(requestPaths).toEqual(['/v1/verify', '/v1/settle']);
  });

  it('supports verify-only without reaching settle', async () => {
    const result = await verifyAndSettle({
      paymentHeader: header(),
      requirements,
      verifyOnly: true,
    });
    expect(result).toMatchObject({
      settled: false,
      isValid: true,
      failureReason: 'verify_only_mode',
    });
    expect(requestPaths).toEqual(['/v1/verify']);
  });
});

describe('Meridian disabled configuration', () => {
  it('is a no-op with every MERIDIAN_* variable unset', async () => {
    const keys = [
      'MERIDIAN_FACILITATOR_URL',
      'MERIDIAN_API_KEY',
      'MERIDIAN_PLATFORM_FEE_BPS',
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      expect(loadMeridianConfig()).toEqual({
        enabled: false,
        facilitatorUrl: null,
        apiKey: null,
        platformFeeBps: 0,
        configError: null,
      });
      const result = await verifyAndSettle({ paymentHeader: header(), requirements });
      expect(result).toMatchObject({
        settled: false,
        isValid: false,
        failureReason: 'facilitator_config_error',
        outage: false,
      });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
