/**
 * Postgres side of the Trading Arena analysis (`analysis.ts`): the queries and
 * writes behind `ArenaAnalysisStore`, plus the best-effort ElizaOS memory
 * writer. Params changes go through `updateArenaAgentParams` (queries.ts), the
 * one arena params writer the owner routes use too. Kept apart from
 * `analysis.ts` so the analysis logic and its tests load without a database or
 * an agent runtime.
 */

import {
  and,
  avatars,
  db,
  desc,
  eq,
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

/**
 * Files the report as an earned-skill memory in the agent's OWN running
 * ElizaOS runtime, under the Trading Floor building, so its chat and its
 * decide loop can recall it (`readEarnedSkillLessons`). The memory id seed
 * includes the runtime agent id (`recordEarnedSkillMemory`). Never starts a
 * runtime: a BYO agent, or a hosted one that is asleep, is skipped with a log
 * line. Never throws.
 */
export async function writeArenaReportMemory(input: ArenaReportMemoryInput): Promise<void> {
  try {
    const [avatar] = await db
      .select({ platformAgentId: avatars.platformAgentId })
      .from(avatars)
      .where(eq(avatars.id, input.avatarId))
      .limit(1);
    if (!avatar?.platformAgentId) {
      console.log(`[floor-arena/analysis] ${input.agentId}: no hosted runtime for the avatar; report memory skipped`);
      return;
    }
    const { agentOrchestrator } = await import('../agent-orchestrator');
    const runtime = agentOrchestrator.getRunningAgentRuntime(avatar.platformAgentId);
    if (!runtime) {
      console.log(`[floor-arena/analysis] ${input.agentId}: hosted runtime not running; report memory skipped`);
      return;
    }
    const ok = await runtime.recordEarnedSkillMemory({
      avatarId: input.avatarId,
      buildingId: TRADING_FLOOR_BUILDING_ID,
      teacherName: 'Trading Arena analyst',
      lesson: input.text,
    });
    if (!ok) console.log(`[floor-arena/analysis] ${input.agentId}: runtime refused the report memory; skipped`);
  } catch (err) {
    console.log(
      `[floor-arena/analysis] ${input.agentId}: report memory skipped (${(err instanceof Error ? err.message : String(err)).slice(0, 160)})`,
    );
  }
}
