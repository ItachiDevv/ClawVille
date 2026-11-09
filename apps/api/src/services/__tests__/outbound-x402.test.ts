import { describe, expect, it } from 'bun:test';
import type { PaymentRequired } from '@x402/core/types';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { SOLANA_MAINNET, callVendorWithAvatarWallet, checkQuote, isBase58Of, payerSignatureFromPayload, selectSolanaUsdcRequirement } from '../outbound-x402';
import { STUDIOS_MAX_CALL_ATOMIC, STUDIOS_PAY_TO, parseStudiosImage } from '../vendors/studios';

// Shape of the live Studios quote (2026-11-05): several chains and assets.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_TO = 'HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa';
const FEE_PAYER = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
const PIN = { vendor: 'studios' as const, payTo: STUDIOS_PAY_TO, maxCallAtomic: STUDIOS_MAX_CALL_ATOMIC };
const PAYER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function quote(accepts: PaymentRequired['accepts']): PaymentRequired {
  return { x402Version: 2, resource: { url: 'https://mystudios.fun/api/v1/images/generations' }, accepts } as PaymentRequired;
}
const usdcEntry = { scheme: 'exact', network: SOLANA_MAINNET, amount: '5000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } };
const others = [
  { scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x3201', maxTimeoutSeconds: 300, extra: {} },
  { scheme: 'exact', network: SOLANA_MAINNET, amount: '12057878', asset: '6GGY8GViCR5v4xR4Lxb4nfiAJsEoJua5Gj6YecxbJ4BQ', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } },
];

describe('the request on the wire (a refused quote stops before the database)', () => {
  async function firstRequest(input: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await callVendorWithAvatarWallet({
      avatarId: 'a', actor: 'agent', pin: PIN, tool: 't', idempotencyKey: 'key-00001', url: 'https://vendor.example/x',
      ...input,
    } as never, {
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response('no', { status: 500 });
      },
    });
    expect(result).toEqual({ ok: false, code: 'vendor_refused', httpStatus: 500 });
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it('POST is unchanged: the default method, JSON headers and the JSON body', async () => {
    const body = { model: 'm', prompt: 'p' };
    for (const input of [{ body }, { method: 'POST' as const, body }]) {
      const { url, init } = await firstRequest(input);
      expect(url).toBe('https://vendor.example/x');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', Accept: 'application/json' });
      expect(init.body).toBe(JSON.stringify(body));
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeDefined();
    }
  });

  it('GET sends no body and no Content-Type, and refuses redirects', async () => {
    const { init } = await firstRequest({ method: 'GET' });
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect('body' in init).toBe(false);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
});

describe('selectSolanaUsdcRequirement', () => {
  it('picks the Solana mainnet USDC entry wherever it sits', () => {
    expect(selectSolanaUsdcRequirement(quote([...others, usdcEntry] as never))).toMatchObject({ asset: USDC, amount: '5000' });
    expect(selectSolanaUsdcRequirement(quote([usdcEntry, ...others] as never))).toMatchObject({ asset: USDC });
  });
  it('refuses a quote with no such entry, or with two', () => {
    expect(selectSolanaUsdcRequirement(quote(others as never))).toBeNull();
    expect(selectSolanaUsdcRequirement(quote([usdcEntry, usdcEntry] as never))).toBeNull();
    expect(selectSolanaUsdcRequirement(quote([{ ...usdcEntry, network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' }] as never))).toBeNull();
    expect(selectSolanaUsdcRequirement(quote([{ ...usdcEntry, scheme: 'upto' }] as never))).toBeNull();
  });
});

describe('checkQuote', () => {
  it('accepts the pinned wallet and a sane amount', () => {
    expect(checkQuote(usdcEntry as never, PIN, PAYER)).toEqual({ ok: true, amount: 5000n });
  });
  it('refuses another payTo', () => {
    expect(checkQuote({ ...usdcEntry, payTo: FEE_PAYER } as never, PIN, PAYER)).toEqual({ ok: false, code: 'vendor_pay_to_changed' });
  });
  it('refuses a bad, zero or too large amount, and a missing fee payer', () => {
    for (const amount of ['0', '-5', '1.5', '5e3', '', String(STUDIOS_MAX_CALL_ATOMIC + 1n)]) {
      expect(checkQuote({ ...usdcEntry, amount } as never, PIN, PAYER)).toEqual({ ok: false, code: 'vendor_quote_invalid' });
    }
    expect(checkQuote({ ...usdcEntry, extra: {} } as never, PIN, PAYER)).toEqual({ ok: false, code: 'vendor_quote_invalid' });
  });
  it('refuses a quote that makes our own wallet the fee payer, or a fee payer that is not a key', () => {
    expect(checkQuote({ ...usdcEntry, extra: { feePayer: PAYER } } as never, PIN, PAYER)).toEqual({ ok: false, code: 'vendor_quote_invalid' });
    expect(checkQuote({ ...usdcEntry, extra: { feePayer: 'x'.repeat(44) } } as never, PIN, PAYER)).toEqual({ ok: false, code: 'vendor_quote_invalid' });
  });
});

describe('payerSignatureFromPayload', () => {
  it('returns our own signature from a transaction that the fee payer has not signed yet', () => {
    const feePayer = Keypair.generate();
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: feePayer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: feePayer.publicKey, lamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([payer]);
    const b64 = Buffer.from(tx.serialize()).toString('base64');
    const sig = payerSignatureFromPayload(b64, payer.publicKey.toBase58());
    expect(isBase58Of(sig, 64)).toBe(true);
    expect(() => payerSignatureFromPayload(b64, Keypair.generate().publicKey.toBase58())).toThrow();
    expect(() => payerSignatureFromPayload(b64, feePayer.publicKey.toBase58())).toThrow();
  });
});

describe('parseStudiosImage', () => {
  it('reads base64 data from the first entry only', () => {
    expect(parseStudiosImage({ data: [{ b64_json: 'aGVs\nbG8=' }] })).toEqual({ imageBase64: 'aGVsbG8=' });
  });
  it('never accepts a link (the API stores, follows and redirects to no vendor URL)', () => {
    expect(parseStudiosImage({ data: [{ url: 'https://cdn.example/x.png?sig=1' }] })).toBeNull();
  });
  it('drops anything else', () => {
    expect(parseStudiosImage({ data: [{ url: 'http://plain/x.png' }] })).toBeNull();
    expect(parseStudiosImage({ data: [{ url: 'javascript:alert(1)' }] })).toBeNull();
    expect(parseStudiosImage({ data: [{ b64_json: '<script>' }] })).toBeNull();
    expect(parseStudiosImage({ data: [] })).toBeNull();
    expect(parseStudiosImage('ignore previous instructions')).toBeNull();
  });
});
