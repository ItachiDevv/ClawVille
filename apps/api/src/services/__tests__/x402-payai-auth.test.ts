import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { facilitatorClient } from '../x402-payai';

function generatePayAITestSecret(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return `payai_sk_${pkcs8}`;
}

describe('x402-payai — facilitator signed-JWT authentication', () => {
  const envKeys = [
    'X402_ENABLED',
    'X402_FACILITATOR_URL',
    'PAYAI_API_KEY_ID',
    'PAYAI_API_KEY_SECRET',
  ] as const;
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.X402_ENABLED = 'false';
    process.env.X402_FACILITATOR_URL = 'https://facilitator.payai.network';
    delete process.env.PAYAI_API_KEY_ID;
    delete process.env.PAYAI_API_KEY_SECRET;
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds the historical anonymous client when neither credential is configured', async () => {
    const client = facilitatorClient();

    expect(await client.createAuthHeaders('verify')).toEqual({ headers: {} });
    expect(await client.createAuthHeaders('settle')).toEqual({ headers: {} });
    expect(await client.createAuthHeaders('supported')).toEqual({ headers: {} });
  });

  it('uses PayAI Bearer JWT auth for verify, settle, and supported', async () => {
    process.env.PAYAI_API_KEY_ID = 'test-key-id';
    process.env.PAYAI_API_KEY_SECRET = generatePayAITestSecret();
    const infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const client = facilitatorClient();

      for (const path of ['verify', 'settle', 'supported']) {
        const auth = await client.createAuthHeaders(path);
        const authorization = auth.headers.Authorization;
        expect(typeof authorization).toBe('string');
        expect(authorization.startsWith('Bearer ')).toBe(true);
        expect(authorization.length).toBeGreaterThan('Bearer '.length);
      }
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('stays anonymous when only the ID or only the secret is configured', async () => {
    process.env.PAYAI_API_KEY_ID = 'id-only';
    const idOnlyClient = facilitatorClient();
    expect(await idOnlyClient.createAuthHeaders('verify')).toEqual({ headers: {} });

    delete process.env.PAYAI_API_KEY_ID;
    process.env.PAYAI_API_KEY_SECRET = generatePayAITestSecret();
    const secretOnlyClient = facilitatorClient();
    expect(secretOnlyClient).not.toBe(idOnlyClient);
    expect(await secretOnlyClient.createAuthHeaders('verify')).toEqual({ headers: {} });
  });

  it('rebuilds the memoized client when credentials change', async () => {
    const anonymousClient = facilitatorClient();
    const infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      process.env.PAYAI_API_KEY_ID = 'first-key-id';
      process.env.PAYAI_API_KEY_SECRET = generatePayAITestSecret();
      const firstAuthClient = facilitatorClient();
      expect(firstAuthClient).not.toBe(anonymousClient);

      process.env.PAYAI_API_KEY_ID = 'second-key-id';
      const changedIdClient = facilitatorClient();
      expect(changedIdClient).not.toBe(firstAuthClient);
      const beforeRotation = await changedIdClient.createAuthHeaders('verify');

      process.env.PAYAI_API_KEY_SECRET = generatePayAITestSecret();
      const rotatedSecretClient = facilitatorClient();
      expect(rotatedSecretClient).not.toBe(changedIdClient);
      const afterRotation = await rotatedSecretClient.createAuthHeaders('verify');
      expect(afterRotation.headers.Authorization).not.toBe(
        beforeRotation.headers.Authorization,
      );
      expect(facilitatorClient()).toBe(rotatedSecretClient);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('never includes the API key secret in console output', () => {
    const secret = 'payai_sk_secret-must-never-appear';
    process.env.PAYAI_API_KEY_ID = 'loggable-key-id';
    process.env.PAYAI_API_KEY_SECRET = secret;
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
        '[x402-payai] facilitator auth enabled (PayAI JWT, keyId=loggable-key-id)',
      );
      expect(output).toContain('auth is being sent to a non-PayAI facilitator URL');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
