import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { tokenomicsRedeemRoutes } from '../tokenomics-redeem';

describe('tokenomics redeem dark gate', () => {
  it('returns typed 503 before auth/body parsing on POST and GET', async () => {
    const previous = process.env.TOKENOMICS_REDEEM_ENABLED;
    delete process.env.TOKENOMICS_REDEEM_ENABLED;
    try {
      const app = new Hono();
      app.route('/api/tokenomics/redeem', tokenomicsRedeemRoutes);
      const post = await app.request('/api/tokenomics/redeem', { method: 'POST' });
      expect(post.status).toBe(503);
      expect(await post.json()).toEqual({
        ok: false,
        error: 'redeem_disabled',
        code: 'redeem_disabled',
      });
      const get = await app.request('/api/tokenomics/redeem/00000000-0000-0000-0000-000000000000');
      expect(get.status).toBe(503);
    } finally {
      if (previous === undefined) delete process.env.TOKENOMICS_REDEEM_ENABLED;
      else process.env.TOKENOMICS_REDEEM_ENABLED = previous;
    }
  });
});
