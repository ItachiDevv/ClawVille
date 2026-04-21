/**
 * Internal metrics dashboard — read from the `events` table only.
 *
 * Four cards + one chart:
 *   Card 1: DAU connected agents (24h) + 7d delta + Milady-origin %
 *   Card 2: Connect → first engagement (7d) conversion
 *   Card 3: Returning-day rate (7d) — agents active on ≥2 distinct calendar days
 *   Card 4: Agent↔agent collaborations (7d) + MiladyAI teacher chats sublabel
 *   Chart:  Buildings by visits (7d)
 *
 * All queries run in parallel via Promise.all — no dependencies between them.
 *
 * Admin-gated via ADMIN_USER_IDS env var. See middleware/admin-only.ts.
 * Also exposes POST /__test-alert for verifying the Telegram alert channel.
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import { alertError } from '../services/alert-error';
import type { AppContext } from '../types';

export const dashboardRoutes = new Hono<AppContext>();

const MEASUREMENT_START = process.env.METRICS_MEASUREMENT_START ?? '2026-04-21';

// sessionMiddleware populates c.get('user'); adminOnly checks allowlist.
dashboardRoutes.use('*', sessionMiddleware);

dashboardRoutes.get('/overview', adminOnly, async (c) => {
  const [dauRes, miladyRes, funnelRes, retentionRes, collabRes, teacherChatRes, buildingsRes] =
    await Promise.all([
      // Card 1: DAU + 7d delta
      db.execute<{ count: number; prev_count: number }>(sql`
        WITH now_24h AS (
          SELECT COUNT(DISTINCT agent_id)::int AS c
          FROM events
          WHERE event_type = 'agent.connected'
            AND ts > now() - interval '24 hours'
            AND agent_id IS NOT NULL
        ), prev_24h AS (
          SELECT COUNT(DISTINCT agent_id)::int AS c
          FROM events
          WHERE event_type = 'agent.connected'
            AND ts > now() - interval '7 days'
            AND ts <= now() - interval '6 days'
            AND agent_id IS NOT NULL
        )
        SELECT (SELECT c FROM now_24h) AS count,
               (SELECT c FROM prev_24h) AS prev_count
      `),

      // Card 1 sublabel: Milady-origin %
      db.execute<{ total: number; milady: number }>(sql`
        SELECT
          COUNT(DISTINCT agent_id)::int AS total,
          COUNT(DISTINCT agent_id) FILTER (WHERE payload->>'miladyAgentId' IS NOT NULL)::int AS milady
        FROM events
        WHERE event_type = 'agent.connected'
          AND ts > now() - interval '24 hours'
          AND agent_id IS NOT NULL
      `),

      // Card 2: Connect → first engagement (7d)
      db.execute<{ connects: number; engaged: number }>(sql`
        WITH connects AS (
          SELECT DISTINCT agent_id FROM events
          WHERE event_type = 'agent.connected'
            AND ts > now() - interval '7 days'
            AND agent_id IS NOT NULL
        ),
        engaged AS (
          SELECT DISTINCT agent_id FROM events
          WHERE event_type IN ('building.visited', 'agent.chat.turn')
            AND ts > now() - interval '7 days'
            AND agent_id IS NOT NULL
        )
        SELECT
          (SELECT COUNT(*)::int FROM connects) AS connects,
          (SELECT COUNT(*)::int FROM connects c JOIN engaged e USING (agent_id)) AS engaged
      `),

      // Card 3: Returning-day rate (7d)
      db.execute<{ total_agents: number; returning_agents: number }>(sql`
        WITH agent_days AS (
          SELECT agent_id, COUNT(DISTINCT DATE(ts)) AS distinct_days
          FROM events
          WHERE ts > now() - interval '7 days'
            AND agent_id IS NOT NULL
          GROUP BY agent_id
        )
        SELECT
          COUNT(*)::int AS total_agents,
          COUNT(*) FILTER (WHERE distinct_days >= 2)::int AS returning_agents
        FROM agent_days
      `),

      // Card 4: Agent↔agent collaborations (7d)
      db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM events
        WHERE event_type = 'agent.collaboration.turn'
          AND ts > now() - interval '7 days'
      `),

      // Card 4 sublabel: MiladyAI teacher chats (7d).
      // Teacher chats = conversations with the 10 building residents:
      //   'building' — an agent chats with a building's resident character
      //                (POST /api/agent/:sessionId/building/:buildingId/chat)
      //   'location' — a signed-in human chats with a building's resident
      //                (POST /api/locations/:id/chat)
      // We deliberately EXCLUDE 'character' (agent-to-any-NPC via
      // /:sessionId/chat) — that fires for wandering NPCs too and would
      // inflate teacher-engagement numbers.
      db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM events
        WHERE event_type = 'agent.chat.turn'
          AND ts > now() - interval '7 days'
          AND payload->>'chatType' IN ('building', 'location')
      `),

      // Chart: Buildings by visits (7d)
      db.execute<{ building_id: string; visits: number }>(sql`
        SELECT building_id, COUNT(*)::int AS visits FROM events
        WHERE event_type = 'building.visited'
          AND ts > now() - interval '7 days'
          AND building_id IS NOT NULL
        GROUP BY building_id
        ORDER BY visits DESC
      `),
    ]);

  const [dauRow] = dauRes;
  const [miladyRow] = miladyRes;
  const [funnelRow] = funnelRes;
  const [retentionRow] = retentionRes;
  const [collabRow] = collabRes;
  const [teacherChatRow] = teacherChatRes;

  const dauCount = dauRow?.count ?? 0;
  const dauPrev = dauRow?.prev_count ?? 0;
  const miladyTotal = miladyRow?.total ?? 0;
  const miladyCount = miladyRow?.milady ?? 0;
  const funnelConnects = funnelRow?.connects ?? 0;
  const funnelEngaged = funnelRow?.engaged ?? 0;
  const retentionTotal = retentionRow?.total_agents ?? 0;
  const retentionReturning = retentionRow?.returning_agents ?? 0;

  const conversionPct = funnelConnects > 0
    ? Math.round((funnelEngaged / funnelConnects) * 1000) / 10
    : 0;

  const returningPct = retentionTotal > 0
    ? Math.round((retentionReturning / retentionTotal) * 1000) / 10
    : 0;

  const miladyPct = miladyTotal > 0
    ? Math.round((miladyCount / miladyTotal) * 1000) / 10
    : 0;

  return c.json({
    measurementStartDate: MEASUREMENT_START,
    dau: {
      connectedAgents: dauCount,
      delta7d: dauCount - dauPrev,
      miladyOriginPct: miladyPct,
    },
    funnel: {
      uniqueConnectsLast7d: funnelConnects,
      firstEngagedLast7d: funnelEngaged,
      conversionPct,
    },
    retention: {
      totalAgentsLast7d: retentionTotal,
      returningAgentsLast7d: retentionReturning,
      returningDayRatePct: returningPct,
    },
    collaboration: {
      agentToAgentTurns7d: collabRow?.count ?? 0,
      teacherChats7d: teacherChatRow?.count ?? 0,
    },
    buildings: buildingsRes.map((r: { building_id: string; visits: number }, i: number) => ({
      id: r.building_id,
      visits7d: r.visits,
      rank: i + 1,
    })),
  });
});

dashboardRoutes.post('/__test-alert', adminOnly, async (c) => {
  const user = c.get('user');
  await alertError({
    severity: 'warning',
    source: 'dashboard',
    message: 'Test alert fired from /api/dashboard/__test-alert',
    context: { triggeredByUserId: user?.id },
  });
  return c.json({ ok: true, message: 'alert dispatched — check Telegram' });
});
