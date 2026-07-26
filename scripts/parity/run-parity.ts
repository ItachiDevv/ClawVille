import { mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertParityCheckpoint } from './assertion-engine';
import {
  AgentBrowserDriver,
  readCapturedWire,
  readParityRoot,
  waitForParityCheckpoint,
} from './driver';
import { RECORDED_CASES } from './fixtures/recorded';
import { emitMatrix } from './matrix';
import {
  issueFixtureWithRecovery,
  preflightFixtureOwnerRecovery,
} from './fixture-recovery';
import { assertMoneyFromWire } from './money';
import { preflight } from './preflight';
import { writeJsonReport, writeTextReport } from './report';
import { SCENARIO_CATALOG } from './scenarios';
import { runHarnessSelfTest } from './self-test';
import { closeFixtureRun, type FixtureRunHandle } from './teardown';
import type { ScenarioResult } from './types';
import { assertVisibleSurface } from './visible-surface';
import {
  explainWireCorrelation,
  resolveWireForCheckpoint,
  resolveWireForReachedPredicate,
  resolveWireForRoot,
} from './wire-correlation';
import {
  fixtureTeardownRunsFirst,
  requiresGuestShoeReset,
  requiresFixtureOwnerPreflight,
  resolveScenarioState,
} from './runner-env';
import { resetGuestShoes } from './reset-guest-shoes';
import {
  DEFAULT_CASH_TABLE_STATE_PATH,
  readPersistedCashTableState,
} from './pack-cash-table-state';

interface Config {
  webBase: string;
  apiBase: string;
  viewport: [number, number];
  maxLossPerRun: number;
  maxDurationMs: number;
  screenshotDir: string;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadConfig(): Promise<Config> {
  const raw = JSON.parse(
    await readFile(resolve('scripts/parity/parity.config.json'), 'utf8'),
  ) as Config;
  return {
    ...raw,
    webBase: process.env.CV_PARITY_WEB_BASE ?? raw.webBase,
    apiBase: process.env.CV_PARITY_API_BASE ?? raw.apiBase,
    screenshotDir:
      process.env.CV_PARITY_SCREENSHOT_DIR ?? raw.screenshotDir,
  };
}

function runRecordedCases(): { pass: boolean; output: string } {
  const output: string[] = [];
  let pass = true;
  for (const recorded of RECORDED_CASES) {
    const result = assertParityCheckpoint({
      game: recorded.game,
      checkpoint: {
        label: recorded.id,
        surface: recorded.root.surface,
        expectRevisionAdvance: true,
        expectDealStep: recorded.expectedDealStep,
        expectCorrelationHand: recorded.root.correlation.hand,
        final: recorded.final,
      },
      root: recorded.root,
      records: recorded.records,
    });
    output.push(`RECORDED ${recorded.id}: ${result.pass ? 'PASS' : 'FAIL'}`);
    if (!result.pass) {
      pass = false;
      for (const mismatch of result.mismatches) {
        output.push(
          `  ${mismatch.slot}.${mismatch.field}: expected=${mismatch.expected} actual=${mismatch.actual}`,
        );
      }
    }
  }
  return { pass, output: output.join('\n') };
}

async function emitExistingMatrix(): Promise<boolean> {
  const results = await existingResults();
  const matrix = emitMatrix(SCENARIO_CATALOG, results);
  const path = value('--matrix') ?? 'scripts/parity/out/matrix.md';
  await writeTextReport(path, matrix.markdown);
  console.log(matrix.markdown.trimEnd());
  return matrix.pass;
}

async function existingResults(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const names = await readdir('scripts/parity/out/results').catch(() => []);
  for (const name of names.filter(
    (candidate) => candidate.endsWith('.json')
      && !candidate.includes('.attempt-'),
  )) {
    try {
      results.push(JSON.parse(
        await readFile(resolve('scripts/parity/out/results', name), 'utf8'),
      ) as ScenarioResult);
    } catch {
      // A partial/crash artifact is not a proof and is intentionally ignored.
    }
  }
  return results;
}

async function protectedResultPath(
  scenarioId: string,
  result: ScenarioResult,
): Promise<string> {
  const canonical = resolve(
    'scripts/parity/out/results',
    `${scenarioId}.json`,
  );
  if (result.status === 'PASS') return canonical;
  try {
    const existing = JSON.parse(
      await readFile(canonical, 'utf8'),
    ) as ScenarioResult;
    if (existing.status === 'PASS') {
      return resolve(
        'scripts/parity/out/results',
        `${scenarioId}.attempt-${Date.now()}.json`,
      );
    }
  } catch {
    // Missing, partial, or legacy evidence cannot protect the canonical path.
  }
  return canonical;
}

async function runLiveScenario(): Promise<void> {
  const scenarioId = value('--scenario');
  if (!scenarioId) {
    throw new Error('--live requires one exact --scenario id from the catalog');
  }
  const scenario = SCENARIO_CATALOG.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);
  if (scenario.blockedReason) {
    throw new Error(`${scenario.id} is BLOCKED: ${scenario.blockedReason}`);
  }
  const config = await loadConfig();
  const { statePath, cashTableId } = resolveScenarioState(scenario);
  const persistedCashTable =
    scenario.game === 'holdem' && scenario.tier === 'live'
      ? await readPersistedCashTableState(
          process.env.CV_PARITY_CASH_TABLE_STATE
            ?? DEFAULT_CASH_TABLE_STATE_PATH,
        )
      : null;
  const cashTableJoinCode =
    process.env.CV_PARITY_CASH_TABLE_JOIN_CODE
      ?? (
        persistedCashTable?.tableId === cashTableId
          ? persistedCashTable.joinCode
          : null
      );
  if (requiresGuestShoeReset(scenario)) {
    const reset = await resetGuestShoes();
    console.log(
      `[row ${scenario.id}] guest shoes reset before fixture arm `
        + `(blackjack=${reset.blackjack}, baccarat=${reset.baccarat})`,
    );
  }
  // Unique per-run session: a crashed prior attempt leaves a wedged daemon
  // squatting the session name, and the next open() hangs on it forever.
  const driver = new AgentBrowserDriver(
    `cove-parity-${scenario.id}-${Date.now().toString(36)}`,
    statePath,
  );
  const route = `${
      scenario.game === 'blackjack'
        ? '/cove/blackjack'
        : scenario.game === 'baccarat'
          ? '/cove/baccarat'
          : `/cove/table${cashTableId
            ? `?tableId=${encodeURIComponent(cashTableId)}`
            : ''}`
    }`;
  let fixture: FixtureRunHandle | null = null;
  let cleaning = false;
  const cleanup = async (): Promise<void> => {
    if (cleaning) return;
    cleaning = true;
    const errors: string[] = [];
    if (fixtureTeardownRunsFirst(scenario)) {
      // DELETE closes and reveals every fixture-linked shoe/practice table in
      // one server transaction. Running the ordinary UI close first replaces
      // the document and destroys the page-local show-once credential.
      await closeFixtureRun(driver, fixture, config.apiBase).catch((error: unknown) => {
        errors.push(`fixture: ${String(error)}`);
      });
    } else {
      await scenario.teardown(driver, config.apiBase).catch((error: unknown) => {
        errors.push(`game: ${String(error)}`);
      });
      await closeFixtureRun(driver, fixture, config.apiBase).catch((error: unknown) => {
        errors.push(`fixture: ${String(error)}`);
      });
    }
    await driver.close().catch((error: unknown) => {
      errors.push(`browser: ${String(error)}`);
    });
    if (errors.length > 0) throw new Error(`teardown failed: ${errors.join('; ')}`);
  };
  const signal = (name: string) => {
    void cleanup().finally(() => {
      console.error(`${name}: parity teardown completed`);
      process.exit(130);
    });
  };
  process.once('SIGINT', () => signal('SIGINT'));
  process.once('SIGTERM', () => signal('SIGTERM'));

  const checkpoints: ScenarioResult['checkpoints'] = [];
  const screenshots: string[] = [];
  let finalRoot = null as Awaited<ReturnType<typeof waitForParityCheckpoint>> | null;
  let allWires = [] as Awaited<ReturnType<typeof readCapturedWire>>;
  const visibleSurface: ScenarioResult['visibleSurface'] = {};
  const moneyAssertions: ScenarioResult['money'][] = [];
  let ba1Snapshot: unknown;
  const navigate = async (
    path: string,
    releaseFixtureGate = true,
  ): Promise<void> => {
    const previousDocumentId = await driver.evalJson<string | null>(
      `window.__CV_CAPTURE_DOCUMENT_ID ?? null`,
    );
    await driver.evalJson(`(() => { location.assign(${JSON.stringify(path)}); return true; })()`);
    const pathname = new URL(path, config.webBase).pathname;
    await driver.waitFn(`(
      location.pathname === ${JSON.stringify(pathname)}
      && typeof window.__CV_CAPTURE_DOCUMENT_ID === 'string'
      && window.__CV_CAPTURE_DOCUMENT_ID !== ${JSON.stringify(previousDocumentId)}
    )`, 30_000);
    if (releaseFixtureGate) {
      await driver.evalJson(
        `(() => { window.__CV_RELEASE_FIXTURE_GATE?.(); return true; })()`,
      );
    }
  };
  let primaryError: unknown = null;
  try {
    console.log(`[row ${scenario.id}] opening ${config.webBase}/cove`);
    await driver.openWithInitScript(
      `${config.webBase}/cove`,
      'scripts/parity/capture-hook.js',
    );
    await driver.evalJson(
      `(() => { window.__CV_RELEASE_FIXTURE_GATE?.(); return true; })()`,
    );
    await driver.setViewport(config.viewport[0], config.viewport[1]);
    console.log(`[row ${scenario.id}] page open, viewport set`);
    // Fixture-owner recovery exercises the fixture issue API and therefore
    // belongs only to fixture-backed rows. Organic live rows reconcile their
    // actual game resource through the ordinary preflight below; coupling
    // them to fixture schema availability stalls real-vCLAW certification
    // before the game route is reached.
    if (statePath && requiresFixtureOwnerPreflight(scenario)) {
      const probeScenario = scenario.fixtureName;
      await preflightFixtureOwnerRecovery(
        driver,
        probeScenario,
        config,
        cashTableId,
      );
    }
    // Reconcile on the actual game UI only when the neutral preflight finds
    // state. This preserves the fixture-before-seed-arm ordering.
    let clean = await preflight(driver, scenario.game, config.apiBase);
    if (
      !clean.clean
      || (
        scenario.game === 'holdem'
        && (
          scenario.tier === 'live'
          || (scenario.tier === 'guest' && Boolean(scenario.fixtureName))
        )
      )
    ) {
      // A fixture-backed route may have an eager seed arm queued while its
      // stale resource is reconciled. Keep that arm gated in this disposable
      // document; navigating away cancels it. The final route document is
      // released only after the new fixture run has been issued.
      await navigate(route, !scenario.fixtureName);
      if (scenario.game === 'holdem' && scenario.tier === 'guest') {
        await driver.waitFn(
          `typeof window.__CV_REQUEST_FINGERPRINT === 'string'
            && window.__CV_REQUEST_FINGERPRINT.length > 0`,
          30_000,
        );
      }
      clean = await preflight(driver, scenario.game, config.apiBase);
      await navigate('/cove');
    }
    if (!clean.clean) {
      throw new Error(`preflight refused: ${clean.notes.join('; ')}`);
    }
    if (
      scenario.game === 'holdem'
      && scenario.tier === 'live'
      && cashTableId
      && cashTableJoinCode
    ) {
      const seat = await driver.evalJson<{
        status: number;
        tableId: string | null;
      }>(`(async () => {
        const response = await fetch(
          ${JSON.stringify(config.apiBase.replace(/\/$/, ''))}
            + '/api/cove/poker/cash/tables/join-by-code',
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              joinCode: ${JSON.stringify(cashTableJoinCode)},
            }),
          },
        );
        const body = await response.json().catch(() => null);
        return {
          status: response.status,
          tableId:
            typeof body?.tableId === 'string' ? body.tableId : null,
        };
      })()`);
      if (
        ![200, 201].includes(seat.status)
        || seat.tableId !== cashTableId
      ) {
        throw new Error(
          `live holdem exact-seat open failed with HTTP ${seat.status}`,
        );
      }
      console.log(
        `[row ${scenario.id}] live cash seat opened for exact table`,
      );
    }
    console.log(`[row ${scenario.id}] preflight clean, navigating ${route}`);
    await navigate(route, !scenario.fixtureName);
    if (scenario.fixtureName) {
      fixture = await issueFixtureWithRecovery(
        driver,
        scenario.fixtureName,
        config,
        cashTableId,
      );
      console.log(`[row ${scenario.id}] fixture ${scenario.fixtureName} issued (${fixture.runId})`);
    }

    const previous = new Map<string, number>();
    const previousSettlementCorrelation = new Map<string, string>();
    for await (const checkpoint of scenario.run(driver)) {
      const after = previous.get(checkpoint.surface) ?? 0;
      const preferCurrentRoot = async (
        candidate: Awaited<ReturnType<typeof waitForParityCheckpoint>>,
      ): Promise<Awaited<ReturnType<typeof waitForParityCheckpoint>>> => {
        if (checkpoint.label.startsWith('every-')) return candidate;
        const current = await readParityRoot(driver, checkpoint.surface);
        if (
          current
          && current.renderRevision > after
          && (
            checkpoint.expectDealStep === undefined
            || current.dealStep === checkpoint.expectDealStep
          )
          && (
            checkpoint.expectTransition === undefined
            || current.transition === checkpoint.expectTransition
          )
          && (
            checkpoint.expectCorrelationHand === undefined
            || current.correlation.hand === checkpoint.expectCorrelationHand
          )
          && (!checkpoint.final || current.transition === 'idle')
        ) {
          return current;
        }
        return candidate;
      };
      const captureCurrentCashWitness = async (
        candidate: Awaited<ReturnType<typeof waitForParityCheckpoint>>,
      ): Promise<void> => {
        if (
          scenario.game !== 'holdem'
          || scenario.tier !== 'live'
          || candidate.dealStep === 'showdown'
          || candidate.correlation.handNumber === null
        ) {
          return;
        }
        const separator = candidate.correlation.hand.lastIndexOf(':');
        const tableId = separator > 0
          ? candidate.correlation.hand.slice(0, separator)
          : '';
        if (!tableId) return;
        await driver.evalJson<number>(`(async () => {
          const response = await fetch(
            ${JSON.stringify(config.apiBase.replace(/\/$/, ''))}
              + '/api/cove/poker/cash/tables/'
              + ${JSON.stringify(tableId)}
              + '/state-for-agent',
            { credentials: 'include' },
          );
          return response.status;
        })()`);
      };
      console.log(`[row ${scenario.id}] awaiting checkpoint ${checkpoint.label} on ${checkpoint.surface} (after r${after})`);
      let root;
      try {
        root = await waitForParityCheckpoint(
          driver,
          checkpoint,
          after,
          config.maxDurationMs,
        );
      } catch (error) {
        const journalTail = await driver.evalJson<Array<{
          revision: number;
          dealStep: string;
          transition: string;
          correlationHand: string | null;
        }>>(`(() => (
          (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(checkpoint.surface)}) ?? [])
            .slice(-12)
            .map((entry) => {
              let correlationHand = null;
              try { correlationHand = JSON.parse(entry.signature)[2] ?? null; }
              catch {}
              return {
                revision: entry.revision,
                dealStep: entry.dealStep,
                transition: entry.transition,
                correlationHand,
              };
            })
        ))()`).catch(() => []);
        throw new Error(
          `checkpoint ${checkpoint.label} wait failed: ${String(error)}; journalTail=${
            JSON.stringify(journalTail)
          }`,
        );
      }
      root = await preferCurrentRoot(root);
      await captureCurrentCashWitness(root);
      if (scenario.row === 'H10') {
        const tableId = root.correlation.hand.slice(
          0,
          root.correlation.hand.lastIndexOf(':'),
        );
        const after = Math.max(0, (root.correlation.handNumber ?? 1) - 1);
        ba1Snapshot = await driver.evalJson(`(async () => {
          const response = await fetch(
            ${JSON.stringify(config.apiBase.replace(/\/$/, ''))}
              + '/api/cove/poker/cash/tables/' + ${JSON.stringify(tableId)}
              + '/last-settled?afterHandNumber=' + ${after}
            , { credentials: 'include' }
          );
          if (!response.ok) throw new Error('BA-1 fetch failed: ' + response.status);
          const body = await response.json();
          return body.snapshot ?? body;
        })()`);
      }
      allWires = await readCapturedWire(driver);
      const priorSettlement = scenario.game === 'baccarat'
        && checkpoint.expectDealStep === 'settled'
        ? previousSettlementCorrelation.get(checkpoint.surface) ?? null
        : null;
      const correlationDeadline = Date.now() + config.maxDurationMs;
      while (
        priorSettlement !== null
        && Date.now() < correlationDeadline
        && resolveWireForCheckpoint(root, allWires, priorSettlement) === null
        && root.correlation.hand === priorSettlement
      ) {
        console.log(`[row ${scenario.id}] checkpoint ${checkpoint.label} r${root.renderRevision} retained prior correlation ${priorSettlement} — awaiting current coup`);
        root = await waitForParityCheckpoint(
          driver,
          checkpoint,
          root.renderRevision,
          Math.max(2_000, correlationDeadline - Date.now()),
        );
        allWires = await readCapturedWire(driver);
      }
      if (
        priorSettlement !== null
        && root.correlation.hand === priorSettlement
      ) {
        throw new Error(
          `checkpoint ${checkpoint.label} retained prior settlement correlation ${priorSettlement} for ${config.maxDurationMs}ms`,
        );
      }
      let result = assertParityCheckpoint({
        game: scenario.game,
        checkpoint,
        root,
        records: allWires,
        previousRevision: after,
        ba1Snapshot,
      });
      // Eventual-consistency window: a pre-existing intermediate revision
      // (e.g. the hole→player-turn transition published before an action's
      // response lands) can satisfy "newer than the last checkpoint" while the
      // matching revision is still milliseconds away. Re-assert on strictly
      // newer revisions until the state matches or the window closes — the
      // parity claim is that the render REACHES wire truth, and a final
      // mismatch still fails loudly.
      const settleDeadline = Date.now() + 45_000;
      while (!result.pass && Date.now() < settleDeadline) {
        const transientWire = result.resolvedWireSeq === null
          ? null
          : allWires.find(
            (candidate) => candidate.seq === result.resolvedWireSeq,
          ) ?? null;
        console.log(
          `[row ${scenario.id}] checkpoint ${checkpoint.label} r${root.renderRevision} transient wire=${
            transientWire
              ? `${transientWire.seq}:${transientWire.urlSuffix}`
              : '<none>'
          } detail=${JSON.stringify(result.mismatches ?? []).slice(0, 400)}`,
        );
        console.log(`[row ${scenario.id}] checkpoint ${checkpoint.label} r${root.renderRevision} transient mismatch — awaiting newer revision`);
        // The mirror can publish from application state just before the
        // capture hook appends the matching fetch record. Re-check the same
        // immutable journal root during a short wire-only grace window; a
        // render revision is not expected merely because capture completed.
        for (
          let wireAttempt = 0;
          wireAttempt < 8 && !result.pass && Date.now() < settleDeadline;
          wireAttempt += 1
        ) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
          allWires = await readCapturedWire(driver);
          result = assertParityCheckpoint({
            game: scenario.game,
            checkpoint,
            root,
            records: allWires,
            previousRevision: after,
            ba1Snapshot,
          });
        }
        if (result.pass) break;
        if (checkpoint.label.startsWith('every-')) break;
        try {
          root = await waitForParityCheckpoint(
            driver,
            checkpoint,
            root.renderRevision,
            Math.max(2_000, settleDeadline - Date.now()),
          );
          root = await preferCurrentRoot(root);
          await captureCurrentCashWitness(root);
        } catch {
          break;
        }
        allWires = await readCapturedWire(driver);
        result = assertParityCheckpoint({
          game: scenario.game,
          checkpoint,
          root,
          records: allWires,
          previousRevision: after,
          ba1Snapshot,
        });
      }
      previous.set(checkpoint.surface, root.renderRevision);
      const screenshot = resolve(
        config.screenshotDir,
        `${scenario.id}-${checkpoint.label}-r${root.renderRevision}.png`,
      );
      await mkdir(resolve(config.screenshotDir), { recursive: true });
      await driver.screenshot(screenshot);
      result.screenshot = screenshot;
      checkpoints.push(result);
      screenshots.push(screenshot);
      finalRoot = root;
      if (
        scenario.game === 'baccarat'
        && checkpoint.expectDealStep === 'settled'
      ) {
        previousSettlementCorrelation.set(
          checkpoint.surface,
          root.correlation.hand,
        );
      }
      if (
        scenario.game === 'holdem'
        && result.resolvedWireSeq === null
      ) {
        const candidates = allWires
          .filter((record) =>
            record.urlSuffix.includes('poker/cash/tables/')
          )
          .slice(-12)
          .map((record) => ({
            seq: record.seq,
            suffix: record.urlSuffix,
            status: record.status,
            handNumber: record.handNumber,
            correlation: explainWireCorrelation(root, record),
            responseKeys:
              record.responseBody
              && typeof record.responseBody === 'object'
              && !Array.isArray(record.responseBody)
                ? Object.keys(record.responseBody).slice(0, 8)
                : [],
          }));
        console.log(
          `[row ${scenario.id}] unresolved cash correlation=${JSON.stringify(
            root.correlation,
          )} candidates=${JSON.stringify(candidates)}`,
        );
      }
      console.log(`[row ${scenario.id}] checkpoint ${checkpoint.label} r${root.renderRevision} pass=${result.pass}${result.pass ? '' : ` mismatches=${JSON.stringify(result.mismatches ?? []).slice(0, 400)}`}`);
      const wire = result.resolvedWireSeq === null
        ? null
        : allWires.find(
          (candidate) => candidate.seq === result.resolvedWireSeq,
        ) ?? null;
      if (wire && ['settled', 'showdown'].includes(root.dealStep)) {
        const visible = await assertVisibleSurface(
          driver,
          scenario.game,
          root,
          wire,
          ba1Snapshot,
          allWires,
        );
        for (const [name, assertion] of Object.entries(visible)) {
          visibleSurface[`${checkpoint.label}:${name}`] = assertion;
        }
        moneyAssertions.push(assertMoneyFromWire(
          scenario.game,
          wire,
          allWires,
          ba1Snapshot,
        ));
      }
    }
    allWires = await readCapturedWire(driver);
    const finalWire = resolveWireForReachedPredicate(
      finalRoot,
      checkpoints,
      allWires,
    );
    const lastPassingCheckpoint = checkpoints
      .slice()
      .reverse()
      .find((checkpoint) => checkpoint.pass);
    const reached = lastPassingCheckpoint?.expectedResolvedWire === '<none>'
      || Boolean(finalWire && scenario.reachedPredicate(finalWire.responseBody));
    const money = moneyAssertions.length > 0
      ? {
          equation: moneyAssertions.map((assertion) => assertion.equation).join('; '),
          values: Object.assign(
            {},
            ...moneyAssertions.map((assertion, index) => Object.fromEntries(
              Object.entries(assertion.values).map(([key, value]) => [
                `${index + 1}:${key}`,
                value,
              ]),
            )),
          ),
          pass: moneyAssertions.every((assertion) => assertion.pass),
          ...(moneyAssertions.every((assertion) => assertion.pass)
            ? {}
            : {
                reason: moneyAssertions
                  .map((assertion) => assertion.reason)
                  .filter(Boolean)
                  .join('; '),
              }),
        }
      : {
          equation: 'not a settlement checkpoint',
          values: {},
          pass: true,
        };
    const visiblePass = Object.values(visibleSurface).every((probe) => probe.pass);
    const pass = reached
      && checkpoints.length > 0
      && checkpoints.every((checkpoint) => checkpoint.pass)
      && visiblePass
      && money.pass;
    const result: ScenarioResult = {
      scenario: scenario.id,
      game: scenario.game,
      tier: scenario.tier,
      surface: scenario.surface,
      required: scenario.required,
      reached,
      pass,
      status: reached ? (pass ? 'PASS' : 'FAIL') : 'UNPROVEN',
      phases: scenario.phases,
      checkpoints,
      visibleSurface,
      money,
      screenshots,
    };
    const resultPath = await protectedResultPath(scenario.id, result);
    await writeJsonReport(resultPath, result);
    const canonicalResultPath = resolve(
      'scripts/parity/out/results',
      `${scenario.id}.json`,
    );
    const results = await existingResults();
    if (resultPath === canonicalResultPath) {
      const previousIndex = results.findIndex(
        (candidate) => candidate.scenario === scenario.id,
      );
      if (previousIndex >= 0) {
        results.splice(previousIndex, 1, result);
      } else {
        results.push(result);
      }
    }
    const matrix = emitMatrix(SCENARIO_CATALOG, results);
    await writeTextReport('scripts/parity/out/matrix.md', matrix.markdown);
    console.log(JSON.stringify(result, null, 2));
    console.log(matrix.markdown.trimEnd());
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      // Never let a teardown failure REPLACE the primary error — that masks
      // the actual row failure (the exact bug this branch shipped with).
      if (primaryError) {
        console.error(`[row ${scenario.id}] cleanup also failed (non-masking; primary error follows): ${String(cleanupError)}`);
      } else {
        throw cleanupError;
      }
    }
  }
}

async function main(): Promise<void> {
  if (has('--self-test')) {
    const result = await runHarnessSelfTest();
    console.log(result.output);
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (has('--offline')) {
    const recorded = runRecordedCases();
    console.log(recorded.output);
    if (!recorded.pass) process.exitCode = 1;
    return;
  }
  if (has('--emit-matrix')) {
    const pass = await emitExistingMatrix();
    if (!pass) process.exitCode = 1;
    return;
  }
  if (has('--live')) {
    await runLiveScenario();
    return;
  }
  console.log(
    'Usage: bun scripts/parity/run-parity.ts --self-test|--offline|--emit-matrix [--matrix path]|--live --scenario id',
  );
}

await main();
