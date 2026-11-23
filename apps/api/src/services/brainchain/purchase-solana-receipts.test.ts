import {expect, test} from 'bun:test';
import {Keypair, PublicKey, TransactionMessage, VersionedTransaction} from '@solana/web3.js';
import {createTransferCheckedInstruction} from '@solana/spl-token';
import bs58 from 'bs58';
import {SolanaBuyerReceipts, verifySolanaRefundTransaction} from './purchase-solana-receipts';
import {SolanaBuyerRpc} from './purchase-solana-rpc';
import {SOLANA_BUYER_LANE as L} from './purchase-solana-policy';
import {buildSolanaBuyerArtifact, decodeSolanaBuyerTransaction} from './purchase-solana-transaction';
test('a partial payer signature cannot establish a completed payment receipt', async () => {
  const payer = Keypair.generate(), a = buildSolanaBuyerArtifact(payer.publicKey.toBase58(), {blockhash: Keypair.generate().publicKey.toBase58(), contextSlot: 100, lastValidBlockHeight: 200});
  const tx = decodeSolanaBuyerTransaction(a.unsignedTransaction); tx.sign([payer]);
  const payerSignature = bs58.encode(tx.signatures[1]!); const calls: string[] = [];
  const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init?.body)); calls.push(request.method);
    const result = request.method === 'getGenesisHash' ? L.genesisHash : {slot: 110, blockTime: Math.floor(Date.now() / 1000), transaction: [Buffer.from(tx.serialize()).toString('base64'), 'base64'],
      meta: {err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: []}, version: 0};
    return Response.json({jsonrpc: '2.0', id: 1, result});
  }) as unknown as typeof fetch;
  await expect(new SolanaBuyerReceipts(new SolanaBuyerRpc(fetcher)).verify(payerSignature, a, 'payment')).rejects.toMatchObject({code: 'receipt_unavailable'});
  expect(calls).toEqual(['getGenesisHash', 'getTransaction']);
});
test('fixed RPC refuses submission, redirects, oversize responses, and error envelopes', async () => {
  const dummy = (async () => {throw new Error('must not call');}) as unknown as typeof fetch;
  await expect(new SolanaBuyerRpc(dummy).read('sendTransaction' as never, [])).rejects.toMatchObject({code: 'invalid_request'});
  for (const response of [Response.redirect('https://untrusted.invalid', 302), new Response('x'.repeat(262145), {headers: {'Content-Type': 'application/json'}}), Response.json({jsonrpc: '2.0', id: 1, error: {message: 'untrusted-secret-value'}})]) {
    const fetcher = (async () => response) as unknown as typeof fetch;
    const error = await new SolanaBuyerRpc(fetcher).genesis().then(() => null, cause => cause as Error);
    expect(error?.message).toBe('BrainChain purchase refused: receipt_unavailable');
  }
});
test('S2 pure refund verifier requires the authority signature and exact account roles', () => {
  const desk = Keypair.generate(), fee = Keypair.generate(), source = Keypair.generate().publicKey, destination = Keypair.generate().publicKey;
  const expected = {source: source.toBase58(), destination: destination.toBase58(), mint: L.token, authority: desk.publicKey.toBase58(), amount: 1000000n, decimals: 6};
  for (const shape of ['valid', 'nonsigner', 'writable-mint', 'readonly-source', 'extra-account', 'bad-signature', 'wrong-pinned-authority', 'desk-fee'] as const) {
    const ix = createTransferCheckedInstruction(source, new PublicKey(L.token), destination, desk.publicKey, 1000000n, 6);
    if (shape === 'nonsigner') ix.keys[3]!.isSigner = false;
    if (shape === 'writable-mint') ix.keys[1]!.isWritable = true;
    if (shape === 'readonly-source') ix.keys[0]!.isWritable = false;
    if (shape === 'extra-account') ix.keys.push({pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false});
    const tx = new VersionedTransaction(new TransactionMessage({payerKey: shape === 'desk-fee' ? desk.publicKey : fee.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix]}).compileToV0Message());
    tx.sign(shape === 'nonsigner' ? [fee] : shape === 'desk-fee' ? [desk] : [fee, desk]);
    if (shape === 'bad-signature') tx.signatures[1]![0] ^= 1;
    const pins = shape === 'wrong-pinned-authority' ? {...expected, authority: L.recipient} : expected;
    if (shape === 'valid' || shape === 'desk-fee') expect(() => verifySolanaRefundTransaction(tx, pins)).not.toThrow();
    else expect(() => verifySolanaRefundTransaction(tx, pins)).toThrow();
  }
});
test('S2 fabricated successful RPC metadata cannot substitute an unrelated fee signature for the pinned desk', async () => {
  const payer = Keypair.generate(), fee = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58();
  const artifact = buildSolanaBuyerArtifact(payer.publicKey.toBase58(), {blockhash, contextSlot: 100, lastValidBlockHeight: 200});
  const ix = createTransferCheckedInstruction(new PublicKey(artifact.destinationAta), new PublicKey(L.token), new PublicKey(artifact.sourceAta), new PublicKey(L.recipient), 1000000n, 6); ix.keys[3]!.isSigner = false;
  const tx = new VersionedTransaction(new TransactionMessage({payerKey: fee.publicKey, recentBlockhash: blockhash, instructions: [ix]}).compileToV0Message()); tx.sign([fee]);
  const signature = bs58.encode(tx.signatures[0]!), now = Math.floor(Date.now() / 1000), keys = tx.message.staticAccountKeys;
  const source = keys.findIndex(key => key.toBase58() === artifact.destinationAta), destination = keys.findIndex(key => key.toBase58() === artifact.sourceAta);
  const balance = (accountIndex: number, owner: string, amount: string) => ({accountIndex, owner, mint: L.token, uiTokenAmount: {amount, decimals: 6}});
  const receipt = {slot: 110, blockTime: now, transaction: [Buffer.from(tx.serialize()).toString('base64'), 'base64'], version: 0, meta: {err: null, innerInstructions: [], preTokenBalances: [balance(source, L.recipient, '2000000'), balance(destination, artifact.payer, '0')], postTokenBalances: [balance(source, L.recipient, '1000000'), balance(destination, artifact.payer, '1000000')]}};
  const fetcher = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = JSON.parse(String(init?.body));
    const result = request.method === 'getGenesisHash' ? L.genesisHash : request.method === 'getTransaction' ? receipt : request.method === 'getLatestBlockhash' ? {context: {slot: 120}, value: {}} : {blockhash, blockTime: now, signatures: [signature]};
    return Response.json({jsonrpc: '2.0', id: 1, result});
  }) as typeof fetch;
  await expect(new SolanaBuyerReceipts(new SolanaBuyerRpc(fetcher)).verify(signature, artifact, 'refund', 100n, 'finalized')).rejects.toMatchObject({code: 'receipt_unavailable'});
});
