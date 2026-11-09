/** Controlled SDK compatibility probe. No network or user key is available. */
import {z} from 'zod';
import {Keypair, PublicKey, TransactionMessage, VersionedTransaction} from '@solana/web3.js';
import {MintLayout, TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {createKeyPairSignerFromBytes} from '@solana/kit';
import {ExactSvmScheme} from '@x402/svm/exact/client';
import {SOLANA_BUYER_LANE as L} from './purchase-solana-policy';
import {buildSolanaBuyerArtifact, verifySolanaBuyerTransaction} from './purchase-solana-transaction';
if (process.env.BRAINCHAIN_SDK_FIXTURE !== '1') throw new Error('Fixture opt-in required');
const payer = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
const data = Buffer.alloc(MintLayout.span);
MintLayout.encode({mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default}, data);
const calls: string[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  if (String(input) !== 'https://sdk.fixture.invalid') throw new Error('Network refused');
  const request = JSON.parse(String(init?.body)); calls.push(request.method);
  const result = request.method === 'getAccountInfo' ? {context: {slot: 100}, value: {owner: TOKEN_PROGRAM_ID.toBase58(), data: [data.toString('base64'), 'base64'], executable: false, lamports: 1000000, rentEpoch: 0, space: 82}}
    : request.method === 'getLatestBlockhash' ? {context: {slot: 100}, value: {blockhash, lastValidBlockHeight: 200}} : null;
  if (!result) throw new Error('Unexpected method');
  return Response.json({jsonrpc: '2.0', id: request.id, result});
}) as typeof fetch;
const scheme = new ExactSvmScheme(await createKeyPairSignerFromBytes(payer.secretKey), {rpcUrl: 'https://sdk.fixture.invalid'});
const payload = await scheme.createPaymentPayload(2, {scheme: 'exact', network: L.network, asset: L.token, payTo: L.recipient, amount: L.amountAtomic, maxTimeoutSeconds: 300, extra: {feePayer: L.feePayer}});
const wire = z.string().parse(payload.payload.transaction);
const transaction = VersionedTransaction.deserialize(Buffer.from(wire, 'base64'));
const memo = TransactionMessage.decompile(transaction.message).instructions[3]!.data.toString('utf8');
const artifact = buildSolanaBuyerArtifact(payer.publicKey.toBase58(), {blockhash, lastValidBlockHeight: 200, contextSlot: 100}, memo);
// This checks the installed SDK's actual wire bytes against our strict reconstructed message.
verifySolanaBuyerTransaction(artifact, wire, false);
process.stdout.write(JSON.stringify({calls, compatible: true, instructions: transaction.message.compiledInstructions.length}));
