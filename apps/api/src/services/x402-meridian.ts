/**
 * Meridian's Solana x402 v1 adapter.
 *
 * This is intentionally separate from the PayAI/@x402 exact-SVM path. Meridian
 * requires a v1 envelope, plain Solana network names, and a transaction invoking
 * its fee-splitting program. It is disabled unless both Meridian URL and API key
 * are configured.
 */
import { randomBytes } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { z } from 'zod';
import { calculateMeridianSettlementAmounts } from './x402-settlement-accounting';
import { loadX402Config } from './x402-config';

export const MERIDIAN_PROGRAM_ID = 'Ro6hz1smrm5zDh73849eDqKna9dE1EkPsWekAB5rBWm';
export const MERIDIAN_TRANSFER_WITH_AUTHORIZATION_DISCRIMINATOR = Uint8Array.from([
  241, 208, 6, 43, 81, 61, 213, 10,
]);
export const MERIDIAN_MAX_FEE_BPS = 1_000;
export const MERIDIAN_TREASURY_FEE_BPS = 100;
export const MERIDIAN_USDC_DECIMALS = 6;
export const MERIDIAN_USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MERIDIAN_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export type MeridianNetwork = 'solana' | 'solana-devnet';
export type MeridianCluster = 'mainnet' | 'devnet';

const publicKeySchema = z.string().min(32).max(44).refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, 'invalid Solana public key');

const platformFeeBpsSchema = z.coerce.number().int().min(0).max(MERIDIAN_MAX_FEE_BPS);

const meridianFacilitatorConfigSchema = z.object({
  network: z.enum(['solana', 'solana-devnet']),
  facilitator: publicKeySchema,
  programId: z.literal(MERIDIAN_PROGRAM_ID),
  configPda: publicKeySchema,
  usdcMint: publicKeySchema,
  treasury: publicKeySchema,
  treasuryToken: publicKeySchema,
  treasuryFeeBps: z.literal(MERIDIAN_TREASURY_FEE_BPS),
  paused: z.boolean(),
});

export type MeridianSolanaFacilitatorConfig = z.infer<typeof meridianFacilitatorConfigSchema>;

export interface MeridianRuntimeConfig {
  enabled: boolean;
  facilitatorUrl: string | null;
  apiKey: string | null;
  platformFeeBps: number;
  configError: string | null;
}

/** Never throws; invalid or partial configuration disables Meridian. */
export function loadMeridianConfig(): MeridianRuntimeConfig {
  const facilitatorUrl = process.env.MERIDIAN_FACILITATOR_URL?.trim() || null;
  const apiKey = process.env.MERIDIAN_API_KEY?.trim() || null;
  const parsedBps = platformFeeBpsSchema.safeParse(
    process.env.MERIDIAN_PLATFORM_FEE_BPS?.trim() || '0',
  );
  const allUnset = facilitatorUrl === null
    && apiKey === null
    && process.env.MERIDIAN_PLATFORM_FEE_BPS?.trim() === undefined;

  if (allUnset) {
    return {
      enabled: false,
      facilitatorUrl: null,
      apiKey: null,
      platformFeeBps: 0,
      configError: null,
    };
  }

  if (!facilitatorUrl || !apiKey || !parsedBps.success) {
    return {
      enabled: false,
      facilitatorUrl,
      apiKey,
      platformFeeBps: parsedBps.success ? parsedBps.data : 0,
      configError: !facilitatorUrl
        ? 'missing_meridian_facilitator_url'
        : !apiKey
          ? 'missing_meridian_api_key'
          : 'invalid_meridian_platform_fee_bps',
    };
  }

  return {
    enabled: true,
    facilitatorUrl,
    apiKey,
    platformFeeBps: parsedBps.data,
    configError: null,
  };
}

export function isMeridianEnabled(): boolean {
  return loadMeridianConfig().enabled;
}

export function meridianNetworkForCluster(cluster: MeridianCluster): MeridianNetwork {
  return cluster === 'mainnet' ? 'solana' : 'solana-devnet';
}

export function meridianUsdcMintForNetwork(network: MeridianNetwork): string {
  return network === 'solana' ? MERIDIAN_USDC_MINT_MAINNET : MERIDIAN_USDC_MINT_DEVNET;
}

function meridianApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}${path}`;
}

export interface MeridianPaymentRequirements {
  scheme: 'exact';
  network: MeridianNetwork;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: {
    name: 'USDC';
    decimals: 6;
    feePayer: string;
    creditedRecipient: string;
    platformFeeBps: number;
    [key: string]: unknown;
  };
}

export interface MeridianPaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: MeridianNetwork;
  payload: { transaction: string; [key: string]: unknown };
}

const paymentRequirementsSchema = z.object({
  scheme: z.literal('exact'),
  network: z.enum(['solana', 'solana-devnet']),
  asset: publicKeySchema,
  payTo: publicKeySchema,
  maxAmountRequired: z.string().regex(/^[1-9]\d*$/),
  resource: z.string().min(1),
  description: z.string().min(1),
  mimeType: z.string().min(1),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({
    name: z.literal('USDC'),
    decimals: z.literal(6),
    feePayer: publicKeySchema,
    creditedRecipient: publicKeySchema,
    platformFeeBps: z.number().int().min(0).max(MERIDIAN_MAX_FEE_BPS),
  }).passthrough(),
});

const paymentPayloadSchema = z.object({
  x402Version: z.literal(1),
  scheme: z.literal('exact'),
  network: z.enum(['solana', 'solana-devnet']),
  payload: z.object({ transaction: z.string().min(1) }).passthrough(),
});

const verifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  invalidMessage: z.string().optional(),
  payer: z.string().optional(),
}).passthrough();

const settleResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string().optional().default(''),
  network: z.string().optional(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
}).passthrough();

export type MeridianVerifyResponse = z.infer<typeof verifyResponseSchema>;
export type MeridianSettleResponse = z.infer<typeof settleResponseSchema>;

export interface MeridianVerifyAndSettleInput {
  paymentHeader: string;
  requirements: MeridianPaymentRequirements;
  verifyOnly?: boolean;
  expectedPayer?: string;
  /** Same optional observation seam as PayAI; callback failures are swallowed. */
  onFacilitatorError?: (
    stage: 'verify' | 'settle',
    error: unknown,
  ) => void;
}

export interface MeridianVerifyAndSettleResult {
  settled: boolean;
  isValid: boolean;
  txSignature: string | null;
  network: string | null;
  payer: string | null;
  failureReason: string | null;
  /** True only for a network/timeout/malformed-upstream/HTTP-5xx failure. */
  outage: boolean;
  httpStatus: number | null;
  raw: { verify?: MeridianVerifyResponse; settle?: MeridianSettleResponse };
}

// The sibling aliases keep imports parallel with x402-payai.ts while retaining
// Meridian-prefixed names for call sites that import both adapters.
export type VerifyAndSettleInput = MeridianVerifyAndSettleInput;
export type VerifyAndSettleResult = MeridianVerifyAndSettleResult;

const failed = (
  failureReason: string,
  extra: Partial<MeridianVerifyAndSettleResult> = {},
): MeridianVerifyAndSettleResult => ({
  settled: false,
  isValid: false,
  txSignature: null,
  network: null,
  payer: null,
  failureReason,
  outage: false,
  httpStatus: null,
  raw: {},
  ...extra,
});

type PostResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; outage: boolean; status: number | null };

async function postMeridian<S extends z.ZodTypeAny>(
  url: string,
  apiKey: string,
  body: unknown,
  schema: S,
): Promise<PostResult<z.output<S>>> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { ok: false, outage: response.status >= 500, status: response.status };
    }
    const parsed = schema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, data: parsed.data, status: response.status }
      : { ok: false, outage: true, status: response.status };
  } catch {
    return { ok: false, outage: true, status: null };
  }
}

function decodePaymentHeader(header: string): MeridianPaymentPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const parsed = paymentPayloadSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function notifyFacilitatorError(
  input: MeridianVerifyAndSettleInput,
  stage: 'verify' | 'settle',
  error: { status: number | null; outage: boolean },
): void {
  try {
    input.onFacilitatorError?.(stage, error);
  } catch {
    // Observation must never weaken the adapter's never-throw money boundary.
  }
}

/** Meridian sibling of PayAI's never-throw verify→settle primitive. */
export async function verifyAndSettle(
  input: MeridianVerifyAndSettleInput,
): Promise<MeridianVerifyAndSettleResult> {
  try {
    const runtime = loadMeridianConfig();
    if (!runtime.enabled || !runtime.facilitatorUrl || !runtime.apiKey) {
      return failed('facilitator_config_error');
    }

    const payload = decodePaymentHeader(input.paymentHeader);
    const requirements = paymentRequirementsSchema.safeParse(input.requirements);
    if (!payload || !requirements.success) return failed('malformed_payment_header');
    const merchantWalletPubkey = loadX402Config().merchantWalletPubkey;
    if (
      !merchantWalletPubkey
      || requirements.data.payTo !== merchantWalletPubkey
    ) {
      // Meridian Solana is seller-side: the dashboard pins one organization
      // recipient, so arbitrary payTo values can never be settled safely.
      return failed('merchant_recipient_mismatch');
    }
    if (
      payload.network !== requirements.data.network
      || requirements.data.asset !== meridianUsdcMintForNetwork(requirements.data.network)
      || requirements.data.extra.creditedRecipient !== requirements.data.payTo
    ) return failed('payment_invalid');

    const body = {
      paymentPayload: payload,
      paymentRequirements: requirements.data,
    };
    const verifyResult = await postMeridian(
      meridianApiUrl(runtime.facilitatorUrl, '/verify'),
      runtime.apiKey,
      body,
      verifyResponseSchema,
    );
    if (!verifyResult.ok) {
      notifyFacilitatorError(input, 'verify', {
        status: verifyResult.status,
        outage: verifyResult.outage,
      });
      return failed('facilitator_verify_error', {
        outage: verifyResult.outage,
        httpStatus: verifyResult.status,
      });
    }

    const verify = verifyResult.data;
    if (verify.isValid !== true) {
      return failed(verify.invalidReason ?? 'payment_invalid', {
        payer: verify.payer ?? null,
        raw: { verify },
      });
    }
    if (input.expectedPayer && verify.payer && verify.payer !== input.expectedPayer) {
      return failed('payment_invalid', { payer: verify.payer, raw: { verify } });
    }
    if (input.verifyOnly === true) {
      return failed('verify_only_mode', {
        isValid: true,
        payer: verify.payer ?? null,
        raw: { verify },
      });
    }

    const settleResult = await postMeridian(
      meridianApiUrl(runtime.facilitatorUrl, '/settle'),
      runtime.apiKey,
      body,
      settleResponseSchema,
    );
    if (!settleResult.ok) {
      notifyFacilitatorError(input, 'settle', {
        status: settleResult.status,
        outage: settleResult.outage,
      });
      return failed('facilitator_settle_error', {
        isValid: true,
        payer: verify.payer ?? null,
        outage: settleResult.outage,
        httpStatus: settleResult.status,
        raw: { verify },
      });
    }

    const settle = settleResult.data;
    const txSignature = settle.transaction?.trim() || null;
    const payer = settle.payer ?? verify.payer ?? null;
    if (input.expectedPayer && payer && payer !== input.expectedPayer) {
      return failed('payment_invalid', {
        isValid: true,
        payer,
        raw: { verify, settle },
      });
    }
    if (settle.success !== true || !txSignature) {
      return failed(settle.errorReason ?? 'settlement_failed', {
        isValid: true,
        payer,
        network: settle.network ?? null,
        raw: { verify, settle },
      });
    }

    return {
      settled: true,
      isValid: true,
      txSignature,
      network: settle.network ?? requirements.data.network,
      payer,
      failureReason: null,
      outage: false,
      httpStatus: settleResult.status,
      raw: { verify, settle },
    };
  } catch {
    return failed('facilitator_config_error');
  }
}

export async function fetchMeridianFacilitatorConfig(input: {
  facilitatorUrl: string;
  network: MeridianNetwork;
}): Promise<MeridianSolanaFacilitatorConfig> {
  const response = await fetch(
    meridianApiUrl(input.facilitatorUrl, `/solana/facilitator?network=${input.network}`),
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) throw new Error(`Meridian facilitator config returned HTTP ${response.status}`);
  const config = meridianFacilitatorConfigSchema.parse(await response.json());
  if (config.network !== input.network) throw new Error('Meridian facilitator network mismatch');
  if (config.usdcMint !== meridianUsdcMintForNetwork(input.network)) {
    throw new Error('Meridian facilitator returned a non-USDC mint');
  }
  if (deriveAssociatedTokenAddress(config.treasury, config.usdcMint).toBase58() !== config.treasuryToken) {
    throw new Error('Meridian treasury token account does not match treasury USDC ATA');
  }
  if (config.paused) throw new Error('Meridian facilitator is paused');
  return config;
}

export function deriveAssociatedTokenAddress(owner: string, mint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(TOKEN_PROGRAM_ID).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

/** Derive the trusted platform owner's USDC ATA using the captured SPL programs. */
export function deriveMeridianPlatformTokenAccount(
  ownerPubkey: string,
  facilitatorConfig: MeridianSolanaFacilitatorConfig,
): string {
  const config = meridianFacilitatorConfigSchema.parse(facilitatorConfig);
  if (config.usdcMint !== meridianUsdcMintForNetwork(config.network)) {
    throw new Error('Meridian facilitator returned a non-USDC mint');
  }
  return deriveAssociatedTokenAddress(ownerPubkey, config.usdcMint).toBase58();
}

export interface BuildMeridianTransferInstructionInput {
  facilitatorConfig: MeridianSolanaFacilitatorConfig;
  payerPubkey: string;
  recipient: string;
  grossAmountBaseUnits: bigint;
  platformFeeBps: number;
  /** Required when platformFeeBps > 0; public config does not supply it. */
  platformToken?: string;
  validAfterUnixSeconds: bigint;
  validBeforeUnixSeconds: bigint;
  nonce: Uint8Array;
}

export function buildMeridianTransferInstruction(
  input: BuildMeridianTransferInstructionInput,
): {
  instruction: TransactionInstruction;
  amounts: ReturnType<typeof calculateMeridianSettlementAmounts>;
} {
  const config = meridianFacilitatorConfigSchema.parse(input.facilitatorConfig);
  if (config.paused) throw new Error('Meridian facilitator is paused');
  if (config.usdcMint !== meridianUsdcMintForNetwork(config.network)) {
    throw new Error('Meridian facilitator returned a non-USDC mint');
  }
  if (deriveAssociatedTokenAddress(config.treasury, config.usdcMint).toBase58() !== config.treasuryToken) {
    throw new Error('Meridian treasury token account does not match treasury USDC ATA');
  }
  const platformFeeBps = platformFeeBpsSchema.parse(input.platformFeeBps);
  if (input.grossAmountBaseUnits <= 0n) throw new Error('Meridian payment amount must be positive');
  if (input.grossAmountBaseUnits > 0xffff_ffff_ffff_ffffn) {
    throw new Error('Meridian payment amount exceeds u64');
  }
  if (input.nonce.length !== 32) throw new Error('Meridian nonce must be exactly 32 bytes');
  if (input.validBeforeUnixSeconds <= input.validAfterUnixSeconds) {
    throw new Error('Meridian authorization expiry must be after valid-after');
  }
  if (platformFeeBps > 0 && !input.platformToken) {
    throw new Error('Meridian platform token account is required when platform fee bps is nonzero');
  }

  const payer = new PublicKey(input.payerPubkey);
  const programId = new PublicKey(config.programId);
  const platformToken = platformFeeBps === 0
    ? programId
    : new PublicKey(input.platformToken!);
  const data = Buffer.alloc(66);
  data.set(MERIDIAN_TRANSFER_WITH_AUTHORIZATION_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(input.grossAmountBaseUnits, 8);
  data.writeBigInt64LE(input.validAfterUnixSeconds, 16);
  data.writeBigInt64LE(input.validBeforeUnixSeconds, 24);
  data.set(input.nonce, 32);
  data.writeUInt16LE(platformFeeBps, 64);

  const instruction = new TransactionInstruction({
    programId,
    data,
    keys: [
      { pubkey: new PublicKey(config.facilitator), isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(config.configPda), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(config.usdcMint), isSigner: false, isWritable: false },
      { pubkey: deriveAssociatedTokenAddress(input.payerPubkey, config.usdcMint), isSigner: false, isWritable: true },
      { pubkey: deriveAssociatedTokenAddress(input.recipient, config.usdcMint), isSigner: false, isWritable: true },
      { pubkey: platformToken, isSigner: false, isWritable: platformFeeBps > 0 },
      { pubkey: new PublicKey(config.treasuryToken), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
  });

  return {
    instruction,
    amounts: calculateMeridianSettlementAmounts(input.grossAmountBaseUnits, platformFeeBps),
  };
}

export interface PrepareMeridianPaymentInput {
  payerSecretKey: Uint8Array;
  payerPubkey: string;
  payTo: string;
  grossAmountBaseUnits: bigint;
  network: MeridianCluster;
  rpcUrl?: string;
  resource: { url: string; description?: string; mimeType?: string };
  maxTimeoutSeconds?: number;
  platformToken?: string;
  /** Trusted platform wallet owner; its USDC ATA is derived after live config resolution. */
  platformOwner?: string;
  /** Test seams; production obtains these from env/RPC/crypto randomness. */
  platformFeeBps?: number;
  facilitatorConfig?: MeridianSolanaFacilitatorConfig;
  recentBlockhash?: string;
  nowUnixSeconds?: number;
  nonce?: Uint8Array;
}

export interface PreparedMeridianPayment {
  paymentHeader: string;
  paymentPayload: MeridianPaymentPayload;
  requirements: MeridianPaymentRequirements;
  payerPubkey: string;
  network: MeridianCluster;
  facilitatorConfig: MeridianSolanaFacilitatorConfig;
  amounts: ReturnType<typeof calculateMeridianSettlementAmounts>;
  instruction: TransactionInstruction;
}

/** Build and payer-sign Meridian's custom v1 Solana settlement transaction. */
export async function prepareMeridianPayment(
  input: PrepareMeridianPaymentInput,
): Promise<PreparedMeridianPayment> {
  const runtime = loadMeridianConfig();
  if (runtime.enabled) {
    const merchantWalletPubkey = loadX402Config().merchantWalletPubkey;
    if (!merchantWalletPubkey || input.payTo !== merchantWalletPubkey) {
      throw new Error('Meridian payTo must match the configured merchant wallet');
    }
  }
  const network = meridianNetworkForCluster(input.network);
  const platformFeeBps = platformFeeBpsSchema.parse(
    input.platformFeeBps ?? runtime.platformFeeBps,
  );
  const facilitatorConfig = input.facilitatorConfig ?? await (async () => {
    if (!runtime.enabled || !runtime.facilitatorUrl) {
      throw new Error('Meridian is disabled');
    }
    return fetchMeridianFacilitatorConfig({
      facilitatorUrl: runtime.facilitatorUrl,
      network,
    });
  })();
  if (facilitatorConfig.network !== network) throw new Error('Meridian facilitator network mismatch');
  const platformToken = input.platformToken ?? (
    platformFeeBps > 0 && input.platformOwner
      ? deriveMeridianPlatformTokenAccount(input.platformOwner, facilitatorConfig)
      : undefined
  );

  const payer = input.payerSecretKey.length === 32
    ? Keypair.fromSeed(input.payerSecretKey)
    : Keypair.fromSecretKey(input.payerSecretKey);
  if (payer.publicKey.toBase58() !== input.payerPubkey) {
    throw new Error('Meridian signer does not match the pinned payer pubkey');
  }

  const timeoutSeconds = input.maxTimeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Meridian timeout must be a positive integer');
  }
  const now = input.nowUnixSeconds ?? Math.floor(Date.now() / 1_000);
  const nonce = input.nonce ?? randomBytes(32);
  const { instruction, amounts } = buildMeridianTransferInstruction({
    facilitatorConfig,
    payerPubkey: input.payerPubkey,
    recipient: input.payTo,
    grossAmountBaseUnits: input.grossAmountBaseUnits,
    platformFeeBps,
    platformToken,
    validAfterUnixSeconds: 0n,
    validBeforeUnixSeconds: BigInt(now + timeoutSeconds),
    nonce,
  });

  const recentBlockhash = input.recentBlockhash ?? await (async () => {
    if (!input.rpcUrl) throw new Error('Meridian rpcUrl is required without a blockhash test seam');
    return (await new Connection(input.rpcUrl, 'confirmed').getLatestBlockhash('confirmed')).blockhash;
  })();
  // Meridian's validator parses LEGACY transactions only — a v0
  // VersionedTransaction is rejected as invalid_exact_svm_payload_transaction
  // (proven against the live devnet facilitator, 2026-07-22).
  const transaction = new Transaction();
  transaction.add(instruction);
  transaction.feePayer = new PublicKey(facilitatorConfig.facilitator);
  transaction.recentBlockhash = recentBlockhash;
  transaction.partialSign(payer);

  const requirements: MeridianPaymentRequirements = {
    scheme: 'exact',
    network,
    asset: facilitatorConfig.usdcMint,
    payTo: input.payTo,
    maxAmountRequired: input.grossAmountBaseUnits.toString(),
    resource: input.resource.url,
    // Required by Meridian's verify schema — omitting it is rejected as
    // invalid_payment_requirements (proven live 2026-07-22).
    description: input.resource.description ?? 'ClawVille x402 settlement',
    mimeType: input.resource.mimeType ?? 'application/json',
    maxTimeoutSeconds: timeoutSeconds,
    extra: {
      name: 'USDC',
      decimals: MERIDIAN_USDC_DECIMALS,
      feePayer: facilitatorConfig.facilitator,
      creditedRecipient: input.payTo,
      platformFeeBps,
    },
  };
  const paymentPayload: MeridianPaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network,
    payload: {
      transaction: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
    },
  };
  return {
    paymentHeader: Buffer.from(JSON.stringify(paymentPayload), 'utf8').toString('base64'),
    paymentPayload,
    requirements,
    payerPubkey: input.payerPubkey,
    network: input.network,
    facilitatorConfig,
    amounts,
    instruction,
  };
}
