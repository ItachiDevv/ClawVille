/**
 * Read-only Solana USDC verifier used by the x402 reconciliation worker.
 *
 * The caller supplies the network connection and the cross-table signature
 * ownership check. Keeping both behind dependencies makes every money decision
 * unit-testable and prevents this parser from silently choosing a cluster or
 * treating a database outage as an unbound signature.
 */

import { PublicKey, type Connection } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { z } from 'zod';
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  type X402Network,
} from './x402-payai';

const atomicSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const signatureSchema = z.string().trim().min(1).max(128);
const addressSchema = z.string().trim().min(32).max(64).refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, 'invalid Solana public key');

const parsedTransferCheckedSchema = z.object({
  program: z.literal('spl-token'),
  parsed: z.object({
    type: z.literal('transferChecked'),
    info: z.object({
      source: addressSchema,
      destination: addressSchema,
      authority: addressSchema,
      mint: addressSchema,
      tokenAmount: z.object({
        amount: atomicSchema,
        decimals: z.number().int().min(0).max(255),
        uiAmount: z.number().nullable().optional(),
        uiAmountString: z.string().optional(),
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const parsedTransactionSchema = z.object({
  blockTime: z.number().int().nonnegative().nullable(),
  meta: z.object({
    err: z.unknown().nullable(),
    innerInstructions: z.array(z.object({
      index: z.number().int().nonnegative(),
      instructions: z.array(z.unknown()),
    }).passthrough()).nullable().optional(),
  }).passthrough().nullable(),
  transaction: z.object({
    message: z.object({
      instructions: z.array(z.unknown()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const signatureInfoSchema = z.object({
  signature: signatureSchema,
  blockTime: z.number().int().nonnegative().nullable(),
  err: z.unknown().nullable(),
}).passthrough();
const signaturePageSchema = z.array(signatureInfoSchema);

export interface ReconcileSignatureInfo {
  signature: string;
  blockTime: number | null;
  err?: unknown | null;
}

export function parseReconcileSignaturePage(raw: unknown): ReconcileSignatureInfo[] {
  return signaturePageSchema.parse(raw);
}

export interface ReconcileChainDeps {
  getParsedTransaction(network: X402Network, signature: string): Promise<unknown | null>;
  getSignaturesForAddress(
    network: X402Network,
    address: string,
    options: { before?: string; until?: string; limit: number },
  ): Promise<unknown>;
  /** Must check tx_signature ownership across x402_checkouts, ct_topups, and
   * agent_payments. A rejected lookup aborts the probe; it never fails open. */
  isSignatureBound(signature: string): Promise<boolean>;
}

/** Adapt an injected/reused Solana connection source to the verifier API. */
export function createConnectionReconcileChainDeps(
  connectionForNetwork: (network: X402Network) => Connection,
  isSignatureBound: (signature: string) => Promise<boolean>,
): ReconcileChainDeps {
  return {
    async getParsedTransaction(network, signature) {
      return connectionForNetwork(network).getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    },
    async getSignaturesForAddress(network, address, options) {
      return connectionForNetwork(network).getSignaturesForAddress(
        new PublicKey(address),
        options,
        'confirmed',
      );
    },
    isSignatureBound,
  };
}

/** Resolve only the two rails supported by the settle machines. Unknown values
 * are refused instead of falling back to the process-wide configured network. */
export function resolveReconcileNetwork(value: unknown): X402Network | null {
  if (value === 'mainnet' || value === SOLANA_MAINNET_CAIP2) return 'mainnet';
  if (value === 'devnet' || value === SOLANA_DEVNET_CAIP2) return 'devnet';
  return null;
}

/** Derive the classic SPL associated token account for a wallet owner + mint. */
export function deriveUsdcAta(owner: string, mint: string): string {
  const ownerKey = new PublicKey(addressSchema.parse(owner));
  const mintKey = new PublicKey(addressSchema.parse(mint));
  return getAssociatedTokenAddressSync(mintKey, ownerKey, false).toBase58();
}

export interface VerifiedUsdcTransfer {
  signature: string;
  atomicAmount: string;
  mint: string;
  destinationAta: string;
  sourceAta: string;
  payer: string;
  blockTime: number | null;
}

export type ChainVerification =
  | { kind: 'confirmed_match'; transfer: VerifiedUsdcTransfer }
  | {
      kind: 'confirmed_mismatch';
      signature: string;
      blockTime: number | null;
      reason:
        | 'no_transfer_checked'
        | 'wrong_destination'
        | 'wrong_mint'
        | 'wrong_amount'
        | 'wrong_payer'
        | 'multiple_exact_matches';
      transfers: VerifiedUsdcTransfer[];
    }
  | { kind: 'tx_failed'; signature: string; blockTime: number | null }
  | { kind: 'not_found'; signature: string };

export interface VerifyUsdcTransferInput {
  network: X402Network;
  signature: string;
  expectedAtomic: string;
  expectedMint: string;
  destinationOwner: string;
  expectedPayer?: string | null;
  /** Reconcile remains exact; live facilitator settlement accepts an overpay. */
  amountMode?: 'exact' | 'at_least';
}

function transferMismatchReason(
  transfers: VerifiedUsdcTransfer[],
  expected: {
    destinationAta: string;
    mint: string;
    atomic: string;
    payer: string | null;
  },
): Exclude<Extract<ChainVerification, { kind: 'confirmed_mismatch' }>['reason'], 'multiple_exact_matches'> {
  if (transfers.length === 0) return 'no_transfer_checked';
  const toDestination = transfers.filter((t) => t.destinationAta === expected.destinationAta);
  if (toDestination.length === 0) return 'wrong_destination';
  const correctMint = toDestination.filter((t) => t.mint === expected.mint);
  if (correctMint.length === 0) return 'wrong_mint';
  if (expected.payer && !correctMint.some((t) => t.payer === expected.payer)) {
    return 'wrong_payer';
  }
  return 'wrong_amount';
}

export function aggregatePayerTransfers(
  transfers: VerifiedUsdcTransfer[],
): Array<{ payer: string; total: bigint; transfers: VerifiedUsdcTransfer[] }> {
  const groups = new Map<string, { payer: string; total: bigint; transfers: VerifiedUsdcTransfer[] }>();
  for (const transfer of transfers) {
    const group = groups.get(transfer.payer) ?? {
      payer: transfer.payer,
      total: 0n,
      transfers: [],
    };
    group.total += BigInt(transfer.atomicAmount);
    group.transfers.push(transfer);
    groups.set(transfer.payer, group);
  }
  return [...groups.values()];
}

export type ParsedUsdcTransaction =
  | { kind: 'not_found'; signature: string }
  | { kind: 'tx_failed'; signature: string; blockTime: number | null }
  | {
      kind: 'confirmed';
      signature: string;
      blockTime: number | null;
      transfers: VerifiedUsdcTransfer[];
    };

/**
 * Parse every SPL `transferChecked` instruction from one transaction. This is
 * the single parser used by both per-row verification and the bulk outage
 * indexer, so the two recovery paths cannot drift on instruction semantics.
 */
export function parseUsdcTransaction(
  rawSignature: string,
  raw: unknown | null,
): ParsedUsdcTransaction {
  const signature = signatureSchema.parse(rawSignature);
  if (raw === null) return { kind: 'not_found', signature };

  const tx = parsedTransactionSchema.parse(raw);
  if (!tx.meta) throw new Error(`transaction ${signature} has no meta`);
  if (tx.meta.err !== null) {
    return { kind: 'tx_failed', signature, blockTime: tx.blockTime };
  }

  const instructions: unknown[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta.innerInstructions ?? []) {
    instructions.push(...inner.instructions);
  }
  const transfers: VerifiedUsdcTransfer[] = [];
  for (const instruction of instructions) {
    const parsed = parsedTransferCheckedSchema.safeParse(instruction);
    if (!parsed.success) continue;
    const info = parsed.data.parsed.info;
    transfers.push({
      signature,
      atomicAmount: info.tokenAmount.amount,
      mint: info.mint,
      destinationAta: info.destination,
      sourceAta: info.source,
      payer: info.authority,
      blockTime: tx.blockTime,
    });
  }
  return {
    kind: 'confirmed',
    signature,
    blockTime: tx.blockTime,
    transfers,
  };
}

/** Verify one signature against an exact USDC transfer. Malformed RPC payloads
 * throw so the reconciler skips the row rather than converting ambiguity into
 * a destructive no-money decision. */
export async function verifyUsdcTransfer(
  input: VerifyUsdcTransferInput,
  deps: Pick<ReconcileChainDeps, 'getParsedTransaction'>,
): Promise<ChainVerification> {
  const signature = signatureSchema.parse(input.signature);
  const expectedAtomic = atomicSchema.parse(input.expectedAtomic);
  const expectedMint = addressSchema.parse(input.expectedMint);
  const expectedPayer = input.expectedPayer == null
    ? null
    : addressSchema.parse(input.expectedPayer);
  const destinationAta = deriveUsdcAta(input.destinationOwner, expectedMint);
  const raw = await deps.getParsedTransaction(input.network, signature);
  const parsedTx = parseUsdcTransaction(signature, raw);
  if (parsedTx.kind === 'not_found') return parsedTx;
  if (parsedTx.kind === 'tx_failed') return parsedTx;
  const transfers = parsedTx.transfers;

  const applicable = transfers.filter((transfer) =>
    transfer.destinationAta === destinationAta
      && transfer.mint === expectedMint
      && (!expectedPayer || transfer.payer === expectedPayer));
  const exactGroups = aggregatePayerTransfers(applicable)
    .filter((group) => input.amountMode === 'at_least'
      ? group.total >= BigInt(expectedAtomic)
      : group.total === BigInt(expectedAtomic));
  if (exactGroups.length === 1) {
    const group = exactGroups[0];
    return {
      kind: 'confirmed_match',
      transfer: {
        ...group.transfers[0],
        atomicAmount: group.total.toString(),
        payer: group.payer,
      },
    };
  }
  return {
    kind: 'confirmed_mismatch',
    signature,
    blockTime: parsedTx.blockTime,
    reason: exactGroups.length > 1
      ? 'multiple_exact_matches'
      : transferMismatchReason(transfers, {
          destinationAta,
          mint: expectedMint,
          atomic: expectedAtomic,
          payer: expectedPayer,
        }),
    transfers,
  };
}

export interface ProbeUsdcTransfersInput {
  network: X402Network;
  expectedAtomic: string;
  expectedMint: string;
  destinationOwner: string;
  expectedPayer?: string | null;
  sinceIso: string;
  maxSignatures: number;
}

export type ProbeUsdcTransfersResult =
  | {
      kind: 'match';
      match: VerifiedUsdcTransfer;
      examined: number;
      excludedBound: number;
    }
  | {
      kind: 'ambiguous';
      matches: VerifiedUsdcTransfer[];
      examined: number;
      excludedBound: number;
    }
  | {
      kind: 'none';
      examined: number;
      excludedBound: number;
    }
  | {
      kind: 'indeterminate';
      reason: 'candidate_transaction_not_found' | 'lookback_cap_exhausted';
      examined: number;
      excludedBound: number;
    };

/** Scan the destination ATA newest-first within a hard signature cap. Exactly
 * one eligible match is returned; two matches are permanently ambiguous. */
export async function probeUsdcTransfers(
  input: ProbeUsdcTransfersInput,
  deps: ReconcileChainDeps,
): Promise<ProbeUsdcTransfersResult> {
  const sinceMs = new Date(input.sinceIso).getTime();
  if (!Number.isFinite(sinceMs)) throw new Error(`invalid reconcile sinceIso: ${input.sinceIso}`);
  if (!Number.isInteger(input.maxSignatures) || input.maxSignatures < 1) {
    throw new Error(`maxSignatures must be a positive integer, got ${input.maxSignatures}`);
  }
  const destinationAta = deriveUsdcAta(input.destinationOwner, input.expectedMint);
  const matches: VerifiedUsdcTransfer[] = [];
  let examined = 0;
  let excludedBound = 0;
  let unavailableCandidate = false;
  let before: string | undefined;
  let reachedSinceBoundary = false;
  let scanComplete = false;

  while (examined < input.maxSignatures && !reachedSinceBoundary && matches.length < 2) {
    const limit = Math.min(1_000, input.maxSignatures - examined);
    const rawPage = await deps.getSignaturesForAddress(
      input.network,
      destinationAta,
      before ? { before, limit } : { limit },
    );
    const page = signaturePageSchema.parse(rawPage);
    if (page.length === 0) {
      scanComplete = true;
      break;
    }

    for (const candidate of page) {
      if (examined >= input.maxSignatures) break;
      examined += 1;
      if (candidate.blockTime !== null && candidate.blockTime * 1_000 < sinceMs) {
        reachedSinceBoundary = true;
        break;
      }
      if (candidate.err !== null) continue;
      if (await deps.isSignatureBound(candidate.signature)) {
        excludedBound += 1;
        continue;
      }
      const verdict = await verifyUsdcTransfer({
        network: input.network,
        signature: candidate.signature,
        expectedAtomic: input.expectedAtomic,
        expectedMint: input.expectedMint,
        destinationOwner: input.destinationOwner,
        expectedPayer: input.expectedPayer,
      }, deps);
      if (verdict.kind === 'not_found') {
        unavailableCandidate = true;
        continue;
      }
      if (
        verdict.kind === 'confirmed_match'
        && verdict.transfer.blockTime !== null
        && verdict.transfer.blockTime * 1_000 >= sinceMs
      ) {
        matches.push(verdict.transfer);
        if (matches.length === 2) break;
      } else if (verdict.kind === 'confirmed_match' && verdict.transfer.blockTime === null) {
        unavailableCandidate = true;
      }
    }

    const last = page.at(-1)?.signature;
    if (reachedSinceBoundary || page.length < limit) {
      scanComplete = true;
      break;
    }
    if (!last || last === before) {
      throw new Error('reconcile signature pagination did not advance');
    }
    before = last;
  }

  if (matches.length > 1) return { kind: 'ambiguous', matches, examined, excludedBound };
  if (unavailableCandidate) {
    return {
      kind: 'indeterminate',
      reason: 'candidate_transaction_not_found',
      examined,
      excludedBound,
    };
  }
  if (!scanComplete && examined >= input.maxSignatures) {
    return {
      kind: 'indeterminate',
      reason: 'lookback_cap_exhausted',
      examined,
      excludedBound,
    };
  }
  if (matches.length === 1) return { kind: 'match', match: matches[0], examined, excludedBound };
  return { kind: 'none', examined, excludedBound };
}
