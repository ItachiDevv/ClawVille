import { z } from 'zod';
import { TransactionMessage, type VersionedTransaction } from '@solana/web3.js';
import { decodeTransferCheckedInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { BrainchainPurchaseError } from './purchase-policy';
import type { BuyerReceiptEvidence } from './purchase-receipts';
import { SOLANA_BUYER_LANE as L, solanaBuyerSignature } from './purchase-solana-policy';
import { completedSolanaBuyerTransactionId, decodeSolanaBuyerTransaction, verifySolanaBuyerSignatureSet, type SolanaBuyerArtifact } from './purchase-solana-transaction';
import { SolanaBuyerRpc } from './purchase-solana-rpc';

const integer = z.number().int().nonnegative().safe();
const tokenBalance = z.object({accountIndex: integer, mint: z.literal(L.token), owner: z.string(),
  uiTokenAmount: z.object({amount: z.string().regex(/^(0|[1-9][0-9]*)$/), decimals: z.literal(6)}).passthrough()}).passthrough();
const transactionSchema = z.object({slot: integer, blockTime: integer.nullable(), transaction: z.tuple([z.string().max(1644), z.literal('base64')]),
  meta: z.object({err: z.null(), preTokenBalances: z.array(tokenBalance).max(20), postTokenBalances: z.array(tokenBalance).max(20),
    innerInstructions: z.array(z.unknown()).max(0), loadedAddresses: z.object({writable: z.array(z.string()).max(0), readonly: z.array(z.string()).max(0)}).optional(),
  }).passthrough(), version: z.union([z.literal(0), z.literal('legacy')]).optional(),
}).passthrough();
const blockSchema = z.object({blockhash: z.string().min(32).max(44), blockTime: integer.nullable(), signatures: z.array(solanaBuyerSignature).max(5000).optional()}).passthrough();
export interface SolanaBuyerReceiptEvidence extends BuyerReceiptEvidence {finality: 'confirmed'|'finalized';network: typeof L.network}
/** Pure verifier. The production caller below supplies the fixed desk and asset pins. */
export function verifySolanaRefundTransaction(tx: VersionedTransaction, expected: {source: string;destination: string;mint: string;authority: string;amount: bigint;decimals: number}): void {
  if (tx.message.addressTableLookups.length !== 0) throw new Error('Refund lookup tables refused');
  const message = TransactionMessage.decompile(tx.message);
  if (message.instructions.length !== 1) throw new Error('Refund instruction shape refused');
  const instruction = message.instructions[0]!;
  if (instruction.keys.length !== 4 || instruction.data.length !== 10) throw new Error('Refund account shape refused');
  const transfer = decodeTransferCheckedInstruction(instruction, TOKEN_PROGRAM_ID);
  const feePayer = message.payerKey.toBase58(), authorityIsFeePayer = feePayer === expected.authority;
  const expectedSigners = authorityIsFeePayer ? [expected.authority] : [feePayer, expected.authority];
  if (transfer.keys.source.pubkey.toBase58() !== expected.source || transfer.keys.destination.pubkey.toBase58() !== expected.destination
    || transfer.keys.mint.pubkey.toBase58() !== expected.mint || transfer.keys.owner.pubkey.toBase58() !== expected.authority
    || transfer.data.amount !== expected.amount || transfer.data.decimals !== expected.decimals || transfer.keys.multiSigners.length !== 0
    || transfer.keys.source.isSigner || !transfer.keys.source.isWritable || transfer.keys.destination.isSigner || !transfer.keys.destination.isWritable
    || transfer.keys.mint.isSigner || transfer.keys.mint.isWritable || !transfer.keys.owner.isSigner || transfer.keys.owner.isWritable !== authorityIsFeePayer) throw new Error('Refund transfer authority refused');
  const required = new Set([feePayer, expected.authority, expected.source, expected.destination, expected.mint, TOKEN_PROGRAM_ID.toBase58()]);
  if (required.size !== (authorityIsFeePayer ? 5 : 6) || tx.message.staticAccountKeys.length !== required.size
    || tx.message.staticAccountKeys.some(key => !required.has(key.toBase58()))) throw new Error('Refund account inventory refused');
  const programIndex = tx.message.staticAccountKeys.findIndex(key => key.equals(TOKEN_PROGRAM_ID));
  if (programIndex < 0 || tx.message.isAccountWritable(programIndex) || tx.message.isAccountSigner(programIndex)) throw new Error('Refund token program role refused');
  verifySolanaBuyerSignatureSet(tx, expectedSigners);
}
export class SolanaBuyerReceipts {
  constructor(private readonly rpc = new SolanaBuyerRpc()) {}
  async verify(transaction: string, artifact: SolanaBuyerArtifact, kind: 'payment'|'refund', afterBlock?: bigint, finality: 'confirmed'|'finalized' = 'confirmed', signal?:AbortSignal): Promise<SolanaBuyerReceiptEvidence> {
    solanaBuyerSignature.parse(transaction); await this.rpc.genesis(signal);
    try {
      const options = {encoding: 'base64', commitment: finality, maxSupportedTransactionVersion: 0};
      const receipt = transactionSchema.parse(await this.rpc.read('getTransaction', [transaction, options],signal));
      const tx = decodeSolanaBuyerTransaction(receipt.transaction[0]);
      if (kind === 'payment') {
        if (completedSolanaBuyerTransactionId(artifact, receipt.transaction[0]) !== transaction) throw new Error();
      } else {
        if (afterBlock === undefined || BigInt(receipt.slot) <= afterBlock || tx.message.addressTableLookups.length !== 0) throw new Error();
        verifySolanaRefundTransaction(tx, {source: artifact.destinationAta, destination: artifact.sourceAta, mint: L.token,
          authority: L.recipient, amount: BigInt(L.amountAtomic), decimals: L.decimals});
        // RPC signature lookup identifies the fee payer's transaction, not a payer signature.
        if (bs58.encode(tx.signatures[0]!) !== transaction) throw new Error();
      }
      const source = kind === 'payment' ? artifact.sourceAta : artifact.destinationAta;
      const destination = kind === 'payment' ? artifact.destinationAta : artifact.sourceAta;
      const keys = tx.message.staticAccountKeys;
      const sourceIndex = keys.findIndex(key => key.toBase58() === source), destinationIndex = keys.findIndex(key => key.toBase58() === destination);
      const delta = (index: number) => {
        const before = receipt.meta.preTokenBalances.filter(item => item.accountIndex === index), after = receipt.meta.postTokenBalances.filter(item => item.accountIndex === index);
        if (index < 0 || before.length !== 1 || after.length !== 1 || before[0]!.owner !== after[0]!.owner) throw new Error();
        const expected = index === sourceIndex ? kind === 'payment' ? artifact.payer : L.recipient : kind === 'payment' ? L.recipient : artifact.payer;
        if (before[0]!.owner !== expected) throw new Error();
        return BigInt(after[0]!.uiTokenAmount.amount) - BigInt(before[0]!.uiTokenAmount.amount);
      };
      if (delta(sourceIndex) !== -BigInt(L.amountAtomic) || delta(destinationIndex) !== BigInt(L.amountAtomic)) throw new Error();
      const block = blockSchema.parse(await this.rpc.read('getBlock', [receipt.slot, {commitment: finality, transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0}],signal));
      if (!block.signatures?.includes(transaction)) throw new Error();
      const head = z.object({context: z.object({slot: integer}), value: z.unknown()}).parse(await this.rpc.read('getLatestBlockhash', [{commitment: finality, minContextSlot: receipt.slot}],signal));
      const headBlock = blockSchema.parse(await this.rpc.read('getBlock', [head.context.slot, {commitment: finality, transactionDetails: 'none', rewards: false}],signal));
      const canonical = blockSchema.parse(await this.rpc.read('getBlock', [receipt.slot, {commitment: finality, transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0}],signal));
      const again = transactionSchema.parse(await this.rpc.read('getTransaction', [transaction, options],signal));
      const age = Date.now() / 1000 - (headBlock.blockTime ?? 0);
      if (head.context.slot < receipt.slot || receipt.blockTime === null || canonical.blockTime !== receipt.blockTime || JSON.stringify(again.meta.preTokenBalances) !== JSON.stringify(receipt.meta.preTokenBalances) || JSON.stringify(again.meta.postTokenBalances) !== JSON.stringify(receipt.meta.postTokenBalances) || canonical.blockhash !== block.blockhash || !canonical.signatures?.includes(transaction) || again.slot !== receipt.slot || again.transaction[0] !== receipt.transaction[0] || age < -5 || age > 120) throw new Error();
      return {transaction, logIndex: kind === 'payment' ? 2 : 0, blockNumber: String(receipt.slot), blockHash: block.blockhash,
        observedAt: new Date().toISOString(), headNumber: String(head.context.slot), headHash: headBlock.blockhash, headTimestamp: String(headBlock.blockTime), provisional: true, finality, network: L.network};
    } catch { throw new BrainchainPurchaseError('receipt_unavailable'); }
  }
}
