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
import { gt, sql, sql as drizzleSql } from 'drizzle-orm';
import {
  db,
  tutorialQuestClaims,
  quests as questsTable,
  cosmeticSkus,
  cosmeticVariants,
  avatarSkins,
  avatars,
  dashboardPhases,
  agentBots,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { adminOnly } from '../middleware/admin-only';
import { noStorePrivate } from '../middleware/no-store';
import { alertError } from '../services/alert-error';
import {
  deriveProtocolAckState,
  requiresByoSkillAck,
  resolveApiBase,
} from '../services/skill-protocol';
import type { AppContext } from '../types';

export const dashboardRoutes = new Hono<AppContext>();

export type AgentSkillAckDashboardRow = Pick<
  typeof agentBots.$inferSelect,
  | 'agentId'
  | 'name'
  | 'identityType'
  | 'protocol'
  | 'gatewayUrl'
  | 'cognitionBackend'
  | 'isHouse'
  | 'ack'
  | 'lastSeenAt'
  | 'sessionExpiresAt'
> & {
  /** Authoritative hosted-avatar binding: avatars.platform_agent_id = agent_id. */
  hasHostedAvatarBinding: boolean;
};

/** Build the minimal admin posture response from the canonical ACK helpers. */
export function buildAgentSkillAckDashboard(
  rows: AgentSkillAckDashboardRow[],
  apiBase: string,
  now: Date = new Date(),
) {
  const counts = { none: 0, current: 0, stale: 0 };
  const needsAttention: Array<{
    ackState: 'none' | 'stale';
    agentId: string;
    name: string | null;
    lastAckedVersion: number | null;
    lastSeenAt: Date;
  }> = [];

  for (const row of rows) {
    // Match validateLiveAgentSession's fail-closed TTL semantics. Historical,
    // expired, and legacy-null sessions are not currently connected posture.
    if (row.sessionExpiresAt === null || row.sessionExpiresAt <= now) continue;

    // Keep the cohort definition shared with connect/reconnect. Hatcher and
    // ClawVille-hosted cognition install server-side and do not owe an ACK.
    if (!requiresByoSkillAck(row)) continue;

    const ackState = deriveProtocolAckState(row.ack, apiBase);
    counts[ackState] += 1;
    if (ackState === 'current') continue;

    needsAttention.push({
      ackState,
      agentId: row.agentId,
      name: row.name,
      lastAckedVersion:
        typeof row.ack?.manual?.version === 'number'
          ? row.ack.manual.version
          : null,
      lastSeenAt: row.lastSeenAt,
    });
  }

  // Show the most recently active agents first so the 20-row operator list is
  // actionable. Grouping by state communicates posture without adding fields to
  // the deliberately minimal per-agent response shape.
  needsAttention.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  const attention = needsAttention.slice(0, 20);
  const serialize = (row: (typeof attention)[number]) => ({
    agentId: row.agentId,
    name: row.name,
    lastAckedVersion: row.lastAckedVersion,
    lastSeenAt: row.lastSeenAt.toISOString(),
  });

  return {
    counts,
    agents: {
      stale: attention.filter((row) => row.ackState === 'stale').map(serialize),
      none: attention.filter((row) => row.ackState === 'none').map(serialize),
    },
  };
}

// Lightweight auth-check endpoint for the /dash server component to gate
// the entire dashboard page (not just per-tab data). Returns 200 if the
// caller passes adminOnly (Lucia session + ADMIN_USER_IDS allowlist OR
// the shared-password cv_dash cookie). Used for top-level redirect to
// /dash/login.

const MEASUREMENT_START = process.env.METRICS_MEASUREMENT_START ?? '2026-04-21';

// sessionMiddleware populates c.get('user'); adminOnly checks allowlist.
dashboardRoutes.use('*', sessionMiddleware);

dashboardRoutes.get('/__check', adminOnly, (c) => c.json({ ok: true }));

dashboardRoutes.get('/agent-skill-acks', adminOnly, noStorePrivate, async (c) => {
  const now = new Date();
  // Select only posture fields: this endpoint must never expose the live session
  // hash, partner proxy configuration/token envelope, or user binding.
  const rows = await db
    .select({
      agentId: agentBots.agentId,
      name: agentBots.name,
      identityType: agentBots.identityType,
      protocol: agentBots.protocol,
      gatewayUrl: agentBots.gatewayUrl,
      cognitionBackend: agentBots.cognitionBackend,
      isHouse: agentBots.isHouse,
      hasHostedAvatarBinding: drizzleSql<boolean>`EXISTS (
        SELECT 1 FROM ${avatars}
        WHERE ${avatars.platformAgentId} = ${agentBots.agentId}
      )`,
      ack: agentBots.ack,
      lastSeenAt: agentBots.lastSeenAt,
      sessionExpiresAt: agentBots.sessionExpiresAt,
    })
    .from(agentBots)
    .where(gt(agentBots.sessionExpiresAt, now));

  const posture = buildAgentSkillAckDashboard(rows, resolveApiBase(), now);

  return c.json({
    ...posture,
    generatedAt: now.toISOString(),
  });
});

dashboardRoutes.get('/overview', adminOnly, noStorePrivate, async (c) => {
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
      // We deliberately EXCLUDE:
      //   - 'character' — agent-to-any-NPC via /:sessionId/chat fires for
      //                   wandering NPCs too, would inflate numbers.
      //   - 'system-agent' — system agents (Town Guide et al.) are NOT
      //                   teachers per CLAUDE.md Brand Identity §4. Tracked
      //                   separately to avoid polluting the
      //                   teacher-chat metric. Follow-up PR can add a
      //                   dedicated card for system-agent chats.
      db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count FROM events
        WHERE event_type = 'agent.chat.turn'
          AND ts > now() - interval '7 days'
          AND payload->>'chatType' IN ('building', 'location')
          -- Guest-avatar carve-out (2026-04-23) — un-authed visitor chats
          -- are flagged with payload.isGuest so the teacher-chat metric
          -- only counts real-account engagement. Older events without
          -- the field coalesce to '' which fails the equality test.
          AND coalesce(payload->>'isGuest', '') <> 'true'
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

// ─── Q3 plan §gamification dashboard — read endpoints for the new tabs ────

dashboardRoutes.get('/quests', adminOnly, noStorePrivate, async (c) => {
  // Tutorial quest claim counts — one row per quest_id present in the
  // tutorial_quest_claims table. Quests with zero claims are omitted from
  // the SQL but the tab fills them in client-side.
  const tutorial = await db
    .select({
      questId: tutorialQuestClaims.questId,
      claimCount: drizzleSql<number>`count(*)::int`.as('count'),
      totalCt: drizzleSql<number>`sum(${tutorialQuestClaims.tokensCredited})::int`.as('total_ct'),
    })
    .from(tutorialQuestClaims)
    .groupBy(tutorialQuestClaims.questId);

  // Backend admin-curated quests + counts.
  const admin = await db
    .select({
      id: questsTable.id,
      title: questsTable.title,
      tier: questsTable.tier,
      status: questsTable.status,
      tokenReward: questsTable.tokenReward,
      currentCompletions: questsTable.currentCompletions,
      maxCompletions: questsTable.maxCompletions,
    })
    .from(questsTable)
    .orderBy(questsTable.createdAt);

  return c.json({
    tutorial: tutorial.map((r) => ({
      questId: r.questId,
      claimCount: Number(r.claimCount) || 0,
      totalCt: Number(r.totalCt) || 0,
    })),
    admin,
    generatedAt: new Date().toISOString(),
  });
});

dashboardRoutes.get('/phases', adminOnly, noStorePrivate, async (c) => {
  const rows = await db
    .select()
    .from(dashboardPhases)
    .orderBy(dashboardPhases.sortOrder);
  return c.json({ phases: rows, generatedAt: new Date().toISOString() });
});

dashboardRoutes.get('/economy', adminOnly, noStorePrivate, async (c) => {
  // Live operational metrics that complement the static config in the
  // Token Economy tab. Three queries, all aggregations over recent windows.

  // 1. Anti-farm fingerprint coverage — what fraction of events in the
  //    last 24h have fp_hash populated? Should be ≥99% post-Phase-1
  //    middleware deploy; gaps indicate emitter sites still using the
  //    plain logEvent path (e.g., reward-pipeline / agent-collaboration
  //    services that haven't been migrated yet).
  const fpCoverage = await db.execute<{
    total: number;
    with_fp: number;
  }>(drizzleSql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE fp_hash IS NOT NULL)::int AS with_fp
    FROM events
    WHERE ts > now() - interval '24 hours'
  `);

  // 2. ClawToken sources/sinks — sum of credits + debits by reason in
  //    the last 30d. Gives an at-a-glance picture of where tokens enter
  //    + leave the economy.
  const tokenFlow = await db.execute<{
    reason: string;
    credits: number;
    debits: number;
    total_tx: number;
  }>(drizzleSql`
    SELECT
      reason,
      COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::int AS credits,
      ABS(COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0))::int AS debits,
      COUNT(*)::int AS total_tx
    FROM claw_token_transactions
    WHERE created_at > now() - interval '30 days'
    GROUP BY reason
    ORDER BY (COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) +
             ABS(COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0))) DESC
  `);

  // 3. Daily-login summary — lifetime stats so the team can see total
  //    distribution + recent activity.
  const dailyLogin = await db.execute<{
    lifetime_ct: number;
    lifetime_claims: number;
    last_24h_claims: number;
  }>(drizzleSql`
    SELECT
      COALESCE(SUM(amount), 0)::int AS lifetime_ct,
      COUNT(*)::int AS lifetime_claims,
      COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h_claims
    FROM claw_token_transactions
    WHERE reason = 'daily_login' AND amount > 0
  `);

  return c.json({
    fingerprintCoverage24h: {
      total: Number(fpCoverage[0]?.total ?? 0),
      withFp: Number(fpCoverage[0]?.with_fp ?? 0),
      pct: Number(fpCoverage[0]?.total ?? 0) > 0
        ? Math.round((Number(fpCoverage[0].with_fp) / Number(fpCoverage[0].total)) * 1000) / 10
        : 0,
    },
    tokenFlow30d: tokenFlow.map((r) => ({
      reason: r.reason,
      credits: Number(r.credits) || 0,
      debits: Number(r.debits) || 0,
      totalTx: Number(r.total_tx) || 0,
    })),
    dailyLogin: {
      lifetimeCt: Number(dailyLogin[0]?.lifetime_ct ?? 0),
      lifetimeClaims: Number(dailyLogin[0]?.lifetime_claims ?? 0),
      last24hClaims: Number(dailyLogin[0]?.last_24h_claims ?? 0),
    },
    generatedAt: new Date().toISOString(),
  });
});

dashboardRoutes.get('/cosmetics', adminOnly, noStorePrivate, async (c) => {
  // SKUs + variant counts + ownership counts. Three queries, one merge.
  const skus = await db.select().from(cosmeticSkus).orderBy(cosmeticSkus.createdAt);
  const variantCounts = await db
    .select({
      skuId: cosmeticVariants.skuId,
      n: drizzleSql<number>`count(*)::int`.as('n'),
    })
    .from(cosmeticVariants)
    .groupBy(cosmeticVariants.skuId);
  const ownerCounts = await db
    .select({
      skuId: avatarSkins.skuId,
      owners: drizzleSql<number>`count(*)::int`.as('owners'),
      equippedNow: drizzleSql<number>`count(*) FILTER (WHERE ${avatarSkins.equipped})::int`.as('equipped_now'),
    })
    .from(avatarSkins)
    .groupBy(avatarSkins.skuId);

  const variantBySku = new Map(variantCounts.map((v) => [v.skuId, Number(v.n) || 0]));
  const ownerBySku = new Map(
    ownerCounts.map((o) => [o.skuId, { owners: Number(o.owners) || 0, equippedNow: Number(o.equippedNow) || 0 }]),
  );

  return c.json({
    cosmetics: skus.map((s) => ({
      ...s,
      variantCount: variantBySku.get(s.id) ?? 0,
      ownerCount: ownerBySku.get(s.id)?.owners ?? 0,
      equippedNow: ownerBySku.get(s.id)?.equippedNow ?? 0,
    })),
    generatedAt: new Date().toISOString(),
  });
});
