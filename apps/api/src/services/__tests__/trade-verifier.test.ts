import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import bs58 from 'bs58';
import { decodeSwapFromParsedTransaction, scoreTrade, TRADE_REJECT_REASONS } from '../trade-verifier';
import { TRADE_DEX_PROGRAMS, TRADE_MINTS } from '@clawville/shared';

const WALLET = '11111111111111111111111111111111';
const TOKEN_A = TRADE_MINTS.ANSEM;
const TOKEN_B = TRADE_MINTS.USDC;
const TOKEN_ACCOUNT_A = bs58.encode(new Uint8Array(32).fill(2));
const TOKEN_ACCOUNT_B = bs58.encode(new Uint8Array(32).fill(3));
const TOKEN_ACCOUNT_C = bs58.encode(new Uint8Array(32).fill(4));
const THIRD_PARTY = bs58.encode(new Uint8Array(32).fill(5));

function pumpSwapRaw(): any {
  return {
    slot: 200,
    blockTime: 1_750_000_000,
    transaction: { message: {
      accountKeys: [{ pubkey: WALLET, signer: true, writable: true }, TRADE_DEX_PROGRAMS.pumpswap,
        TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B],
      instructions: [{ programId: TRADE_DEX_PROGRAMS.pumpswap,
        accounts: [WALLET, TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B],
        data: bs58.encode(Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234])) }],
    } },
    meta: {
      err: null, fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [999_995_000, 0],
      preTokenBalances: [
        { accountIndex: 2, mint: TOKEN_A, owner: WALLET, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '1000', decimals: 6 } },
        { accountIndex: 3, mint: TOKEN_B, owner: WALLET, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: TOKEN_A, owner: WALLET, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '500', decimals: 6 } },
        { accountIndex: 3, mint: TOKEN_B, owner: WALLET, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '900', decimals: 6 } },
      ],
      innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [],
    },
  };
}

function jupiterRouteData(): string {
  const bytes = Buffer.alloc(31);
  Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]).copy(bytes, 0);
  bytes.writeUInt32LE(1, 8);
  return bs58.encode(bytes);
}

describe('trade verifier', () => {
  test('returns not_found for a null RPC payload', () => {
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: null })).toEqual({ kind: 'not_found', signature: 'sig' });
  });

  test('decodes a synthetic PumpSwap wallet-owned two-leg delta', () => {
    const decoded = decodeSwapFromParsedTransaction({ signature: 'sig', raw: pumpSwapRaw(), expectedWallet: WALLET });
    expect(decoded.kind).toBe('swap');
    if (decoded.kind === 'swap') {
      expect(decoded.dex).toBe('pumpswap');
      expect(decoded.inputAmount).toBe('500');
      expect(decoded.outputAmount).toBe('900');
    }
  });

  test('rejects a wallet that did not sign', () => {
    const raw = pumpSwapRaw();
    raw.transaction.message.accountKeys[0] = { pubkey: WALLET, signer: false, writable: true };
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET })).toMatchObject({ kind: 'rejected', reason: 'wallet_not_signer' });
  });

  test('prefers an executed Jupiter route over an executed PumpSwap route', () => {
    const raw = pumpSwapRaw();
    raw.transaction.message.accountKeys.push(TRADE_DEX_PROGRAMS.jupiter);
    raw.transaction.message.instructions.push({
      programId: TRADE_DEX_PROGRAMS.jupiter,
      accounts: [WALLET, TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B],
      data: jupiterRouteData(),
    });
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET })).toMatchObject({ kind: 'swap', dex: 'jupiter' });
  });

  test('rejects a mutated PumpSwap discriminator', () => {
    const raw = pumpSwapRaw();
    raw.transaction.message.instructions[0].data = bs58.encode(Uint8Array.from([103, 6, 61, 18, 1, 218, 235, 234]));
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET })).toMatchObject({ kind: 'rejected', reason: 'dex_discriminator_unknown' });
  });

  test('distinguishes failed and malformed transactions', () => {
    const failed = pumpSwapRaw();
    failed.meta.err = { InstructionError: [0, 'Custom'] };
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: failed, expectedWallet: WALLET })).toMatchObject({ kind: 'tx_failed' });
    const missingMeta = pumpSwapRaw();
    missingMeta.meta = null;
    expect(() => decodeSwapFromParsedTransaction({ signature: 'sig', raw: missingMeta, expectedWallet: WALLET })).toThrow('meta is null');
  });

  test('rejects cleanly when the approved swap has extra or missing wallet legs', () => {
    const multi = pumpSwapRaw();
    multi.transaction.message.accountKeys.push(TOKEN_ACCOUNT_C);
    multi.transaction.message.instructions[0].accounts.push(TOKEN_ACCOUNT_C);
    multi.meta.preTokenBalances.push({ accountIndex: 4, mint: TRADE_MINTS.WSOL, owner: WALLET,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '10000000', decimals: 9 } });
    multi.meta.postTokenBalances.push({ accountIndex: 4, mint: TRADE_MINTS.WSOL, owner: WALLET,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '0', decimals: 9 } });
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: multi, expectedWallet: WALLET })).toMatchObject({ kind: 'rejected', reason: 'multi_leg' });

    const single = pumpSwapRaw();
    single.meta.postTokenBalances[1].uiTokenAmount.amount = '0';
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: single, expectedWallet: WALLET })).toMatchObject({ kind: 'rejected', reason: 'single_sided' });
  });

  test('rejects wallet legs that are unrelated to the qualifying DEX instruction', () => {
    const raw = pumpSwapRaw();
    raw.transaction.message.instructions[0].accounts = [WALLET];
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'rejected', reason: 'vault_flow_mismatch' });
  });

  test('diagnoses a qualifying swap that pays its output to a third party', () => {
    const raw = pumpSwapRaw();
    raw.meta.preTokenBalances[1].owner = THIRD_PARTY;
    raw.meta.postTokenBalances[1].owner = THIRD_PARTY;
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'rejected', reason: 'token_account_not_owned' });
  });

  test('rejects a same-mint transfer instead of netting it into no movement', () => {
    const raw = pumpSwapRaw();
    raw.meta.preTokenBalances[1].mint = TOKEN_A;
    raw.meta.postTokenBalances[1].mint = TOKEN_A;
    raw.meta.postTokenBalances[1].uiTokenAmount.amount = '500';
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET })).toMatchObject({ kind: 'rejected', reason: 'same_mint' });
  });

  test('scores ANSEM before CLAWVILLE and compares transaction slot with bound slot', () => {
    expect(scoreTrade({ notionalUsd: 1, minNotionalUsd: 0.5, slot: 11, blockTime: 1,
      boundSlot: 10, scoredTodayForAvatar: 0, dailyScoredCap: 20,
      inputMint: TRADE_MINTS.CLAWVILLE, outputMint: TRADE_MINTS.ANSEM, pairAlreadyScoredToday: false })).toEqual({ scored: true, tier: 'ansem' });
    expect(scoreTrade({ notionalUsd: 1, minNotionalUsd: 0.5, slot: 10, blockTime: 1,
      boundSlot: 10, scoredTodayForAvatar: 0, dailyScoredCap: 20,
      inputMint: TOKEN_A, outputMint: TOKEN_B, pairAlreadyScoredToday: false })).toEqual({ scored: false, reason: 'pre_bind' });
  });

  test('scores a same-second post-bind trade when its slot is strictly greater', () => {
    const bindingSecond = 1_750_000_000;
    expect(scoreTrade({ notionalUsd: 1, minNotionalUsd: 0.5, slot: 201, blockTime: bindingSecond,
      boundSlot: 200, scoredTodayForAvatar: 0, dailyScoredCap: 20,
      inputMint: TOKEN_A, outputMint: TOKEN_B, pairAlreadyScoredToday: false })).toEqual({ scored: true, tier: 'ansem' });
  });

  test('keeps the documented not_a_swap detail list identical to the runtime array', () => {
    const architecture = readFileSync(resolve(import.meta.dir, '../../../../../ARCHITECTURE.md'), 'utf8');
    const row = architecture.split(/\r?\n/).find((line) => line.startsWith('| `not_a_swap` |'));
    expect(row).toBeDefined();
    const documented = [...(row ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]).slice(1);
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual([...TRADE_REJECT_REASONS].sort());
  });

  test('keeps multiplier tiers direction-independent', () => {
    const verdict = (inputMint: string, outputMint: string) => scoreTrade({ notionalUsd: 1, minNotionalUsd: 0.5,
      slot: 11, blockTime: 1, boundSlot: 10, scoredTodayForAvatar: 0, dailyScoredCap: 20,
      inputMint, outputMint, pairAlreadyScoredToday: false });
    expect(verdict(TRADE_MINTS.WSOL, TRADE_MINTS.ANSEM)).toEqual({ scored: true, tier: 'ansem' });
    expect(verdict(TRADE_MINTS.ANSEM, TRADE_MINTS.WSOL)).toEqual({ scored: true, tier: 'ansem' });
    expect(verdict(TRADE_MINTS.USDC, TRADE_MINTS.CLAWVILLE)).toEqual({ scored: true, tier: 'clv' });
    expect(verdict(TRADE_MINTS.USDC, TRADE_MINTS.WSOL)).toEqual({ scored: true, tier: 'base' });
  });

  test.skip('TODO-FIXTURE: needs a supplied confirmed Jupiter v6 ExactIn mainnet signature and recorded getParsedTransaction JSON', () => {});
  test.skip('TODO-FIXTURE: needs a supplied confirmed PumpSwap buy or sell mainnet signature and recorded getParsedTransaction JSON', () => {});
  test.skip('TODO-FIXTURE: needs a supplied confirmed pump.fun bonding-curve buy or sell mainnet signature and recorded getParsedTransaction JSON', () => {});
});
