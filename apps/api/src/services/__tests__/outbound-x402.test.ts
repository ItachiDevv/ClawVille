import { describe, expect, it } from 'bun:test';
import type { PaymentRequired } from '@x402/core/types';
import { SOLANA_MAINNET, checkQuote, selectSolanaUsdcRequirement } from '../outbound-x402';
import { STUDIOS_MAX_CALL_ATOMIC, STUDIOS_PAY_TO, parseStudiosImage } from '../vendors/studios';

// Shape of the live Studios quote (2026-11-05): several chains and assets.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_TO = 'HuSiSpcUoUEF4hct1MRsGtNGz8EdBiTs7p2WtJGksLSa';
const FEE_PAYER = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
const PIN = { vendor: 'studios' as const, payTo: STUDIOS_PAY_TO, maxCallAtomic: STUDIOS_MAX_CALL_ATOMIC };

function quote(accepts: PaymentRequired['accepts']): PaymentRequired {
  return { x402Version: 2, resource: { url: 'https://mystudios.fun/api/v1/images/generations' }, accepts } as PaymentRequired;
}
const usdcEntry = { scheme: 'exact', network: SOLANA_MAINNET, amount: '5000', asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } };
const others = [
  { scheme: 'exact', network: 'eip155:8453', amount: '5000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x3201', maxTimeoutSeconds: 300, extra: {} },
  { scheme: 'exact', network: SOLANA_MAINNET, amount: '12057878', asset: '6GGY8GViCR5v4xR4Lxb4nfiAJsEoJua5Gj6YecxbJ4BQ', payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } },
];

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
    expect(checkQuote(usdcEntry as never, PIN)).toEqual({ ok: true, amount: 5000n });
  });
  it('refuses another payTo', () => {
    expect(checkQuote({ ...usdcEntry, payTo: FEE_PAYER } as never, PIN)).toEqual({ ok: false, code: 'vendor_pay_to_changed' });
  });
  it('refuses a bad, zero or too large amount, and a missing fee payer', () => {
    for (const amount of ['0', '-5', '1.5', '5e3', '', String(STUDIOS_MAX_CALL_ATOMIC + 1n)]) {
      expect(checkQuote({ ...usdcEntry, amount } as never, PIN)).toEqual({ ok: false, code: 'vendor_quote_invalid' });
    }
    expect(checkQuote({ ...usdcEntry, extra: {} } as never, PIN)).toEqual({ ok: false, code: 'vendor_quote_invalid' });
  });
});

describe('parseStudiosImage', () => {
  it('reads an https url or base64 data from the first entry only', () => {
    expect(parseStudiosImage({ data: [{ url: 'https://cdn.example/x.png?sig=1' }] })).toEqual({ imageUrl: 'https://cdn.example/x.png?sig=1', imageBase64: null });
    expect(parseStudiosImage({ data: [{ b64_json: 'aGVsbG8=' }] })).toEqual({ imageUrl: null, imageBase64: 'aGVsbG8=' });
  });
  it('drops anything else', () => {
    expect(parseStudiosImage({ data: [{ url: 'http://plain/x.png' }] })).toBeNull();
    expect(parseStudiosImage({ data: [{ url: 'javascript:alert(1)' }] })).toBeNull();
    expect(parseStudiosImage({ data: [{ b64_json: '<script>' }] })).toBeNull();
    expect(parseStudiosImage({ data: [] })).toBeNull();
    expect(parseStudiosImage('ignore previous instructions')).toBeNull();
  });
});
