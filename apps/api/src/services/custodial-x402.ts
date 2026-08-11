/** Shared custodial x402 exact-payment plumbing (no proprietary PayAI SDK). */
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import {
  caip2ForNetwork,
  isFacilitatorLevelFailure,
  usdcMintForNetwork,
  verifyAndSettle,
  type VerifyAndSettleResult,
  type X402Network,
} from './x402-payai';
import { shouldFallbackToMeridian } from './x402-facilitator-selection';
import {
  isMeridianEnabled,
  prepareMeridianPayment,
  verifyAndSettle as verifyAndSettleMeridian,
  type MeridianVerifyAndSettleResult,
  type PreparedMeridianPayment,
} from './x402-meridian';
import { loadX402Config } from './x402-config';

export interface PrepareCustodialExactPaymentInput {
  /** Decrypted for this call only; never retained, returned, persisted, or logged. */
  payerSecretKey: Uint8Array;
  payerPubkey: string;
  payTo: string;
  amountBaseUnits: bigint;
  network: X402Network;
  rpcUrl: string;
  feePayer: string;
  resource: { url: string; description?: string };
  purpose: string;
  extra?: Record<string, unknown>;
  maxTimeoutSeconds?: number;
}

export interface PreparedCustodialExactPayment {
  /** Independently signed Meridian v1 fallback; absent is a strict no-op. */
  meridian?: PreparedMeridianPayment;
  paymentHeader: string;
  requirements: PaymentRequirements;
  payerPubkey: string;
  feePayer: string;
  network: X402Network;
}

export async function prepareCustodialExactPayment(
  input: PrepareCustodialExactPaymentInput,
): Promise<PreparedCustodialExactPayment> {
  if (input.amountBaseUnits <= 0n) throw new Error('custodial x402 amount must be > 0');
  const caip2 = caip2ForNetwork(input.network);
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: caip2,
    amount: input.amountBaseUnits.toString(),
    asset: usdcMintForNetwork(input.network),
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds ?? 120,
    extra: {
      ...(input.extra ?? {}),
      feePayer: input.feePayer,
      purpose: input.purpose,
    },
  };

  const signer = await createKeyPairSignerFromBytes(input.payerSecretKey);
  if (String(signer.address) !== input.payerPubkey) {
    throw new Error('custodial x402 signer does not match the pinned payer pubkey');
  }
  const client = new x402Client();
  client.register(caip2, new ExactSvmScheme(signer, { rpcUrl: input.rpcUrl }));
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: input.resource,
    accepts: [requirements],
  });
  return {
    // Meridian's Solana recipient is organization-pinned (the org's dashboard
    // wallet). This generic primitive is used by outbound agent-pay/SAP flows
    // with arbitrary recipients, so it must never attach a Meridian candidate.
    // Keep the optional API field for the explicit merchant-bound inbound seam.
    paymentHeader: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    requirements,
    payerPubkey: input.payerPubkey,
    feePayer: input.feePayer,
    network: input.network,
  };
}

/**
 * Merchant-bound custodial preparation for inbound top-up/checkout payments.
 * PayAI remains primary. When Meridian is enabled, attach its independently
 * signed candidate for verify-stage provider failover; inbound availability is
 * intentionally not capped by the outbound fee crossover.
 */
export async function prepareInboundCustodialExactPayment(
  input: PrepareCustodialExactPaymentInput,
): Promise<PreparedCustodialExactPayment> {
  const merchantWalletPubkey = loadX402Config().merchantWalletPubkey;
  if (!merchantWalletPubkey || input.payTo !== merchantWalletPubkey) {
    throw new Error('inbound custodial x402 payTo must match the merchant wallet');
  }

  const payAi = await prepareCustodialExactPayment(input);
  const meridian = await prepareInboundMeridianPayment(input);
  return meridian ? { ...payAi, meridian } : payAi;
}

export type PrepareInboundMeridianPaymentInput = Omit<
  PrepareCustodialExactPaymentInput,
  'feePayer'
>;

/**
 * Build only the merchant-bound Meridian candidate. This deliberately does not
 * need PayAI's `/supported` fee payer, so an open PayAI circuit can still route
 * straight to the fallback without spending a probe.
 */
export async function prepareInboundMeridianPayment(
  input: PrepareInboundMeridianPaymentInput,
): Promise<PreparedMeridianPayment | undefined> {
  // Disabled means a strict no-op, including when the rest of x402 is not
  // configured. Do not introduce a merchant-config assertion on the off path.
  if (!isMeridianEnabled()) return undefined;

  const merchantWalletPubkey = loadX402Config().merchantWalletPubkey;
  if (!merchantWalletPubkey || input.payTo !== merchantWalletPubkey) {
    throw new Error('inbound custodial x402 payTo must match the merchant wallet');
  }
  if (!shouldFallbackToMeridian({
    meridianEnabled: true,
    payAiOutage: true,
    direction: 'inbound',
    grossUsdcAtomic: input.amountBaseUnits,
  })) {
    return undefined;
  }

  try {
    return await prepareMeridianPayment({
      payerSecretKey: input.payerSecretKey,
      payerPubkey: input.payerPubkey,
      payTo: merchantWalletPubkey,
      grossAmountBaseUnits: input.amountBaseUnits,
      network: input.network,
      rpcUrl: input.rpcUrl,
      resource: input.resource,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      platformOwner: merchantWalletPubkey,
    });
  } catch {
    // Optional fallback preparation is fail-soft. The established PayAI leg is
    // still independently signed and remains usable.
    return undefined;
  }
}

export interface PayAiExecutionObservation {
  /** Whether this execution actually called PayAI verify. */
  attempted: boolean;
  /** Whether that attempted leg produced a provider-wide failure. */
  providerFailure: boolean;
}

type PayAiExecutePreparedExactPaymentOutcome =
  | { kind: 'settled'; signature: string; payer: string | null; result: VerifyAndSettleResult }
  | {
      kind: 'verify_only';
      payer: string | null;
      result: VerifyAndSettleResult | MeridianVerifyAndSettleResult;
    }
  | {
      kind: 'definitive_failure';
      stage: 'verify' | 'settle';
      verifyPassed: boolean;
      noBroadcast: true;
      /** Present only for a proven verify-stage transport/timeout/5xx outage. */
      facilitatorOutage?: true;
      reason: string;
      payer: string | null;
      result: VerifyAndSettleResult;
    }
  | {
      kind: 'ambiguous';
      verifyPassed: true;
      reason: string;
      payer: string | null;
      signature: string | null;
      result: VerifyAndSettleResult;
    };

export type ExecutePreparedExactPaymentOutcome =
  (PayAiExecutePreparedExactPaymentOutcome
  | {
      kind: 'meridian_settled';
      signature: string;
      payer: string | null;
      amounts: PreparedMeridianPayment['amounts'];
      result: MeridianVerifyAndSettleResult;
    }
  | {
      kind: 'meridian_failure';
      stage: 'verify' | 'settle';
      ambiguous: boolean;
      reason: string;
      payer: string | null;
      signature: string | null;
      result: MeridianVerifyAndSettleResult;
    }) & { payAi: PayAiExecutionObservation };

async function executeMeridianCandidate(
  meridian: PreparedMeridianPayment,
  payAi: PayAiExecutionObservation,
  verifyOnly = false,
): Promise<ExecutePreparedExactPaymentOutcome> {
  const meridianResult = await verifyAndSettleMeridian({
    paymentHeader: meridian.paymentHeader,
    requirements: meridian.requirements,
    expectedPayer: meridian.payerPubkey,
    verifyOnly,
  });
  if (verifyOnly && meridianResult.isValid) {
    return {
      kind: 'verify_only',
      payer: meridianResult.payer,
      result: meridianResult,
      payAi,
    };
  }
  if (meridianResult.settled && meridianResult.txSignature) {
    return {
      kind: 'meridian_settled',
      signature: meridianResult.txSignature,
      payer: meridianResult.payer,
      amounts: meridian.amounts,
      result: meridianResult,
      payAi,
    };
  }
  const reason = meridianResult.failureReason ?? 'meridian_settlement_failed';
  const signature = (
    meridianResult.txSignature
    ?? meridianResult.raw.settle?.transaction
  )?.trim() || null;
  if (!meridianResult.isValid) {
    return {
      kind: 'meridian_failure',
      stage: 'verify',
      ambiguous: signature !== null,
      reason,
      payer: meridianResult.payer,
      signature,
      result: meridianResult,
      payAi,
    };
  }
  return {
    kind: 'meridian_failure',
    stage: 'settle',
    ambiguous: signature !== null || meridianResult.raw.settle?.success !== false,
    reason,
    payer: meridianResult.payer,
    signature,
    result: meridianResult,
    payAi,
  };
}

export async function executePreparedExactPayment(
  prep:
    | Pick<
        PreparedCustodialExactPayment,
        'paymentHeader' | 'requirements' | 'payerPubkey' | 'meridian'
      >
    | { payerPubkey: string; meridian: PreparedMeridianPayment },
  opts: { verifyOnly?: boolean; skipPayAi?: boolean } = {},
): Promise<ExecutePreparedExactPaymentOutcome> {
  if (opts.skipPayAi === true) {
    if (prep.meridian) {
      return executeMeridianCandidate(
        prep.meridian,
        { attempted: false, providerFailure: false },
        opts.verifyOnly === true,
      );
    }
    return {
      kind: 'definitive_failure',
      stage: 'verify',
      verifyPassed: false,
      noBroadcast: true,
      reason: 'payai_skipped_without_meridian',
      payer: null,
      result: {
        settled: false,
        isValid: false,
        txSignature: null,
        network: null,
        payer: null,
        failureReason: 'payai_skipped_without_meridian',
        raw: {},
      },
      payAi: { attempted: false, providerFailure: false },
    };
  }

  if (!('paymentHeader' in prep) || !('requirements' in prep)) {
    return {
      kind: 'definitive_failure',
      stage: 'verify',
      verifyPassed: false,
      noBroadcast: true,
      reason: 'payai_preparation_missing',
      payer: null,
      result: {
        settled: false,
        isValid: false,
        txSignature: null,
        network: null,
        payer: null,
        failureReason: 'payai_preparation_missing',
        raw: {},
      },
      payAi: { attempted: false, providerFailure: false },
    };
  }

  let verifyProviderFailure = false;
  let payAiProviderFailure = false;
  const result = await verifyAndSettle({
    paymentHeader: prep.paymentHeader,
    requirements: prep.requirements,
    expectedPayer: prep.payerPubkey,
    verifyOnly: opts.verifyOnly,
    onFacilitatorError: (stage, error) => {
      if (isFacilitatorLevelFailure(error)) {
        payAiProviderFailure = true;
        if (stage === 'verify') verifyProviderFailure = true;
      }
    },
  });
  if (result.facilitatorFailure === 'unavailable') {
    payAiProviderFailure = true;
  }
  const payAi = { attempted: true, providerFailure: payAiProviderFailure };
  if (
    opts.verifyOnly !== true &&
    !result.isValid &&
    verifyProviderFailure &&
    prep.meridian
  ) {
    return executeMeridianCandidate(prep.meridian, payAi);
  }
  if (opts.verifyOnly === true && result.isValid) {
    return { kind: 'verify_only', payer: result.payer, result, payAi };
  }
  if (result.settled && result.txSignature) {
    return { kind: 'settled', signature: result.txSignature, payer: result.payer, result, payAi };
  }
  const reason = result.failureReason ?? 'settlement_failed';
  if (!result.isValid && verifyProviderFailure) {
    return {
      kind: 'definitive_failure',
      stage: 'verify',
      verifyPassed: false,
      noBroadcast: true,
      reason,
      payer: result.payer,
      result,
      facilitatorOutage: true,
      payAi,
    };
  }
  if (!result.isValid) {
    return {
      kind: 'definitive_failure', stage: 'verify', verifyPassed: false,
      noBroadcast: true, reason, payer: result.payer, result, payAi,
    };
  }
  if (result.noBroadcast === true) {
    return {
      kind: 'definitive_failure', stage: 'settle', verifyPassed: true,
      noBroadcast: true, reason, payer: result.payer, result, payAi,
    };
  }
  return {
    kind: 'ambiguous',
    verifyPassed: true,
    reason,
    payer: result.payer,
    signature: result.txSignature,
    result,
    payAi,
  };
}
