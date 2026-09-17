import { afterEach, describe, expect, test } from 'bun:test';
import { Keypair, PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { TRADE_MINTS, TRADE_USDC_AUTHORITIES } from '@clawville/shared';
import type { AlertErrorParams } from '../alert-error';
import { resetTradingLoopAlertsForTest } from '../trading-rpc';
import {
  clearTradingMintInfoCacheForTests,
  loadTradingMintWhitelist,
  tradingMintAdmissible,
  type MintInfo,
} from '../trading-mint-info';

/** The four mints exactly as read from mainnet on 2026-09-17 (getAccountInfo, jsonParsed). */
const ON_CHAIN: Record<keyof typeof TRADE_MINTS, MintInfo> = {
  USDC: {
    mint: TRADE_MINTS.USDC,
    decimals: 6,
    programId: TOKEN_PROGRAM_ID,
    extensions: [],
    mintAuthority: TRADE_USDC_AUTHORITIES.mint,
    freezeAuthority: TRADE_USDC_AUTHORITIES.freeze,
  },
  WSOL: { mint: TRADE_MINTS.WSOL, decimals: 9, programId: TOKEN_PROGRAM_ID, extensions: [], mintAuthority: null, freezeAuthority: null },
  ANSEM: {
    mint: TRADE_MINTS.ANSEM,
    decimals: 6,
    programId: TOKEN_2022_PROGRAM_ID,
    extensions: ['MetadataPointer', 'TokenMetadata'],
    mintAuthority: null,
    freezeAuthority: null,
  },
  CLAWVILLE: {
    mint: TRADE_MINTS.CLAWVILLE,
    decimals: 6,
    programId: TOKEN_2022_PROGRAM_ID,
    extensions: ['MetadataPointer', 'TokenMetadata'],
    mintAuthority: null,
    freezeAuthority: null,
  },
};

const OTHER_KEY = Keypair.generate().publicKey.toBase58();

describe('tradingMintAdmissible', () => {
  test('the pinned USDC authorities are the Circle keys read from mainnet', () => {
    // Literal so a wrong constant cannot pass by fixtures that read the constant back.
    expect(TRADE_USDC_AUTHORITIES.mint).toBe('BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG');
    expect(TRADE_USDC_AUTHORITIES.freeze).toBe('7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar');
  });

  test('admits all four mints in their exact on-chain shape', () => {
    for (const [name, mint] of Object.entries(TRADE_MINTS) as [keyof typeof TRADE_MINTS, string][]) {
      expect(tradingMintAdmissible(mint, ON_CHAIN[name])).toBe(true);
    }
  });

  test('a mint outside the table is never admissible, whatever its shape', () => {
    expect(tradingMintAdmissible(OTHER_KEY, { ...ON_CHAIN.WSOL, mint: OTHER_KEY })).toBe(false);
    expect(tradingMintAdmissible('constructor', { ...ON_CHAIN.WSOL, mint: 'constructor' })).toBe(false);
  });

  test('USDC must carry exactly the pinned Circle mint and freeze authorities', () => {
    const usdc = ON_CHAIN.USDC;
    // The pre-fix rule demanded a null mint authority, which mainnet USDC never has.
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...usdc, mintAuthority: null })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...usdc, mintAuthority: OTHER_KEY })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...usdc, freezeAuthority: null })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...usdc, freezeAuthority: OTHER_KEY })).toBe(false);
  });

  test('every non-USDC mint must have no authority of either kind', () => {
    for (const name of ['WSOL', 'ANSEM', 'CLAWVILLE'] as const) {
      const base = ON_CHAIN[name];
      expect(tradingMintAdmissible(base.mint, { ...base, mintAuthority: OTHER_KEY })).toBe(false);
      expect(tradingMintAdmissible(base.mint, { ...base, freezeAuthority: OTHER_KEY })).toBe(false);
      expect(tradingMintAdmissible(base.mint, { ...base, mintAuthority: TRADE_USDC_AUTHORITIES.mint })).toBe(false);
    }
  });

  test('rejects wrong decimals, wrong program, foreign mint field, and value-affecting extensions', () => {
    expect(tradingMintAdmissible(TRADE_MINTS.WSOL, { ...ON_CHAIN.WSOL, decimals: 6 })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...ON_CHAIN.USDC, decimals: 9 })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...ON_CHAIN.USDC, programId: TOKEN_2022_PROGRAM_ID })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.ANSEM, { ...ON_CHAIN.ANSEM, programId: TOKEN_PROGRAM_ID })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...ON_CHAIN.USDC, mint: TRADE_MINTS.WSOL })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.USDC, { ...ON_CHAIN.USDC, extensions: ['TransferFeeConfig'] })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.ANSEM, { ...ON_CHAIN.ANSEM, extensions: ['MetadataPointer', 'TokenMetadata', 'TransferHook'] })).toBe(false);
    expect(tradingMintAdmissible(TRADE_MINTS.ANSEM, { ...ON_CHAIN.ANSEM, extensions: ['MetadataPointer'] })).toBe(false);
  });
});

/** Raw SPL Token (legacy program) mint account bytes. */
function encodeLegacyMint(input: { decimals: number; mintAuthority: string | null; freezeAuthority: string | null }): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: input.mintAuthority ? 1 : 0,
    mintAuthority: new PublicKey(input.mintAuthority ?? PublicKey.default),
    supply: 1n,
    decimals: input.decimals,
    isInitialized: true,
    freezeAuthorityOption: input.freezeAuthority ? 1 : 0,
    freezeAuthority: new PublicKey(input.freezeAuthority ?? PublicKey.default),
  }, data);
  return data;
}

function fakeConnection(answer: (mint: string) => AccountInfo<Buffer> | null): { connection: Connection; calls: string[] } {
  const calls: string[] = [];
  const connection = {
    rpcEndpoint: 'https://fake.mainnet.test',
    async getAccountInfo(key: PublicKey) {
      const mint = key.toBase58();
      calls.push(mint);
      return answer(mint);
    },
  } as unknown as Connection;
  return { connection, calls };
}

const usdcAccount = (): AccountInfo<Buffer> => ({
  owner: TOKEN_PROGRAM_ID,
  executable: false,
  lamports: 1,
  data: encodeLegacyMint({ decimals: 6, mintAuthority: TRADE_USDC_AUTHORITIES.mint, freezeAuthority: TRADE_USDC_AUTHORITIES.freeze }),
});

describe('loadTradingMintWhitelist', () => {
  afterEach(() => {
    clearTradingMintInfoCacheForTests();
    resetTradingLoopAlertsForTest();
  });

  test('an incomplete list pages once per missing set, naming the mint and cause', async () => {
    const alerts: AlertErrorParams[] = [];
    const alert = async (params: AlertErrorParams) => { alerts.push(params); };
    const { connection } = fakeConnection((mint) => (mint === TRADE_MINTS.USDC ? usdcAccount() : null));
    await loadTradingMintWhitelist({ connection, alert });
    await loadTradingMintWhitelist({ connection, alert });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe('critical');
    expect(alerts[0]!.context?.missing).toEqual([
      `${TRADE_MINTS.ANSEM}:unreadable`,
      `${TRADE_MINTS.CLAWVILLE}:unreadable`,
      `${TRADE_MINTS.WSOL}:unreadable`,
    ].sort());
  });

  test('a mint that changed shape is reported as shape_changed, not unreadable', async () => {
    const alerts: AlertErrorParams[] = [];
    const alert = async (params: AlertErrorParams) => { alerts.push(params); };
    const { connection } = fakeConnection((mint) => (mint === TRADE_MINTS.USDC
      ? { owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, data: encodeLegacyMint({ decimals: 6, mintAuthority: OTHER_KEY, freezeAuthority: TRADE_USDC_AUTHORITIES.freeze }) }
      : null));
    const whitelist = await loadTradingMintWhitelist({ connection, alert });
    expect(whitelist.has(TRADE_MINTS.USDC)).toBe(false);
    expect((alerts[0]!.context?.missing as string[])).toContain(`${TRADE_MINTS.USDC}:shape_changed`);
  });

  test('a rejected load releases the cache so the next call retries', async () => {
    const alerts: AlertErrorParams[] = [];
    const alert = async (params: AlertErrorParams) => { alerts.push(params); };
    const broken = { rpcEndpoint: 'x', getAccountInfo: () => { throw new Error('boom'); } } as unknown as Connection;
    // getMintInfo swallows read errors into null, so the load resolves incomplete and releases.
    expect((await loadTradingMintWhitelist({ connection: broken, alert })).size).toBe(0);
    const { connection, calls } = fakeConnection((mint) => (mint === TRADE_MINTS.USDC ? usdcAccount() : null));
    expect((await loadTradingMintWhitelist({ connection, alert })).size).toBe(1);
    expect(calls).toHaveLength(4);
  });

  test('admits real USDC bytes (live Circle authorities) through the decoder', async () => {
    const { connection } = fakeConnection((mint) => (mint === TRADE_MINTS.USDC ? usdcAccount() : null));
    const whitelist = await loadTradingMintWhitelist({ connection });
    expect(whitelist.get(TRADE_MINTS.USDC)?.mintAuthority).toBe(TRADE_USDC_AUTHORITIES.mint);
    expect(whitelist.get(TRADE_MINTS.USDC)?.freezeAuthority).toBe(TRADE_USDC_AUTHORITIES.freeze);
    expect(whitelist.get(TRADE_MINTS.USDC)?.decimals).toBe(6);
  });

  test('an incomplete list is not frozen: the next call reads the chain again', async () => {
    const first = fakeConnection(() => null);
    expect((await loadTradingMintWhitelist({ connection: first.connection })).size).toBe(0);
    expect(first.calls).toHaveLength(4);

    const second = fakeConnection((mint) => (mint === TRADE_MINTS.USDC ? usdcAccount() : null));
    const retried = await loadTradingMintWhitelist({ connection: second.connection });
    expect(second.calls).toHaveLength(4);
    expect(retried.size).toBe(1);
    expect(retried.has(TRADE_MINTS.USDC)).toBe(true);
  });

  test('a legacy mint with a stray mint authority is refused even with correct decimals', async () => {
    const { connection } = fakeConnection((mint) => (mint === TRADE_MINTS.WSOL
      ? { owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, data: encodeLegacyMint({ decimals: 9, mintAuthority: OTHER_KEY, freezeAuthority: null }) }
      : null));
    const whitelist = await loadTradingMintWhitelist({ connection });
    expect(whitelist.has(TRADE_MINTS.WSOL)).toBe(false);
  });
});
