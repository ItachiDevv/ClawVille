'use client';
import bs58 from 'bs58';
import { z } from 'zod';
import type { BrainchainBuyerOrder } from '@clawville/shared';
import { getSolanaProvider } from './solana-wallet';

const network = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const recipient = 'AeRePM6UDB8onv5Mt9crXSaxfH8ivd7L7X71iqRaZ3Qi';
const feePayer = 'BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP';
const termsSchema = z.object({network: z.literal(network), intentMessage: z.string().min(100).max(5000), unsignedTransaction: z.string().max(1644),
  payer: z.string().min(32).max(44), messageHash: z.string().regex(/^[a-f0-9]{64}$/), lastValidBlockHeight: z.number().int().positive().safe()}).strict();
export async function connectBrainchainSolanaPayer(): Promise<string> {
  const provider = getSolanaProvider(); if (!provider) throw new Error('Connect a Solana wallet for this devnet purchase.');
  return (await provider.connect()).publicKey.toString();
}
async function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<void> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), {name: 'Ed25519'}, false, ['verify']);
  if (signature.length !== 64 || !await crypto.subtle.verify('Ed25519', key, new Uint8Array(signature), new Uint8Array(message))) throw new Error('The wallet returned an invalid signature.');
}
/** No sendTransaction, signAndSendTransaction, secret key, or RPC submission path exists. */
export async function signBrainchainSolanaPurchase(order: BrainchainBuyerOrder, raw: unknown, signal?: AbortSignal): Promise<{intentSignature: string;signedTransaction: string}> {
  const terms = termsSchema.parse(raw); const provider = getSolanaProvider();
  if (!provider || !('signTransaction' in provider) || typeof provider.signTransaction !== 'function') throw new Error('This wallet cannot sign a devnet transaction.');
  const {PublicKey, VersionedTransaction, TransactionMessage} = await import('@solana/web3.js');
  signal?.throwIfAborted();
  if ((await provider.connect()).publicKey.toString() !== terms.payer || order.payer !== terms.payer || order.network !== network || order.chainId !== null) throw new Error('Select the original devnet payer account.');
  const bytes = Uint8Array.from(atob(terms.unsignedTransaction), value => value.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(bytes), messageBytes = tx.message.serialize();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(messageBytes))), value => value.toString(16).padStart(2, '0')).join('');
  const lines = terms.intentMessage.split('\n');
  if (lines.length !== 2 || lines[0] !== 'ClawVille BrainChain Solana devnet purchase') throw new Error('The purchase intent is invalid.');
  const intent = z.object({orderId: z.literal(order.id), payer: z.literal(terms.payer), bodyHash: z.literal(order.bodyHash), network: z.literal(network),
    genesisHash: z.literal('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'), endpoint: z.literal('https://brain.testnet.usebrainchain.com/x402/tasks'),
    token: z.literal(mint), recipient: z.literal(recipient), feePayer: z.literal(feePayer), amountAtomic: z.literal('1000000'), messageHash: z.literal(hash),
    blockhash: z.string(), lastValidBlockHeight: z.literal(terms.lastValidBlockHeight), sourceAta: z.string(), destinationAta: z.string(), validBefore: z.string().regex(/^[0-9]+$/), permanentAvatarBinding: z.literal(true),
  }).passthrough().parse(JSON.parse(lines[1]!));
  const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), ataProgram = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ata = (owner: string) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), tokenProgram.toBuffer(), new PublicKey(mint).toBuffer()], ataProgram)[0].toBase58();
  const message = TransactionMessage.decompile(tx.message), instructions = message.instructions;
  const transfer = instructions[2];
  if (hash !== terms.messageHash || tx.version !== 0 || tx.message.addressTableLookups.length || tx.message.header.numRequiredSignatures !== 2 || tx.message.header.numReadonlySignedAccounts !== 1 || tx.message.header.numReadonlyUnsignedAccounts !== 4 || tx.message.staticAccountKeys.length !== 8 || tx.signatures.some(value => value.some(byte => byte !== 0))
    || tx.message.staticAccountKeys[0]?.toBase58() !== feePayer || tx.message.staticAccountKeys[1]?.toBase58() !== terms.payer || message.recentBlockhash !== intent.blockhash
    || Number(intent.validBefore) * 1000 <= Date.now() || instructions.length !== 4
    || instructions[0]?.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111' || instructions[0]?.data.toString('hex') !== '02204e0000' || instructions[0]?.keys.length !== 0
    || instructions[1]?.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111' || instructions[1]?.data.toString('hex') !== '030100000000000000' || instructions[1]?.keys.length !== 0
    || transfer?.programId.toBase58() !== tokenProgram.toBase58() || transfer.data.toString('hex') !== '0c40420f000000000006' || transfer.keys.length !== 4
    || transfer.keys.map(key => [key.isSigner,key.isWritable].join(':')).join(',') !== 'false:true,false:false,false:true,true:false'
    || transfer.keys.map(key => key.pubkey.toBase58()).join(',') !== [ata(terms.payer), mint, ata(recipient), terms.payer].join(',')
    || intent.sourceAta !== ata(terms.payer) || intent.destinationAta !== ata(recipient)
    || instructions[3]?.programId.toBase58() !== 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' || instructions[3].keys.length !== 0 || !/^[a-f0-9]{32}$/.test(instructions[3].data.toString())) throw new Error('The devnet transaction does not match this purchase.');
  signal?.throwIfAborted();
  const intentBytes = new TextEncoder().encode(terms.intentMessage), intentResult = await provider.signMessage(intentBytes, 'utf8');
  const intentSignature = intentResult instanceof Uint8Array ? intentResult : intentResult.signature;
  await verify(intentSignature, intentBytes, new PublicKey(terms.payer).toBytes());
  signal?.throwIfAborted();
  if (provider.publicKey?.toString() !== terms.payer) throw new Error('The payer account changed. Select the original payer.');
  const signed: unknown = await provider.signTransaction(tx);
  signal?.throwIfAborted();
  if (!(signed instanceof VersionedTransaction) || signed.message.serialize().some((byte, index) => byte !== messageBytes[index]) || signed.message.serialize().length !== messageBytes.length
    || signed.signatures.length !== 2 || signed.signatures[0]!.some(byte => byte !== 0) || provider.publicKey?.toString() !== terms.payer) throw new Error('The wallet changed the purchase transaction.');
  await verify(signed.signatures[1]!, messageBytes, new PublicKey(terms.payer).toBytes());
  return {intentSignature: bs58.encode(intentSignature), signedTransaction: btoa(String.fromCharCode(...signed.serialize()))};
}
