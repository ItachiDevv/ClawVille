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
const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/trade');

function recordedFixture(name: string): any {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function recordedSignature(name: string): string {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, `${name}.source.json`), 'utf8')).signature;
}

function allInstructions(raw: any): any[] {
  return [
    ...(raw.transaction?.message?.instructions ?? []),
    ...(raw.meta?.innerInstructions ?? []).flatMap((group: any) => group.instructions ?? []),
  ];
}

function mutateRecordedDiscriminator(name: string, programId: string, discriminatorHex: string): any {
  const raw = structuredClone(recordedFixture(name));
  const instruction = allInstructions(raw).find((ix) => {
    if (ix.programId !== programId || typeof ix.data !== 'string') return false;
    return Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex') === discriminatorHex;
  });
  expect(instruction).toBeDefined();
  const bytes = bs58.decode(instruction.data);
  bytes[0] ^= 0xff;
  instruction.data = bs58.encode(bytes);
  return raw;
}

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

  test('rejects in-memory discriminator mutations built from recorded fixtures', () => {
    const cases = [
      ['jupiter-swap', TRADE_DEX_PROGRAMS.jupiter, 'e517cb977ae3ad2a'],
      ['pumpswap-swap', TRADE_DEX_PROGRAMS.pumpswap, '66063d1201daebea'],
      ['pumpswap-buy-exact-quote-in', TRADE_DEX_PROGRAMS.pumpswap, 'c62e1552b4d9e870'],
      ['pumpfun-buy', TRADE_DEX_PROGRAMS.pumpfun, '66063d1201daebea'],
    ] as const;
    for (const [name, programId, discriminatorHex] of cases) {
      const raw = mutateRecordedDiscriminator(name, programId, discriminatorHex);
      expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw }))
        .toMatchObject({ kind: 'rejected', reason: 'dex_discriminator_unknown' });
    }
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

  test('resolves inner instruction membership through ALT keys without using position', () => {
    const raw = pumpSwapRaw();
    raw.transaction.message.accountKeys = [raw.transaction.message.accountKeys[0], TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_C];
    raw.transaction.message.instructions = [];
    raw.meta.loadedAddresses = { writable: [TOKEN_ACCOUNT_B, TRADE_DEX_PROGRAMS.pumpswap], readonly: [] };
    for (const balance of raw.meta.preTokenBalances) balance.accountIndex = balance.mint === TOKEN_A ? 1 : 3;
    for (const balance of raw.meta.postTokenBalances) balance.accountIndex = balance.mint === TOKEN_A ? 1 : 3;
    raw.meta.innerInstructions = [{ index: 0, instructions: [{
      programIdIndex: 4,
      accounts: [3, 0, 1],
      data: bs58.encode(Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234])),
    }] }];
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'swap', dex: 'pumpswap' });

    const missingLeg = structuredClone(raw);
    missingLeg.meta.innerInstructions[0].instructions[0].accounts = [0, 1];
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: missingLeg, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'rejected', reason: 'vault_flow_mismatch' });
  });

  test('requires the wallet system account when native SOL is a swap leg', () => {
    const raw = pumpSwapRaw();
    raw.meta.postTokenBalances[0].uiTokenAmount.amount = '1000';
    raw.meta.postBalances[0] = 900_000_000;
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'swap', inputMint: TRADE_MINTS.WSOL, outputMint: TOKEN_B });
    raw.transaction.message.instructions[0].accounts = [TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B];
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

  test('keeps an ambiguous single-sided flow when only the same-mint pool vault moved', () => {
    const raw = pumpSwapRaw();
    raw.meta.postTokenBalances[1].uiTokenAmount.amount = '0';
    raw.transaction.message.accountKeys.push(TOKEN_ACCOUNT_C);
    raw.transaction.message.instructions[0].accounts.push(TOKEN_ACCOUNT_C);
    raw.meta.preTokenBalances.push({ accountIndex: 4, mint: TOKEN_A, owner: THIRD_PARTY,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '0', decimals: 6 } });
    raw.meta.postTokenBalances.push({ accountIndex: 4, mint: TOKEN_A, owner: THIRD_PARTY,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '500', decimals: 6 } });
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'rejected', reason: 'single_sided' });
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

  test('decodes the recorded Jupiter v6 route fixture', () => {
    expect(decodeSwapFromParsedTransaction({
      signature: recordedSignature('jupiter-swap'), raw: recordedFixture('jupiter-swap'),
    })).toMatchObject({ kind: 'swap', dex: 'jupiter' });
  });

  test('decodes the first real fleet trade (staging SafeRebalancer, $1 SOL→USDC via Jupiter, v0 + lookup table)', () => {
    // Recorded 2026-09-17 from the staging $1 mainnet rung: the raw JSON-RPC `jsonParsed`
    // document (string keys), which is the shape the observer must feed this decoder.
    const name = 'jupiter-fleet-sol-usdc';
    const wallet = 'vaLqeo9HSaA5JbbDiL5GbusBG9jsKgQ6KXW8AUDZ3ZX';
    const decoded = decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name), expectedWallet: wallet });
    expect(decoded).toMatchObject({
      kind: 'swap', dex: 'jupiter', inputMint: TRADE_MINTS.WSOL, outputMint: TRADE_MINTS.USDC,
      inputDecimals: 9, outputDecimals: 6, inputAmount: '9929616', outputAmount: '999229', blockTime: 1_789_672_796, slot: 447_873_097, wallet,
    });
    // The same document with the wallet passed as a non-signer third party is refused.
    expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name), expectedWallet: THIRD_PARTY }))
      .toMatchObject({ kind: 'rejected', reason: 'wallet_not_signer' });
  });

  test('decodes the recorded PumpSwap buy and sell fixtures', () => {
    for (const name of ['pumpswap-swap', 'pumpswap-sell']) {
      expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name) }))
        .toMatchObject({ kind: 'swap', dex: 'pumpswap' });
    }
  });

  test('recognises the recorded PumpSwap buy_exact_quote_in instruction', () => {
    // The recorded transaction is a dust-sized buy (the wallet gained 8.59 tokens for ~0.00017 SOL,
    // below SOL_DUST_LAMPORTS), so only the token leg survives delta aggregation and the verifier
    // reports `single_sided`. The assertion that matters here is the discriminator: before the
    // `buy_exact_quote_in` pin this fixture was refused `dex_discriminator_unknown` with the same bytes.
    const name = 'pumpswap-buy-exact-quote-in';
    expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name) }))
      .toMatchObject({ kind: 'rejected', reason: 'single_sided', dex: 'pumpswap' });
    // The same bytes on the pump.fun bonding-curve program are NOT accepted (pumpswap-only pin).
    const relabelled = recordedFixture(name) as {
      transaction: { message: { instructions: Array<{ programId: string }> } };
      meta: { innerInstructions: Array<{ instructions: Array<{ programId: string }> }> };
    };
    const everyInstruction = [
      ...relabelled.transaction.message.instructions,
      ...relabelled.meta.innerInstructions.flatMap((group) => group.instructions),
    ];
    for (const ix of everyInstruction) {
      if (ix.programId === TRADE_DEX_PROGRAMS.pumpswap) ix.programId = TRADE_DEX_PROGRAMS.pumpfun;
    }
    expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: relabelled }))
      .toMatchObject({ kind: 'rejected', reason: 'dex_discriminator_unknown', dex: 'pumpfun' });
  });

  test('decodes the recorded pump.fun buy and sell fixtures', () => {
    for (const name of ['pumpfun-buy', 'pumpfun-sell']) {
      expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name) }))
        .toMatchObject({ kind: 'swap', dex: 'pumpfun' });
    }
  });

  test('rejects the recorded failed Jupiter transaction before swap decoding', () => {
    expect(decodeSwapFromParsedTransaction({
      signature: recordedSignature('failed-tx'), raw: recordedFixture('failed-tx'),
    })).toMatchObject({ kind: 'tx_failed' });
  });

  test('pins every recorded program discriminator, including the failed Jupiter fixture', () => {
    const cases = [
      ['jupiter-swap', TRADE_DEX_PROGRAMS.jupiter, 'e517cb977ae3ad2a'],
      ['jupiter-fleet-sol-usdc', TRADE_DEX_PROGRAMS.jupiter, 'e517cb977ae3ad2a'],
      ['failed-tx', TRADE_DEX_PROGRAMS.jupiter, 'c1209b3341d69c81'],
      ['pumpswap-swap', TRADE_DEX_PROGRAMS.pumpswap, '66063d1201daebea'],
      ['pumpswap-buy-exact-quote-in', TRADE_DEX_PROGRAMS.pumpswap, 'c62e1552b4d9e870'],
      ['pumpswap-sell', TRADE_DEX_PROGRAMS.pumpswap, '33e685a4017f83ad'],
      ['pumpfun-buy', TRADE_DEX_PROGRAMS.pumpfun, '66063d1201daebea'],
      ['pumpfun-sell', TRADE_DEX_PROGRAMS.pumpfun, '33e685a4017f83ad'],
    ] as const;
    for (const [name, programId, discriminatorHex] of cases) {
      const observed = allInstructions(recordedFixture(name))
        .filter((ix) => ix.programId === programId && typeof ix.data === 'string')
        .map((ix) => Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex'));
      expect(observed).toContain(discriminatorHex);
    }
  });

  test.skip('TODO-FIXTURE: no recorded spl-transfer-not-a-swap.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded unused-jupiter-key.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded memo-carrying-dex-address.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded pumpswap-liquidity-deposit.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded pumpswap-liquidity-withdraw.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded pumpfun-creator-fee-claim.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded dex-tx-with-unrelated-transfer.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded sponsored-swap.json was supplied', () => {});
  test.skip('TODO-FIXTURE: no recorded alt-resolved-execution.json was supplied', () => {});
});
