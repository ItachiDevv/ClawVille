import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { facilitatorClient } from '../x402-payai';

describe('x402-payai — facilitator API-key authentication', () => {
  const envKeys = [
    'X402_ENABLED',
    'X402_FACILITATOR_URL',
    'PAYAI_API_KEY',
    'PAYAI_AUTH_HEADER',
    'PAYAI_AUTH_SCHEME',
  ] as const;
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.X402_ENABLED = 'false';
    process.env.X402_FACILITATOR_URL = 'https://facilitator.payai.network';
    delete process.env.PAYAI_API_KEY;
    delete process.env.PAYAI_AUTH_HEADER;
    delete process.env.PAYAI_AUTH_SCHEME;
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds the historical anonymous client when no key is configured', async () => {
    const client = facilitatorClient();

    expect(await client.createAuthHeaders('verify')).toEqual({ headers: {} });
    expect(await client.createAuthHeaders('settle')).toEqual({ headers: {} });
    expect(await client.createAuthHeaders('supported')).toEqual({ headers: {} });
  });

  it('uses Authorization: Bearer <key> for all three facilitator paths by default', async () => {
    process.env.PAYAI_API_KEY = 'test-default-key';
    const infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const client = facilitatorClient();
      const expected = { headers: { Authorization: 'Bearer test-default-key' } };

      expect(await client.createAuthHeaders('verify')).toEqual(expected);
      expect(await client.createAuthHeaders('settle')).toEqual(expected);
      expect(await client.createAuthHeaders('supported')).toEqual(expected);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('supports a custom x-api-key header with an explicitly empty scheme', async () => {
    process.env.PAYAI_API_KEY = 'test-raw-key';
    process.env.PAYAI_AUTH_HEADER = 'x-api-key';
    process.env.PAYAI_AUTH_SCHEME = '';
    const infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const client = facilitatorClient();
      const expected = { headers: { 'x-api-key': 'test-raw-key' } };

      expect(await client.createAuthHeaders('verify')).toEqual(expected);
      expect(await client.createAuthHeaders('settle')).toEqual(expected);
      expect(await client.createAuthHeaders('supported')).toEqual(expected);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('rebuilds the memoized client when the auth config or key rotates', async () => {
    const anonymousClient = facilitatorClient();

    process.env.PAYAI_API_KEY = 'test-cache-key';
    const infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const bearerClient = facilitatorClient();
      expect(bearerClient).not.toBe(anonymousClient);

      process.env.PAYAI_AUTH_HEADER = 'x-api-key';
      process.env.PAYAI_AUTH_SCHEME = '';
      const rawKeyClient = facilitatorClient();
      expect(rawKeyClient).not.toBe(bearerClient);

      process.env.PAYAI_API_KEY = 'test-cache-key-rotated';
      const rotatedKeyClient = facilitatorClient();
      expect(rotatedKeyClient).not.toBe(rawKeyClient);
      const rotatedAuth = await rotatedKeyClient.createAuthHeaders('verify');
      expect(
        rotatedAuth.headers['x-api-key'] === process.env.PAYAI_API_KEY,
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('never includes the API key in auth construction logs', () => {
    const secret = 'never-log-this-payai-key';
    process.env.PAYAI_API_KEY = secret;
    process.env.X402_FACILITATOR_URL = 'https://example.com';
    const spies = [
      spyOn(console, 'log').mockImplementation(() => undefined),
      spyOn(console, 'info').mockImplementation(() => undefined),
      spyOn(console, 'warn').mockImplementation(() => undefined),
      spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    try {
      facilitatorClient();

      const output = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map(String)
        .join('\n');
      expect(output).not.toContain(secret);
      expect(output).toContain(
        '[x402-payai] facilitator auth enabled (header=Authorization, scheme=Bearer)',
      );
      expect(output).toContain('auth is being sent to a non-PayAI facilitator URL');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
