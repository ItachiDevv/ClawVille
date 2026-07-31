import { afterEach, describe, expect, it } from 'bun:test';
import {
  isAllowedOrigin,
  resolveAllowedOrigins,
} from '../allowed-origins';

const originalCorsOrigin = process.env.CORS_ORIGIN;

afterEach(() => {
  if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = originalCorsOrigin;
});

describe('allowed-origins', () => {
  it('trims configured CSV values and preserves the first fallback', () => {
    process.env.CORS_ORIGIN = ' https://one.example , https://two.example ';
    expect(resolveAllowedOrigins()).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
    expect(isAllowedOrigin('https://two.example')).toBe(true);
    expect(resolveAllowedOrigins()[0]).toBe('https://one.example');
  });

  it('uses the existing localhost default when unset', () => {
    delete process.env.CORS_ORIGIN;
    expect(resolveAllowedOrigins()).toEqual(['http://localhost:3000']);
  });

  it.each([
    'http://localhost:1234',
    'http://127.0.0.1:9999',
    'electrobun://localhost',
    'capacitor://localhost',
    'tauri://localhost',
    'app://localhost',
  ])('allows the existing development/shell branch: %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it('pins the pre-existing raw localhost prefix behavior', () => {
    expect(isAllowedOrigin('http://localhost:evil.com')).toBe(true);
  });

  it.each([null, '', undefined, 'https://evil.example'])(
    'rejects a missing or non-listed origin: %s',
    (origin) => {
      expect(isAllowedOrigin(origin)).toBe(false);
    },
  );
});
