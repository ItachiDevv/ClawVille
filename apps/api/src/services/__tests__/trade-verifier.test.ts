import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
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
const GENESIS_WALLET = '4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n';
const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/trade');

// Full outputs captured before the rent clamp, including the ordered mint deltas.
const RECORDED_DECODE_BASELINE = {
  'failed-tx': {
    kind: "tx_failed", signature: "2HuBv39UHksyRASCMyYBuMaBge8cxPyhsrioEWbrT2pJFHpaknrBZNn6cAWnwtt2FnA3JhY3oHRPaGPgq2FHoc9Q",
    blockTime: 1789543549,
  },
  'genesis-sol-usdc-route': {
    kind: "swap", signature: "21k5fZgAyCCv75Y5KemTZisWwu42HoHNDesaS7VW93iiby9cApaLZybbvk2KmiLcTCXEArVswVC8YA6dC99VP8ZQ",
    blockTime: 1789724229, slot: 448045004, dex: "jupiter",
    wallet: "4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n",
    inputMint: "So11111111111111111111111111111111111111112", inputAmount: "18890000", inputDecimals: 9,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", outputAmount: "2000506", outputDecimals: 6,
    deltas: [{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","delta":"2000506","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"-18890000","decimals":9}],
  },
  'genesis-sol-usdc-shared-route': {
    kind: "swap", signature: "52T89GfDyYak95r92xcacfrcwDETXPS6wULyVkMxCY3EHJcrSY4LChm9WhG5hDuNRij1dp29gasckjhnJrN9bS8z",
    blockTime: 1789732488, slot: 448076001, dex: "jupiter",
    wallet: "4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n",
    inputMint: "So11111111111111111111111111111111111111112", inputAmount: "9453139", inputDecimals: 9,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", outputAmount: "1000265", outputDecimals: 6,
    deltas: [{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","delta":"1000265","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"-9453139","decimals":9}],
  },
  'genesis-usdc-sol-route': {
    kind: "swap", signature: "2yVEpsLXqSU1BVJjkNzHauKreF7jzYKAyeqQkx1Dsr4N6CJfgiekEC7it61NPZRUpNQrR7WyXcCQyc3ZHcYzWACN",
    blockTime: 1789732476, slot: 448075957, dex: "jupiter",
    wallet: "4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n",
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inputAmount: "1000000", inputDecimals: 6,
    outputMint: "So11111111111111111111111111111111111111112", outputAmount: "9453139", outputDecimals: 9,
    deltas: [{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","delta":"-1000000","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"9453139","decimals":9}],
  },
  'jupiter-fleet-sol-usdc': {
    kind: "swap", signature: "5mytFoup16GrVojktQYHaG9bc5fP1w6jQ135zTYgJVe7Bjc1Jtu8Tzcu6gAtpfVVr4DZgeX3gZFBHaBDGpK4Jow2",
    blockTime: 1789672796, slot: 447873097, dex: "jupiter",
    wallet: "vaLqeo9HSaA5JbbDiL5GbusBG9jsKgQ6KXW8AUDZ3ZX",
    inputMint: "So11111111111111111111111111111111111111112", inputAmount: "9929616", inputDecimals: 9,
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", outputAmount: "999229", outputDecimals: 6,
    deltas: [{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","delta":"999229","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"-9929616","decimals":9}],
  },
  'jupiter-shared-route-v2-foreign-leg': {
    kind: "rejected", signature: "2g87Mx2WtkbGW5LhbxQ4HXTr3NoEmFH21CMF9aFD3rR5ZwZL4Qqi6fuKcA3Ee6cwwfXwJvHintLX4VX7oNhSbepM",
    blockTime: 1789734208, reason: "vault_flow_mismatch", dex: "jupiter",
  },
  'jupiter-swap': {
    kind: "swap", signature: "rAggcYyw6gLgCriJriKzoptpqNkDg2jDWc9rbpH7ThDqbjKi7Jc5pdjbbrLeHzY9mMfUT7Q59sEvji3w8Xj8mxd",
    blockTime: 1789543549, slot: 447465211, dex: "jupiter",
    wallet: "8KTZstCPs7zxV3RxB7bRr1K5yASzDmPtb532ybG4CFwj",
    inputMint: "So11111111111111111111111111111111111111112", inputAmount: "103200000", inputDecimals: 9,
    outputMint: "5NYBrbe2kbs5cy6GSpTWejNZxsYnXtcdGTGMm49qhj5P", outputAmount: "221753930128", outputDecimals: 6,
    deltas: [{"mint":"5NYBrbe2kbs5cy6GSpTWejNZxsYnXtcdGTGMm49qhj5P","delta":"221753930128","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"-103200000","decimals":9}],
  },
  'jupiter-usdc-meme-route-v2-multihop': {
    kind: "swap", signature: "gAjXqETKsrpL5yZ3uwXzc7ffDUH2rrtNs8VTxCexjUinc1ZAaSXnkYrEbA8oHZZ1dG7dmwE5n1fsG4DH6pVQVKG",
    blockTime: 1789733261, slot: 448078889, dex: "jupiter",
    wallet: "8PriTQ9uQsj1DFeBvqMac3BXuo3dUBhMG5rWT55xqbRZ",
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inputAmount: "66000000", inputDecimals: 6,
    outputMint: "7P48QkgheGNX4X5yZM8JCi4bzEyxQf8xE6juCdDau9rw", outputAmount: "261247338523", outputDecimals: 6,
    deltas: [{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","delta":"-66000000","decimals":6},{"mint":"7P48QkgheGNX4X5yZM8JCi4bzEyxQf8xE6juCdDau9rw","delta":"261247338523","decimals":6}],
  },
  'jupiter-usdc-meme-route-v2': {
    kind: "swap", signature: "2zh8G5eYGi81tuQQ8BiaLpXCL11U6morSdMzFAyL6DM44QhWpXvhAkFQv9GaXAx7fRuRpz8pyrabWbiWP6YAtWfv",
    blockTime: 1789733263, slot: 448078896, dex: "jupiter",
    wallet: "FamoiQ3tLrY9aBWoZW9nL9jaeMd9PkNFXDqt3mwrrvXP",
    inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", inputAmount: "4999032", inputDecimals: 6,
    outputMint: "3M1kURavgnF4WnDNjiyCWUh7nu2S5rkoQk9WY2kS4uaz", outputAmount: "82938657692", outputDecimals: 6,
    deltas: [{"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","delta":"-4999032","decimals":6},{"mint":"3M1kURavgnF4WnDNjiyCWUh7nu2S5rkoQk9WY2kS4uaz","delta":"82938657692","decimals":6}],
  },
  'pumpfun-buy': {
    kind: "swap", signature: "5gxX2PgcJ5q96qHuaFAVJcmEXxqSJG5Pa4N89sZmLEeGjtRZdfMXDoVhQZYgG3QrPNNhicyhh39pMWB4zcLZPenG",
    blockTime: 1789543564, slot: 447465258, dex: "pumpfun",
    wallet: "7wYAWkpSXmertUvYbt4rxyx5BB6hDg9viVrta4J6XJYG",
    inputMint: "So11111111111111111111111111111111111111112", inputAmount: "60001000", inputDecimals: 9,
    outputMint: "HpYdUftXwEaG7jekkjFvFLWeJ5dfqaFvtDHoRC6jd99s", outputAmount: "779654677425", outputDecimals: 6,
    deltas: [{"mint":"HpYdUftXwEaG7jekkjFvFLWeJ5dfqaFvtDHoRC6jd99s","delta":"779654677425","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"-60001000","decimals":9}],
  },
  'pumpfun-sell': {
    kind: "swap", signature: "4StYuz8cookp5Gs19awNvS3FCzK6USd3w4dCnzgfv6HQP8xJ71wRw4ZtYj9qKtqPGp2s6K7Jc8aBqV1Uy6pt5SvJ",
    blockTime: 1789543564, slot: 447465258, dex: "pumpfun",
    wallet: "CtzvQtccmX9PcZkcb7RL91oaYpKBxkQUuoDetMhExCA7",
    inputMint: "4Q5UtSacu6EaYT17cMU47bdjY7CY1sUJmY5KH1YhoAEG", inputAmount: "1068241390339", inputDecimals: 6,
    outputMint: "So11111111111111111111111111111111111111112", outputAmount: "31865223", outputDecimals: 9,
    deltas: [{"mint":"4Q5UtSacu6EaYT17cMU47bdjY7CY1sUJmY5KH1YhoAEG","delta":"-1068241390339","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"31865223","decimals":9}],
  },
  'pumpswap-buy-exact-quote-in': {
    kind: "rejected", signature: "64Yr6i5KcJdZdjnfjx7DSGEiheyZAUsKoADmMF6RQNnUrmq6PTBbDoW2MTD8uuQrJFk2Rgb9vxg9PSkTfJtf69xm",
    blockTime: 1789543550, reason: "single_sided", dex: "pumpswap",
  },
  'pumpswap-sell': {
    kind: "swap", signature: "28bZjsAs3uc9NwB2Wj7VCMrkzpshBFLmtGJRPDwf8ibFpHxkWijRC2NZdjBP9b9JQi5e9PqMnJ8XnvYh6ruQkT59",
    blockTime: 1789543550, slot: 447465216, dex: "pumpswap",
    wallet: "4UioYoQ9PAJwb37DGh7Zq1PMNW3MhQAwYjVmepdH7P5i",
    inputMint: "So11111111111111111111111111111111111111112", inputAmount: "7970044052", inputDecimals: 9,
    outputMint: "13bg6WhCAgVXaZXaTV6xNw3etg4QjJ5pUMtmSA3VeUt8", outputAmount: "2567457902636", outputDecimals: 6,
    deltas: [{"mint":"13bg6WhCAgVXaZXaTV6xNw3etg4QjJ5pUMtmSA3VeUt8","delta":"2567457902636","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"-7970044052","decimals":9}],
  },
  'pumpswap-swap': {
    kind: "swap", signature: "v71puHPhrxKWeeT2ZsNZZnu28z9xLYiNRVSvbLZTwSqNawr1kibZKzARyGicJYXTXvo485W2vsPB7pMpairsWaw",
    blockTime: 1789543550, slot: 447465216, dex: "pumpswap",
    wallet: "AvS3fGxtqb6exwarzZeggaKGriULPaQxb8KCeaw1VsYj",
    inputMint: "9K1yTZZ5VZkL8p7MQkEWdSD3nZkUTHYnvSrbTXyCJaLR", inputAmount: "2324155571", inputDecimals: 6,
    outputMint: "So11111111111111111111111111111111111111112", outputAmount: "3171519", outputDecimals: 9,
    deltas: [{"mint":"9K1yTZZ5VZkL8p7MQkEWdSD3nZkUTHYnvSrbTXyCJaLR","delta":"-2324155571","decimals":6},{"mint":"So11111111111111111111111111111111111111112","delta":"3171519","decimals":9}],
  },
};

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

function jupiterTokenAccountRaw(direction: 'buy' | 'sell', rent = 2_074_080) {
  const meme = { accountIndex: 2, mint: TOKEN_A as string, owner: WALLET,
    programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', uiTokenAmount: { amount: '5000', decimals: 6 } };
  const usdc = { accountIndex: 3, mint: TOKEN_B, owner: WALLET,
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount: '2000000', decimals: 6 } };
  const buying = direction === 'buy';
  return {
    slot: 200,
    blockTime: 1_750_000_000,
    transaction: { message: {
      accountKeys: [{ pubkey: WALLET, signer: true, writable: true }, TRADE_DEX_PROGRAMS.jupiter,
        TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B],
      instructions: [{ programId: TRADE_DEX_PROGRAMS.jupiter,
        accounts: [WALLET, TOKEN_ACCOUNT_A, TOKEN_ACCOUNT_B], data: jupiterRouteData() }],
    } },
    meta: {
      err: null, fee: 5000,
      preBalances: [1_000_000_000, 0, buying ? 0 : rent, 2_039_280],
      postBalances: [1_000_000_000 + (buying ? -rent : rent) - 5000, 0, buying ? rent : 0, 2_039_280],
      preTokenBalances: buying ? [usdc] : [meme, usdc],
      postTokenBalances: [
        ...(buying ? [meme] : []),
        { ...usdc, uiTokenAmount: { amount: buying ? '0' : '3500000', decimals: 6 } },
      ],
      innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [],
    },
  };
}

function thirdPartyTokenRentRaw(mode: 'create' | 'close') {
  const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const MEME = '3M1kURavgnF4WnDNjiyCWUh7nu2S5rkoQk9WY2kS4uaz';
  const k = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  const PAYER = k(9); // second wallet: fee payer + ATA funder / refund receiver
  const W = k(7);     // bound wallet (signer, swap authority)
  const OTHER = k(8); // owner of the foreign swap account
  const W_USDC = k(2), OTHER_WSOL = k(3), W_NEW_ATA = k(4);
  const TK = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const v2 = () => { const b = Buffer.alloc(24); Buffer.from('bb64facc31c4af14', 'hex').copy(b, 0); return bs58.encode(b); };
  const create = mode === 'create';
  return {
    slot: 500, blockTime: 1_789_000_000,
    transaction: { message: {
      accountKeys: [{ pubkey: PAYER, signer: true, writable: true }, { pubkey: W, signer: true, writable: true },
        JUP, W_USDC, OTHER_WSOL, W_NEW_ATA],
      instructions: [{ programId: JUP, accounts: [W, W_USDC, OTHER_WSOL], data: v2() }],
    } },
    meta: {
      err: null, fee: 5000,
      // W's native balance never moves. PAYER funds the new ATA (create) or receives the close refund (close).
      preBalances: [1_000_000_000, 500_000_000, 1, 2_039_280, 2_039_280, create ? 0 : 2_039_280],
      postBalances: [create ? 1_000_000_000 - 2_039_280 - 5000 : 1_000_000_000 + 2_039_280 - 5000,
        500_000_000, 1, 2_039_280, 2_039_280, create ? 2_039_280 : 0],
      preTokenBalances: [
        // create: W spends USDC, the output lands in OTHER's account. close: OTHER's account pays W USDC.
        { accountIndex: 3, mint: USDC, owner: W, programId: TK, uiTokenAmount: { amount: create ? '2000000' : '0', decimals: 6 } },
        { accountIndex: 4, mint: WSOL, owner: OTHER, programId: TK, uiTokenAmount: { amount: create ? '0' : '10000000', decimals: 9 } },
        ...(create ? [] : [{ accountIndex: 5, mint: MEME, owner: W, programId: TK, uiTokenAmount: { amount: '0', decimals: 6 } }]),
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: USDC, owner: W, programId: TK, uiTokenAmount: { amount: create ? '0' : '2000000', decimals: 6 } },
        { accountIndex: 4, mint: WSOL, owner: OTHER, programId: TK, uiTokenAmount: { amount: create ? '10000000' : '0', decimals: 9 } },
        ...(create ? [{ accountIndex: 5, mint: MEME, owner: W, programId: TK, uiTokenAmount: { amount: '0', decimals: 6 } }] : []),
      ],
      innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [],
    },
  };
}

describe('trade verifier', () => {
  test('keeps every recorded fixture decoded output identical to the pre-clamp baseline', () => {
    const names = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.source.json'))
      .map((name) => name.slice(0, -5)).sort();
    expect(names).toEqual(Object.keys(RECORDED_DECODE_BASELINE).sort());
    for (const [name, expected] of Object.entries(RECORDED_DECODE_BASELINE)) {
      expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name) }))
        .toEqual(expected as unknown as ReturnType<typeof decodeSwapFromParsedTransaction>);
    }
  });

  test.each([
    ['create', 'third-party-paid ATA creation must not become a WSOL output leg'],
    ['close', 'a close refund sent to another wallet must not become a WSOL input leg'],
  ] as const)('%s: %s', (mode) => {
    const raw = thirdPartyTokenRentRaw(mode);
    const wallet = bs58.encode(new Uint8Array(32).fill(7));
    expect(decodeSwapFromParsedTransaction({ signature: `probe-${mode}`, raw, expectedWallet: wallet }))
      .toEqual({ kind: 'rejected', signature: `probe-${mode}`, blockTime: 1_789_000_000,
        reason: 'token_account_not_owned', dex: 'jupiter' });
  });

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
      ['jupiter-usdc-meme-route-v2', TRADE_DEX_PROGRAMS.jupiter, 'bb64facc31c4af14'],
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

  const genesisCases = [
    { name: 'genesis-sol-usdc-route', inputMint: TRADE_MINTS.WSOL, inputAmount: '18890000', inputDecimals: 9,
      outputMint: TRADE_MINTS.USDC, outputAmount: '2000506', outputDecimals: 6, slot: 448_045_004, blockTime: 1_789_724_229 },
    { name: 'genesis-usdc-sol-route', inputMint: TRADE_MINTS.USDC, inputAmount: '1000000', inputDecimals: 6,
      outputMint: TRADE_MINTS.WSOL, outputAmount: '9453139', outputDecimals: 9, slot: 448_075_957, blockTime: 1_789_732_476 },
    { name: 'genesis-sol-usdc-shared-route', inputMint: TRADE_MINTS.WSOL, inputAmount: '9453139', inputDecimals: 9,
      outputMint: TRADE_MINTS.USDC, outputAmount: '1000265', outputDecimals: 6, slot: 448_076_001, blockTime: 1_789_732_488 },
  ];
  for (const { name, ...expected } of genesisCases) {
    test(`decodes the recorded ${name} fixture`, () => {
      expect(decodeSwapFromParsedTransaction({
        signature: recordedSignature(name), raw: recordedFixture(name), expectedWallet: GENESIS_WALLET,
      })).toMatchObject({ kind: 'swap', dex: 'jupiter', wallet: GENESIS_WALLET, ...expected });
    });

    test(`rejects a non-signer for the recorded ${name} fixture`, () => {
      expect(decodeSwapFromParsedTransaction({
        signature: recordedSignature(name), raw: recordedFixture(name), expectedWallet: THIRD_PARTY,
      })).toMatchObject({ kind: 'rejected', reason: 'wallet_not_signer' });
    });
  }

  const v2Cases = [
    { name: 'jupiter-usdc-meme-route-v2', wallet: 'FamoiQ3tLrY9aBWoZW9nL9jaeMd9PkNFXDqt3mwrrvXP',
      inputAmount: '4999032', outputMint: '3M1kURavgnF4WnDNjiyCWUh7nu2S5rkoQk9WY2kS4uaz', outputAmount: '82938657692',
      slot: 448_078_896, blockTime: 1_789_733_263 },
    { name: 'jupiter-usdc-meme-route-v2-multihop', wallet: '8PriTQ9uQsj1DFeBvqMac3BXuo3dUBhMG5rWT55xqbRZ',
      inputAmount: '66000000', outputMint: '7P48QkgheGNX4X5yZM8JCi4bzEyxQf8xE6juCdDau9rw', outputAmount: '261247338523',
      slot: 448_078_889, blockTime: 1_789_733_261 },
  ];
  for (const { name, ...expected } of v2Cases) {
    test(`decodes the recorded ${name} fixture without a rent SOL leg`, () => {
      expect(decodeSwapFromParsedTransaction({
        signature: recordedSignature(name), raw: recordedFixture(name), expectedWallet: expected.wallet,
      })).toMatchObject({ kind: 'swap', dex: 'jupiter', inputMint: TRADE_MINTS.USDC,
        inputDecimals: 6, outputDecimals: 6, ...expected });
    });
  }

  test('rejects the recorded SharedAccountsRouteV2 foreign leg after recognizing its discriminator', () => {
    const name = 'jupiter-shared-route-v2-foreign-leg';
    expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name) }))
      .toMatchObject({ kind: 'rejected', reason: 'vault_flow_mismatch', dex: 'jupiter' });
  });

  test.each([
    ['jupiter-swap', '103200000'],
    ['pumpfun-buy', '60001000'],
  ])('removes account rent from the recorded %s SOL input', (name, inputAmount) => {
    expect(decodeSwapFromParsedTransaction({ signature: recordedSignature(name), raw: recordedFixture(name) }))
      .toMatchObject({ kind: 'swap', inputMint: TRADE_MINTS.WSOL, inputAmount });
  });

  test('nets rent when a USDC buy creates a wallet-owned Token-2022 account', () => {
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: jupiterTokenAccountRaw('buy'), expectedWallet: WALLET }))
      .toMatchObject({ kind: 'swap', dex: 'jupiter', inputMint: TOKEN_B, inputAmount: '2000000', inputDecimals: 6,
        outputMint: TOKEN_A, outputAmount: '5000', outputDecimals: 6 });
  });

  test('nets recovered rent when a sell closes the wallet-owned token account', () => {
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: jupiterTokenAccountRaw('sell'), expectedWallet: WALLET }))
      .toMatchObject({ kind: 'swap', dex: 'jupiter', inputMint: TOKEN_A, inputAmount: '5000', inputDecimals: 6,
        outputMint: TOKEN_B, outputAmount: '1500000', outputDecimals: 6 });
  });

  test('keeps a SOL leg when created token-account rent exceeds the per-account bound', () => {
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw: jupiterTokenAccountRaw('buy', 3_500_000), expectedWallet: WALLET }))
      .toMatchObject({ kind: 'rejected', reason: 'multi_leg', dex: 'jupiter' });
  });

  test('nets only rent when a created wSOL account retains the wrapped amount', () => {
    const raw = jupiterTokenAccountRaw('buy', 2_039_280);
    const wrappedAmount = 10_000_000;
    raw.meta.postTokenBalances[0] = { accountIndex: 2, mint: TRADE_MINTS.WSOL, owner: WALLET,
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      uiTokenAmount: { amount: String(wrappedAmount), decimals: 9 } };
    raw.meta.postBalances[2] += wrappedAmount;
    raw.meta.postBalances[0] -= wrappedAmount;
    expect(decodeSwapFromParsedTransaction({ signature: 'sig', raw, expectedWallet: WALLET }))
      .toMatchObject({ kind: 'rejected', reason: 'single_sided', dex: 'jupiter' });
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
      ['genesis-sol-usdc-route', TRADE_DEX_PROGRAMS.jupiter, 'e517cb977ae3ad2a'],
      ['genesis-sol-usdc-shared-route', TRADE_DEX_PROGRAMS.jupiter, 'c1209b3341d69c81'],
      ['jupiter-usdc-meme-route-v2', TRADE_DEX_PROGRAMS.jupiter, 'bb64facc31c4af14'],
      ['jupiter-shared-route-v2-foreign-leg', TRADE_DEX_PROGRAMS.jupiter, 'd19853937cfed8e9'],
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
