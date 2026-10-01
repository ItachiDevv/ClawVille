import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Extract this pure helper without importing the renderer and its DOM mocks
// into Bun's shared test process.
const interiorSource = readFileSync(new URL('../../../lib/three/trading-floor/trading-floor-interior.tsx', import.meta.url), 'utf8');
const interiorFile = ts.createSourceFile('interior.tsx', interiorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const gateDeclaration = interiorFile.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'createTradingFloorReadyGate',
);
if (!gateDeclaration) throw new Error('Trading Floor ready gate is missing');
const gateJs = ts.transpileModule(
  gateDeclaration.getText(interiorFile).replace(/^export\s+/, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const createTradingFloorReadyGate = new Function(
  `${gateJs}\nreturn createTradingFloorReadyGate;`,
)() as typeof import('../../../lib/three/trading-floor/trading-floor-interior').createTradingFloorReadyGate;

test('avatar warm effect uses the stable store getter and visible wrappers', () => {
  const hook = interiorFile.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'useTradingFloorAvatarWarm',
  );
  if (!hook?.body) throw new Error('Trading Floor avatar warm hook is missing');
  const effect = hook.body.statements.find(
    (node): node is ts.ExpressionStatement =>
      ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(interiorFile) === 'useLayoutEffect',
  );
  if (!effect || !ts.isCallExpression(effect.expression)) {
    throw new Error('Trading Floor avatar layout effect is missing');
  }
  const dependencies = effect.expression.arguments[1];
  if (!dependencies || !ts.isArrayLiteralExpression(dependencies)) {
    throw new Error('Trading Floor avatar layout effect dependencies are missing');
  }
  expect(hook.getText(interiorFile)).toContain('useThree((state) => state.get)');
  expect(hook.getText(interiorFile)).toContain('const { gl, camera, scene } = get();');
  const dependencyNames = dependencies.elements.map((node) => node.getText(interiorFile));
  expect(dependencyNames).toContain('get');
  expect(dependencyNames).not.toContain('camera');
  expect(dependencyNames).not.toContain('gl');
  expect(dependencyNames).not.toContain('scene');

  const wrappers = [...interiorSource.matchAll(/<group ref=\{warmWrapperRef\}([^>]*)>/g)];
  expect(wrappers).toHaveLength(2);
  for (const wrapper of wrappers) {
    expect(wrapper[1]).not.toMatch(/visible=\{false\}/);
  }
});

function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  return {
    schedule: ((run: () => void, delay: number) => {
      const id = ++nextId;
      jobs.set(id, { at: now + delay, run });
      return id;
    }) as unknown as typeof setTimeout,
    cancel: ((id: number) => jobs.delete(id)) as unknown as typeof clearTimeout,
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...jobs].sort((a, b) => a[1].at - b[1].at)
          .find(([, job]) => job.at <= end);
        if (!due) break;
        now = due[1].at;
        jobs.delete(due[0]);
        due[1].run();
      }
      now = end;
    },
    pending: () => jobs.size,
  };
}

describe('Trading Floor ready gate', () => {
  test('room then avatar fires once at avatar mount', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.roomMounted();
    expect(count).toBe(0);
    expect(gate.avatarMounted()).toBe(false);
    expect(count).toBe(1);
    timers.advance(1500);
    expect(count).toBe(1);
  });

  test('missing avatar fires once after 1500 ms', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.roomMounted();
    timers.advance(1499);
    expect(count).toBe(0);
    timers.advance(1);
    expect(count).toBe(1);
    expect(gate.avatarMounted()).toBe(true);
    expect(count).toBe(1);
  });

  test('avatar before room fires at room mount', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.avatarMounted();
    expect(count).toBe(0);
    gate.roomMounted();
    expect(count).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  test('unmount cancels the timer and a new mount generation works', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.roomMounted();
    gate.roomUnmounted();
    timers.advance(1500);
    expect(count).toBe(0);
    expect(timers.pending()).toBe(0);
    gate.roomMounted();
    gate.avatarMounted();
    expect(count).toBe(1);
  });

  test('room remount fires immediately while the avatar remains mounted', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.avatarMounted();
    gate.roomMounted();
    expect(count).toBe(1);
    gate.roomUnmounted();
    gate.roomMounted();
    expect(count).toBe(2);
    expect(timers.pending()).toBe(0);
  });

  test('avatar unmount leaves the next room mount on its own fallback', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.avatarMounted();
    gate.roomMounted();
    gate.avatarUnmounted();
    gate.roomUnmounted();
    gate.roomMounted();
    expect(count).toBe(1);
    timers.advance(1499);
    expect(count).toBe(1);
    timers.advance(1);
    expect(count).toBe(2);
  });

  test('fallback does not mark a missing avatar as mounted for the next room', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.roomMounted();
    timers.advance(1500);
    expect(count).toBe(1);
    gate.roomUnmounted();
    gate.roomMounted();
    expect(count).toBe(1);
    timers.advance(1500);
    expect(count).toBe(2);
  });

  test('duplicate notifications and rerenders never double fire', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, true, timers.schedule, timers.cancel);
    gate.roomMounted();
    gate.roomMounted();
    gate.avatarMounted();
    gate.avatarMounted();
    timers.advance(2000);
    expect(count).toBe(1);
  });

  test('no-avatar mode fires with the room', () => {
    const timers = fakeTimers();
    let count = 0;
    const gate = createTradingFloorReadyGate(() => count++, false, timers.schedule, timers.cancel);
    gate.roomMounted();
    expect(count).toBe(1);
    expect(timers.pending()).toBe(0);
  });
});

test('late avatar compile uses the renderer FIFO and frame callbacks allocate no objects', () => {
  const source = interiorSource;
  const compileSource = readFileSync(new URL('../../../lib/three/boot-core-compile.ts', import.meta.url), 'utf8');
  expect(source).toContain('chainPostBootCompile({');
  expect(compileSource).toMatch(/function chainPostBootCompile[\s\S]*?chainBootCompile</);
  expect(source).toContain('compileAsync(root, camera, scene)');
  const warmHook = source.slice(
    source.indexOf('function useTradingFloorAvatarWarm('),
    source.indexOf('function TradingFloorVRMPlayer('),
  );
  expect(warmHook.indexOf('wrapper.visible = false;')).toBeGreaterThan(-1);
  expect(warmHook.indexOf('wrapper.visible = false;')).toBeLessThan(
    warmHook.indexOf('chainPostBootCompile({'),
  );
  expect(warmHook).toContain('withStageSlotFrustumCullingDisabledSync');
  const file = ts.createSourceFile('interior.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ['useFrame', 'useSceneFrame'].includes(node.expression.text)) {
      expect(node.getText(file)).not.toMatch(/\bnew\s+/);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
});

// The helper is pure. Keep stage React and DOM setup out of Bun's shared test
// process, which also runs unrelated stage tests with their own JSDOM.
const stageSource = readFileSync(new URL('./StageHostedTradingFloorScene.tsx', import.meta.url), 'utf8');
const stageFile = ts.createSourceFile('stage.tsx', stageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const drainDeclaration = stageFile.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'waitForTradingFloorGpuDrain',
);
if (!drainDeclaration) throw new Error('Trading Floor GPU drain is missing');
const drainJs = ts.transpileModule(
  drainDeclaration.getText(stageFile).replace(/^export\s+/, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const waitForTradingFloorGpuDrain = new Function(
  `${drainJs}\nreturn waitForTradingFloorGpuDrain;`,
)() as typeof import('./StageHostedTradingFloorScene').waitForTradingFloorGpuDrain;

describe('Trading Floor GPU drain', () => {
  test('default timers wait for WebGPU work and a WebGL fence in browsers', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Reflect.apply(realSetTimeout, globalThis, args);
    } as typeof setTimeout;
    globalThis.clearTimeout = function (this: unknown, ...args: Parameters<typeof clearTimeout>) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Reflect.apply(realClearTimeout, globalThis, args);
    } as typeof clearTimeout;

    try {
      let gpuSettled = false;
      let submitted = 0;
      const work = new Promise<void>((resolve) => realSetTimeout(resolve, 40));
      const gpuWait = waitForTradingFloorGpuDrain({
        backend: { device: { queue: { onSubmittedWorkDone: () => { submitted++; return work; } } } },
      }).then(() => { gpuSettled = true; });
      await Promise.resolve();
      expect(submitted).toBe(1);
      expect(gpuSettled).toBe(false);
      await gpuWait;
      expect(gpuSettled).toBe(true);

      let polls = 0;
      let deleted = 0;
      let glSettled = false;
      const sync = {};
      const glWait = waitForTradingFloorGpuDrain({ backend: { gl: {
        SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, SIGNALED: 3,
        fenceSync: () => sync,
        flush: () => undefined,
        getSyncParameter: () => ++polls === 3 ? 3 : 0,
        deleteSync: () => { deleted++; },
      } } }).then(() => { glSettled = true; });
      await Promise.resolve();
      expect(polls).toBe(1);
      expect(glSettled).toBe(false);
      await glWait;
      expect(polls).toBe(3);
      expect(deleted).toBe(1);
      expect(glSettled).toBe(true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('WebGPU waits for submitted work', async () => {
    const timers = fakeTimers();
    let finish!: () => void;
    let settled = false;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const wait = waitForTradingFloorGpuDrain({
      backend: { device: { queue: { onSubmittedWorkDone: () => work } } },
    }, 3000, timers).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await wait;
    expect(settled).toBe(true);
    expect(timers.pending()).toBe(0);
  });

  test('WebGL polls its fence until signaled and deletes it', async () => {
    const timers = fakeTimers();
    let polls = 0;
    let flushed = 0;
    let deleted = 0;
    const sync = {};
    const wait = waitForTradingFloorGpuDrain({ backend: { gl: {
      SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, SIGNALED: 3,
      fenceSync: () => sync,
      flush: () => { flushed++; },
      getSyncParameter: () => ++polls === 3 ? 3 : 0,
      deleteSync: (value: unknown) => { expect(value).toBe(sync); deleted++; },
    } } }, 3000, timers);
    expect(flushed).toBe(1);
    expect(polls).toBe(1);
    timers.advance(32);
    await wait;
    expect(polls).toBe(3);
    expect(deleted).toBe(1);
    expect(timers.pending()).toBe(0);
  });

  test('both backends time out and continue', async () => {
    const gpuTimers = fakeTimers();
    const gpuWait = waitForTradingFloorGpuDrain({
      backend: { device: { queue: { onSubmittedWorkDone: () => new Promise<void>(() => {}) } } },
    }, 30, gpuTimers);
    gpuTimers.advance(30);
    await gpuWait;

    const glTimers = fakeTimers();
    let deleted = 0;
    const glWait = waitForTradingFloorGpuDrain({ backend: { gl: {
      SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, SIGNALED: 3,
      fenceSync: () => ({}), flush: () => undefined,
      getSyncParameter: () => 0,
      deleteSync: () => { deleted++; },
    } } }, 30, glTimers);
    glTimers.advance(30);
    await glWait;
    expect(deleted).toBe(1);
    expect(glTimers.pending()).toBe(0);
  });

  test('missing or throwing APIs never block', async () => {
    await waitForTradingFloorGpuDrain({});
    await waitForTradingFloorGpuDrain({ backend: { gl: {
      fenceSync: () => { throw new Error('lost context'); },
    } } });
    await waitForTradingFloorGpuDrain({ backend: { device: { queue: {
      onSubmittedWorkDone: () => { throw new Error('lost device'); },
    } } } });
  });
});




