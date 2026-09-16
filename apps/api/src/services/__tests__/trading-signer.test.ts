import { describe, expect, test } from 'bun:test';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { isValidSolanaSignature, signTradingSwap } from '../trading-signer';
import type { SwapLeg } from '../trading-swap-validator';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const ROUTE = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);

function transaction(wallet: PublicKey, input = 1_000n, quotedOut = 2_000n, slippageBps = 100): VersionedTransaction {
  const data = Buffer.alloc(31);
  ROUTE.copy(data, 0);
  data.writeUInt32LE(1, 8);
  data.writeBigUInt64LE(input, 12);
  data.writeBigUInt64LE(quotedOut, 20);
  data.writeUInt16LE(slippageBps, 28);
  data[30] = 0;
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [new TransactionInstruction({ programId: JUPITER, keys: [], data })],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function leg(mint: PublicKey, direction: SwapLeg['direction']): SwapLeg {
  return { mint, tokenProgram: TOKEN_PROGRAM_ID, ata: Keypair.generate().publicKey, mode: 'token', direction };
}

describe('Trading Floor signer', () => {
  test('validates signatures by decoded byte length', () => {
    expect(isValidSolanaSignature('a'.repeat(64))).toBe(false);
    expect(isValidSolanaSignature(bs58.encode(new Uint8Array(64).fill(7)))).toBe(true);
  });

  test('captures signed bytes and signature before any caller can send', async () => {
    const keypair = Keypair.generate();
    const tx = transaction(keypair.publicKey);
    const events: string[] = [];
    const result = await signTradingSwap({
      walletRow: { publicKey: keypair.publicKey.toBase58() } as never,
      boundPubkey: keypair.publicKey.toBase58(),
      transaction: tx,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_980n,
      inputLeg: leg(Keypair.generate().publicKey, 'debit'),
      outputLeg: leg(Keypair.generate().publicKey, 'credit'),
      shape: 'token-token',
      inputAmount: 1_000n,
      quotedOutAmount: 2_000n,
      slippageBps: 100,
      deps: {
        keypair,
        persistCaptured: async (captured) => {
          events.push('captured');
          expect(captured.signature).toBe(bs58.encode(tx.signatures[0]!));
          expect(captured.signedBytes.length).toBeGreaterThan(0);
        },
      },
    });
    expect(result.kind).toBe('submitted');
    expect(events).toEqual(['captured']);
  });

  test('refuses a built minimum below the admitted minimum without capture', async () => {
    const keypair = Keypair.generate();
    const tx = transaction(keypair.publicKey);
    let captured = false;
    const result = await signTradingSwap({
      walletRow: { publicKey: keypair.publicKey.toBase58() } as never,
      boundPubkey: keypair.publicKey.toBase58(),
      transaction: tx,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_981n,
      inputLeg: leg(Keypair.generate().publicKey, 'debit'),
      outputLeg: leg(Keypair.generate().publicKey, 'credit'),
      shape: 'token-token',
      inputAmount: 1_000n,
      quotedOutAmount: 2_000n,
      slippageBps: 100,
      deps: { keypair, persistCaptured: async () => { captured = true; } },
    });
    expect(result).toMatchObject({ kind: 'refused_presign', code: 'min_out_below_admitted' });
    expect(captured).toBe(false);
  });

  test('refuses a keypair that differs from the bound wallet', async () => {
    const bound = Keypair.generate();
    const wrong = Keypair.generate();
    const tx = transaction(bound.publicKey);
    const result = await signTradingSwap({
      walletRow: { publicKey: bound.publicKey.toBase58() } as never,
      boundPubkey: bound.publicKey.toBase58(),
      transaction: tx,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_980n,
      inputLeg: leg(Keypair.generate().publicKey, 'debit'),
      outputLeg: leg(Keypair.generate().publicKey, 'credit'),
      shape: 'token-token',
      inputAmount: 1_000n,
      quotedOutAmount: 2_000n,
      slippageBps: 100,
      deps: { keypair: wrong },
    });
    expect(result).toMatchObject({ kind: 'refused_presign', code: 'keypair_mismatch' });
  });
});
