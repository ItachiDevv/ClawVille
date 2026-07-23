import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import {
  FIXTURE_SCENARIOS,
  assertFixtureScenarioArm,
  assertFixtureResourceHeader,
  chargeFixtureRecord,
  consumeFixtureRecord,
  hashFixtureToken,
  issueFixtureToken,
  parseFixtureHeader,
  planFixtureExposure,
  resolveFixtureOwnerAvatarId,
  resolveCashFixtureServerSeed,
  validateFixtureRun,
  type LockedFixtureRun,
} from '../cove-test-fixture';
import { playHand as playBlackjack } from '../blackjack-engine';
import {
  buildShoe as buildBaccaratShoe,
  playCoup,
  replayShoeUpToCoup,
} from '../baccarat-engine';
import { playHand as playHoldem } from '../holdem-engine';
import { PokerTableSim } from '../poker/poker-table-sim';
import type { Action, HandResult, SimClock } from '../poker/poker-table-types';

const TOKEN = 'A'.repeat(43);
const RUN_ID = '11111111-1111-4111-8111-111111111111';

class FixtureSimClock implements SimClock {
  now(): number {
    return 0;
  }

  setTimer(): unknown {
    return {};
  }

  clearTimer(): void {}
}

function run(overrides: Partial<LockedFixtureRun> = {}): LockedFixtureRun {
  return {
    runId: RUN_ID,
    ownerAvatarId: '22222222-2222-4222-8222-222222222222',
    scenarioName: 'bj-split',
    tokenHash: hashFixtureToken(TOKEN),
    startedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 60_000),
    exposureBudgetCt: 100,
    spentCt: 0,
    status: 'active',
    consumedAt: null,
    ...overrides,
  };
}

describe('BA-2 fixture safety gate', () => {
  const cwd = join(import.meta.dir, '..', '..', '..');
  const importStatement = "await import('./src/services/cove-test-fixture.ts')";

  it('imports when enabled only on the literal staging environment', () => {
    const result = Bun.spawnSync([process.execPath, '-e', importStatement], {
      cwd,
      env: { ...process.env, CV_TEST_FIXTURE_ENABLED: '1', CLAWVILLE_ENV: 'staging' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
  });

  it('crashes at module load when enabled outside staging', () => {
    const result = Bun.spawnSync([process.execPath, '-e', importStatement], {
      cwd,
      env: { ...process.env, CV_TEST_FIXTURE_ENABLED: '1', CLAWVILLE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'CV_TEST_FIXTURE_ENABLED is set but CLAWVILLE_ENV',
    );
  });

  it('keeps stale-shoe force-close before stale-run closure on replacement run', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-test-fixture.ts'),
    ).text();
    const staleSelection = routeSource.indexOf('const staleRuns = await tx');
    const shoeClose = routeSource.indexOf('await closeFixtureShoes(', staleSelection);
    const runClose = routeSource.indexOf('.update(coveTestFixtureRuns)', shoeClose);
    const newRunInsert = routeSource.indexOf('.insert(coveTestFixtureRuns)', runClose);
    expect(staleSelection).toBeGreaterThan(-1);
    expect(shoeClose).toBeGreaterThan(staleSelection);
    expect(runClose).toBeGreaterThan(shoeClose);
    expect(newRunInsert).toBeGreaterThan(runClose);
  });

  it('recovers linked resources from terminal as well as active prior runs', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-test-fixture.ts'),
    ).text();
    const staleSelection = routeSource.indexOf('const staleRuns = await tx');
    const recoveryCall = routeSource.indexOf('await closeFixtureShoes(', staleSelection);
    const selectionSource = routeSource.slice(staleSelection, recoveryCall);
    expect(selectionSource).toContain('WHERE r.owner_avatar_id = ${ownerAvatarId}');
    expect(selectionSource).toContain("s.status = 'open'");
    expect(selectionSource).toContain('h.settled_at IS NULL');
    expect(selectionSource).toContain("s.current_stack_ct = '0'");
    expect(selectionSource).not.toContain('s.current_stack_ct = 0');
    expect(selectionSource).not.toContain("r.status = 'active'");
  });

  it('rotates a stale blocked run credential once before returning recovery 409', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-test-fixture.ts'),
    ).text();
    const recoveryCheck = routeSource.indexOf('if (recovery)');
    const issue = routeSource.indexOf('const recoveryToken = issueFixtureToken()', recoveryCheck);
    const expiryCheck = routeSource.indexOf(
      "recovery.status === 'active'",
      issue,
    );
    const hashWrite = routeSource.indexOf(
      'tokenHash: hashFixtureToken(recoveryToken),',
      issue,
    );
    const terminalize = routeSource.indexOf("status: 'expired' as const", expiryCheck);
    const response = routeSource.indexOf("error: 'fixture_recovery_required'", hashWrite);
    expect(recoveryCheck).toBeGreaterThan(-1);
    expect(issue).toBeGreaterThan(recoveryCheck);
    expect(expiryCheck).toBeGreaterThan(issue);
    expect(terminalize).toBeGreaterThan(expiryCheck);
    expect(hashWrite).toBeGreaterThan(issue);
    expect(response).toBeGreaterThan(hashWrite);
    expect(routeSource).not.toContain('console.log(recoveryToken)');
    expect(routeSource).not.toContain('console.warn(recoveryToken)');
  });

  it('serializes run replacement by owner and keeps a unique-active database backstop', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-test-fixture.ts'),
    ).text();
    const ownerLock = routeSource.indexOf('SELECT id FROM avatars WHERE id = ${ownerAvatarId} FOR UPDATE');
    const staleSelection = routeSource.indexOf('const staleRuns = await tx', ownerLock);
    const insert = routeSource.indexOf('.insert(coveTestFixtureRuns)', staleSelection);
    expect(ownerLock).toBeGreaterThan(-1);
    expect(staleSelection).toBeGreaterThan(ownerLock);
    expect(insert).toBeGreaterThan(staleSelection);
    expect(routeSource).toContain("message: 'fixture_run_conflict'");

    const schemaSource = await Bun.file(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'database', 'src', 'schema', 'cove-test-fixture.ts'),
    ).text();
    const migrationSource = await Bun.file(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'database', 'migrations', '0026_test_fixture_runs.sql'),
    ).text();
    expect(schemaSource).toContain("uniqueIndex('cove_test_fixture_runs_owner_active_unique')");
    expect(schemaSource).toContain(".where(sql`status = 'active'`)");
    expect(migrationSource).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "cove_test_fixture_runs_owner_active_unique"');
    expect(migrationSource).toContain(`WHERE "status" = 'active'`);
  });

  it('fails closed when a fixture open loses the fresh-resource insert race', async () => {
    const routeNames = ['cove-blackjack.ts', 'cove-baccarat.ts', 'cove-holdem.ts'];
    const fixtureRaceGuard =
      /if \(pgCode === '23505'\) \{\s+if \(fixtureHeader\) \{\s+throw new HTTPException\(409, \{ message: 'fixture_requires_fresh_shoe' \}\);/;
    for (const routeName of routeNames) {
      const routeSource = await Bun.file(
        join(import.meta.dir, '..', '..', 'routes', routeName),
      ).text();
      expect(routeSource).toMatch(fixtureRaceGuard);
    }
  });

  it('replacement recovery discards guest-demo practice only and refuses ledger loss', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-test-fixture.ts'),
    ).text();
    const practiceSelection = routeSource.indexOf('eq(holdemTables.fixtureRunId, runId)');
    const ledgerRefusal = routeSource.indexOf(
      "message: 'fixture_practice_ledger_recovery_required'",
      practiceSelection,
    );
    const demoDiscard = routeSource.indexOf("playerStack: '0'", ledgerRefusal);
    const ledgerNullGuard = routeSource.indexOf('isNull(holdemTables.userId)', demoDiscard);
    expect(practiceSelection).toBeGreaterThan(-1);
    expect(ledgerRefusal).toBeGreaterThan(practiceSelection);
    expect(demoDiscard).toBeGreaterThan(ledgerRefusal);
    expect(ledgerNullGuard).toBeGreaterThan(demoDiscard);
  });

  it('refuses unsafe blackjack/cash teardown and voids cash only after Walk Away', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-test-fixture.ts'),
    ).text();
    expect(routeSource).toContain("message: 'fixture_blackjack_hand_requires_settlement'");
    expect(routeSource).toContain("message: 'fixture_cash_recovery_required'");
    const cashRefusal = routeSource.indexOf("message: 'fixture_cash_recovery_required'");
    const placeholderVoid = routeSource.indexOf('.set({ fixtureVoidedAt: now })', cashRefusal);
    expect(placeholderVoid).toBeGreaterThan(cashRefusal);
    expect(routeSource).toContain("seat.status !== 'left' || BigInt(seat.currentStackCt) !== 0n");
    const managerSource = await Bun.file(
      join(import.meta.dir, '..', 'poker', 'cash-table-manager.ts'),
    ).text();
    expect(managerSource).toContain('serverSeedReveal: fixtureServerSeed');
  });

  it('preserves fixture provenance with restrictive foreign keys', async () => {
    const schemaNames = [
      'cove-test-fixture.ts',
      'blackjack.ts',
      'baccarat.ts',
      'holdem.ts',
      'poker-cash.ts',
      'cove-events.ts',
    ];
    for (const schemaName of schemaNames) {
      const source = await Bun.file(
        join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'database', 'src', 'schema', schemaName),
      ).text();
      if (schemaName === 'cove-test-fixture.ts') {
        const ownerFk = source.slice(
          source.indexOf("ownerAvatarId: uuid('owner_avatar_id')"),
          source.indexOf("scenarioName:", source.indexOf("ownerAvatarId: uuid('owner_avatar_id')")),
        );
        expect(ownerFk).not.toContain("onDelete: 'set null'");
        expect(source).not.toContain("onDelete: 'cascade'");
      } else {
        const lines = source.split(/\r?\n/);
        const fixtureLines = lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes("fixtureRunId: uuid('fixture_run_id')"));
        expect(fixtureLines.length).toBeGreaterThan(0);
        for (const { index } of fixtureLines) {
          expect(lines.slice(index, index + 6).join('\n')).not.toContain("onDelete: 'set null'");
        }
      }
    }
    const migrationSource = await Bun.file(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'database', 'migrations', '0026_test_fixture_runs.sql'),
    ).text();
    expect(migrationSource.toLowerCase()).not.toContain('on delete set null');
    expect(migrationSource.toLowerCase()).toContain('on delete restrict');
  });

  it('revalidates every practice deal/action/settle mutation under its lock transaction', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-holdem.ts'),
    ).text();
    expect(routeSource.match(/legStakeCt: 0,/g)).toHaveLength(3);
    expect(routeSource.match(/fixtureAccess\.runId !== .*fixture_run_id/g)).toHaveLength(3);
  });

  it('rejects a delayed cash action when the live sim advanced to another hand', async () => {
    const managerSource = await Bun.file(
      join(import.meta.dir, '..', 'poker', 'cash-table-manager.ts'),
    ).text();
    const snapshotRead = managerSource.indexOf('const current = this.sim.getPublicSnapshot(sid)');
    const handGuard = managerSource.indexOf('current.handNumber !== input.handNumber', snapshotRead);
    const mutation = managerSource.indexOf('this.sim.applyAction(', handGuard);
    expect(snapshotRead).toBeGreaterThan(-1);
    expect(handGuard).toBeGreaterThan(snapshotRead);
    expect(mutation).toBeGreaterThan(handGuard);
  });

  it('rejects a wrong cash arm before exposure or ledger mutation', async () => {
    const untouched = run({ scenarioName: 'bj-split', spentCt: 0 });
    expect(() =>
      assertFixtureScenarioArm(FIXTURE_SCENARIOS[untouched.scenarioName], 'holdem-cash'),
    ).toThrow('fixture_arm_mismatch');
    expect(untouched.spentCt).toBe(0);

    const serviceSource = await Bun.file(
      join(import.meta.dir, '..', 'cove-test-fixture.ts'),
    ).text();
    const chargeStart = serviceSource.indexOf('export async function chargeFixtureExposure');
    const armCheck = serviceSource.indexOf('assertFixtureScenarioArm(scenario, args.arm)', chargeStart);
    const budgetPlan = serviceSource.indexOf('const plan = planFixtureExposure(', armCheck);
    expect(armCheck).toBeGreaterThan(chargeStart);
    expect(budgetPlan).toBeGreaterThan(armCheck);

    const managerSource = await Bun.file(
      join(import.meta.dir, '..', 'poker', 'cash-table-manager.ts'),
    ).text();
    const sitCharge = managerSource.indexOf('const charge = await chargeFixtureExposure(tx,');
    const cashArm = managerSource.indexOf("arm: 'holdem-cash'", sitCharge);
    const isolation = managerSource.indexOf(
      "competitors.some((seat) => seat.isSeeded !== 'true')",
      cashArm,
    );
    const funded = managerSource.indexOf('const fundedSittingIn = competitors.filter(', isolation);
    const capacity = managerSource.indexOf('fundedSittingIn.length < requiredCompetitors', funded);
    const ledgerDebit = managerSource.indexOf('this.ledger.debitClawTokens(', capacity);
    expect(cashArm).toBeGreaterThan(sitCharge);
    expect(isolation).toBeGreaterThan(cashArm);
    expect(funded).toBeGreaterThan(isolation);
    expect(capacity).toBeGreaterThan(funded);
    expect(ledgerDebit).toBeGreaterThan(capacity);
  });

  it('authenticates fixture baccarat resume before threshold rotation and never commit-then-409s', async () => {
    const routeSource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-baccarat.ts'),
    ).text();
    const linkedBranch = routeSource.indexOf('if (row.fixtureRunId)');
    const missingHeader = routeSource.indexOf(
      "throw new HTTPException(401, { message: 'invalid_test_fixture' })",
      linkedBranch,
    );
    const credentialCheck = routeSource.indexOf(
      'await validateLinkedFixtureArmAccessInTransaction(tx,',
      missingHeader,
    );
    const thresholdCheck = routeSource.indexOf(
      'if (row.dealtCount < RESHUFFLE_CARD_THRESHOLD)',
      credentialCheck,
    );
    const closeMutation = routeSource.indexOf('.update(baccaratShoes)', thresholdCheck);
    const freshInsert = routeSource.indexOf('.insert(baccaratShoes)', closeMutation);
    const fixtureRotationGuard = routeSource.indexOf(
      "fixtureHeader && resumed.kind !== 'fixture-rotated'",
      freshInsert,
    );
    expect(linkedBranch).toBeGreaterThan(-1);
    expect(missingHeader).toBeGreaterThan(linkedBranch);
    expect(credentialCheck).toBeGreaterThan(missingHeader);
    expect(thresholdCheck).toBeGreaterThan(credentialCheck);
    expect(closeMutation).toBeGreaterThan(thresholdCheck);
    expect(freshInsert).toBeGreaterThan(closeMutation);
    expect(fixtureRotationGuard).toBeGreaterThan(freshInsert);
    expect(routeSource).toContain(
      'const carriedBalance = isLedgerSubject(subject) ? 0n : guestDemoBalance(row)',
    );
  });

  it('commits initial-arm expiry before callers surface 402 and preserves closed status', async () => {
    const serviceSource = await Bun.file(
      join(import.meta.dir, '..', 'cove-test-fixture.ts'),
    ).text();
    const consumeStart = serviceSource.indexOf('export async function consumeFixtureArm');
    const chargeStart = serviceSource.indexOf('export async function chargeFixtureExposure');
    const consumeSource = serviceSource.slice(consumeStart, chargeStart);
    expect(consumeSource).not.toContain('validateFixtureRun(');
    expect(consumeSource.indexOf(".set({ status: 'expired'")).toBeGreaterThan(-1);
    expect(consumeSource.indexOf('return {', consumeSource.indexOf(".set({ status: 'expired'")))
      .toBeGreaterThan(consumeSource.indexOf(".set({ status: 'expired'"));

    const closeStart = serviceSource.indexOf('export async function closeFixtureRunForOwner');
    const chargeSource = serviceSource.slice(chargeStart, closeStart);
    expect(chargeSource).toContain('const plan = planFixtureExposure(');
    expect(chargeSource).toContain("if (plan.kind === 'completion')");
    expect(chargeSource).toContain('if (plan.closeAs)');
  });
});

describe('BA-2 token and state transitions', () => {
  it('binds an authenticated Lucia guest to its active avatar and rejects anonymous fixture auth', async () => {
    const guestAvatarId = '44444444-4444-4444-8444-444444444444';
    const seenUsers: string[] = [];
    await expect(
      resolveFixtureOwnerAvatarId({
        header: `${RUN_ID}.${TOKEN}`,
        luciaUserId: 'guest-user-id',
        agentAvatarId: null,
        loadActiveAvatarId: async (userId) => {
          seenUsers.push(userId);
          return guestAvatarId;
        },
      }),
    ).resolves.toBe(guestAvatarId);
    expect(seenUsers).toEqual(['guest-user-id']);

    await expect(
      resolveFixtureOwnerAvatarId({
        header: `${RUN_ID}.${TOKEN}`,
        luciaUserId: null,
        agentAvatarId: null,
        loadActiveAvatarId: async () => guestAvatarId,
      }),
    ).rejects.toThrow('test_fixture_requires_authenticated_owner');
  });

  it('issues a 32-byte base64url token and persists only its sha256 digest', () => {
    const token = issueFixtureToken();
    const hash = hashFixtureToken(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(parseFixtureHeader(`${RUN_ID}.${token}`)).toEqual({ runId: RUN_ID, token });
  });

  it('consumes a seed arm exactly once', () => {
    const consumed = consumeFixtureRecord(run());
    expect(consumed.consumedAt).toBeInstanceOf(Date);
    expect(() => consumeFixtureRecord(consumed)).toThrow('fixture_already_consumed');
  });

  it('accounts exposure atomically and rejects a leg beyond the budget', () => {
    const charged = chargeFixtureRecord(run({ spentCt: 35 }), 60);
    expect(charged.spentCt).toBe(95);
    expect(() => chargeFixtureRecord(charged, 6)).toThrow('fixture_budget_exhausted');
  });

  it('blocks new exposure after exhaustion but permits zero-cost completion', () => {
    const active = run({ exposureBudgetCt: 20, spentCt: 20 });
    expect(planFixtureExposure(active, 20)).toEqual({
      kind: 'deny',
      reason: 'exhausted',
      closeAs: 'closed',
    });
    const closed = run({ exposureBudgetCt: 20, spentCt: 20, status: 'closed' });
    expect(planFixtureExposure(closed, 0)).toEqual({ kind: 'completion' });
    expect(planFixtureExposure(closed, 1)).toEqual({
      kind: 'deny',
      reason: 'closed',
    });
  });

  it('rejects a wrong resource run, owner, token, and expired run', () => {
    expect(() =>
      assertFixtureResourceHeader(
        RUN_ID,
        `33333333-3333-4333-8333-333333333333.${TOKEN}`,
      ),
    ).toThrow('invalid_test_fixture');
    expect(() =>
      validateFixtureRun({
        run: run(),
        token: TOKEN,
        ownerAvatarId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow('invalid_test_fixture');
    expect(() =>
      validateFixtureRun({
        run: run(),
        token: 'B'.repeat(43),
        ownerAvatarId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrow('invalid_test_fixture');
    expect(() =>
      validateFixtureRun({
        run: run({ expiresAt: new Date(0) }),
        token: TOKEN,
        ownerAvatarId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toThrow('fixture_budget_exhausted');
  });
});

describe('BA-2 deterministic catalog', () => {
  it('pins all 13 frozen scenario ids', () => {
    expect(Object.keys(FIXTURE_SCENARIOS)).toEqual([
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
    ]);
  });

  it('replays the blackjack outcomes and opening conditions', () => {
    const split = FIXTURE_SCENARIOS['bj-split'];
    const unsplitOpening = playBlackjack({
      serverSeed: split.serverSeed,
      clientSeed: split.clientSeed,
      nonce: 0,
      cursor: 0,
      bet: 20n,
      script: { hands: [['stand']], didSplit: false, tookInsurance: false },
    }).playerHands[0]?.cards;
    expect(unsplitOpening).toHaveLength(2);
    expect(unsplitOpening?.[0]?.rank).toBe(unsplitOpening?.[1]?.rank);
    const splitResult = playBlackjack({
      serverSeed: split.serverSeed,
      clientSeed: split.clientSeed,
      nonce: 0,
      cursor: 0,
      bet: 20n,
      script: split.blackjackScript,
    });
    expect(splitResult.playerHands).toHaveLength(2);

    const natural = FIXTURE_SCENARIOS['bj-natural'];
    expect(
      playBlackjack({
        serverSeed: natural.serverSeed,
        clientSeed: natural.clientSeed,
        nonce: 0,
        cursor: 0,
        bet: 20n,
        script: natural.blackjackScript,
      }).playerHands[0]?.outcome,
    ).toBe('blackjack');

    const push = FIXTURE_SCENARIOS['bj-push'];
    expect(
      playBlackjack({
        serverSeed: push.serverSeed,
        clientSeed: push.clientSeed,
        nonce: 0,
        cursor: 0,
        bet: 20n,
        script: push.blackjackScript,
      }).playerHands[0]?.outcome,
    ).toBe('push');

    const insurance = FIXTURE_SCENARIOS['bj-insurance'];
    const insuranceResult = playBlackjack({
      serverSeed: insurance.serverSeed,
      clientSeed: insurance.clientSeed,
      nonce: 0,
      cursor: 0,
      bet: 20n,
      script: insurance.blackjackScript,
    });
    expect(insuranceResult.dealer.cards[0]?.rank).toBe('A');
    expect(insuranceResult.insurance).not.toBeNull();
  });

  it('replays baccarat naturals, third cards, tie, and threshold state', () => {
    const replay = (name: keyof typeof FIXTURE_SCENARIOS, bet: 'player' | 'banker' | 'tie') => {
      const scenario = FIXTURE_SCENARIOS[name];
      return playCoup({
        serverSeed: scenario.serverSeed,
        clientSeed: scenario.clientSeed,
        nonce: 0,
        cursor: 0,
        bet,
        stake: 20n,
      });
    };
    expect(replay('bac-player-natural', 'player').player.isNatural).toBe(true);
    expect(replay('bac-banker-natural', 'banker').banker.isNatural).toBe(true);
    expect(replay('bac-player-third', 'player').player.cards).toHaveLength(3);
    expect(replay('bac-banker-third', 'banker').banker.cards).toHaveLength(3);
    expect(replay('bac-tie', 'player').winner).toBe('tie');

    const threshold = FIXTURE_SCENARIOS['bac-shoe-near-threshold'];
    const dealt = threshold.initialDealtCount!;
    const result = playCoup({
      serverSeed: threshold.serverSeed,
      clientSeed: threshold.clientSeed,
      nonce: 0,
      cursor: 0,
      bet: 'player',
      stake: 20n,
      dealtBefore: dealt,
      remainingShoe: buildBaccaratShoe().slice(dealt),
    });
    expect(result.dealtAfter).toBeGreaterThanOrEqual(312);
    expect(FIXTURE_SCENARIOS['bac-shoe-exhausted'].initialDealtCount).toBe(312);

    const replayed = replayShoeUpToCoup({
      serverSeed: threshold.serverSeed,
      clientSeed: threshold.clientSeed,
      targetNonce: 0,
      coups: [{ bet: 'player', stake: 20n }],
      initialDealtCount: dealt,
    });
    expect(replayed).toEqual(result);
  });

  it('makes the history verifier load and replay the persisted baccarat fixture offset', async () => {
    const historySource = await Bun.file(
      join(import.meta.dir, '..', '..', 'routes', 'cove-history.ts'),
    ).text();
    const shoeLoad = historySource.indexOf('columns: { fixtureInitialDealtCount: true }');
    const replay = historySource.indexOf(
      'initialDealtCount: shoe.fixtureInitialDealtCount',
      shoeLoad,
    );
    expect(shoeLoad).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(shoeLoad);
  });

  it('replays holdem showdown and fold-win scripts', () => {
    const showdown = FIXTURE_SCENARIOS['holdem-multiway-showdown'];
    const showdownResult = playHoldem({
      serverSeed: showdown.serverSeed,
      clientSeed: showdown.clientSeed,
      nonce: 0,
      buttonSeat: 0,
      humanStartingStack: 100n,
      humanActions: [...(showdown.holdemActions ?? [])],
    });
    expect(showdownResult.endedAt).toBe('showdown');
    expect(showdownResult.board).toHaveLength(5);

    const fold = FIXTURE_SCENARIOS['holdem-fold-win'];
    const foldResult = playHoldem({
      serverSeed: fold.serverSeed,
      clientSeed: fold.clientSeed,
      nonce: 0,
      buttonSeat: 0,
      humanStartingStack: 100n,
      humanActions: [...(fold.holdemActions ?? [])],
    });
    expect(foldResult.endedAt).not.toBe('showdown');
    expect(foldResult.seats.find((seat) => seat.isHuman)?.status).toBe('folded');
  });

  it('replays cash advisor flow as a three-way showdown and deterministic fold win', () => {
    const replayCash = (
      scenarioName: 'holdem-multiway-showdown' | 'holdem-fold-win',
      handNumber = 1,
    ) => {
      const scenario = FIXTURE_SCENARIOS[scenarioName];
      const sim = new PokerTableSim(new FixtureSimClock());
      let completed: HandResult | null = null;
      sim.setHandCompleteFn((_tableId, result) => {
        completed = result;
      });
      const avatarIds = ['fixture-human', 'fixture-bot-1', 'fixture-bot-2'];
      const seats = avatarIds.map((avatarId, seatIndex) => ({
        seatIndex,
        avatarId,
        name: avatarId,
        subjectType: seatIndex === 0 ? 'human' as const : 'agent' as const,
        ...(seatIndex === 0 ? {} : { agentId: avatarId }),
        chipStack: 100,
        isSeeded: seatIndex !== 0,
      }));
      const buttonSeatIndex = handNumber % seats.length;
      const serverSeed = resolveCashFixtureServerSeed({
        scenario,
        handNumber,
        buttonSeatIndex,
        ownerAvatarId: avatarIds[0]!,
        seats,
        blinds: { sb: 1, bb: 2, ante: 0 },
      });
      sim.startHand({
        tableId: scenarioName,
        handNumber,
        seatAssignments: seats,
        blinds: { sb: 1, bb: 2, ante: 0 },
        buttonSeatIndex,
        serverSeed,
        clientSeed: scenario.clientSeed,
        turnClockMs: 20_000,
        agentTurnGraceMs: 5_000,
      });

      for (let actionSeq = 0; !completed && actionSeq < 100; actionSeq++) {
        const snapshot = sim.getPublicSnapshot(scenarioName);
        const actingSeat = snapshot?.seats.find(
          (seat) => seat.seatIndex === snapshot.toActSeatIndex,
        );
        if (!actingSeat) throw new Error('fixture cash sim has no acting seat');
        const view = sim.getSeatViewForAgent(scenarioName, actingSeat.avatarId);
        if (!view?.isYourTurn) throw new Error('fixture cash sim lost the actor');
        const action: Action | null =
          actingSeat.avatarId === avatarIds[0]
            ? view.legalActions.includes('check')
              ? { kind: 'check' }
              : { kind: 'call' }
            : sim.getActionAdvice(scenarioName, actingSeat.avatarId)?.recommended ?? null;
        if (!action) throw new Error('fixture cash advisor returned no action');
        const applied = sim.applyAction(scenarioName, actingSeat.avatarId, action, {
          idempotencyKey: `${scenarioName}-${actionSeq}`,
        });
        expect(applied.ok).toBe(true);
      }
      if (!completed) throw new Error('fixture cash sim did not terminate');
      return completed as HandResult;
    };

    for (const handNumber of [1, 10, 25, 100]) {
      const showdown = replayCash('holdem-multiway-showdown', handNumber);
      expect(showdown.endedAt).toBe('showdown');
      expect(showdown.perSeat.filter((seat) => seat.holeCards !== null)).toHaveLength(3);
    }

    const foldWin = replayCash('holdem-fold-win');
    expect(foldWin.endedAt).toBe('preflop');
    expect(foldWin.perSeat.find((seat) => seat.seatIndex === 0)?.isWinner).toBe(true);
    expect(foldWin.perSeat.filter((seat) => seat.holeCards !== null)).toHaveLength(0);
  });
});
