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
    paymentHeader: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    requirements,
    payerPubkey: input.payerPubkey,
    feePayer: input.feePayer,
    network: input.network,
  };
}

export type ExecutePreparedExactPaymentOutcome =
  | { kind: 'settled'; signature: string; payer: string | null; result: VerifyAndSettleResult }
  | { kind: 'verify_only'; payer: string | null; result: VerifyAndSettleResult }
  | {
      kind: 'definitive_failure';
      stage: 'verify' | 'settle';
      verifyPassed: boolean;
      reason: string;
      payer: string | null;
      result: VerifyAndSettleResult;
    }
  | {
      kind: 'ambiguous';
      verifyPassed: true;
      reason: string;
      payer: string | null;
      result: VerifyAndSettleResult;
    };

export async function executePreparedExactPayment(
  prep: Pick<PreparedCustodialExactPayment, 'paymentHeader' | 'requirements'>,
  opts: { verifyOnly?: boolean } = {},
): Promise<ExecutePreparedExactPaymentOutcome> {
  const result = await verifyAndSettle({
    paymentHeader: prep.paymentHeader,
    requirements: prep.requirements,
    verifyOnly: opts.verifyOnly,
  });
  if (opts.verifyOnly === true && result.isValid) {
    return { kind: 'verify_only', payer: result.payer, result };
  }
  if (result.settled && result.txSignature) {
    return { kind: 'settled', signature: result.txSignature, payer: result.payer, result };
  }
  const reason = result.failureReason ?? 'settlement_failed';
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
  return { kind: 'ambiguous', verifyPassed: true, reason, payer: result.payer, result };
}
