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
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';

const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const ROUTE = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);
const SHARED_ROUTE = Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]);

function transaction(
  wallet: PublicKey,
  inputLeg: SwapLeg,
  outputLeg: SwapLeg,
  input = 1_000n,
  quotedOut = 2_000n,
  slippageBps = 100,
  decoyLegs: readonly SwapLeg[] = [],
): VersionedTransaction {
  const shared = !inputLeg.tokenProgram.equals(outputLeg.tokenProgram);
  const data = Buffer.alloc(shared ? 32 : 31);
  (shared ? SHARED_ROUTE : ROUTE).copy(data, 0);
  const header = shared ? 9 : 8;
  if (shared) data[8] = 0;
  data.writeUInt32LE(1, header);
  const args = data.length - 19;
  data.writeBigUInt64LE(input, args);
  data.writeBigUInt64LE(quotedOut, args + 8);
  data.writeUInt16LE(slippageBps, args + 16);
  data[args + 18] = 0;
  const routeKeys = shared ? [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: inputLeg.ata, isSigner: false, isWritable: true },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: outputLeg.ata, isSigner: false, isWritable: true },
    { pubkey: inputLeg.mint, isSigner: false, isWritable: false },
    { pubkey: outputLeg.mint, isSigner: false, isWritable: false },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ] : [
    { pubkey: inputLeg.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: inputLeg.ata, isSigner: false, isWritable: true },
    { pubkey: outputLeg.ata, isSigner: false, isWritable: true },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: outputLeg.mint, isSigner: false, isWritable: false },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
  ];
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [new TransactionInstruction({
      programId: JUPITER,
      keys: [
        ...routeKeys,
        ...decoyLegs.map((leg) => ({ pubkey: leg.ata, isSigner: false, isWritable: true })),
      ],
      data,
    })],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function leg(wallet: PublicKey, mintValue: string, direction: SwapLeg['direction']): SwapLeg {
  const mint = new PublicKey(mintValue);
  const tokenProgram = mintValue === TRADE_MINTS.ANSEM || mintValue === TRADE_MINTS.CLAWVILLE
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  return {
    mint,
    tokenProgram,
    ata: getAssociatedTokenAddressSync(mint, wallet, true, tokenProgram),
    mode: 'token',
    direction,
  };
}

describe('Trading Floor signer', () => {
  test('validates signatures by decoded byte length', () => {
    expect(isValidSolanaSignature('a'.repeat(64))).toBe(false);
    expect(isValidSolanaSignature(bs58.encode(new Uint8Array(64).fill(7)))).toBe(true);
  });

  test('captures signed bytes and signature before any caller can send', async () => {
    const keypair = Keypair.generate();
    const inputLeg = leg(keypair.publicKey, TRADE_MINTS.USDC, 'debit');
    const outputLeg = leg(keypair.publicKey, TRADE_MINTS.ANSEM, 'credit');
    const tx = transaction(keypair.publicKey, inputLeg, outputLeg);
    const events: string[] = [];
    const result = await signTradingSwap({
      walletRow: { publicKey: keypair.publicKey.toBase58() } as never,
      boundPubkey: keypair.publicKey.toBase58(),
      transaction: tx,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_980n,
      inputLeg,
      outputLeg,
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
    const inputLeg = leg(keypair.publicKey, TRADE_MINTS.USDC, 'debit');
    const outputLeg = leg(keypair.publicKey, TRADE_MINTS.ANSEM, 'credit');
    const tx = transaction(keypair.publicKey, inputLeg, outputLeg);
    let captured = false;
    const result = await signTradingSwap({
      walletRow: { publicKey: keypair.publicKey.toBase58() } as never,
      boundPubkey: keypair.publicKey.toBase58(),
      transaction: tx,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_981n,
      inputLeg,
      outputLeg,
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
    const inputLeg = leg(bound.publicKey, TRADE_MINTS.USDC, 'debit');
    const outputLeg = leg(bound.publicKey, TRADE_MINTS.ANSEM, 'credit');
    const tx = transaction(bound.publicKey, inputLeg, outputLeg);
    const result = await signTradingSwap({
      walletRow: { publicKey: bound.publicKey.toBase58() } as never,
      boundPubkey: bound.publicKey.toBase58(),
      transaction: tx,
      recentBlockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_980n,
      inputLeg,
      outputLeg,
      shape: 'token-token',
      inputAmount: 1_000n,
      quotedOutAmount: 2_000n,
      slippageBps: 100,
      deps: { keypair: wrong },
    });
    expect(result).toMatchObject({ kind: 'refused_presign', code: 'keypair_mismatch' });
  });

  test('revalidates both legs, shape, decoded quote, and slippage before capture', async () => {
    const keypair = Keypair.generate();
    const actualInput = leg(keypair.publicKey, TRADE_MINTS.USDC, 'debit');
    const actualOutput = leg(keypair.publicKey, TRADE_MINTS.ANSEM, 'credit');
    let captured = false;
    const cases = [
      {
        name: 'mint',
        inputLeg: { ...actualInput, mint: Keypair.generate().publicKey, ata: Keypair.generate().publicKey },
      },
      {
        name: 'token program',
        inputLeg: { ...actualInput, tokenProgram: TOKEN_2022_PROGRAM_ID },
      },
      {
        name: 'ATA owner',
        inputLeg: { ...actualInput, ata: getAssociatedTokenAddressSync(actualInput.mint, Keypair.generate().publicKey, true, actualInput.tokenProgram) },
      },
      {
        name: 'output mint',
        outputLeg: { ...actualOutput, mint: Keypair.generate().publicKey, ata: Keypair.generate().publicKey },
      },
      {
        name: 'output token program',
        outputLeg: { ...actualOutput, tokenProgram: TOKEN_PROGRAM_ID },
      },
      {
        name: 'output ATA owner',
        outputLeg: { ...actualOutput, ata: getAssociatedTokenAddressSync(actualOutput.mint, Keypair.generate().publicKey, true, actualOutput.tokenProgram) },
      },
      { name: 'shape', shape: 'sol-token' as const },
      { name: 'quoted output', quotedOutAmount: 2_001n },
      { name: 'slippage', slippageBps: 101 },
    ];
    for (const item of cases) {
      const tx = transaction(keypair.publicKey, actualInput, actualOutput);
      const result = await signTradingSwap({
        walletRow: { publicKey: keypair.publicKey.toBase58() } as never,
        boundPubkey: keypair.publicKey.toBase58(),
        transaction: tx,
        recentBlockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: 99,
        admittedMinOut: 1_980n,
        inputLeg: item.inputLeg ?? actualInput,
        outputLeg: item.outputLeg ?? actualOutput,
        shape: item.shape ?? 'token-token',
        inputAmount: 1_000n,
        quotedOutAmount: item.quotedOutAmount ?? 2_000n,
        slippageBps: item.slippageBps ?? 100,
        deps: { keypair, persistCaptured: async () => { captured = true; } },
      });
      expect(result, item.name).toMatchObject({ kind: 'refused_presign', code: 'tx_binding_failed' });
      expect(captured, item.name).toBe(false);
    }

    const hostileInput = leg(keypair.publicKey, TRADE_MINTS.CLAWVILLE, 'debit');
    const decoyTx = transaction(keypair.publicKey, hostileInput, actualOutput, 1_000n, 2_000n, 100, [actualInput]);
    const decoyResult = await signTradingSwap({
      walletRow: { publicKey: keypair.publicKey.toBase58() } as never,
      boundPubkey: keypair.publicKey.toBase58(),
      transaction: decoyTx,
      recentBlockhash: decoyTx.message.recentBlockhash,
      lastValidBlockHeight: 99,
      admittedMinOut: 1_980n,
      inputLeg: actualInput,
      outputLeg: actualOutput,
      shape: 'token-token',
      inputAmount: 1_000n,
      quotedOutAmount: 2_000n,
      slippageBps: 100,
      deps: { keypair, persistCaptured: async () => { captured = true; } },
    });
    expect(decoyResult).toMatchObject({ kind: 'refused_presign', code: 'tx_binding_failed' });
    expect(captured).toBe(false);
  });
});
