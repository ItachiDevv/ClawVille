import { expect, test } from 'bun:test';
import { Keypair, PublicKey, VersionedTransaction, ComputeBudgetProgram, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { buildSolanaBuyerArtifact, decodeSolanaBuyerTransaction, verifySolanaBuyerTransaction, verifySolanaBuyerSignatureSet, solanaBuyerIntent, verifySolanaBuyerIntent, completedSolanaBuyerTransactionId } from './purchase-solana-transaction';
import { SOLANA_BUYER_LANE as L, selectSolanaBuyerQuote } from './purchase-solana-policy';
import { buyerDigest, type BuyerTerms } from './purchase-policy';
const payer = Keypair.generate();
const lifetime = {blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200, contextSlot: 100};
function artifact() { return buildSolanaBuyerArtifact(payer.publicKey.toBase58(), lifetime, 'ab'.repeat(16)); }
function signed() { const a = artifact(), tx = decodeSolanaBuyerTransaction(a.unsignedTransaction); tx.sign([payer]); return {a, tx, raw: Buffer.from(tx.serialize()).toString('base64')}; }
test('reviewed x402 shape has exact two signers and four instructions', () => {
  const {a, tx, raw} = signed(); expect(tx.message.header.numRequiredSignatures).toBe(2);
  expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(L.feePayer); expect(tx.message.staticAccountKeys[1]!.toBase58()).toBe(a.payer);
  const message = TransactionMessage.decompile(tx.message); expect(message.instructions).toHaveLength(4);
  expect(message.instructions[0]!.data.toString('hex')).toBe(ComputeBudgetProgram.setComputeUnitLimit({units: 20000}).data.toString('hex'));
  expect(message.instructions[1]!.data.toString('hex')).toBe(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}).data.toString('hex'));
  expect(message.instructions[2]!.data.toString('hex')).toBe('0c40420f000000000006');
  expect(message.instructions[3]!.data.toString()).toBe('ab'.repeat(16));
  expect(verifySolanaBuyerTransaction(a, raw, false).signatures[1]).toEqual(tx.signatures[1]);
  expect(() => completedSolanaBuyerTransactionId(a, raw)).toThrow();
});
test('actual payer Ed25519 proof binds exact task and message', () => {
  const a = artifact(), terms: BuyerTerms = {orderId: crypto.randomUUID(), avatarId: crypto.randomUUID(), payer: a.payer, bodyHash: buyerDigest('brief'), quoteHash: buyerDigest('quote'), intentNonce: `0x${'ab'.repeat(32)}`, paymentNonce: `0x${'cd'.repeat(32)}`, validAfter: '1', validBefore: '200'};
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(solanaBuyerIntent(terms, a)), payer.secretKey));
  expect(() => verifySolanaBuyerIntent(terms, a, signature)).not.toThrow();
  expect(() => verifySolanaBuyerIntent({...terms, avatarId: crypto.randomUUID()}, a, signature)).toThrow();
  expect(() => verifySolanaBuyerIntent({...terms, bodyHash: buyerDigest('other')}, a, signature)).toThrow();
});
test('pure completed-signature verification checks both generated signer keys without changing production pins', () => {
  const {tx} = signed(), fee = Keypair.generate(); tx.message.staticAccountKeys[0] = fee.publicKey; tx.sign([fee, payer]);
  expect(() => verifySolanaBuyerSignatureSet(tx, [fee.publicKey.toBase58(), payer.publicKey.toBase58()])).not.toThrow();
  expect(() => verifySolanaBuyerSignatureSet(tx, [L.feePayer, payer.publicKey.toBase58()])).toThrow();
  tx.signatures[0]![0] ^= 1; expect(() => verifySolanaBuyerSignatureSet(tx, [fee.publicKey.toBase58(), payer.publicKey.toBase58()])).toThrow();
});
test('instruction, fee payer, ALT, signature and unsigned message mutations refuse', () => {
  for (const mutation of ['fee', 'price', 'extra', 'alt', 'signature', 'completed', 'artifact'] as const) {
    const {a, tx} = signed(); let target = a;
    if (mutation === 'fee') tx.message.staticAccountKeys[0] = Keypair.generate().publicKey;
    if (mutation === 'price') tx.message.compiledInstructions[1]!.data[1] = 2;
    if (mutation === 'extra') tx.message.compiledInstructions.push(tx.message.compiledInstructions[2]!);
    if (mutation === 'alt') tx.message.addressTableLookups.push({accountKey: Keypair.generate().publicKey, writableIndexes: [], readonlyIndexes: []});
    if (mutation === 'signature') tx.signatures[1]![0] ^= 1;
    if (mutation === 'completed') tx.signatures[0]![0] = 1;
    if (mutation === 'artifact') target = {...a, destinationAta: Keypair.generate().publicKey.toBase58()};
    expect(() => verifySolanaBuyerTransaction(target, Buffer.from(tx.serialize()).toString('base64'), false)).toThrow();
  }
});
test('only exact observed devnet offer qualifies', () => {
  const requirement = {scheme: 'exact', network: L.network, asset: L.token, payTo: L.recipient, amount: L.amountAtomic, maxTimeoutSeconds: 300, extra: {feePayer: L.feePayer}};
  const quote = {x402Version: 2, resource: {url: L.endpoint}, accepts: [requirement]};
  expect(selectSolanaBuyerQuote(quote).requirement.network).toBe(L.network);
  for (const replacement of [{asset: Keypair.generate().publicKey.toBase58()}, {extra: {feePayer: payer.publicKey.toBase58()}}, {amount: '1000001'}, {maxTimeoutSeconds: 301}]) expect(() => selectSolanaBuyerQuote({...quote, accepts: [{...requirement, ...replacement}]})).toThrow();
});
test('installed x402/svm2.9.0 produces the same exact message under a controlled RPC', async () => {
  const child = Bun.spawn([process.execPath, new URL('./purchase-solana-sdk-fixture.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    env: {...process.env, BRAINCHAIN_SDK_FIXTURE: '1'}, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(stderr).toBe(''); expect(JSON.parse(stdout)).toEqual({calls: ['getAccountInfo', 'getLatestBlockhash'], compatible: true, instructions: 4});
});
