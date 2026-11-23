import { createHash, randomBytes } from 'node:crypto';
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { BrainchainPurchaseError, buyerDigest, canonical, type BuyerTerms } from './purchase-policy';
import { SOLANA_BUYER_LANE as L, solanaBuyerAddress, solanaBuyerSignature } from './purchase-solana-policy';

export interface SolanaBuyerArtifact {
  version: 1; network: typeof L.network; genesisHash: typeof L.genesisHash; payer: string;
  sourceAta: string; destinationAta: string; blockhash: string; lastValidBlockHeight: number; contextSlot: number;
  messageHash: string; unsignedTransaction: string; memo: string;
}
const memoProgram = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export function buildSolanaBuyerArtifact(payer: string, lifetime: {blockhash: string;lastValidBlockHeight: number;contextSlot: number}, memo = randomBytes(16).toString('hex')): SolanaBuyerArtifact {
  solanaBuyerAddress.parse(payer); solanaBuyerAddress.parse(lifetime.blockhash);
  if (payer === L.feePayer || payer === L.recipient || !PublicKey.isOnCurve(new PublicKey(payer).toBytes()) || !/^[a-f0-9]{32}$/.test(memo)
    || !Number.isSafeInteger(lifetime.lastValidBlockHeight) || lifetime.lastValidBlockHeight <= 0 || !Number.isSafeInteger(lifetime.contextSlot) || lifetime.contextSlot <= 0) throw new BrainchainPurchaseError('invalid_request');
  const mint = new PublicKey(L.token), authority = new PublicKey(payer);
  const source = getAssociatedTokenAddressSync(mint, authority), destination = getAssociatedTokenAddressSync(mint, new PublicKey(L.recipient));
  const message = new TransactionMessage({ payerKey: new PublicKey(L.feePayer), recentBlockhash: lifetime.blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({units: 20000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}),
    createTransferCheckedInstruction(source, mint, destination, authority, BigInt(L.amountAtomic), L.decimals, [], TOKEN_PROGRAM_ID),
    new TransactionInstruction({programId: memoProgram, keys: [], data: Buffer.from(memo, 'utf8')}),
  ] }).compileToV0Message();
  // Kit (used by x402/svm2.9.0) sorts each account-role group by address.
  // web3.js keeps insertion order. Reindex the pure message to the SDK's wire order.
  const original = [...message.staticAccountKeys];
  const rank = (index: number) => index === 0 ? 0 : message.isAccountSigner(index) ? message.isAccountWritable(index) ? 1 : 2 : message.isAccountWritable(index) ? 3 : 4;
  const order = original.map((key, index) => ({key, index})).sort((a, b) => rank(a.index) - rank(b.index) || (a.key.toBase58() < b.key.toBase58() ? -1 : a.key.equals(b.key) ? 0 : 1));
  const relocated = new Map(order.map((item, index) => [item.index, index]));
  message.staticAccountKeys = order.map(item => item.key);
  message.compiledInstructions = message.compiledInstructions.map(instruction => ({...instruction, programIdIndex: relocated.get(instruction.programIdIndex)!, accountKeyIndexes: instruction.accountKeyIndexes.map(index => relocated.get(index)!)}));
  return Object.freeze({version: 1, network: L.network, genesisHash: L.genesisHash, payer, sourceAta: source.toBase58(), destinationAta: destination.toBase58(),
    blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight, contextSlot: lifetime.contextSlot, memo, messageHash: createHash('sha256').update(message.serialize()).digest('hex'), unsignedTransaction: Buffer.from(new VersionedTransaction(message).serialize()).toString('base64')});
}
export function solanaBuyerIntent(terms: BuyerTerms, artifact: SolanaBuyerArtifact): string {
  return ['ClawVille BrainChain Solana devnet purchase', canonical({version: 1, ...terms, network: L.network, genesisHash: L.genesisHash,
    endpoint: L.endpoint, token: L.token, recipient: L.recipient, feePayer: L.feePayer, amountAtomic: L.amountAtomic,
    sourceAta: artifact.sourceAta, destinationAta: artifact.destinationAta, messageHash: artifact.messageHash,
    blockhash: artifact.blockhash, lastValidBlockHeight: artifact.lastValidBlockHeight, contextSlot: artifact.contextSlot,
    permanentAvatarBinding: true})].join('\n');
}
export function decodeSolanaBuyerTransaction(raw: string): VersionedTransaction {
  try {
    if (raw.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error();
    const bytes = Buffer.from(raw, 'base64'); if (bytes.length > 1232 || bytes.toString('base64') !== raw) throw new Error();
    const tx = VersionedTransaction.deserialize(bytes); if (Buffer.from(tx.serialize()).toString('base64') !== raw) throw new Error(); return tx;
  } catch { throw new BrainchainPurchaseError('invalid_proof'); }
}
/** Pure cryptographic verifier. Production callers supply the pinned signer keys. */
export function verifySolanaBuyerSignatureSet(tx: VersionedTransaction, expectedKeys: readonly string[]): void {
  if (expectedKeys.length !== tx.message.header.numRequiredSignatures || tx.signatures.length !== expectedKeys.length || expectedKeys.length > 2) throw new BrainchainPurchaseError('invalid_proof');
  for (let index = 0; index < expectedKeys.length; index++) {
    const key = new PublicKey(expectedKeys[index]!);
    if (!tx.message.staticAccountKeys[index]?.equals(key) || !nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[index]!, key.toBytes())) throw new BrainchainPurchaseError('invalid_proof');
  }
}
export function verifySolanaBuyerTransaction(artifact: SolanaBuyerArtifact, raw: string, completed: boolean): VersionedTransaction {
  const rebuilt = buildSolanaBuyerArtifact(artifact.payer, artifact, artifact.memo);
  if (canonical(rebuilt) !== canonical(artifact)) throw new BrainchainPurchaseError('invalid_proof');
  const tx = decodeSolanaBuyerTransaction(raw), unsigned = decodeSolanaBuyerTransaction(artifact.unsignedTransaction);
  const bytes = tx.message.serialize();
  if (Buffer.compare(Buffer.from(bytes), Buffer.from(unsigned.message.serialize())) !== 0 || tx.signatures.length !== 2
    || tx.message.header.numRequiredSignatures !== 2 || tx.message.staticAccountKeys[0]?.toBase58() !== L.feePayer
    || tx.message.staticAccountKeys[1]?.toBase58() !== artifact.payer || tx.message.addressTableLookups.length !== 0
    || !nacl.sign.detached.verify(bytes, tx.signatures[1]!, new PublicKey(artifact.payer).toBytes())) throw new BrainchainPurchaseError('invalid_proof');
  const feeSigned = tx.signatures[0]!.some(value => value !== 0);
  if (completed) verifySolanaBuyerSignatureSet(tx, [L.feePayer, artifact.payer]);
  else if (feeSigned) throw new BrainchainPurchaseError('invalid_proof');
  return tx;
}
export function verifySolanaBuyerIntent(terms: BuyerTerms, artifact: SolanaBuyerArtifact, signature: string): void {
  solanaBuyerSignature.parse(signature);
  if (artifact.payer !== terms.payer || !nacl.sign.detached.verify(Buffer.from(solanaBuyerIntent(terms, artifact)), bs58.decode(signature), new PublicKey(terms.payer).toBytes())) throw new BrainchainPurchaseError('invalid_proof');
}
/** The first signature becomes a transaction ID only after the fee payer signs. */
export function completedSolanaBuyerTransactionId(artifact: SolanaBuyerArtifact, raw: string): string {
  return bs58.encode(verifySolanaBuyerTransaction(artifact, raw, true).signatures[0]!);
}
