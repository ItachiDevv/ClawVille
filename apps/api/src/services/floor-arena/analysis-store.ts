/**
 * Postgres side of the Trading Arena analysis (`analysis.ts`): the queries and
 * writes behind `ArenaAnalysisStore`, plus the report memory writer and the
 * owner-chat lesson fold (D29). Params changes go through
 * `updateArenaAgentParams` (queries.ts), the one arena params writer the owner
 * routes use too. Kept apart from `analysis.ts` so the analysis logic and its
 * tests load without a database or an agent runtime.
 */

import {
  and,
  avatars,
  db,
  desc,
  eq,
  floorArenaAgents,
  floorArenaEvents,
  floorArenaParamChanges,
  floorArenaPositions,
  floorArenaReports,
  gt,
  isNotNull,
  lte,
  sql,
} from '@clawville/database';
import type { FloorArenaAgentKind, FloorArenaSuggestion, FloorArenaSuggestionState } from '@clawville/shared';
import {
  ARENA_DUPLICATE_WINDOW_MS,
  type ArenaAnalysisCandidate,
  type ArenaAnalysisStore,
  type ArenaClosedTrade,
  type ArenaParamChangeWrite,
  type ArenaPriorReport,
  type ArenaReportMemoryInput,
  type ArenaReportWrite,
} from './analysis';
import type { EarnedSkillStore } from '../earned-skill-memory';
import { updateArenaAgentParams } from './queries';

/** The Trading Floor building id; earned-skill memories are filed under it. */
const TRADING_FLOOR_BUILDING_ID = 'cron-automation';

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function toNumber(value: string | number | null): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertReportRow(tx: Tx, report: ArenaReportWrite): Promise<string> {
  const [row] = await tx
    .insert(floorArenaReports)
    .values({
      agentId: report.agentId,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      stats: report.stats as unknown as Record<string, unknown>,
      summary: report.summary,
      suggestion: report.suggestion,
      suggestionState: report.suggestionState,
      createdAt: report.periodEnd,
    })
    .returning({ id: floorArenaReports.id });
  await tx.insert(floorArenaEvents).values({
    agentId: report.agentId,
    at: report.periodEnd,
    type: 'report',
    summary: report.eventSummary,
    // No suggestion state here: an automatic apply moves it after this insert,
    // and the report row is the one place that holds the current state.
    data: {
      reportId: row!.id,
      ...(report.suggestion ? { suggestion: { path: report.suggestion.path, from: report.suggestion.from, to: report.suggestion.to } } : {}),
    },
  });
  return row!.id;
}

export function createArenaAnalysisStore(): ArenaAnalysisStore {
  return {
    async listCandidates(now) {
      // Only agents whose last report (or creation) is at least 30 minutes old
      // come back, so the per-minute tick stays cheap. A stopped agent with
      // nothing left to close never comes back.
      const cutoff = new Date(now.getTime() - 30 * 60_000).toISOString();
      const rows = await db.execute<{
        id: string;
        kind: FloorArenaAgentKind;
        name: string;
        template_id: string;
        params: unknown;
        params_version: number;
        status: string;
        seated: boolean;
        auto_apply_suggestions: boolean;
        avatar_id: string | null;
        created_at: Date | string;
        last_report_at: Date | string | null;
        last_period_end: Date | string | null;
        closed_since: number | string;
        opened_since: number | string;
      }>(sql`
        SELECT a.id, a.kind, a.name, a.template_id, a.params, a.params_version, a.status, a.seated,
               a.auto_apply_suggestions, a.avatar_id, a.created_at,
               r.created_at AS last_report_at, r.period_end AS last_period_end,
               (SELECT count(*) FROM floor_arena_positions p
                 WHERE p.agent_id = a.id AND p.status = 'closed'
                   AND p.closed_at > COALESCE(r.period_end, a.created_at)) AS closed_since,
               (SELECT count(*) FROM floor_arena_positions p
                 WHERE p.agent_id = a.id
                   AND p.opened_at > COALESCE(r.period_end, a.created_at)) AS opened_since
        FROM floor_arena_agents a
        LEFT JOIN LATERAL (
          SELECT created_at, period_end FROM floor_arena_reports
          WHERE agent_id = a.id ORDER BY created_at DESC LIMIT 1
        ) r ON true
        WHERE COALESCE(r.created_at, a.created_at) <= ${cutoff}::timestamptz
          AND (a.status <> 'stopped' OR EXISTS (
            SELECT 1 FROM floor_arena_positions p
            WHERE p.agent_id = a.id AND p.status = 'closed'
              AND p.closed_at > COALESCE(r.period_end, a.created_at)))
      `);
      // postgres-js returns the rows array itself; other drivers return { rows }.
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: typeof rows[number][] })?.rows ?? []);
      return list.map((row): ArenaAnalysisCandidate => ({
        agent: {
          id: row.id,
          kind: row.kind,
          name: row.name,
          templateId: row.template_id,
          params: row.params,
          paramsVersion: Number(row.params_version),
          status: row.status,
          seated: row.seated,
          autoApplySuggestions: row.auto_apply_suggestions,
          avatarId: row.avatar_id,
          createdAt: toDate(row.created_at)!,
        },
        lastReportAt: toDate(row.last_report_at),
        lastReportPeriodEnd: toDate(row.last_period_end),
        closedSince: Number(row.closed_since),
        openedSince: Number(row.opened_since),
      }));
    },

    async loadClosedTrades(agentId, limit) {
      const rows = await db
        .select({
          openedAt: floorArenaPositions.openedAt,
          closedAt: floorArenaPositions.closedAt,
          paramsVersion: floorArenaPositions.paramsVersion,
          exitReason: floorArenaPositions.exitReason,
          pnlUsd: floorArenaPositions.pnlUsd,
          pnlMult: floorArenaPositions.pnlMult,
          source: floorArenaPositions.source,
          features: floorArenaPositions.entryFeatures,
        })
        .from(floorArenaPositions)
        .where(and(
          eq(floorArenaPositions.agentId, agentId),
          eq(floorArenaPositions.status, 'closed'),
          // An 'unresolved' exit (no bookable sell price for 30 min) closes
          // with pnl NULL: it is not a win, a loss or a death, so the stats
          // and the tuner never see it.
          isNotNull(floorArenaPositions.pnlUsd),
          isNotNull(floorArenaPositions.pnlMult),
        ))
        .orderBy(desc(floorArenaPositions.closedAt))
        .limit(limit);
      return rows.map((row): ArenaClosedTrade => ({
        openedAt: toDate(row.openedAt) ?? new Date(0),
        closedAt: toDate(row.closedAt) ?? new Date(0),
        paramsVersion: row.paramsVersion,
        exitReason: row.exitReason,
        pnlUsd: toNumber(row.pnlUsd),
        pnlMult: toNumber(row.pnlMult),
        source: row.source,
        features: row.features ?? null,
      }));
    },

    async countOpened(agentId, from, to) {
      const [row] = await db
        .select({ n: sql<string>`count(*)` })
        .from(floorArenaPositions)
        .where(and(
          eq(floorArenaPositions.agentId, agentId),
          gt(floorArenaPositions.openedAt, from),
          lte(floorArenaPositions.openedAt, to),
        ));
      return Number(row?.n ?? 0);
    },

    async countOpen(agentId) {
      const [row] = await db
        .select({ n: sql<string>`count(*)` })
        .from(floorArenaPositions)
        .where(and(eq(floorArenaPositions.agentId, agentId), eq(floorArenaPositions.status, 'open')));
      return Number(row?.n ?? 0);
    },

    async loadRecentReports(agentId, limit) {
      const rows = await db
        .select({
          createdAt: floorArenaReports.createdAt,
          summary: floorArenaReports.summary,
          suggestion: floorArenaReports.suggestion,
          suggestionState: floorArenaReports.suggestionState,
        })
        .from(floorArenaReports)
        .where(eq(floorArenaReports.agentId, agentId))
        .orderBy(desc(floorArenaReports.createdAt))
        .limit(limit);
      return rows.map((row): ArenaPriorReport => ({
        createdAt: row.createdAt,
        summary: row.summary ?? '',
        suggestion: (row.suggestion ?? null) as FloorArenaSuggestion | null,
        suggestionState: row.suggestionState as FloorArenaSuggestionState,
      }));
    },

    async lastParamChangeAt(agentId) {
      const [row] = await db
        .select({ at: floorArenaParamChanges.at })
        .from(floorArenaParamChanges)
        .where(eq(floorArenaParamChanges.agentId, agentId))
        .orderBy(desc(floorArenaParamChanges.at))
        .limit(1);
      return row?.at ?? null;
    },

    async insertReport(report) {
      return db.transaction(async (tx) => {
        // Two leaders can overlap for a few seconds during a failover. The
        // per-agent lock serialises them and the window check makes the second
        // report a no-op, so an agent never gets two reports (or two tuner
        // changes) for one period.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`floor-arena-report:${report.agentId}`}, 0))`);
        const since = new Date(report.periodEnd.getTime() - ARENA_DUPLICATE_WINDOW_MS);
        const [recent] = await tx
          .select({ id: floorArenaReports.id })
          .from(floorArenaReports)
          .where(and(eq(floorArenaReports.agentId, report.agentId), gt(floorArenaReports.createdAt, since)))
          .limit(1);
        if (recent) return { duplicate: true as const };
        return { reportId: await insertReportRow(tx, report) };
      });
    },

    async applyParamChange(change: ArenaParamChangeWrite) {
      return updateArenaAgentParams({
        agentId: change.agentId,
        expectedVersion: change.expectedParamsVersion,
        params: change.params,
        changes: change.changes,
        source: change.source,
        reason: change.reason || null,
        summary: change.eventSummary,
        report: { id: change.reportId, state: 'auto_applied' },
      });
    },

    async rejectPendingReport(reportId, agentId, reason) {
      await db.execute(sql`
        UPDATE floor_arena_reports
        SET suggestion_state = 'rejected',
            suggestion = NULL,
            stats = jsonb_set(stats, '{suggestionCheck,reason}', to_jsonb(${reason}::text), true)
        WHERE id = ${reportId}::uuid AND agent_id = ${agentId} AND suggestion_state = 'pending'
      `);
    },
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 160);
}

/** The avatar's hosted platform agent id, or null for a BYO or unprovisioned avatar. */
async function readAvatarPlatformAgentId(avatarId: string): Promise<string | null> {
  const [avatar] = await db
    .select({ platformAgentId: avatars.platformAgentId })
    .from(avatars)
    .where(eq(avatars.id, avatarId))
    .limit(1);
  return avatar?.platformAgentId ?? null;
}

/**
 * D29: files every full player report (the analysis tick never sends a short
 * no-trade report here) as an EARNED-SKILL lesson of the owner's
 * avatar under the Trading Floor building, through `recordEarnedSkillLesson`.
 * It lands in the avatar's own hosted ElizaOS runtime when that runtime is
 * warm in this API process (embedded; id seeded with the runtime agent id),
 * else in the avatar-keyed `npc_memories` keyword store (no hosted runtime, a
 * runtime asleep after 30 idle minutes, or a failed embed). Never lazy-starts
 * a runtime, never throws, logs ONE line with the store.
 *
 * Readers, all through `readEarnedSkillLessons` (it reads either store): the
 * owner's avatar chat `POST /api/avatars/me/chat` (via `tradingFloorLessonContext`
 * below), the Trading Floor teacher's chat (`world-teacher-chat.ts`), the
 * hosted autonomy decide loop (`agent-autonomy-driver.ts` `readRecentLessons`)
 * and `GET /api/agent/:sessionId/skills/cron-automation/skill-memory`. The
 * runtime's KnowledgeProvider does NOT read these rows.
 */
export async function writeArenaReportMemory(
  input: ArenaReportMemoryInput,
  lookupPlatformAgentId: (avatarId: string) => Promise<string | null> = readAvatarPlatformAgentId,
): Promise<EarnedSkillStore> {
  let platformAgentId = '';
  try {
    platformAgentId = (await lookupPlatformAgentId(input.avatarId)) ?? '';
  } catch (err) {
    console.log(`[floor-arena/analysis] ${input.agentId}: avatar lookup failed (${errorText(err)}); keyword store only`);
  }
  let store: EarnedSkillStore = 'none';
  try {
    const { recordEarnedSkillLesson } = await import('../earned-skill-memory');
    store = await recordEarnedSkillLesson({
      platformAgentId,
      avatarId: input.avatarId,
      agentId: input.agentId,
      buildingId: TRADING_FLOOR_BUILDING_ID,
      teacherName: 'Trading Arena analyst',
      lesson: input.text,
    });
  } catch (err) {
    console.log(`[floor-arena/analysis] ${input.agentId}: report memory write failed (${errorText(err)})`);
  }
  console.log(`[floor-arena/analysis] ${input.agentId}: report memory store=${store}`);
  return store;
}

const LESSON_FOLD_LIMIT = 3;
const LESSON_FOLD_TIMEOUT_MS = 1_500;

/**
 * D29: the owner's avatar chat recalls what their agent learned at the Trading
 * Floor (its 30-minute arena reports, and the teacher's lessons there), the way
 * `world-teacher-chat.ts` folds prior lessons into a teacher turn. Only for an
 * owner who has an arena agent (one indexed lookup), so other chats pay no
 * embedding. Returns the context block, or null when there is nothing to add.
 * Bounded and fail-soft: the lookup and the read together get 1.5 s; a slow
 * or failing step returns null, never throws.
 */
export async function tradingFloorLessonContext(
  input: { userId: string; platformAgentId: string; avatarId: string; query: string },
  deps: {
    hasArenaAgent?: (userId: string) => Promise<boolean>;
    read?: (i: { platformAgentId: string; avatarId: string; buildingId: string; query: string; limit: number }) => Promise<string[]>;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const hasArenaAgent = deps.hasArenaAgent ?? (async (userId: string) => {
    const [row] = await db.select({ id: floorArenaAgents.id }).from(floorArenaAgents)
      .where(and(eq(floorArenaAgents.ownerUserId, userId), eq(floorArenaAgents.kind, 'user'))).limit(1);
    return Boolean(row);
  });
  const fold = async (): Promise<string | null> => {
    if (!(await hasArenaAgent(input.userId))) return null;
    const read = deps.read ?? (await import('../earned-skill-memory')).readEarnedSkillLessons;
    const lessons = await read({ ...input, buildingId: TRADING_FLOOR_BUILDING_ID, limit: LESSON_FOLD_LIMIT });
    if (lessons.length === 0) return null;
    return `What you have learned at the Trading Floor (your own Trading Arena reports and lessons there). Use it when the question is about trading or your arena agent:\n${lessons.map((l) => `- ${l}`).join('\n')}`;
  };
  // ONE time box over the whole fold, the arena lookup included (Codex r14): a
  // stalled database query must never hold the owner's chat. The fold's own
  // promise always has a handler, so a rejection that lands after the timeout
  // is swallowed, never unhandled.
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), deps.timeoutMs ?? LESSON_FOLD_TIMEOUT_MS);
    fold()
      .then((context) => { clearTimeout(timer); resolve(context); })
      .catch(() => { clearTimeout(timer); resolve(null); });
  });
}
