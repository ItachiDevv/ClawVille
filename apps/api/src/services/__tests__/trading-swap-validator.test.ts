import { describe, expect, test } from 'bun:test';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS } from '@clawville/shared';
import { validateTradingLegs, validateTradingSwapSimulation, type SwapLeg, type SwapShape } from '../trading-swap-validator';

const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const ROUTE = Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]);

const wallet = Keypair.generate().publicKey;
const mintProgram = new Map<string, PublicKey>([
  [TRADE_MINTS.WSOL, TOKEN_PROGRAM_ID],
  [TRADE_MINTS.USDC, TOKEN_PROGRAM_ID],
  [TRADE_MINTS.ANSEM, TOKEN_2022_PROGRAM_ID],
  [TRADE_MINTS.CLAWVILLE, TOKEN_2022_PROGRAM_ID],
]);

function tokenLeg(mintValue: string, direction: SwapLeg['direction']): SwapLeg {
  const mint = new PublicKey(mintValue);
  const tokenProgram = mintProgram.get(mintValue)!;
  return {
    mint,
    tokenProgram,
    ata: getAssociatedTokenAddressSync(mint, wallet, true, tokenProgram),
    mode: 'token',
    direction,
  };
}

function nativeLeg(direction: SwapLeg['direction']): SwapLeg {
  return {
    mint: new PublicKey(TRADE_MINTS.WSOL),
    tokenProgram: TOKEN_PROGRAM_ID,
    ata: getAssociatedTokenAddressSync(new PublicKey(TRADE_MINTS.WSOL), wallet, true, TOKEN_PROGRAM_ID),
    mode: 'native-sol',
    direction,
  };
}

function routeTransaction(inputAmount: bigint, quotedOut: bigint, slippageBps: number): VersionedTransaction {
  const data = Buffer.alloc(31);
  ROUTE.copy(data);
  data.writeUInt32LE(1, 8);
  data.writeBigUInt64LE(inputAmount, 12);
  data.writeBigUInt64LE(quotedOut, 20);
  data.writeUInt16LE(slippageBps, 28);
  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [new TransactionInstruction({ programId: JUPITER, keys: [], data })],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function tokenData(leg: SwapLeg, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  leg.mint.toBuffer().copy(data, 0);
  wallet.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

function connectionFor(input: {
  specs: SwapLeg[];
  preAmounts: bigint[];
  postAmounts: bigint[];
  preWallet: number;
  postWallet: number;
  fee?: number;
}) {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) => {
      const index = input.specs.findIndex((spec) => spec.ata.equals(key));
      if (index >= 0) return { owner: input.specs[index]!.tokenProgram, data: tokenData(input.specs[index]!, input.preAmounts[index]!), lamports: 2_039_280, executable: false, rentEpoch: 0 };
      if (key.equals(wallet)) return { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: input.preWallet, executable: false, rentEpoch: 0 };
      return null;
    }),
    getFeeForMessage: async () => ({ context: { slot: 1 }, value: input.fee ?? 5_000 }),
    simulateTransaction: async (_tx: unknown, config: { accounts: { addresses: string[] } }) => ({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        unitsConsumed: 1,
        returnData: null,
        innerInstructions: null,
        replacementBlockhash: null,
        accounts: config.accounts.addresses.map((address) => {
          const key = new PublicKey(address);
          const index = input.specs.findIndex((spec) => spec.ata.equals(key));
          if (index >= 0) return { owner: input.specs[index]!.tokenProgram.toBase58(), data: [tokenData(input.specs[index]!, input.postAmounts[index]!).toString('base64'), 'base64'], lamports: 2_039_280, executable: false, rentEpoch: 0 };
          if (key.equals(wallet)) return { owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], lamports: input.postWallet, executable: false, rentEpoch: 0 };
          return null;
        }),
      },
    }),
  } as never;
}

describe('Trading Floor leg validator', () => {
  test('accepts every ordered pair of distinct static mints in both SOL modes', () => {
    const mints = Object.values(TRADE_MINTS);
    for (const input of mints) {
      for (const output of mints) {
        if (input === output) continue;
        const inputLeg = input === TRADE_MINTS.WSOL ? nativeLeg('debit') : tokenLeg(input, 'debit');
        const outputLeg = output === TRADE_MINTS.WSOL ? nativeLeg('credit') : tokenLeg(output, 'credit');
        const shape: SwapShape = input === TRADE_MINTS.WSOL
          ? 'sol-token'
          : output === TRADE_MINTS.WSOL ? 'token-sol' : 'token-token';
        expect(validateTradingLegs({ wallet, inputLeg, outputLeg, shape }), `${input} -> ${output}`).toEqual({ ok: true });
      }
    }
  });

  test('refuses each inconsistent leg shape before an RPC can exist', () => {
    const usdc = tokenLeg(TRADE_MINTS.USDC, 'debit');
    const ansem = tokenLeg(TRADE_MINTS.ANSEM, 'credit');
    const cases: Array<{ inputLeg: SwapLeg; outputLeg: SwapLeg; shape: SwapShape }> = [
      { inputLeg: { ...usdc, direction: 'credit' }, outputLeg: ansem, shape: 'token-token' },
      { inputLeg: usdc, outputLeg: { ...ansem, direction: 'debit' }, shape: 'token-token' },
      { inputLeg: usdc, outputLeg: { ...ansem, ata: Keypair.generate().publicKey }, shape: 'token-token' },
      { inputLeg: usdc, outputLeg: ansem, shape: 'sol-token' },
      { inputLeg: nativeLeg('debit'), outputLeg: nativeLeg('credit'), shape: 'sol-token' },
      { inputLeg: usdc, outputLeg: { ...usdc, direction: 'credit' }, shape: 'token-token' },
    ];
    for (const item of cases) expect(validateTradingLegs({ wallet, ...item }).ok).toBe(false);
  });

  test('checks token deltas and keeps ATA rent neutral in a token route', async () => {
    const inputLeg = tokenLeg(TRADE_MINTS.USDC, 'debit');
    const outputLeg = tokenLeg(TRADE_MINTS.ANSEM, 'credit');
    const tx = routeTransaction(100n, 200n, 500);
    const result = await validateTradingSwapSimulation({
      transaction: tx,
      wallet,
      connection: connectionFor({ specs: [inputLeg, outputLeg], preAmounts: [1_000n, 0n], postAmounts: [900n, 190n], preWallet: 1_000_000, postWallet: 995_000 }),
      inputLeg,
      outputLeg,
      shape: 'token-token',
      inputAmount: 100n,
      minimumOutAmount: 190n,
      priorityFeeLamports: 1_000_000n,
      transactionDerivedWsolAccounts: [],
    });
    expect(result).toEqual({ ok: true });
  });

  test('bounds native input by the admitted amount plus the exact fee', async () => {
    const inputLeg = nativeLeg('debit');
    const outputLeg = tokenLeg(TRADE_MINTS.ANSEM, 'credit');
    const tx = routeTransaction(100n, 200n, 500);
    for (const [postWallet, ok] of [[994_900, true], [994_899, false]] as const) {
      const result = await validateTradingSwapSimulation({
        transaction: tx,
        wallet,
        connection: connectionFor({ specs: [outputLeg], preAmounts: [0n], postAmounts: [190n], preWallet: 1_000_000, postWallet }),
        inputLeg,
        outputLeg,
        shape: 'sol-token',
        inputAmount: 100n,
        minimumOutAmount: 190n,
        priorityFeeLamports: 1_000_000n,
        transactionDerivedWsolAccounts: [],
      });
      expect(result.ok).toBe(ok);
    }
  });

  test('credits native output with the exact transaction fee', async () => {
    const inputLeg = tokenLeg(TRADE_MINTS.USDC, 'debit');
    const outputLeg = nativeLeg('credit');
    const tx = routeTransaction(100n, 200n, 500);
    for (const [postWallet, ok] of [[995_190, true], [995_189, false]] as const) {
      const result = await validateTradingSwapSimulation({
        transaction: tx,
        wallet,
        connection: connectionFor({ specs: [inputLeg], preAmounts: [1_000n], postAmounts: [900n], preWallet: 1_000_000, postWallet }),
        inputLeg,
        outputLeg,
        shape: 'token-sol',
        inputAmount: 100n,
        minimumOutAmount: 190n,
        priorityFeeLamports: 1_000_000n,
        transactionDerivedWsolAccounts: [],
      });
      expect(result.ok).toBe(ok);
    }
  });
});
