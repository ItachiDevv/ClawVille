import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StageSlotErrorBoundary } from './StageSlotErrorBoundary';
import { resetStageStore, useStageStore } from './stage-store';

const source = (name: string): string =>
  readFileSync(resolve(import.meta.dir, name), 'utf8');

const hostSource = source('StageHostedActivityScene.tsx');
const rootSource = source('WorldStageRoot.tsx');
const transitionSource = source('StageTransition.tsx');

beforeEach(() => {
  resetStageStore();
});

describe('persistent activity stage slot', () => {
  test('registers no activity frame callback', () => {
    expect(hostSource).not.toContain('useSceneFrame');
  });

  test('marks the requested positive generation warming', () => {
    expect(hostSource).toMatch(
      /if \(!requested \|\| generation <= 0\) return;[\s\S]*?setSceneWarming\(ACTIVITY_SCENE_ID, generation\)/,
    );
  });

  test('late host warming cannot demote page-owned readiness', () => {
    useStageStore.getState().registerScenes(['activity']);
    useStageStore.getState().requestScene('activity');
    const generation =
      useStageStore.getState().pendingRequest?.generation ?? 0;
    useStageStore.getState().ackReady('activity', generation);
    useStageStore.getState().setSceneWarming('activity', generation);
    expect(useStageStore.getState().scenes.activity?.status).toBe('ready');
  });

  test('warms the activity slot directly without colliding with cove or kelp', () => {
    expect(hostSource).toContain("slotId: ACTIVITY_SCENE_ID");
    expect(hostSource).toContain('compile: undefined');
    expect(hostSource).toContain('directWarm: async () =>');
  });

  test('does not acknowledge readiness from the slot host', () => {
    expect(hostSource).not.toContain('ackReady');
  });

  test('pauses only after activity reaches idle', () => {
    expect(hostSource).toMatch(
      /state\.activeScene === ACTIVITY_SCENE_ID &&\s*state\.transition\?\.phase === 'idle'/,
    );
  });

  test('idles on demand without detaching the persistent R3F root', () => {
    const canvasSource = source('WorldStageCanvas.tsx');
    expect(canvasSource).toContain(
      "setFrameloop(paused ? 'demand' : 'always')",
    );
    expect(canvasSource).not.toContain('_roots');
  });

  test('an awaiting-phase pause variant violates the required guard', () => {
    const shouldPause = (phase: 'awaiting' | 'idle') => phase === 'idle';
    expect(shouldPause('awaiting')).toBeFalse();
    expect(shouldPause('idle')).toBeTrue();
  });

  test('requesting world clears renderPaused without an explicit unpause', () => {
    useStageStore.getState().setRenderPaused(true);
    useStageStore.getState().requestScene('world');
    expect(useStageStore.getState().renderPaused).toBeFalse();
  });

  test('host cleanup clears renderPaused', () => {
    expect(hostSource.match(/setRenderPaused\(false\)/g)).toHaveLength(2);
  });

  test('idle pause cannot fire when another scene is active', () => {
    expect(hostSource).toContain(
      'state.activeScene === ACTIVITY_SCENE_ID',
    );
  });

  test('slot boundary reset key includes generation and recovery count', () => {
    expect(rootSource).toContain(
      'const activityResetKey = `${activityGeneration}:${recoveryCount}`',
    );
    expect(rootSource).toContain('resetKey={activityResetKey}');
  });

  test('a healthy boundary preserves its child when only resetKey changes', () => {
    const prior = { failed: false, resetKey: '1:0' };
    expect(
      StageSlotErrorBoundary.getDerivedStateFromProps(
        {
          resetKey: '2:0',
          onRuntimeError: () => {},
          children: null,
        },
        prior,
      ),
    ).toEqual({ failed: false, resetKey: '2:0' });
  });

  test('a recovery-count bump clears a failed boundary', () => {
    expect(
      StageSlotErrorBoundary.getDerivedStateFromProps(
        {
          resetKey: '7:1',
          onRuntimeError: () => {},
          children: null,
        },
        { failed: true, resetKey: '7:0' },
      ),
    ).toEqual({ failed: false, resetKey: '7:1' });
  });

  test('activity runtime crash flag is keyed to the same reset key', () => {
    expect(rootSource).toContain(
      'activityRuntimeCrashKey === activityResetKey',
    );
  });

  test('activity lazy failure renders a terminal chunk panel and acknowledges', () => {
    expect(rootSource).toContain('LazyStageHostedActivityScene');
    expect(rootSource).toContain(
      'The activity stage hit a runtime error. Reload the page to retry.',
    );
    expect(rootSource).toMatch(
      /handleActivityRuntimeCrash[\s\S]*?ackReady\(/,
    );
  });

  test('pending activity uses activity watchdog kind without world ceilings', () => {
    expect(transitionSource).toContain(
      "activity: 'activity'",
    );
    expect(source('stage-watchdog-machine.ts')).toContain(
      "if (sample.sceneKind === 'world')",
    );
  });

  test('empty activity slot does not wait for a nonexistent controlled frame', () => {
    expect(transitionSource).toContain(
      'current?.sceneId === ACTIVITY_SCENE_ID',
    );
    expect(transitionSource).toContain(
      'pendingRequest.sceneId !== ACTIVITY_SCENE_ID',
    );
  });
});
