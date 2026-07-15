/**
 * Metered agent services behind the x402 Solana paywall.
 *
 * These routes are registered under `/api/v2/agent/*` and gated by the
 * `X402_ENABLED` env var. The paid middleware is currently quarantined:
 * requesting `X402_ENABLED=true` fail-boots until its settlements join the
 * durable global receipt registry. When disabled (default), the routes still
 * exist without paymentMiddleware for local request/response iteration.
 *
 * Existing agent/gateway/skills APIs remain free. The handlers below are
 * bounded, real services: an Eliza-backed expert consultation and a cached
 * multi-window leaderboard analysis. When the paywall is enabled, x402 first
 * verifies the signed payment, runs the handler, and settles only a successful
 * (<400) deliverable response.
 */

import { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import { SHOP_BUILDINGS } from '@clawville/shared';
import { z } from 'zod';
import type { AppContext } from '../types';
import {
  assertMeteredAgentPaywallSafe,
  loadX402Config,
  buildX402ResourceServer,
  buildX402Routes,
} from '../services/x402-config';
import { collaborateOnQuery, detectRelevantExperts } from '../services/agent-collaboration';
import { getAgentLeaderboardEntry } from './leaderboard';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import {
  CONTENT_BLOCKED_CODE,
  CONTENT_BLOCKED_MESSAGE,
  OUTPUT_REFUSAL_MESSAGE,
  moderateText,
} from '../services/moderation-service';

export const agentV2Routes = new Hono<AppContext>();

assertMeteredAgentPaywallSafe();
const x402Config = loadX402Config();

const paidServiceLimiter = createRateLimiter({ maxPerWindow: 20, windowMs: 60_000 });

const expertConsultSchema = z
  .object({
    question: z.string().trim().min(1).max(2_000),
    sourceBuildingId: z.enum(SHOP_BUILDINGS).default('api-integrations'),
    maxExperts: z.number().int().min(1).max(2).default(2),
  })
  .strict();

const analyticsAgentIdSchema = z.string().trim().min(1).max(160);

/**
 * x402/hono settles only successful responses. Keep this decision explicit so
 * an all-experts-failed consultation can never become a paid empty receipt.
 */
export function getExpertConsultDeliveryStatus(insightCount: number): 200 | 503 {
  return insightCount > 0 ? 200 : 503;
}

// Rate-limit BEFORE the x402 middleware so an over-limit caller is refused
// before settlement. A post-payment 429 would charge for a service we withheld.
agentV2Routes.use('/expert-consult', async (c, next) => {
  if (!paidServiceLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited', message: 'Too many paid service requests.' }, 429);
  }
  return next();
});
agentV2Routes.use('/expert-consult', async (c, next) => {
  const body = await c.req.raw.clone().json().catch(() => null);
  const parsed = expertConsultSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'question (1-2000 chars), sourceBuildingId, and maxExperts (1-2) are required.',
      },
      400,
    );
  }
  if (
    detectRelevantExperts(
      parsed.data.question,
      parsed.data.sourceBuildingId,
      parsed.data.maxExperts,
    ).length === 0
  ) {
    return c.json(
      {
        error: 'no_relevant_expert',
        message: 'Ask a domain-specific question that matches at least one ClawVille expert.',
      },
      422,
    );
  }
  const inputModeration = await moderateText(parsed.data.question, {
    surface: 'x402-expert-consult',
    direction: 'input',
  });
  if (!inputModeration.allowed) {
    return c.json({ error: CONTENT_BLOCKED_MESSAGE, code: CONTENT_BLOCKED_CODE }, 400);
  }
  return next();
});
agentV2Routes.use('/analytics/*', async (c, next) => {
  if (!paidServiceLimiter.check(getClientIp(c.req.raw.headers))) {
    return c.json({ error: 'rate_limited', message: 'Too many paid service requests.' }, 429);
  }
  return next();
});
agentV2Routes.use('/analytics/:agentId', async (c, next) => {
  if (!analyticsAgentIdSchema.safeParse(c.req.param('agentId')).success) {
    return c.json({ error: 'invalid_agent_id' }, 400);
  }
  return next();
});

if (x402Config.enabled) {
  const resourceServer = buildX402ResourceServer(x402Config);
  if (resourceServer) {
    const routes = buildX402Routes(x402Config);
    agentV2Routes.use('*', paymentMiddleware(routes, resourceServer));
    console.log(
      `[x402] Paywall ENABLED on /api/v2/agent/* — merchant=${x402Config.merchantWalletPubkey.slice(0, 8)}... network=${x402Config.network}`,
    );
  }
} else {
  console.log('[x402] Paywall DISABLED (set X402_ENABLED=true to activate).');
}

agentV2Routes.get('/ping', (c) => {
  return c.json({
    ok: true,
    timestamp: new Date().toISOString(),
    merchant: x402Config.merchantWalletPubkey || null,
    network: x402Config.network,
    x402Enabled: x402Config.enabled,
  });
});

/**
 * A real paid service call: consult up to two existing Eliza-backed building
 * experts and return their attributed responses. No target-agent delivery is
 * claimed here; the codebase has no durable target inbox/receipt primitive.
 */
agentV2Routes.post('/expert-consult', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = expertConsultSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'question (1-2000 chars), sourceBuildingId, and maxExperts (1-2) are required.',
      },
      400,
    );
  }

  try {
    const result = await collaborateOnQuery({
      message: parsed.data.question,
      sourceBuildingId: parsed.data.sourceBuildingId,
      maxExperts: parsed.data.maxExperts,
      timeoutMs: 8_000,
    });

    const insights = await Promise.all(
      result.insights.map(async (insight) => {
        const outputModeration = await moderateText(insight.response, {
          surface: 'x402-expert-consult',
          direction: 'output',
        });
        return {
          buildingId: insight.buildingId,
          buildingName: insight.buildingName,
          response: outputModeration.allowed ? insight.response : OUTPUT_REFUSAL_MESSAGE,
        };
      }),
    );

    const deliveryStatus = getExpertConsultDeliveryStatus(insights.length);
    if (deliveryStatus !== 200) {
      return c.json(
        {
          error: 'expert_service_unavailable',
          message: 'No expert produced a deliverable response; the x402 payment was not settled.',
        },
        deliveryStatus,
      );
    }

    return c.json({
      consulted: result.consulted,
      insights,
      durationMs: result.durationMs,
      delivered: true,
    });
  } catch (error) {
    console.error('[agent-v2/expert-consult] service failed:', error instanceof Error ? error.message : 'unknown');
    return c.json({ error: 'expert_service_unavailable' }, 502);
  }
});

/**
 * Paid rank intelligence over the exact cached/capped public leaderboard
 * engine. The helper's horizon is the top 500 subjects per window; null means
 * unranked or outside that horizon, never proof of a zero score.
 */
agentV2Routes.get('/analytics/:agentId', async (c) => {
  const parsedAgentId = analyticsAgentIdSchema.safeParse(c.req.param('agentId'));
  if (!parsedAgentId.success) {
    return c.json({ error: 'invalid_agent_id' }, 400);
  }

  try {
    const windowNames = ['24h', '7d', '30d', 'all'] as const;
    const entries = await Promise.all(
      windowNames.map(async (window) => [
        window,
        await getAgentLeaderboardEntry(parsedAgentId.data, window),
      ] as const),
    );

    return c.json({
      agentId: parsedAgentId.data,
      queriedAt: new Date().toISOString(),
      horizon: 500,
      windows: Object.fromEntries(entries),
    });
  } catch (error) {
    console.error('[agent-v2/analytics] service failed:', error instanceof Error ? error.message : 'unknown');
    return c.json({ error: 'analytics_unavailable' }, 502);
  }
});
