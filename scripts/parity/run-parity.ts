import { mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertParityCheckpoint } from './assertion-engine';
import {
  AgentBrowserDriver,
  readCapturedWire,
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
import { resolveWireForRoot } from './wire-correlation';
import { resolveScenarioState } from './runner-env';

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

async function emitEmptyMatrix(): Promise<boolean> {
  const matrix = emitMatrix(SCENARIO_CATALOG);
  const path = value('--matrix') ?? 'scripts/parity/out/matrix.md';
  await writeTextReport(path, matrix.markdown);
  console.log(matrix.markdown.trimEnd());
  return matrix.pass;
}

async function existingResults(): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const names = await readdir('scripts/parity/out/results').catch(() => []);
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
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
  const driver = new AgentBrowserDriver(`cove-parity-${scenario.id}`, statePath);
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
    await scenario.teardown(driver, config.apiBase).catch((error: unknown) => {
      errors.push(`game: ${String(error)}`);
    });
    await closeFixtureRun(driver, fixture, config.apiBase).catch((error: unknown) => {
      errors.push(`fixture: ${String(error)}`);
    });
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
    await driver.evalJson(`(() => { location.assign(${JSON.stringify(path)}); return true; })()`);
    const pathname = new URL(path, config.webBase).pathname;
    await driver.waitFn(`location.pathname === ${JSON.stringify(pathname)}`, 30_000);
    if (releaseFixtureGate) {
      await driver.evalJson(
        `(() => { window.__CV_RELEASE_FIXTURE_GATE?.(); return true; })()`,
      );
    }
  };
  try {
    await driver.openWithInitScript(
      `${config.webBase}/cove`,
      'scripts/parity/capture-hook.js',
    );
    await driver.evalJson(
      `(() => { window.__CV_RELEASE_FIXTURE_GATE?.(); return true; })()`,
    );
    await driver.setViewport(config.viewport[0], config.viewport[1]);
    // Authenticated fixture owners can carry a hard-death run even into an
    // organic (fixtureName-less) row. Probe every stateful owner before the
    // ordinary game preflight by creating and immediately deleting a
    // no-resource run; a 409 takes the same page-memory-only recovery path.
    if (statePath) {
      const probeScenario = scenario.fixtureName
        ?? (scenario.game === 'blackjack'
          ? 'bj-natural'
          : scenario.game === 'baccarat'
            ? 'bac-tie'
            : 'holdem-fold-win');
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
    if (!clean.clean || (scenario.game === 'holdem' && scenario.tier === 'live')) {
      await navigate(route);
      clean = await preflight(driver, scenario.game, config.apiBase);
      await navigate('/cove');
    }
    if (!clean.clean) {
      throw new Error(`preflight refused: ${clean.notes.join('; ')}`);
    }
    await navigate(route, !scenario.fixtureName);
    if (scenario.fixtureName) {
      fixture = await issueFixtureWithRecovery(
        driver,
        scenario.fixtureName,
        config,
        cashTableId,
      );
    }

    const previous = new Map<string, number>();
    for await (const checkpoint of scenario.run(driver)) {
      const after = previous.get(checkpoint.surface) ?? 0;
      const root = await waitForParityCheckpoint(
        driver,
        checkpoint,
        after,
        config.maxDurationMs,
      );
      previous.set(checkpoint.surface, root.renderRevision);
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
      const result = assertParityCheckpoint({
        game: scenario.game,
        checkpoint,
        root,
        records: allWires,
        previousRevision: after,
        ba1Snapshot,
      });
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
      const wire = resolveWireForRoot(root, allWires);
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
    const finalWire = finalRoot ? resolveWireForRoot(finalRoot, allWires) : null;
    const reached = Boolean(finalWire && scenario.reachedPredicate(finalWire.responseBody));
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
    const resultPath = resolve(
      'scripts/parity/out/results',
      `${scenario.id}.json`,
    );
    await writeJsonReport(resultPath, result);
    const results = (await existingResults())
      .filter((candidate) => candidate.scenario !== scenario.id);
    results.push(result);
    const matrix = emitMatrix(SCENARIO_CATALOG, results);
    await writeTextReport('scripts/parity/out/matrix.md', matrix.markdown);
    console.log(JSON.stringify(result, null, 2));
    console.log(matrix.markdown.trimEnd());
    if (!pass || !matrix.pass) process.exitCode = 1;
  } finally {
    await cleanup();
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
    const pass = await emitEmptyMatrix();
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
