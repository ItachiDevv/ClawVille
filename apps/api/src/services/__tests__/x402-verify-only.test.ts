/**
 * verifyAndSettle VERIFY-ONLY mode (the SAP payai-rail dry-run posture).
 *
 * The money invariant under test: with `verifyOnly:true` the facilitator's
 * `/settle` endpoint is NEVER hit — no matter what `/verify` says — so a
 * dry-run payai release can never move USDC. Also locks the sentinel result
 * shape (`settled:false`, `isValid:true`, `failureReason:'verify_only_mode'`)
 * the payai executor keys on, and that a failing verify still short-circuits
 * settle in BOTH modes.
 *
 * Uses a throwaway in-process facilitator (Bun.serve) that counts hits — the
 * same technique as the devnet evidence script — so no network, no mocks of
 * our own code, the REAL HTTP wire path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { verifyAndSettle } from '../x402-payai';
import type { PaymentRequirements } from '@x402/core/types';

const PORT = 4567;
let server: ReturnType<typeof Bun.serve> | null = null;
let verifyHits = 0;
let settleHits = 0;
/** What the mock's /verify answers next. */
let verifyResponse: { isValid: boolean; invalidReason?: string; payer?: string } = {
  isValid: true,
  payer: 'PayerPubkey11111111111111111111111111111111',
};

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  amount: '1000000',
  asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  payTo: 'WorkerPubkey1111111111111111111111111111111',
  maxTimeoutSeconds: 120,
  extra: {},
};

/** A syntactically-valid base64(JSON) payment header (content is irrelevant —
 *  the counting facilitator never decodes it). */
const paymentHeader = Buffer.from(
  JSON.stringify({ x402Version: 2, scheme: 'exact', payload: {} }),
  'utf8',
).toString('base64');

beforeAll(() => {
  const app = new Hono();
  app.post('/verify', (c) => {
    verifyHits += 1;
    return c.json(verifyResponse);
  });
  app.post('/settle', (c) => {
    settleHits += 1;
    return c.json({
      success: true,
      transaction: 'FakeSig1111111111111111111111111111111111111111111111111111111111',
      network: requirements.network,
      payer: verifyResponse.payer,
    });
  });
  server = Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: app.fetch });
  // facilitatorClient() re-reads the URL per call and rebuilds on change, so
  // pointing the env here (not at module load) is honored.
  process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${PORT}`;
});

afterAll(() => {
  server?.stop();
  delete process.env.X402_FACILITATOR_URL;
});

describe('verifyAndSettle — verifyOnly (payai dry-run posture)', () => {
  it('a PASSING verify in verifyOnly mode NEVER calls /settle and reports the sentinel', async () => {
    verifyResponse = { isValid: true, payer: 'PayerPubkey11111111111111111111111111111111' };
    const before = settleHits;
    const res = await verifyAndSettle({ paymentHeader, requirements, verifyOnly: true });
    expect(settleHits).toBe(before); // the invariant: no settle, ever
    expect(res.settled).toBe(false); // settled:true still ONLY means a real settle
    expect(res.isValid).toBe(true);
    expect(res.failureReason).toBe('verify_only_mode');
    expect(res.txSignature).toBeNull();
    expect(verifyHits).toBeGreaterThan(0);
  });

  it('a FAILING verify in verifyOnly mode reports isValid:false (and still no /settle)', async () => {
    verifyResponse = { isValid: false, invalidReason: 'insufficient_funds' };
    const before = settleHits;
    const res = await verifyAndSettle({ paymentHeader, requirements, verifyOnly: true });
    expect(settleHits).toBe(before);
    expect(res.settled).toBe(false);
    expect(res.isValid).toBe(false);
    expect(res.failureReason).toBe('insufficient_funds');
  });

  it('LIVE mode still settles only after a passing verify (regression guard)', async () => {
    verifyResponse = { isValid: true, payer: 'PayerPubkey11111111111111111111111111111111' };
    const before = settleHits;
    const res = await verifyAndSettle({ paymentHeader, requirements });
    expect(settleHits).toBe(before + 1);
    expect(res.settled).toBe(true);
    expect(res.txSignature).toBe(
      'FakeSig1111111111111111111111111111111111111111111111111111111111',
    );
  });

  it('LIVE mode with a failing verify never reaches /settle (unchanged contract)', async () => {
    verifyResponse = { isValid: false, invalidReason: 'payment_invalid' };
    const before = settleHits;
    const res = await verifyAndSettle({ paymentHeader, requirements });
    expect(settleHits).toBe(before);
    expect(res.settled).toBe(false);
    expect(res.isValid).toBe(false);
  });
});
