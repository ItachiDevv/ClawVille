import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { decideActivityReadiness } from '@/lib/three/activities/activity-readiness';
import { ActivitySceneErrorBoundary } from './ActivitySceneErrorBoundary';

const pageSource = readFileSync(
  resolve(
    import.meta.dir,
    '../../../app/(world)/activity/[activityId]/[roomId]/page.tsx',
  ),
  'utf8',
);
const stageCanvasSource = readFileSync(
  resolve(import.meta.dir, 'WorldStageCanvas.tsx'),
  'utf8',
);

let dom: JSDOM;
let container: HTMLDivElement;
let root: Root | null;
let originalError: typeof console.error;

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

afterAll(() => dom.window.close());

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  originalError = console.error;
  console.error = () => {};
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  console.error = originalError;
});

function Crash(): never {
  throw new Error('chunk rejected');
}

function renderBoundary(
  resetKey: string,
  onFailed: (branch: 'scene-chunk-error') => void = () => {},
  onReload: () => void = () => {},
  onTryAgain: () => void = () => {},
) {
  return createElement(
    ActivitySceneErrorBoundary,
    { resetKey, onFailed, onReload, onTryAgain },
    createElement(Crash),
  );
}

describe('ActivitySceneErrorBoundary', () => {
  test.each(['reef-race', 'bumper-shells'])(
    'a rejected %s chunk renders a room-tagged terminal panel',
    async (activityId) => {
      const roomKey = `${activityId}:ROOM`;
      const failures: Array<{ branch: string; roomKey: string }> = [];
      await act(async () => {
        root!.render(
          renderBoundary(`${roomKey}:0`, (branch) => {
            failures.push({ branch, roomKey });
          }),
        );
      });
      expect(container.getAttribute('role')).toBeNull();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(failures).toEqual([
        { branch: 'scene-chunk-error', roomKey },
      ]);
      expect(
        decideActivityReadiness({
          roomKey,
          targetRoomKey: roomKey,
          pendingGeneration: 3,
          recoveryCount: 0,
          attemptNonce: 0,
          paintedRoomKey: null,
          terminalBranch: 'scene-chunk-error',
          terminalRoomKey: roomKey,
          ackedKey: null,
        }).kind,
      ).toBe('ACK');
    },
  );

  test('same-attempt remount preserves the cached rejection contract', async () => {
    let catches = 0;
    const node = renderBoundary('reef-race:R:0', () => {
      catches += 1;
    });
    await act(async () => root!.render(node));
    await act(async () => root!.render(node));
    expect(catches).toBe(1);
    expect(container.textContent).toContain('failed to load');
  });

  test('Try again creates a fresh dynamic type and resets every readiness latch', () => {
    expect(pageSource).toContain('[activityId, sceneAttempt]');
    expect(pageSource).toMatch(
      /setSceneAttempt\(\(value\) => value \+ 1\);[\s\S]*?setAttemptNonce\(\(value\) => value \+ 1\);[\s\S]*?setPaintedRoomKey\(null\);[\s\S]*?setTerminalOverride\(null\)/,
    );
  });

  test('Reload is the primary action and Try again is secondary', async () => {
    const actions: string[] = [];
    await act(async () => {
      root!.render(
        renderBoundary(
          'reef-race:R:0',
          () => {},
          () => actions.push('reload'),
          () => actions.push('retry'),
        ),
      );
    });
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Reload',
      'Try again',
    ]);
    buttons[0]!.click();
    expect(actions).toEqual(['reload']);
  });

  test('Try again without a pending request waits behind the loading fallback', () => {
    const decision = decideActivityReadiness({
      roomKey: 'reef-race:R',
      targetRoomKey: 'reef-race:R',
      pendingGeneration: null,
      recoveryCount: 0,
      attemptNonce: 1,
      paintedRoomKey: null,
      terminalBranch: null,
      terminalRoomKey: null,
      ackedKey: null,
    });
    expect(decision).toMatchObject({
      kind: 'WAIT',
      reason: 'no-pending-request',
    });
    expect(pageSource).toContain('ENTERING ACTIVITY');
  });

  test('Try again with a pending generation waits for fresh canvas paint', () => {
    expect(
      decideActivityReadiness({
        roomKey: 'reef-race:R',
        targetRoomKey: 'reef-race:R',
        pendingGeneration: 4,
        recoveryCount: 0,
        attemptNonce: 1,
        paintedRoomKey: null,
        terminalBranch: null,
        terminalRoomKey: null,
        ackedKey: null,
      }),
    ).toMatchObject({ kind: 'WAIT', reason: 'not-painted' });
  });

  test('activity canvas context loss is prevented and tagged canvas-lost', () => {
    expect(pageSource).toMatch(
      /onContextLost = \(event: Event\) => \{\s*event\.preventDefault\(\);\s*setPaintedRoomKey\(null\);\s*setTerminalOverride\('canvas-lost'\)/,
    );
  });

  test('the context-loss listener uses the canvas published by onCanvas', () => {
    expect(pageSource).toContain('if (!canvasElement) return');
    expect(pageSource).toContain(
      "canvasElement.addEventListener('webglcontextlost', onContextLost)",
    );
    expect(pageSource).not.toContain("querySelector('canvas')");
  });

  test('stage canvas loss is handled only by the stage canvas owner', () => {
    expect(stageCanvasSource).toContain(
      "tracked(stageCanvas, 'webglcontextlost', onContextLost)",
    );
    expect(pageSource).not.toContain('requestStageRendererRecovery');
  });

  test('activity canvas loss cannot reach stage recovery', () => {
    const activityHandler = pageSource.match(
      /const onContextLost = \(event: Event\) => \{[\s\S]*?\n    \};/,
    )?.[0];
    expect(activityHandler).toBeDefined();
    expect(activityHandler).not.toContain('noteRecovery');
    expect(activityHandler).not.toContain('requestStageRendererRecovery');
  });
});
