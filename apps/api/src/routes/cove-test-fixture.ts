import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  avatars,
  blackjackHands,
  baccaratShoes,
  blackjackShoes,
  coveGameEvents,
  coveTestFixtureRuns,
  db,
  holdemTables,
  pokerCashHands,
  pokerCashSeats,
  sql,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import { resolveAgentSession } from '../middleware/require-auth-or-agent';
import {
  FIXTURE_MAX_TTL_SECONDS,
  COVE_TEST_FIXTURE_HEADER,
  closeFixtureRunForOwner,
  fixtureEnabled,
  hashFixtureToken,
  issueFixtureToken,
} from '../services/cove-test-fixture';
import type { AppContext } from '../types';

const AGENT_SESSION_HEADER = 'X-Clawville-Agent-Session';
type FixtureRouteTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const createRunSchema = z.object({
  scenarioName: z.enum([
    'bj-split',
    'bj-natural',
    'bj-push',
    'bj-insurance',
    'bac-player-natural',
    'bac-banker-natural',
    'bac-player-third',
    'bac-banker-third',
    'bac-tie',
    'bac-shoe-near-threshold',
    'bac-shoe-exhausted',
    'holdem-multiway-showdown',
    'holdem-fold-win',
  ]),
  exposureBudgetCt: z.number().int().positive().max(1_000_000),
  ttlSeconds: z.number().int().min(1).max(FIXTURE_MAX_TTL_SECONDS),
});

async function resolveFixtureOwner(c: {
  get(key: 'user'): { id: string } | null;
  req: { header(name: string): string | undefined };
}): Promise<string> {
  const user = c.get('user');
  if (user) {
    const avatar = await db.query.avatars.findFirst({
      where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    });
    if (!avatar) throw new HTTPException(403, { message: 'active_avatar_required' });
    return avatar.id;
  }

  const agentSession = c.req.header(AGENT_SESSION_HEADER);
  if (agentSession) {
    const resolved = await resolveAgentSession(agentSession);
    if (!resolved) {
      throw new HTTPException(401, { message: 'invalid_or_expired_agent_session' });
    }
    if (!resolved.ledgerCapable) {
      throw new HTTPException(403, { message: 'agent_session_not_ledger_authorized' });
    }
    if (!resolved.avatarId) {
      throw new HTTPException(403, { message: 'agent_session_has_no_active_avatar' });
    }
    return resolved.avatarId;
  }

  throw new HTTPException(401, {
    message: 'auth_required: Lucia cookie or X-Clawville-Agent-Session header',
  });
}

export const coveTestFixtureRouter = new Hono<AppContext>();
coveTestFixtureRouter.use('*', sessionMiddleware);

async function closeFixtureShoes(tx: FixtureRouteTx, runIds: readonly string[]): Promise<void> {
  const now = new Date();
  for (const runId of runIds) {
    const runRows = await tx
      .select({ ownerAvatarId: coveTestFixtureRuns.ownerAvatarId })
      .from(coveTestFixtureRuns)
      .where(eq(coveTestFixtureRuns.runId, runId))
      .limit(1);
    const ownerAvatarId = runRows[0]?.ownerAvatarId;
    if (!ownerAvatarId) {
      throw new HTTPException(409, { message: 'fixture_run_not_found' });
    }

    const bjRows = await tx
      .select({ id: blackjackShoes.id, serverSeed: blackjackShoes.serverSeed })
      .from(blackjackShoes)
      .where(and(eq(blackjackShoes.fixtureRunId, runId), eq(blackjackShoes.status, 'open')));
    for (const shoe of bjRows) {
      const inProgress = await tx
        .select({ id: blackjackHands.id })
        .from(blackjackHands)
        .where(
          and(
            eq(blackjackHands.shoeId, shoe.id),
            eq(blackjackHands.status, 'in_progress'),
          ),
        )
        .limit(1);
      if (inProgress[0]) {
        throw new HTTPException(409, {
          message: 'fixture_blackjack_hand_requires_settlement',
        });
      }
      await tx
        .update(coveGameEvents)
        .set({ revealedServerSeed: shoe.serverSeed })
        .where(
          and(
            eq(coveGameEvents.fixtureRunId, runId),
            eq(coveGameEvents.sessionId, shoe.id),
          ),
        );
    }
    await tx
      .update(blackjackShoes)
      .set({ status: 'closed', closedAt: now })
      .where(and(eq(blackjackShoes.fixtureRunId, runId), eq(blackjackShoes.status, 'open')));

    const bacRows = await tx
      .select({ id: baccaratShoes.id, serverSeed: baccaratShoes.serverSeed })
      .from(baccaratShoes)
      .where(and(eq(baccaratShoes.fixtureRunId, runId), eq(baccaratShoes.status, 'open')));
    for (const shoe of bacRows) {
      await tx
        .update(coveGameEvents)
        .set({ revealedServerSeed: shoe.serverSeed })
        .where(
          and(
            eq(coveGameEvents.fixtureRunId, runId),
            eq(coveGameEvents.sessionId, shoe.id),
          ),
        );
    }
    await tx
      .update(baccaratShoes)
      .set({ status: 'closed', closedAt: now })
      .where(and(eq(baccaratShoes.fixtureRunId, runId), eq(baccaratShoes.status, 'open')));

    const practiceRows = await tx
      .select({
        id: holdemTables.id,
        userId: holdemTables.userId,
        guestFpHash: holdemTables.guestFpHash,
        serverSeed: holdemTables.serverSeed,
      })
      .from(holdemTables)
      .where(and(eq(holdemTables.fixtureRunId, runId), eq(holdemTables.status, 'open')));
    for (const table of practiceRows) {
      if (table.userId || !table.guestFpHash) {
        throw new HTTPException(409, {
          message: 'fixture_practice_ledger_recovery_required',
        });
      }
      await tx
        .update(coveGameEvents)
        .set({ revealedServerSeed: table.serverSeed })
        .where(
          and(
            eq(coveGameEvents.fixtureRunId, runId),
            eq(coveGameEvents.sessionId, table.id),
          ),
        );
    }
    await tx
      .update(holdemTables)
      .set({
        status: 'closed',
        playerStack: '0',
        cashOut: '0',
        closedAt: now,
      })
      .where(
        and(
          eq(holdemTables.fixtureRunId, runId),
          eq(holdemTables.status, 'open'),
          isNull(holdemTables.userId),
        ),
      );

    const unsettledCashHands = await tx
      .select({
        id: pokerCashHands.id,
        tableId: pokerCashHands.tableId,
      })
      .from(pokerCashHands)
      .where(
        and(
          eq(pokerCashHands.fixtureRunId, runId),
          isNull(pokerCashHands.settledAt),
          isNull(pokerCashHands.fixtureVoidedAt),
        ),
      );
    for (const hand of unsettledCashHands) {
      const seats = await tx
        .select({
          id: pokerCashSeats.id,
          status: pokerCashSeats.status,
          currentStackCt: pokerCashSeats.currentStackCt,
        })
        .from(pokerCashSeats)
        .where(
          and(
            eq(pokerCashSeats.tableId, hand.tableId),
            eq(pokerCashSeats.avatarId, ownerAvatarId),
          ),
        );
      const unreconciled =
        seats.length === 0 ||
        seats.some(
          (seat) => seat.status !== 'left' || BigInt(seat.currentStackCt) !== 0n,
        );
      if (unreconciled) {
        throw new HTTPException(409, {
          message: 'fixture_cash_recovery_required',
        });
      }
      // A hard-death cash hand has no durable action/stack delta: after the
      // normal Walk Away path cashes out the fixture owner, tombstone the
      // placeholder while preserving its commitment + fixture reveal.
      await tx
        .update(pokerCashHands)
        .set({ fixtureVoidedAt: now })
        .where(
          and(
            eq(pokerCashHands.id, hand.id),
            isNull(pokerCashHands.settledAt),
            isNull(pokerCashHands.fixtureVoidedAt),
          ),
        );
    }
  }
}

coveTestFixtureRouter.post('/run', async (c) => {
  if (!fixtureEnabled()) {
    throw new HTTPException(404, { message: 'test_fixture_unavailable' });
  }
  const ownerAvatarId = await resolveFixtureOwner(c);
  const parsed = createRunSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(400, { message: 'invalid_test_fixture_request' });
  }

  const token = issueFixtureToken();
  const tokenHash = hashFixtureToken(token);
  const expiresAt = new Date(Date.now() + parsed.data.ttlSeconds * 1_000);
  let run:
    | { kind: 'created'; runId: string }
    | {
        kind: 'recovery';
        runId: string;
        token: string;
        reason:
          | 'blackjack_hand_requires_settlement'
          | 'practice_ledger_recovery_required'
          | 'cash_recovery_required';
      }
    | undefined;
  try {
    run = await db.transaction(async (tx) => {
      // Serialize every run lifecycle for this owner. The partial unique index
      // is the database backstop; this avatar lock makes replacement cleanup
      // and the next insert one ordered critical section.
      const ownerRows = await tx.execute<{ id: string }>(
        sql`SELECT id FROM avatars WHERE id = ${ownerAvatarId} FOR UPDATE`,
      );
      if (!ownerRows[0]) {
        throw new HTTPException(403, { message: 'active_avatar_required' });
      }

      // Hard-death recovery: the prior token may be gone, so the new run must
      // reconcile fixture resources before closing stale run records.
      const staleRuns = await tx.execute<{
        run_id: string;
        status: 'active' | 'expired' | 'closed';
        expires_at: string | Date;
        blackjack_blocked: boolean;
        practice_blocked: boolean;
        cash_blocked: boolean;
      }>(sql`
        SELECT r.run_id, r.status, r.expires_at,
               EXISTS (
                 SELECT 1
                   FROM blackjack_shoes s
                   JOIN blackjack_hands h ON h.shoe_id = s.id
                  WHERE s.fixture_run_id = r.run_id
                    AND s.status = 'open'
                    AND h.status = 'in_progress'
               ) AS blackjack_blocked,
               EXISTS (
                 SELECT 1
                   FROM holdem_tables t
                  WHERE t.fixture_run_id = r.run_id
                    AND t.status = 'open'
                    AND (t.user_id IS NOT NULL OR t.guest_fp_hash IS NULL)
               ) AS practice_blocked,
               EXISTS (
                 SELECT 1
                   FROM poker_cash_hands h
                  WHERE h.fixture_run_id = r.run_id
                    AND h.settled_at IS NULL
                    AND h.fixture_voided_at IS NULL
                    AND NOT EXISTS (
                      SELECT 1
                        FROM poker_cash_seats s
                       WHERE s.table_id = h.table_id
                         AND s.avatar_id = ${ownerAvatarId}
                         AND s.status = 'left'
                         AND s.current_stack_ct = '0'
                    )
               ) AS cash_blocked
          FROM cove_test_fixture_runs r
         WHERE r.owner_avatar_id = ${ownerAvatarId}
           AND (
             EXISTS (
               SELECT 1 FROM blackjack_shoes s
                WHERE s.fixture_run_id = r.run_id AND s.status = 'open'
             )
             OR EXISTS (
               SELECT 1 FROM baccarat_shoes s
                WHERE s.fixture_run_id = r.run_id AND s.status = 'open'
             )
             OR EXISTS (
               SELECT 1 FROM holdem_tables t
                WHERE t.fixture_run_id = r.run_id AND t.status = 'open'
             )
             OR EXISTS (
               SELECT 1 FROM poker_cash_hands h
               WHERE h.fixture_run_id = r.run_id AND h.settled_at IS NULL
                 AND h.fixture_voided_at IS NULL
             )
           )
         ORDER BY r.started_at DESC
      `);
      const recovery = staleRuns.find(
        (stale) => stale.blackjack_blocked || stale.practice_blocked || stale.cash_blocked,
      );
      if (recovery) {
        const recoveryToken = issueFixtureToken();
        const recoveryExpired =
          recovery.status === 'active' &&
          new Date(recovery.expires_at).getTime() <= Date.now();
        await tx
          .update(coveTestFixtureRuns)
          .set({
            tokenHash: hashFixtureToken(recoveryToken),
            ...(recoveryExpired
              ? { status: 'expired' as const, closedAt: new Date() }
              : {}),
          })
          .where(
            and(
              eq(coveTestFixtureRuns.runId, recovery.run_id),
              eq(coveTestFixtureRuns.ownerAvatarId, ownerAvatarId),
            ),
          );
        return {
          kind: 'recovery' as const,
          runId: recovery.run_id,
          token: recoveryToken,
          reason: recovery.blackjack_blocked
            ? ('blackjack_hand_requires_settlement' as const)
            : recovery.practice_blocked
              ? ('practice_ledger_recovery_required' as const)
              : ('cash_recovery_required' as const),
        };
      }
      await closeFixtureShoes(
        tx,
        staleRuns.map((stale) => stale.run_id),
      );
      await tx
        .update(coveTestFixtureRuns)
        .set({ status: 'closed', closedAt: new Date() })
        .where(
          and(
            eq(coveTestFixtureRuns.ownerAvatarId, ownerAvatarId),
            eq(coveTestFixtureRuns.status, 'active'),
          ),
        );
      const [created] = await tx
        .insert(coveTestFixtureRuns)
        .values({
          ownerAvatarId,
          scenarioName: parsed.data.scenarioName,
          tokenHash,
          expiresAt,
          exposureBudgetCt: parsed.data.exposureBudgetCt,
        })
        .returning({ runId: coveTestFixtureRuns.runId });
      return created ? { kind: 'created' as const, runId: created.runId } : undefined;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HTTPException(409, { message: 'fixture_run_conflict' });
    }
    throw error;
  }
  if (!run) throw new HTTPException(500, { message: 'fixture_run_create_failed' });
  if (run.kind === 'recovery') {
    return c.json(
      {
        error: 'fixture_recovery_required',
        recovery: {
          runId: run.runId,
          token: run.token,
          reason: run.reason,
        },
      },
      409,
    );
  }

  return c.json(
    {
      runId: run.runId,
      token,
      ownerAvatarId,
      scenarioName: parsed.data.scenarioName,
      expiresAtMs: expiresAt.getTime(),
      exposureBudgetCt: parsed.data.exposureBudgetCt,
    },
    201,
  );
});

coveTestFixtureRouter.delete('/run/:runId', async (c) => {
  if (!fixtureEnabled()) {
    throw new HTTPException(404, { message: 'test_fixture_unavailable' });
  }
  const ownerAvatarId = await resolveFixtureOwner(c);
  const runId = c.req.param('runId');
  const header = c.req.header(COVE_TEST_FIXTURE_HEADER);
  const closed = await db.transaction(async (tx) => {
    const didClose = await closeFixtureRunForOwner(tx, { runId, ownerAvatarId, header });
    if (!didClose) return false;
    await closeFixtureShoes(tx, [runId]);
    return true;
  });
  if (!closed) throw new HTTPException(404, { message: 'fixture_run_not_found' });
  return c.body(null, 204);
});
