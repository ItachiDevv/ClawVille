/**
 * BA-2 staging-only deterministic Cove parity fixtures.
 *
 * HARD SAFETY INVARIANT: a non-blank CV_TEST_FIXTURE_ENABLED outside the
 * explicit staging environment crashes at module load. Every exported
 * mutation also re-checks the same staging literal before touching state.
 * Raw run tokens are show-once and are never logged or persisted.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { HTTPException } from 'hono/http-exception';
import {
  db,
  sql,
  coveTestFixtureRuns,
  avatars,
  eq,
  and,
  gt,
  inArray,
  isNull,
} from '@clawville/database';
import { PokerTableSim } from './poker/poker-table-sim';
import type {
  Action,
  HandResult as CashHandResult,
  SeatAssignment,
  SimClock,
} from './poker/poker-table-types';

const RAW_FIXTURE_ENABLED = process.env.CV_TEST_FIXTURE_ENABLED;

function isStagingEnv(): boolean {
  return process.env.CLAWVILLE_ENV === 'staging';
}

if (RAW_FIXTURE_ENABLED && RAW_FIXTURE_ENABLED.trim() && !isStagingEnv()) {
  throw new Error(
    `[cove-test-fixture] CV_TEST_FIXTURE_ENABLED is set but CLAWVILLE_ENV is '${process.env.CLAWVILLE_ENV ?? '(unset)'}', not 'staging'. ` +
      'This deterministic-outcome fixture is STAGING-ONLY and MUST NEVER be enabled on production. ' +
      'Unset CV_TEST_FIXTURE_ENABLED on this box (or set CLAWVILLE_ENV=staging if this genuinely IS the staging box).',
  );
}

export const COVE_TEST_FIXTURE_HEADER = 'X-CV-Test-Fixture';
export const FIXTURE_TOKEN_BYTES = 32;
export const FIXTURE_MAX_TTL_SECONDS = 30 * 60;

export type FixtureArm =
  | 'blackjack-shoe'
  | 'baccarat-shoe'
  | 'holdem-practice'
  | 'holdem-cash';

export type FixtureScenarioName =
  | 'bj-split'
  | 'bj-natural'
  | 'bj-push'
  | 'bj-insurance'
  | 'bac-player-natural'
  | 'bac-banker-natural'
  | 'bac-player-third'
  | 'bac-banker-third'
  | 'bac-tie'
  | 'bac-shoe-near-threshold'
  | 'bac-shoe-exhausted'
  | 'holdem-multiway-showdown'
  | 'holdem-fold-win';

export interface FixtureScenario {
  name: FixtureScenarioName;
  arms: readonly FixtureArm[];
  serverSeed: string;
  clientSeed: string;
  blackjackScript?: {
    hands: Array<Array<'hit' | 'stand' | 'double' | 'surrender'>>;
    didSplit: boolean;
    tookInsurance: boolean;
  };
  holdemActions?: Array<{
    type: 'fold' | 'check' | 'call' | 'bet' | 'raise';
    amount?: string;
  }>;
  initialDealtCount?: number;
}

const CLIENT_SEED = 'a1b2c3d4e5f60708';
const seed = (value: number): string => value.toString(16).padStart(64, '0');
const callDown = (): FixtureScenario['holdemActions'] =>
  Array.from({ length: 40 }, () => ({ type: 'call' as const }));

class FixtureSearchClock implements SimClock {
  now(): number {
    return 0;
  }
  setTimer(): unknown {
    return {};
  }
  clearTimer(): void {}
}

/**
 * Deterministic values were exhaustively selected against the landed pure
 * engines. Tests replay every catalog row, so engine drift breaks offline.
 */
export const FIXTURE_SCENARIOS = {
  'bj-split': {
    name: 'bj-split',
    arms: ['blackjack-shoe'],
    serverSeed: seed(33),
    clientSeed: CLIENT_SEED,
    blackjackScript: {
      hands: [['stand'], ['stand']],
      didSplit: true,
      tookInsurance: false,
    },
  },
  'bj-natural': {
    name: 'bj-natural',
    arms: ['blackjack-shoe'],
    serverSeed: seed(12),
    clientSeed: CLIENT_SEED,
    blackjackScript: { hands: [[]], didSplit: false, tookInsurance: false },
  },
  'bj-push': {
    name: 'bj-push',
    arms: ['blackjack-shoe'],
    serverSeed: seed(15),
    clientSeed: CLIENT_SEED,
    blackjackScript: { hands: [['stand']], didSplit: false, tookInsurance: false },
  },
  'bj-insurance': {
    name: 'bj-insurance',
    arms: ['blackjack-shoe'],
    serverSeed: seed(21),
    clientSeed: CLIENT_SEED,
    blackjackScript: { hands: [['stand']], didSplit: false, tookInsurance: true },
  },
  'bac-player-natural': {
    name: 'bac-player-natural',
    arms: ['baccarat-shoe'],
    serverSeed: seed(1),
    clientSeed: CLIENT_SEED,
  },
  'bac-banker-natural': {
    name: 'bac-banker-natural',
    arms: ['baccarat-shoe'],
    serverSeed: seed(15),
    clientSeed: CLIENT_SEED,
  },
  'bac-player-third': {
    name: 'bac-player-third',
    arms: ['baccarat-shoe'],
    serverSeed: seed(2),
    clientSeed: CLIENT_SEED,
  },
  'bac-banker-third': {
    name: 'bac-banker-third',
    arms: ['baccarat-shoe'],
    serverSeed: seed(2),
    clientSeed: CLIENT_SEED,
  },
  'bac-tie': {
    name: 'bac-tie',
    arms: ['baccarat-shoe'],
    serverSeed: seed(14),
    clientSeed: CLIENT_SEED,
  },
  'bac-shoe-near-threshold': {
    name: 'bac-shoe-near-threshold',
    arms: ['baccarat-shoe'],
    serverSeed: seed(2),
    clientSeed: CLIENT_SEED,
    initialDealtCount: 311,
  },
  'bac-shoe-exhausted': {
    name: 'bac-shoe-exhausted',
    arms: ['baccarat-shoe'],
    serverSeed: seed(2),
    clientSeed: CLIENT_SEED,
    initialDealtCount: 312,
  },
  'holdem-multiway-showdown': {
    name: 'holdem-multiway-showdown',
    arms: ['holdem-practice', 'holdem-cash'],
    serverSeed: seed(140),
    clientSeed: CLIENT_SEED,
    holdemActions: callDown(),
  },
  'holdem-fold-win': {
    name: 'holdem-fold-win',
    arms: ['holdem-practice', 'holdem-cash'],
    serverSeed: seed(1),
    clientSeed: CLIENT_SEED,
    holdemActions: [{ type: 'fold' }],
  },
} as const satisfies Record<string, FixtureScenario>;

/**
 * Cash-arm authority comes from the same catalog `arms` consumed by
 * `consumeFixtureArm`; do not maintain a second scenario-name list.
 */
export const HOLDEM_CASH_FIXTURE_SCENARIO_NAMES = Object.values(FIXTURE_SCENARIOS)
  .filter((scenario) => (scenario.arms as readonly FixtureArm[]).includes('holdem-cash'))
  .map((scenario) => scenario.name);

export function assertFixtureScenarioArm(
  scenario: Pick<FixtureScenario, 'arms'>,
  arm: FixtureArm,
): void {
  if (!(scenario.arms as readonly FixtureArm[]).includes(arm)) {
    throw new HTTPException(409, { message: 'fixture_arm_mismatch' });
  }
}

export interface CashFixtureSeat extends SeatAssignment {
  isSeeded: boolean;
}

/**
 * Resolve a cash fixture seed against the ACTUAL hand nonce/button/seats. Cash
 * tables are long-lived, so a catalog seed pinned to hand #1 is not sufficient.
 * The search replays the production seeded-agent advisor policy and the harness
 * owner's documented check/call policy, then returns the first stable seed that
 * satisfies the named terminal shape.
 */
export function resolveCashFixtureServerSeed(args: {
  scenario: FixtureScenario;
  handNumber: number;
  buttonSeatIndex: number;
  ownerAvatarId: string;
  seats: readonly CashFixtureSeat[];
  blinds: { sb: number; bb: number; ante: number };
}): string {
  if (!args.scenario.arms.includes('holdem-cash')) {
    throw new HTTPException(409, { message: 'fixture_arm_mismatch' });
  }
  if (args.seats.length < 2) {
    throw new HTTPException(409, { message: 'fixture_cash_requires_funded_opponents' });
  }
  if (
    args.seats.some(
      (seat) => seat.avatarId !== args.ownerAvatarId && !seat.isSeeded,
    )
  ) {
    throw new HTTPException(409, { message: 'fixture_cash_requires_isolated_table' });
  }
  if (args.scenario.name === 'holdem-multiway-showdown' && args.seats.length < 3) {
    throw new HTTPException(409, { message: 'fixture_cash_requires_three_seats' });
  }

  for (let candidate = 1; candidate <= 20_000; candidate++) {
    const serverSeed = seed(candidate);
    const sim = new PokerTableSim(new FixtureSearchClock());
    let completed: CashHandResult | null = null;
    sim.setHandCompleteFn((_tableId, result) => {
      completed = result;
    });
    const tableId = `fixture-search-${candidate}`;
    sim.startHand({
      tableId,
      handNumber: args.handNumber,
      seatAssignments: [...args.seats],
      blinds: args.blinds,
      buttonSeatIndex: args.buttonSeatIndex,
      serverSeed,
      clientSeed: args.scenario.clientSeed,
      turnClockMs: 20_000,
      agentTurnGraceMs: 5_000,
    });

    for (let actionSeq = 0; !completed && actionSeq < 200; actionSeq++) {
      const snapshot = sim.getPublicSnapshot(tableId);
      const actor = snapshot?.seats.find(
        (seat) => seat.seatIndex === snapshot.toActSeatIndex,
      );
      if (!actor) break;
      const view = sim.getSeatViewForAgent(tableId, actor.avatarId);
      if (!view?.isYourTurn) break;
      let action: Action | null;
      if (actor.avatarId === args.ownerAvatarId) {
        action = view.legalActions.includes('check')
          ? { kind: 'check' }
          : view.legalActions.includes('call')
            ? { kind: 'call' }
            : { kind: 'fold' };
      } else {
        action = sim.getActionAdvice(tableId, actor.avatarId)?.recommended ?? null;
      }
      if (!action) break;
      const applied = sim.applyAction(tableId, actor.avatarId, action, {
        idempotencyKey: `${args.handNumber}:${actionSeq}:${actor.avatarId}`,
      });
      if (!applied.ok) break;
    }

    const result = completed as CashHandResult | null;
    if (!result) continue;
    if (args.scenario.name === 'holdem-multiway-showdown') {
      if (
        result.endedAt === 'showdown' &&
        result.perSeat.filter((seat) => seat.holeCards !== null).length >= 3
      ) {
        return serverSeed;
      }
    } else if (
      args.scenario.name === 'holdem-fold-win' &&
      result.endedAt !== 'showdown' &&
      result.perSeat.some(
        (seat) => seat.avatarId === args.ownerAvatarId && seat.isWinner,
      )
    ) {
      return serverSeed;
    }
  }
  throw new HTTPException(409, { message: 'fixture_cash_seed_search_exhausted' });
}

export interface LockedFixtureRun {
  runId: string;
  ownerAvatarId: string;
  scenarioName: FixtureScenarioName;
  tokenHash: string;
  startedAt: Date;
  expiresAt: Date;
  exposureBudgetCt: number;
  spentCt: number;
  status: 'active' | 'expired' | 'closed';
  consumedAt: Date | null;
}

interface LockedFixtureRow extends Record<string, unknown> {
  run_id: string;
  owner_avatar_id: string;
  scenario_name: string;
  token_hash: string;
  started_at: Date | string;
  expires_at: Date | string;
  exposure_budget_ct: number | string;
  spent_ct: number | string;
  status: string;
  consumed_at: Date | string | null;
}

type FixtureTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assertFixtureUsable(): void {
  if (!RAW_FIXTURE_ENABLED?.trim() || !isStagingEnv()) {
    throw new HTTPException(404, { message: 'test_fixture_unavailable' });
  }
}

export function fixtureEnabled(): boolean {
  return Boolean(RAW_FIXTURE_ENABLED?.trim()) && isStagingEnv();
}

/**
 * Read-only W-F FIX-D2 tick predicate over the authoritative
 * `cove_test_fixture_runs` schema. This is deliberately separate from arm
 * consumption: it never locks, consumes, closes, charges, or moves money.
 */
export async function hasPendingHoldemCashFixtureArm(
  ownerAvatarIds: readonly string[],
  now = new Date(),
): Promise<boolean> {
  if (ownerAvatarIds.length === 0) return false;
  const [pending] = await db
    .select({ runId: coveTestFixtureRuns.runId })
    .from(coveTestFixtureRuns)
    .where(
      and(
        inArray(coveTestFixtureRuns.ownerAvatarId, [...ownerAvatarIds]),
        eq(coveTestFixtureRuns.status, 'active'),
        isNull(coveTestFixtureRuns.consumedAt),
        gt(coveTestFixtureRuns.expiresAt, now),
        inArray(coveTestFixtureRuns.scenarioName, HOLDEM_CASH_FIXTURE_SCENARIO_NAMES),
      ),
    )
    .limit(1);
  return Boolean(pending);
}

export function hashFixtureToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueFixtureToken(): string {
  return randomBytes(FIXTURE_TOKEN_BYTES).toString('base64url');
}

export function parseFixtureHeader(
  header: string | undefined | null,
): { runId: string; token: string } | null {
  if (!header) return null;
  const separator = header.indexOf('.');
  if (separator <= 0 || separator === header.length - 1) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  const runId = header.slice(0, separator);
  const token = header.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  return { runId, token };
}

export function assertFixtureResourceHeader(
  fixtureRunId: string | null | undefined,
  header: string | undefined | null,
): void {
  if (!fixtureRunId) return;
  const credential = parseFixtureHeader(header);
  if (!credential || credential.runId !== fixtureRunId) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
}

export async function resolveFixtureOwnerAvatarId(args: {
  header: string | undefined | null;
  luciaUserId: string | null | undefined;
  agentAvatarId: string | null | undefined;
  loadActiveAvatarId?: (userId: string) => Promise<string | null>;
}): Promise<string | null> {
  if (!args.header) return null;
  if (args.agentAvatarId) return args.agentAvatarId;
  if (!args.luciaUserId) {
    throw new HTTPException(401, { message: 'test_fixture_requires_authenticated_owner' });
  }
  const avatarId = args.loadActiveAvatarId
    ? await args.loadActiveAvatarId(args.luciaUserId)
    : (
        await db.query.avatars.findFirst({
          where: and(eq(avatars.userId, args.luciaUserId), eq(avatars.isActive, true)),
        })
      )?.id ?? null;
  if (!avatarId) throw new HTTPException(403, { message: 'active_avatar_required' });
  return avatarId;
}

function safeTokenHashEqual(expectedHex: string, actualHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedHex) || !/^[0-9a-f]{64}$/i.test(actualHex)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
}

export function validateFixtureRun(args: {
  run: LockedFixtureRun;
  token: string;
  ownerAvatarId: string;
  nowMs?: number;
}): void {
  const nowMs = args.nowMs ?? Date.now();
  if (
    args.run.ownerAvatarId !== args.ownerAvatarId ||
    !safeTokenHashEqual(args.run.tokenHash, hashFixtureToken(args.token))
  ) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  if (args.run.status !== 'active' || args.run.expiresAt.getTime() <= nowMs) {
    throw new HTTPException(402, { message: 'fixture_budget_exhausted' });
  }
}

export function consumeFixtureRecord(run: LockedFixtureRun): LockedFixtureRun {
  if (run.consumedAt) {
    throw new HTTPException(409, { message: 'fixture_already_consumed' });
  }
  return { ...run, consumedAt: new Date() };
}

export function chargeFixtureRecord(
  run: LockedFixtureRun,
  legStakeCt: number,
): LockedFixtureRun {
  if (!Number.isSafeInteger(legStakeCt) || legStakeCt < 0) {
    throw new HTTPException(400, { message: 'invalid_fixture_exposure_leg' });
  }
  const next = run.spentCt + legStakeCt;
  if (next > run.exposureBudgetCt) {
    throw new HTTPException(402, { message: 'fixture_budget_exhausted' });
  }
  return { ...run, spentCt: next };
}

export type FixtureExposurePlan =
  | { kind: 'charge'; spentCt: number }
  | { kind: 'completion' }
  | { kind: 'deny'; reason: 'expired' | 'exhausted' | 'closed'; closeAs?: 'expired' | 'closed' };

/**
 * Pure budget state machine shared by the DB path and offline safety tests.
 * Once a run is terminal, only zero-exposure actions may finish an already
 * staked linked resource; no new shoe/hand can consume a terminal run.
 */
export function planFixtureExposure(
  run: Pick<LockedFixtureRun, 'status' | 'expiresAt' | 'spentCt' | 'exposureBudgetCt'>,
  legStakeCt: number,
  nowMs = Date.now(),
): FixtureExposurePlan {
  if (!Number.isSafeInteger(legStakeCt) || legStakeCt < 0) {
    throw new HTTPException(400, { message: 'invalid_fixture_exposure_leg' });
  }
  if (run.status !== 'active') {
    if (legStakeCt === 0) return { kind: 'completion' };
    return { kind: 'deny', reason: run.status === 'expired' ? 'expired' : 'closed' };
  }
  if (run.expiresAt.getTime() <= nowMs) {
    return { kind: 'deny', reason: 'expired', closeAs: 'expired' };
  }
  const nextSpentCt = run.spentCt + legStakeCt;
  if (nextSpentCt > run.exposureBudgetCt) {
    return { kind: 'deny', reason: 'exhausted', closeAs: 'closed' };
  }
  return { kind: 'charge', spentCt: nextSpentCt };
}

function normalizeLockedRow(row: LockedFixtureRow): LockedFixtureRun {
  const scenarioName = row.scenario_name as FixtureScenarioName;
  if (!FIXTURE_SCENARIOS[scenarioName]) {
    throw new HTTPException(409, { message: 'unknown_fixture_scenario' });
  }
  return {
    runId: row.run_id,
    ownerAvatarId: row.owner_avatar_id,
    scenarioName,
    tokenHash: row.token_hash,
    startedAt: new Date(row.started_at),
    expiresAt: new Date(row.expires_at),
    exposureBudgetCt: Number(row.exposure_budget_ct),
    spentCt: Number(row.spent_ct),
    status: row.status as LockedFixtureRun['status'],
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
  };
}

async function lockRun(
  tx: FixtureTransaction,
  runId: string,
): Promise<LockedFixtureRun> {
  const [row] = await tx.execute<LockedFixtureRow>(sql`
    SELECT run_id, owner_avatar_id, scenario_name, token_hash, started_at, expires_at,
           exposure_budget_ct, spent_ct, status, consumed_at
      FROM cove_test_fixture_runs
     WHERE run_id = ${runId}
     FOR UPDATE
  `);
  if (!row) throw new HTTPException(401, { message: 'invalid_test_fixture' });
  return normalizeLockedRow(row);
}

export async function validateFixtureArmAccess(args: {
  header: string | undefined | null;
  ownerAvatarId: string;
  arm: FixtureArm;
  nowMs?: number;
}): Promise<(FixtureScenario & { runId: string; startedAt: Date }) | null> {
  if (!args.header) return null;
  assertFixtureUsable();
  const result = await db.transaction(async (tx) => {
    const credential = parseFixtureHeader(args.header)!;
    const run = await lockRun(tx, credential.runId);
    if (
      run.ownerAvatarId !== args.ownerAvatarId ||
      !safeTokenHashEqual(run.tokenHash, hashFixtureToken(credential.token))
    ) {
      throw new HTTPException(401, { message: 'invalid_test_fixture' });
    }
    if (run.status !== 'active' || run.expiresAt.getTime() <= (args.nowMs ?? Date.now())) {
      if (run.status === 'active') {
        await tx
          .update(coveTestFixtureRuns)
          .set({ status: 'expired', closedAt: new Date() })
          .where(eq(coveTestFixtureRuns.runId, run.runId));
      }
      return { kind: 'expired' as const };
    }
    const scenario = FIXTURE_SCENARIOS[run.scenarioName];
    if (!(scenario.arms as readonly FixtureArm[]).includes(args.arm)) {
      throw new HTTPException(409, { message: 'fixture_arm_mismatch' });
    }
    return {
      kind: 'ok' as const,
      fixture: { ...scenario, runId: run.runId, startedAt: run.startedAt },
    };
  });
  if (result.kind === 'expired') {
    throw new HTTPException(402, { message: 'fixture_budget_exhausted' });
  }
  return result.fixture;
}

/**
 * Authenticate an already-linked fixture resource without reopening the run.
 * Terminal runs may use this only to finish zero-exposure gameplay; the locked
 * wager transaction still calls `chargeFixtureExposure`, which rejects every
 * positive leg and permits only legStakeCt=0 completion.
 */
export async function validateLinkedFixtureArmAccess(args: {
  header: string | undefined | null;
  ownerAvatarId: string;
  arm: FixtureArm;
  fixtureRunId: string;
}): Promise<FixtureScenario & { runId: string; startedAt: Date }> {
  assertFixtureUsable();
  const credential = parseFixtureHeader(args.header);
  if (!credential || credential.runId !== args.fixtureRunId) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  return db.transaction(async (tx) => {
    return validateLinkedFixtureArmAccessInTransaction(tx, args);
  });
}

export async function validateLinkedFixtureArmAccessInTransaction(
  tx: FixtureTransaction,
  args: {
    header: string | undefined | null;
    ownerAvatarId: string;
    arm: FixtureArm;
    fixtureRunId: string;
  },
): Promise<FixtureScenario & { runId: string; startedAt: Date }> {
  assertFixtureUsable();
  const credential = parseFixtureHeader(args.header);
  if (!credential || credential.runId !== args.fixtureRunId) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  const run = await lockRun(tx, credential.runId);
  if (
    run.ownerAvatarId !== args.ownerAvatarId ||
    !safeTokenHashEqual(run.tokenHash, hashFixtureToken(credential.token))
  ) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  const scenario = FIXTURE_SCENARIOS[run.scenarioName];
  if (!(scenario.arms as readonly FixtureArm[]).includes(args.arm)) {
    throw new HTTPException(409, { message: 'fixture_arm_mismatch' });
  }
  return { ...scenario, runId: run.runId, startedAt: run.startedAt };
}

export async function consumeFixtureArm(
  tx: FixtureTransaction,
  args: {
    header: string | undefined | null;
    ownerAvatarId: string;
    arm: FixtureArm;
    nowMs?: number;
  },
): Promise<
  | { ok: true; fixture: FixtureScenario & { runId: string } }
  | { ok: false; runId: string; reason: 'expired' | 'closed' }
  | null
> {
  if (!args.header) return null;
  assertFixtureUsable();
  const credential = parseFixtureHeader(args.header)!;
  const run = await lockRun(tx, credential.runId);
  if (
    run.ownerAvatarId !== args.ownerAvatarId ||
    !safeTokenHashEqual(run.tokenHash, hashFixtureToken(credential.token))
  ) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  const timeExpired = run.expiresAt.getTime() <= (args.nowMs ?? Date.now());
  if (run.status !== 'active' || timeExpired) {
    if (run.status === 'active') {
      await tx
        .update(coveTestFixtureRuns)
        .set({ status: 'expired', closedAt: new Date() })
        .where(
          and(
            eq(coveTestFixtureRuns.runId, run.runId),
            eq(coveTestFixtureRuns.status, 'active'),
          ),
        );
    }
    return {
      ok: false,
      runId: run.runId,
      reason: run.status === 'active' || run.status === 'expired' ? 'expired' : 'closed',
    };
  }
  const scenario = FIXTURE_SCENARIOS[run.scenarioName];
  if (!(scenario.arms as readonly FixtureArm[]).includes(args.arm)) {
    throw new HTTPException(409, { message: 'fixture_arm_mismatch' });
  }
  if (run.consumedAt) {
    throw new HTTPException(409, { message: 'fixture_already_consumed' });
  }
  const consumed = await tx.execute<{ run_id: string }>(sql`
    UPDATE cove_test_fixture_runs
       SET consumed_at = now()
     WHERE run_id = ${run.runId}
       AND status = 'active'
       AND consumed_at IS NULL
     RETURNING run_id
  `);
  if (!consumed[0]) {
    throw new HTTPException(409, { message: 'fixture_already_consumed' });
  }
  return { ok: true, fixture: { ...scenario, runId: run.runId } };
}

export async function chargeFixtureExposure(
  tx: FixtureTransaction,
  args: {
    header: string | undefined | null;
    ownerAvatarId: string;
    arm: FixtureArm;
    legStakeCt: number;
    nowMs?: number;
  },
): Promise<
  | { ok: true; runId: string; fixture: FixtureScenario }
  | { ok: false; runId: string; reason: 'expired' | 'exhausted' | 'closed' }
  | null
> {
  if (!args.header) return null;
  assertFixtureUsable();
  const credential = parseFixtureHeader(args.header)!;
  const run = await lockRun(tx, credential.runId);
  if (
    run.ownerAvatarId !== args.ownerAvatarId ||
    !safeTokenHashEqual(run.tokenHash, hashFixtureToken(credential.token))
  ) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  const scenario = FIXTURE_SCENARIOS[run.scenarioName];
  assertFixtureScenarioArm(scenario, args.arm);
  const plan = planFixtureExposure(run, args.legStakeCt, args.nowMs ?? Date.now());
  if (plan.kind === 'completion') {
    return { ok: true, runId: run.runId, fixture: scenario };
  }
  if (plan.kind === 'deny') {
    if (plan.closeAs) {
      await tx
        .update(coveTestFixtureRuns)
        .set({
          status: plan.closeAs,
          closedAt: new Date(),
        })
        .where(
          and(
            eq(coveTestFixtureRuns.runId, run.runId),
            eq(coveTestFixtureRuns.status, 'active'),
          ),
        );
    }
    return {
      ok: false,
      runId: run.runId,
      reason: plan.reason,
    };
  }
  const updated = await tx.execute<{ run_id: string }>(sql`
    UPDATE cove_test_fixture_runs
       SET spent_ct = ${plan.spentCt}
     WHERE run_id = ${run.runId}
       AND status = 'active'
       AND spent_ct = ${run.spentCt}
     RETURNING run_id
  `);
  if (!updated[0]) {
    throw new HTTPException(409, { message: 'fixture_exposure_race' });
  }
  return { ok: true, runId: run.runId, fixture: scenario };
}

export async function closeFixtureRunForOwner(tx: FixtureTransaction, args: {
  runId: string;
  ownerAvatarId: string;
  header: string | undefined | null;
}): Promise<boolean> {
  assertFixtureUsable();
  const credential = parseFixtureHeader(args.header);
  if (!credential || credential.runId !== args.runId) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  const locked = await lockRun(tx, args.runId);
  if (
    locked.ownerAvatarId !== args.ownerAvatarId ||
    !safeTokenHashEqual(locked.tokenHash, hashFixtureToken(credential.token))
  ) {
    throw new HTTPException(401, { message: 'invalid_test_fixture' });
  }
  if (locked.status === 'closed') return true;
  const rows = await tx
    .update(coveTestFixtureRuns)
    .set({ status: 'closed', closedAt: new Date() })
    .where(
      and(
        eq(coveTestFixtureRuns.runId, args.runId),
        eq(coveTestFixtureRuns.ownerAvatarId, args.ownerAvatarId),
        sql`${coveTestFixtureRuns.status} <> 'closed'`,
      ),
    )
    .returning({ runId: coveTestFixtureRuns.runId });
  return rows.length > 0;
}
