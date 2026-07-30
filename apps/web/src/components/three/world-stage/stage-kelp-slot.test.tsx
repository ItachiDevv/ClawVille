import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import {
  createKelpActivationLifecycle,
  createKelpActivationToken,
} from '@/lib/three/kelp-activation';
import {
  reportKelpRenderFailure,
} from '@/lib/three/kelp-render-failure-beacon';
import {
  countKelpStageMeshes,
  isKelpStageWarmReady,
} from './StageHostedKelpScene';

describe('stage-hosted kelp slot', () => {
  test('request activation and exit keep one token identity with one reset pair', () => {
    const token = createKelpActivationToken(1);
    const completed: symbol[] = [];
    const lifecycle = createKelpActivationLifecycle(
      token,
      true,
      (completeToken) => completed.push(completeToken.id),
    );
    lifecycle.context.reportResetComplete(token, 'beacon');
    lifecycle.context.reportResetComplete(token, 'motion');
    lifecycle.update(token, true);
    expect(lifecycle.context.token).toBe(token);
    expect(lifecycle.context.isCurrent(token)).toBe(true);
    lifecycle.update(token, false);
    expect(lifecycle.context.token).toBe(token);
    expect(lifecycle.context.isCurrent(token)).toBe(false);
    expect(completed).toEqual([token.id]);
  });

  test('both reset owners observe the render-minted token identity', () => {
    const token = createKelpActivationToken(3);
    const lifecycle = createKelpActivationLifecycle(token, true);
    const beaconToken = lifecycle.context.token;
    const motionToken = lifecycle.context.token;
    expect(beaconToken).toBe(token);
    expect(motionToken).toBe(token);
  });

  test('beacon and motion reset implementations use layout effects before frames', () => {
    const playerSource = readFileSync(
      new URL(
        '../../../lib/three/kelp-realm-player.tsx',
        import.meta.url,
      ),
      'utf8',
    );
    expect(
      playerSource.match(/useLayoutEffect\(\(\) => \{/g)?.length,
    ).toBe(2);
    expect(
      playerSource.indexOf('useLayoutEffect(() => {'),
    ).toBeLessThan(
      playerSource.indexOf('usePlayerCapabilityController({'),
    );
  });

  test('readiness completion is withheld until both owners report', () => {
    const token = createKelpActivationToken(4);
    let readyToken: symbol | null = null;
    const lifecycle = createKelpActivationLifecycle(
      token,
      true,
      (completeToken) => {
        readyToken = completeToken.id;
      },
    );
    lifecycle.context.reportResetComplete(token, 'beacon');
    expect(readyToken).toBeNull();
    lifecycle.context.reportResetComplete(token, 'motion');
    expect(readyToken as symbol | null).toBe(token.id);
  });

  test('a stale aborted finally cannot clear a new generation pending flag', async () => {
    const oldToken = createKelpActivationToken(5);
    const nextToken = createKelpActivationToken(6);
    const lifecycle = createKelpActivationLifecycle(oldToken, true);
    let nextPending = true;
    lifecycle.update(nextToken, true);
    await Promise.resolve().finally(() => {
      if (lifecycle.context.isCurrent(oldToken)) {
        nextPending = false;
      }
    });
    expect(nextPending).toBe(true);
  });

  test('a stale visit result cannot mark a beacon after token change', () => {
    const oldToken = createKelpActivationToken(7);
    const nextToken = createKelpActivationToken(8);
    const lifecycle = createKelpActivationLifecycle(oldToken, true);
    let visited = false;
    lifecycle.update(nextToken, true);
    if (lifecycle.context.isCurrent(oldToken)) visited = true;
    expect(visited).toBe(false);
  });

  test('a stale readiness animation frame is suppressed', () => {
    const oldToken = createKelpActivationToken(9);
    const lifecycle = createKelpActivationLifecycle(oldToken, true);
    lifecycle.update(oldToken, false);
    let environmentReady = false;
    if (lifecycle.context.isCurrent(oldToken)) {
      environmentReady = true;
    }
    expect(environmentReady).toBe(false);
  });

  test('two request generations produce two reset pairs while ownership flips produce none', () => {
    const first = createKelpActivationToken(10);
    const second = createKelpActivationToken(11);
    const completed: symbol[] = [];
    const lifecycle = createKelpActivationLifecycle(
      first,
      true,
      (token) => completed.push(token.id),
    );
    for (const owner of ['beacon', 'motion'] as const) {
      lifecycle.context.reportResetComplete(first, owner);
    }
    lifecycle.update(first, false);
    lifecycle.update(first, true);
    lifecycle.update(second, true);
    for (const owner of ['beacon', 'motion'] as const) {
      lifecycle.context.reportResetComplete(second, owner);
    }
    expect(completed).toEqual([first.id, second.id]);
  });

  test('the rejected chunk beacon lane remains one-shot', () => {
    const originalDescriptors = new Map<
      string,
      PropertyDescriptor | undefined
    >();
    let sends = 0;
    for (const [key, value] of Object.entries({
      window: {},
      document: {
        createElement: () => ({
          getContext: () => null,
        }),
      },
      navigator: {
        sendBeacon: () => {
          sends += 1;
          return true;
        },
      },
    })) {
      originalDescriptors.set(
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      );
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value,
      });
    }
    try {
      reportKelpRenderFailure(
        'chunk-load-failed',
        'first rejection',
      );
      reportKelpRenderFailure(
        'chunk-load-failed',
        'duplicate rejection',
      );
      expect(sends).toBe(1);
    } finally {
      for (const [key, descriptor] of originalDescriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
    }
  });

  test('warming requires environment readiness and a populated kelp slot', () => {
    const token = createKelpActivationToken(12);
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    root.name = 'world-stage:kelp';
    root.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial(),
      ),
    );
    scene.add(root);
    const meshCount = countKelpStageMeshes(scene);
    expect(meshCount).toBe(1);
    expect(
      isKelpStageWarmReady({
        token,
        resetsCompleteToken: token.id,
        environmentReadyToken: null,
        requested: true,
        cameraInstalled: true,
        generation: 12,
        meshCount,
      }),
    ).toBe(false);
    expect(
      isKelpStageWarmReady({
        token,
        resetsCompleteToken: token.id,
        environmentReadyToken: token.id,
        requested: true,
        cameraInstalled: true,
        generation: 12,
        meshCount,
      }),
    ).toBe(true);
  });
});
