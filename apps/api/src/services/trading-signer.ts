import bs58 from 'bs58';
import { createHash } from 'crypto';
import type { Wallet } from '@clawville/database';
import type { TradeRefusalCode } from '@clawville/shared';
import { AddressLookupTableAccount, Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { decryptWalletRow } from './keypair-vault';
import { inspectTradingSwapTransaction, validateTradingLegs, type SwapLeg, type SwapShape } from './trading-swap-validator';

export type SignAndSendOutcome =
  | { kind: 'submitted'; signature: string }
  | { kind: 'refused_presign'; code: TradeRefusalCode; detail: string }
  | { kind: 'reconcile'; signature: string | null; detail: string };

export interface TradingSignerDeps {
  connection?: Connection;
  keypair?: Keypair;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
  priorityFeeLamports?: bigint;
  persistCaptured?: (input: {
    signedBytes: Uint8Array;
    signature: string;
    recentBlockhash: string;
    lastValidBlockHeight: number;
    buildHash: string;
  }) => Promise<void>;
  sendRawTransaction?: (bytes: Uint8Array) => Promise<string>;
}

export function isValidSolanaSignature(signature: string): boolean {
  try { return bs58.decode(signature).length === 64; } catch { return false; }
}

export async function loadTradingKeypair(walletRow: Wallet, boundPubkey: string): Promise<Keypair | null> {
  const keypair = await decryptWalletRow(walletRow);
  return keypair.publicKey.toBase58() === walletRow.publicKey && walletRow.publicKey === boundPubkey ? keypair : null;
}

export async function signTradingSwap(input: {
  walletRow: Wallet;
  boundPubkey: string;
  transaction: VersionedTransaction;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  admittedMinOut: bigint;
  inputLeg: SwapLeg;
  outputLeg: SwapLeg;
  shape: SwapShape;
  inputAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  deps?: TradingSignerDeps;
}): Promise<SignAndSendOutcome> {
  const keypair = input.deps?.keypair ?? await loadTradingKeypair(input.walletRow, input.boundPubkey);
  if (!keypair || input.walletRow.publicKey !== input.boundPubkey || keypair.publicKey.toBase58() !== input.boundPubkey) {
    return { kind: 'refused_presign', code: 'keypair_mismatch', detail: 'custody binding mismatch' };
  }
  if (input.transaction.message.recentBlockhash !== input.recentBlockhash) {
    return { kind: 'refused_presign', code: 'tx_binding_failed', detail: 'recent blockhash mismatch' };
  }
  const wallet = new PublicKey(input.boundPubkey);
  const legs = validateTradingLegs({ wallet, inputLeg: input.inputLeg, outputLeg: input.outputLeg, shape: input.shape });
  if (!legs.ok) return { kind: 'refused_presign', code: 'tx_binding_failed', detail: legs.detail };
  const inspection = inspectTradingSwapTransaction({
    transaction: input.transaction,
    wallet,
    inputAmount: input.inputAmount,
    minimumOutAmount: input.admittedMinOut,
    priorityFeeLamports: input.deps?.priorityFeeLamports ?? 1_000_000n,
    addressLookupTableAccounts: input.deps?.addressLookupTableAccounts,
    inputLeg: input.inputLeg,
    outputLeg: input.outputLeg,
    shape: input.shape,
    quotedOutAmount: input.quotedOutAmount,
    slippageBps: input.slippageBps,
  });
  if (!inspection.ok) {
    const code: TradeRefusalCode = inspection.detail === 'minimum_out_mismatch' || inspection.detail === 'minimum_out_non_positive'
      ? 'min_out_below_admitted'
      : inspection.detail === 'priority_fee' ? 'sol_reserve_breached' : 'tx_binding_failed';
    return { kind: 'refused_presign', code, detail: inspection.detail };
  }
  if (inspection.minimumOutAmount < input.admittedMinOut) {
    return { kind: 'refused_presign', code: 'min_out_below_admitted', detail: 'built minimum is below admission' };
  }
  input.transaction.sign([keypair]);
  const signature = bs58.encode(input.transaction.signatures[0]!);
  if (!isValidSolanaSignature(signature)) return { kind: 'reconcile', signature: null, detail: 'captured signature invalid' };
  const signedBytes = input.transaction.serialize();
  const buildHash = createHash('sha256').update(signedBytes).digest('hex');
  try {
    await input.deps?.persistCaptured?.({ signedBytes, signature, recentBlockhash: input.recentBlockhash, lastValidBlockHeight: input.lastValidBlockHeight, buildHash });
  } catch (error) {
    return { kind: 'reconcile', signature, detail: `capture persistence failed: ${error instanceof Error ? error.message : 'unknown'}` };
  }
  return { kind: 'submitted', signature };
}

export async function sendSignedTradingSwap(input: {
  signedBytes: Uint8Array;
  expectedSignature: string;
  deps?: TradingSignerDeps;
}): Promise<{ kind: 'sent' } | { kind: 'signature_mismatch' } | { kind: 'ambiguous'; detail: string }> {
  try {
    const send = input.deps?.sendRawTransaction ?? (async (bytes: Uint8Array) => {
      if (!input.deps?.connection) throw new Error('connection is required');
      return input.deps.connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 0 });
    });
    const returned = await send(input.signedBytes);
    return returned === input.expectedSignature ? { kind: 'sent' } : { kind: 'signature_mismatch' };
  } catch (error) {
    return { kind: 'ambiguous', detail: error instanceof Error ? error.message : 'send failed' };
  }
}
