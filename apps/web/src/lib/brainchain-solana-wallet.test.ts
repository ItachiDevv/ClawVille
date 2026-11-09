import {expect, test} from 'bun:test';
import {Keypair, VersionedTransaction} from '@solana/web3.js';
import nacl from 'tweetnacl';
import type {BrainchainBuyerOrder} from '@clawville/shared';
import {buildSolanaBuyerArtifact, solanaBuyerIntent} from '../../../api/src/services/brainchain/purchase-solana-transaction';
import {SOLANA_BUYER_LANE as L} from '../../../api/src/services/brainchain/purchase-solana-policy';
import {connectBrainchainSolanaPayer, signBrainchainSolanaPurchase} from './brainchain-solana-wallet';
function fixture() {
  const payer = Keypair.generate(), artifact = buildSolanaBuyerArtifact(payer.publicKey.toBase58(), {blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200, contextSlot: 100});
  const terms = {orderId: crypto.randomUUID(), avatarId: crypto.randomUUID(), payer: artifact.payer, bodyHash: 'ab'.repeat(32), quoteHash: 'cd'.repeat(32), intentNonce: `0x${'12'.repeat(32)}` as const, paymentNonce: `0x${'34'.repeat(32)}` as const, validAfter: '1', validBefore: String(Math.floor(Date.now() / 1000) + 200)};
  const order = {id: terms.orderId, environment: 'testnet', chainId: null, network: L.network, state: 'reserved', payer: terms.payer, bodyHash: terms.bodyHash} as BrainchainBuyerOrder;
  return {payer, order, material: {network: L.network, intentMessage: solanaBuyerIntent(terms, artifact), unsignedTransaction: artifact.unsignedTransaction, payer: artifact.payer, messageHash: artifact.messageHash, lastValidBlockHeight: 200}};
}
test('injected wallet signs exact intent then exact devnet transaction with real Ed25519 verification', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'), f = fixture(), calls: string[] = [];
  const provider = {publicKey: f.payer.publicKey, connect: async () => ({publicKey: f.payer.publicKey}), signMessage: async (bytes: Uint8Array) => {calls.push('intent'); return {signature: nacl.sign.detached(bytes, f.payer.secretKey)};}, signTransaction: async (tx: VersionedTransaction) => {calls.push('transaction'); tx.sign([f.payer]); return tx;}};
  Object.defineProperty(globalThis, 'window', {configurable: true, value: {solana: provider}});
  try {
    expect(await connectBrainchainSolanaPayer()).toBe(f.payer.publicKey.toBase58());
    const signed = await signBrainchainSolanaPurchase(f.order, f.material); expect(calls).toEqual(['intent', 'transaction']);
    expect(signed.intentSignature).toBeString(); expect(signed.signedTransaction).toBeString();
    expect('sendTransaction' in provider).toBe(false);
  } finally {if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');}
});
test('browser refuses altered task, fee payer, wallet return bytes and cancellation', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const mutation of ['task', 'fee', 'wallet', 'abort'] as const) {
      const f = fixture(); let requests = 0;
      const provider = {publicKey: f.payer.publicKey, connect: async () => ({publicKey: f.payer.publicKey}), signMessage: async (bytes: Uint8Array) => {requests++; return nacl.sign.detached(bytes, f.payer.secretKey);}, signTransaction: async (tx: VersionedTransaction) => {requests++; tx.sign([f.payer]); if (mutation === 'wallet') tx.signatures[0]![0] = 1; return tx;}};
      Object.defineProperty(globalThis, 'window', {configurable: true, value: {solana: provider}});
      if (mutation === 'task') f.material.intentMessage = f.material.intentMessage.replace(f.order.bodyHash, 'ef'.repeat(32));
      if (mutation === 'fee') {const tx = VersionedTransaction.deserialize(Buffer.from(f.material.unsignedTransaction, 'base64')); tx.message.staticAccountKeys[0] = Keypair.generate().publicKey; f.material.unsignedTransaction = Buffer.from(tx.serialize()).toString('base64');}
      const controller = new AbortController(); if (mutation === 'abort') controller.abort();
      await expect(signBrainchainSolanaPurchase(f.order, f.material, controller.signal)).rejects.toThrow();
      expect(requests).toBe(mutation === 'wallet' ? 2 : 0);
    }
  } finally {if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');}
});
