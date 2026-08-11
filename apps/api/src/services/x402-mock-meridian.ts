/** Test-only Meridian v1 facilitator. Performs no chain work and holds no keys. */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MOCK_PAYER = 'MockPayer1111111111111111111111111111111111';

function directive(payload: any): string | undefined {
  const value = payload?.payload?.__mock;
  return typeof value === 'string' ? value : undefined;
}

function payer(payload: any): string {
  return payload?.payload?.payer ?? payload?.payer ?? MOCK_PAYER;
}

function signature(seed: unknown): string {
  const hash = createHash('sha512').update(JSON.stringify(seed ?? '')).digest();
  let value = '';
  for (let i = 0; i < 88; i += 1) {
    value += BASE58_ALPHABET[hash[i % hash.length] % BASE58_ALPHABET.length];
  }
  return value;
}

export interface MockMeridianOptions { log?: boolean }

export function buildMockMeridian(opts: MockMeridianOptions = {}): Hono {
  const router = new Hono();
  const log = opts.log ?? true;
  const say = (message: string) => { if (log) console.log(`[x402-mock-meridian] ${message}`); };

  router.post('/v1/verify', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const paymentPayload = body?.paymentPayload;
    const selected = directive(paymentPayload);
    if (selected === 'verify-error-400') return c.json({ error: 'forced_client_error' }, 400);
    if (selected === 'verify-error') return c.json({ error: 'forced_outage' }, 500);
    if (selected === 'verify-invalid') {
      say('verify invalid');
      return c.json({ isValid: false, invalidReason: 'mock_forced_invalid', payer: payer(paymentPayload) });
    }
    say('verify valid');
    return c.json({ isValid: true, payer: payer(paymentPayload) });
  });

  router.post('/v1/settle', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const paymentPayload = body?.paymentPayload;
    const requirements = body?.paymentRequirements;
    const selected = directive(paymentPayload);
    if (selected === 'settle-error-400') return c.json({ error: 'forced_client_error' }, 400);
    if (selected === 'settle-error') return c.json({ error: 'forced_outage' }, 500);
    if (selected === 'settle-fail') {
      return c.json({
        success: false,
        errorReason: 'mock_forced_settlement_failure',
        transaction: '',
        network: requirements?.network ?? 'solana-devnet',
        payer: payer(paymentPayload),
      });
    }
    if (selected === 'settle-fail-signature') {
      return c.json({
        success: false,
        errorReason: 'mock_forced_settlement_failure',
        transaction: signature(paymentPayload),
        network: requirements?.network ?? 'solana-devnet',
        payer: payer(paymentPayload),
      });
    }
    if (selected === 'settle-empty-signature') {
      return c.json({
        success: true,
        transaction: '',
        network: requirements?.network ?? 'solana-devnet',
        payer: payer(paymentPayload),
      });
    }
    return c.json({
      success: true,
      transaction: signature(paymentPayload),
      network: requirements?.network ?? 'solana-devnet',
      payer: payer(paymentPayload),
    });
  });

  return router;
}
