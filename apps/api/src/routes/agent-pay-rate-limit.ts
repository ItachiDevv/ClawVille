import { createRateLimiter } from '../middleware/rate-limit';

const agentPayRateLimiter = createRateLimiter({ maxPerWindow: 6, windowMs: 60_000 });

export type AgentPayRateLimitResult =
  | { ok: true }
  | {
      ok: false;
      status: 429;
      body: { ok: false; error: 'rate_limited'; code: 'rate_limited' };
    };

/** Consume one POST budget unit for the canonical resolved avatar subject. */
export function consumeAgentPayRateLimit(avatarId: string): AgentPayRateLimitResult {
  if (agentPayRateLimiter.check(avatarId)) return { ok: true };
  return {
    ok: false,
    status: 429,
    body: { ok: false, error: 'rate_limited', code: 'rate_limited' },
  };
}

/** Test-only: prevent process-local limiter state from leaking across cases. */
export function resetAgentPayRateLimit(): void {
  agentPayRateLimiter.reset();
}
