/** Shared custodial x402 exact-payment plumbing (no proprietary PayAI SDK). */
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import {
  caip2ForNetwork,
  usdcMintForNetwork,
  verifyAndSettle,
  type VerifyAndSettleResult,
  type X402Network,
} from './x402-payai';
import {
  isFacilitatorOutageError,
  shouldFallbackToMeridian,
} from './x402-facilitator-selection';
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
  let meridian: PreparedMeridianPayment | undefined;
  if (
    shouldFallbackToMeridian({
      meridianEnabled: isMeridianEnabled(),
      payAiOutage: true,
      direction: 'outbound',
      grossUsdcAtomic: input.amountBaseUnits,
    })
  ) {
    try {
      const platformOwner = loadX402Config().merchantWalletPubkey;
      const candidate = await prepareMeridianPayment({
        payerSecretKey: input.payerSecretKey,
        payerPubkey: input.payerPubkey,
        payTo: input.payTo,
        grossAmountBaseUnits: input.amountBaseUnits,
        network: input.network,
        rpcUrl: input.rpcUrl,
        resource: input.resource,
        maxTimeoutSeconds: input.maxTimeoutSeconds,
        platformOwner,
      });
      if (candidate.amounts.netUsdcAtomic >= 10_000n) {
        meridian = candidate;
      }
    } catch {
      // PayAI stays primary. A bad/unavailable optional config removes only
      // the fallback and cannot change the established exact-scheme path.
    }
  }
  return {
    ...(meridian ? { meridian } : {}),
    paymentHeader: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    requirements,
    payerPubkey: input.payerPubkey,
    feePayer: input.feePayer,
    network: input.network,
  };
}

type PayAiExecutePreparedExactPaymentOutcome =
  | { kind: 'settled'; signature: string; payer: string | null; result: VerifyAndSettleResult }
  | { kind: 'verify_only'; payer: string | null; result: VerifyAndSettleResult }
  | {
      kind: 'definitive_failure';
      stage: 'verify' | 'settle';
      verifyPassed: boolean;
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
  | PayAiExecutePreparedExactPaymentOutcome
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
    };

export async function executePreparedExactPayment(
  prep: Pick<
    PreparedCustodialExactPayment,
    'paymentHeader' | 'requirements' | 'payerPubkey' | 'meridian'
  >,
  opts: { verifyOnly?: boolean } = {},
): Promise<ExecutePreparedExactPaymentOutcome> {
  let verifyOutage = false;
  const result = await verifyAndSettle({
    paymentHeader: prep.paymentHeader,
    requirements: prep.requirements,
    expectedPayer: prep.payerPubkey,
    verifyOnly: opts.verifyOnly,
    onFacilitatorError: (stage, error) => {
      if (stage === 'verify' && isFacilitatorOutageError(error)) {
        verifyOutage = true;
      }
    },
  });
  if (
    opts.verifyOnly !== true &&
    !result.isValid &&
    verifyOutage &&
    prep.meridian
  ) {
    const meridianResult = await verifyAndSettleMeridian({
      paymentHeader: prep.meridian.paymentHeader,
      requirements: prep.meridian.requirements,
      expectedPayer: prep.meridian.payerPubkey,
    });
    if (meridianResult.settled && meridianResult.txSignature) {
      return {
        kind: 'meridian_settled',
        signature: meridianResult.txSignature,
        payer: meridianResult.payer,
        amounts: prep.meridian.amounts,
        result: meridianResult,
      };
    }
    const reason = meridianResult.failureReason ?? 'meridian_settlement_failed';
    if (!meridianResult.isValid) {
      return {
        kind: 'meridian_failure',
        stage: 'verify',
        ambiguous: false,
        reason,
        payer: meridianResult.payer,
        signature: meridianResult.txSignature,
        result: meridianResult,
      };
    }
    return {
      kind: 'meridian_failure',
      stage: 'settle',
      ambiguous: meridianResult.raw.settle?.success !== false,
      reason,
      payer: meridianResult.payer,
      signature: meridianResult.txSignature,
      result: meridianResult,
    };
  }
  if (opts.verifyOnly === true && result.isValid) {
    return { kind: 'verify_only', payer: result.payer, result };
  }
  if (result.settled && result.txSignature) {
    return { kind: 'settled', signature: result.txSignature, payer: result.payer, result };
  }
  const reason = result.failureReason ?? 'settlement_failed';
  if (!result.isValid && verifyOutage) {
    return {
      kind: 'definitive_failure',
      stage: 'verify',
      verifyPassed: false,
      reason,
      payer: result.payer,
      result,
      facilitatorOutage: true,
    };
  }
  if (!result.isValid) {
    return {
      kind: 'definitive_failure', stage: 'verify', verifyPassed: false,
      reason, payer: result.payer, result,
    };
  }
  if (result.raw.settle?.success === false) {
    return {
      kind: 'definitive_failure', stage: 'settle', verifyPassed: true,
      reason, payer: result.payer, result,
    };
  }
  return {
    kind: 'ambiguous',
    verifyPassed: true,
    reason,
    payer: result.payer,
    signature: result.txSignature,
    result,
  };
}
