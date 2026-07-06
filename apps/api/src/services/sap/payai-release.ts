/**
 * SAP payai rail — the x402/PayAI SETTLEMENT leg of the three-party topology.
 *
 *   SAP      = the escrow/at-most-once RECORD gate (sap_escrow_settlements +
 *              sap_escrow_approvals — escrow-gate.ts, unchanged discipline).
 *   Covenant = the release AUTHORIZATION (the verification provider verdict +
 *              audit root; a settle fires ONLY on passed===true).
 *   PayAI    = the actual USDC MOVEMENT (this module): an x402 v2 `exact`-scheme
 *              payment — depositor's custodial wallet signs a transfer_checked,
 *              the PayAI facilitator verifies + co-signs as fee payer + submits
 *              it on-chain — driven through the ONE sanctioned PayAI boundary,
 *              `x402-payai.verifyAndSettle`.
 *
 * ── CONSERVATION (no double-pay, by construction) ─────────────────────────────
 * A `payai`-rail job NEVER touches the on-chain SAP vault: `openEscrow` records
 * the commitment in the settlement ledger WITHOUT running the on-chain funding
 * leg, and `settleJob` dispatches HERE instead of `settleCallsUsdc`. Exactly ONE
 * USDC movement exists for the job — the facilitator-settled depositor→worker
 * transfer — and it is reached only after the escrow gate's atomic `settling`
 * claim (the (escrow_pda, job_id) at-most-once lock). The rail is recorded on
 * the row at OPEN; settle dispatch follows the ROW, never the env flag, so a
 * flag flip mid-lifecycle can never fund a vault AND settle via PayAI.
 *
 * ── Two-phase shape (prepare → execute) ───────────────────────────────────────
 * `preparePayaiRelease` does EVERYTHING fallible that moves no money (gate
 * checks, facilitator fee-payer discovery, custodial decrypt + payload signing)
 * BEFORE the escrow gate takes its `settling` claim — a transient failure there
 * returns a clean structured error and leaves the row retryable. Only
 * `executePayaiRelease` (verify→settle, or verify-only on dry-run) runs after
 * the claim, so the terminal-`failed` window is as small as the facilitator
 * interaction itself. Mirrors the on-chain rail's failure posture: a post-claim
 * failure lands `failed` (never auto-retried — an attempted settle may have
 * reached the wire; re-driving would risk a double-pay).
 *
 * ── Secret hygiene ────────────────────────────────────────────────────────────
 * The depositor's custodial keypair is decrypted IN MEMORY ONLY (via the
 * sign-scoped sap-client loader), used to sign the x402 payload, and falls out
 * of scope. It is never logged, echoed, persisted, or attached to a result.
 *
 * ── Gates (all must hold before anything runs) ────────────────────────────────
 * SAP_ENABLED + SAP_ESCROW_ENABLED + SAP_USDC_ESCROW_ENABLED (checked by the
 * escrow gate) + SAP_PAYAI_SETTLEMENT_ENABLED (this rail) — all default OFF.
 * SAP_DRY_RUN=true (the default) maps to facilitator VERIFY-ONLY: the payload
 * is built + verified but `/settle` is never called, so no USDC can move.
 * The facilitator MUST be PayAI (preset 'payai'), the staging mock, or an
 * explicit operator URL — the silent CDP default is REFUSED (the #1 partner
 * constraint: all x402 payment facilitation routes through PayAI).
 * Mainnet inherits the SAP code gate: `sapConfigSnapshot()` → `loadSapConfig()`
 * throws unless SAP_ALLOW_MAINNET was deliberately flipped in code.
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type { PaymentRequirements } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import {
  verifyAndSettle,
  resolveFacilitatorFeePayer,
  caip2ForNetwork,
  usdcMintForNetwork,
  type X402Network,
} from '../x402-payai';
import { loadX402Config } from '../x402-config';
import { sapConfigSnapshot, loadAvatarWalletForSigning } from './sap-client';

// ─── structured results (NEVER throw raw to the gate) ─────────────────────────

export interface PreparedPayaiRelease {
  ok: true;
  /** base64(JSON) x402 payment payload, signed by the DEPOSITOR's custodial key. */
  paymentHeader: string;
  /** The server-derived requirements the payload was built against. */
  requirements: PaymentRequirements;
  /** The facilitator fee payer bound into `requirements.extra.feePayer`. */
  feePayer: string;
  network: X402Network;
  /** The payer (depositor custodial) pubkey — audit only, never the secret. */
  payerPubkey: string;
}

export interface PayaiReleaseFailure {
  ok: false;
  code:
    | 'payai_rail_disabled'
    | 'payai_unavailable'
    | 'avatar_wallet_missing'
    | 'internal';
  message: string;
}

export type PayaiPrepareResult = PreparedPayaiRelease | PayaiReleaseFailure;

export type PayaiExecOutcome =
  /** Dry-run: facilitator VERIFY passed; `/settle` was never called. */
  | { ok: true; dryRun: true; signature: null; payer: string | null }
  /** Live: facilitator settled on-chain — the confirmed tx signature. */
  | { ok: true; dryRun: false; signature: string; payer: string | null }
  | {
      ok: false;
      code: 'payai_release_failed';
      message: string;
      /**
       * TRUE when the facilitator VERIFY passed, so a `/settle` was ATTEMPTED
       * and may have reached the wire before the failure — the escrow gate must
       * treat the row like a broadcast-unconfirmed chain settle (terminal
       * `failed`, reconciler inspects; NEVER auto-retried). FALSE means the
       * failure was verify-stage: provably nothing was submitted.
       */
      broadcastUnknown: boolean;
    };

// ─── phase 1: PREPARE (no money moves; safe to fail pre-claim) ────────────────

export interface PreparePayaiReleaseInput {
  /** The escrow depositor (bounty creator) — the PAYER whose custodial key signs. */
  depositorAvatarId: string;
  /** The worker's wallet pubkey (base58 OWNER address; the scheme derives the ATA). */
  workerWalletPubkey: string;
  /** USDC base units (6dp) this release moves — the escrow gate's releaseAmount. */
  amountBaseUnits: bigint;
  /** The (escrow, job) job id — bound into `extra` for wire-level audit. */
  jobId: string;
  /** Covenant/verification audit root (hex) — bound into `extra` (provenance
   *  parity with the on-chain rail's `service_hash` binding). */
  auditRootHex: string | null;
}

export async function preparePayaiRelease(
  input: PreparePayaiReleaseInput,
): Promise<PayaiPrepareResult> {
  const cfg = sapConfigSnapshot();
  if (!cfg.payaiSettlementEnabled) {
    return {
      ok: false,
      code: 'payai_rail_disabled',
      message: 'the PayAI x402 settlement rail is disabled (SAP_PAYAI_SETTLEMENT_ENABLED).',
    };
  }

  // SAP cluster → x402 network. The SAP mainnet CODE gate already fired inside
  // sapConfigSnapshot() if cluster=mainnet without the deliberate code flip.
  if (cfg.cluster !== 'devnet' && cfg.cluster !== 'mainnet') {
    return { ok: false, code: 'internal', message: `unsupported SAP cluster '${cfg.cluster}'.` };
  }
  const network: X402Network = cfg.cluster;

  // The #1 partner constraint — all x402 facilitation routes through PayAI. The
  // silently-defaulted CDP preset is REFUSED for this rail: the operator must
  // deliberately select 'payai' (prod), 'mock' (staging-only; the x402-config
  // boot guard crashes a prod box carrying the mock), or an explicit URL.
  let facilitatorPreset: string;
  let facilitatorUrlExplicit: boolean;
  try {
    const x402 = loadX402Config();
    facilitatorPreset = x402.facilitatorPreset;
    facilitatorUrlExplicit = x402.facilitatorUrlExplicit;
  } catch (err) {
    return {
      ok: false,
      code: 'payai_unavailable',
      message: `x402 config error: ${(err as Error).message}`,
    };
  }
  if (facilitatorPreset === 'cdp' && !facilitatorUrlExplicit) {
    return {
      ok: false,
      code: 'payai_unavailable',
      message:
        'the payai settlement rail requires X402_FACILITATOR_PRESET=payai (or the ' +
        'staging mock / an explicit X402_FACILITATOR_URL) — refusing the default CDP ' +
        'facilitator (all x402 payment facilitation routes through PayAI).',
    };
  }

  if (input.amountBaseUnits <= 0n) {
    return { ok: false, code: 'internal', message: 'release amount must be > 0.' };
  }

  // Discover the facilitator's fee payer for this network — the SVM exact scheme
  // requires it inside `extra.feePayer` and the facilitator rejects any other.
  const feePayer = await resolveFacilitatorFeePayer(network);
  if (!feePayer) {
    return {
      ok: false,
      code: 'payai_unavailable',
      message: 'facilitator /supported did not advertise an SVM fee payer for this network.',
    };
  }

  // Decrypt the DEPOSITOR's custodial keypair (in-memory only; sign-scoped).
  // The success shape has no `ok` key, so `'ok' in wallet` discriminates the
  // SapFailure branch cleanly.
  const wallet = await loadAvatarWalletForSigning(input.depositorAvatarId);
  if ('ok' in wallet) {
    return {
      ok: false,
      code: wallet.code === 'avatar_wallet_missing' ? 'avatar_wallet_missing' : 'internal',
      message: wallet.message,
    };
  }

  const caip2 = caip2ForNetwork(network);
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: caip2,
    amount: input.amountBaseUnits.toString(),
    asset: usdcMintForNetwork(network),
    payTo: input.workerWalletPubkey,
    maxTimeoutSeconds: 120,
    extra: {
      // REQUIRED by the SVM exact scheme — the facilitator gas sponsor.
      feePayer,
      // Wire-level audit binding (provenance parity with the on-chain rail's
      // service_hash): which job this payment releases + the Covenant/
      // verification audit root that authorized it. Harmless to honest flows.
      purpose: 'sap-payai-release',
      jobId: input.jobId,
      auditRootHex: input.auditRootHex,
    },
  };

  try {
    // Build + sign the x402 payment payload AS the depositor. The reference
    // @x402/svm exact client constructs the transfer_checked tx (fee payer =
    // facilitator, unsigned for that slot), signs it with the payer key, and
    // encodes it into the payload. RPC (blockhash) comes from the SAP cluster
    // config, so payment and rail can never straddle clusters.
    const payerSigner = await createKeyPairSignerFromBytes(wallet.keypair.secretKey);
    const client = new x402Client();
    client.register(caip2, new ExactSvmScheme(payerSigner, { rpcUrl: cfg.rpcUrl }));
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: {
        url: `clawville://sap/escrow/${input.jobId}/release`,
        description: `SAP payai-rail release for job ${input.jobId}`,
      },
      accepts: [requirements],
    });
    const paymentHeader = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    return {
      ok: true,
      paymentHeader,
      requirements,
      feePayer,
      network,
      payerPubkey: wallet.publicKey.toBase58(),
    };
  } catch (err) {
    // Payload construction failure (RPC/blockhash/signing). Nothing was sent to
    // the facilitator — provably no money moved. NEVER echo secret material;
    // the caught message is scheme/RPC-level only.
    return {
      ok: false,
      code: 'payai_unavailable',
      message: `failed to build the x402 payment payload: ${(err as Error).message}`,
    };
  }
}

// ─── phase 2: EXECUTE (post-claim; the only money-moving step) ────────────────

/**
 * Drive the facilitator with the prepared payment. `dryRun:true` (the
 * SAP_DRY_RUN posture) runs VERIFY ONLY — `/settle` is never called, no USDC
 * moves — and reports success iff the facilitator judged the payment valid.
 * Live mode is the full verify→settle through `x402-payai.verifyAndSettle`
 * (settle fires only on a passing verify; success requires a non-empty tx
 * signature). NEVER throws — the escrow gate maps the outcome onto the row.
 */
export async function executePayaiRelease(
  prep: PreparedPayaiRelease,
  opts: { dryRun: boolean },
): Promise<PayaiExecOutcome> {
  const result = await verifyAndSettle({
    paymentHeader: prep.paymentHeader,
    requirements: prep.requirements,
    verifyOnly: opts.dryRun,
  });

  if (opts.dryRun) {
    if (result.isValid === true) {
      return { ok: true, dryRun: true, signature: null, payer: result.payer };
    }
    return {
      ok: false,
      code: 'payai_release_failed',
      message: `payai dry-run verify failed: ${result.failureReason ?? 'payment_invalid'}`,
      broadcastUnknown: false, // verify-only can never submit
    };
  }

  if (result.settled && result.txSignature) {
    return { ok: true, dryRun: false, signature: result.txSignature, payer: result.payer };
  }
  return {
    ok: false,
    code: 'payai_release_failed',
    message: `payai settle failed: ${result.failureReason ?? 'settlement_failed'}`,
    // Verify passed ⇒ a /settle was attempted ⇒ it may have reached the wire
    // before the failure (conservative: treat as possibly-landed). Verify-stage
    // failure ⇒ /settle never ran ⇒ provably nothing was submitted.
    broadcastUnknown: result.isValid === true,
  };
}
