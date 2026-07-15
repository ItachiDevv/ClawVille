import { afterEach, describe, expect, it } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { assertTokenomicsEarnEnabled } from '../tokenomics-earn';

describe('tokenomics E1/E2 dark route gate', () => {
  const original = process.env.TOKENOMICS_EARN_ENABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.TOKENOMICS_EARN_ENABLED;
    else process.env.TOKENOMICS_EARN_ENABLED = original;
  });

  it('returns the typed 503 while the route is default-off', () => {
    delete process.env.TOKENOMICS_EARN_ENABLED;
    try {
      assertTokenomicsEarnEnabled();
      throw new Error('gate unexpectedly opened');
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(503);
      expect((error as HTTPException).message).toBe('tokenomics_earn_disabled');
    }
  });
});
