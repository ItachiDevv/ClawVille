import { afterEach, describe, expect, it } from 'bun:test';
import {
  consumeAgentPayRateLimit,
  resetAgentPayRateLimit,
} from '../agent-pay-rate-limit';

afterEach(() => {
  resetAgentPayRateLimit();
});

describe('POST /api/agent-pay subject rate limit', () => {
  it('allows six requests per resolved avatar and returns the 429 wire on the seventh', () => {
    for (let request = 0; request < 6; request += 1) {
      expect(consumeAgentPayRateLimit('avatar-one')).toEqual({ ok: true });
    }

    expect(consumeAgentPayRateLimit('avatar-one')).toEqual({
      ok: false,
      status: 429,
      body: { ok: false, error: 'rate_limited', code: 'rate_limited' },
    });
  });

  it('keeps another resolved avatar in an independent bucket', () => {
    for (let request = 0; request < 7; request += 1) {
      consumeAgentPayRateLimit('avatar-one');
    }

    expect(consumeAgentPayRateLimit('avatar-two')).toEqual({ ok: true });
  });
});
