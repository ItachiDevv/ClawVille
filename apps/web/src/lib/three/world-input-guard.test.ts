import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { useStageStore, resetStageStore } from '@/components/three/world-stage/stage-store';
import { useBrainchainInteriorStore } from '@/components/brainchain/brainchain-interior-store';
import { selectWorldRendererMode } from '@/lib/world-renderer-mode';
import { isWorldInputBlocked, isWorldFrameBlocked, isWorldServicePanelPath } from './world-input-guard';

test('the retained Office scene never owns world movement input', () => {
  expect(isWorldServicePanelPath('/brainchain')).toBe(true);
  expect(isWorldServicePanelPath('/brainchain/work')).toBe(true);
  expect(isWorldServicePanelPath('/game')).toBe(false);
  expect(isWorldServicePanelPath('/trading-floor')).toBe(false);
  expect(isWorldServicePanelPath('/brainchain-other')).toBe(false);
  expect(isWorldInputBlocked()).toBe(false); // server-side import has no browser globals
});

test('keyboard and all world movement loops enforce the same guard', () => {
  for (const file of ['player/player-input.ts', 'player/player-capability-controller.tsx', 'npc-controller.tsx', '../pixi/use-game-loop.ts']) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8');
    expect(source).toContain('isWorldInputBlocked()');
    if (file.endsWith('player-capability-controller.tsx')) expect(source).toContain('isWorldFrameBlocked(config.sceneId)');
    else if (!file.endsWith('player-input.ts')) expect(source).toContain('isWorldFrameBlocked()');
  }
});

test('Office route and text focus block world input', () => {
  const dom = new JSDOM('<!doctype html><textarea></textarea>', { url: 'https://clawville.world/brainchain' });
  const globals = ['window', 'document'] as const;
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    expect(isWorldInputBlocked()).toBe(true);
    dom.window.history.replaceState(null, '', '/game');
    expect(isWorldInputBlocked()).toBe(false);
    dom.window.document.querySelector('textarea')!.focus();
    expect(isWorldInputBlocked()).toBe(true);
    expect(isWorldFrameBlocked()).toBe(false);
  } finally {
    dom.window.close();
    globals.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globalThis, key, originals[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});


test('only the active 3D Office controller moves, with its window closed', () => {
  const dom = new JSDOM('<!doctype html><textarea></textarea>', { url: 'https://clawville.world/brainchain' });
  const globals = ['window', 'document'] as const;
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const previousOffice = useBrainchainInteriorStore.getState();
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
    resetStageStore();
    selectWorldRendererMode('3d');
    useBrainchainInteriorStore.setState({ section: null, failed: false });
    useStageStore.setState({ activeScene: 'brainchain', transition: null });
    expect(isWorldInputBlocked()).toBe(false);
    expect(isWorldFrameBlocked('brainchain')).toBe(false);
    expect(isWorldFrameBlocked('world')).toBe(true);
    expect(isWorldFrameBlocked()).toBe(true);
    useBrainchainInteriorStore.getState().open('learn');
    expect(isWorldInputBlocked()).toBe(true);
    expect(isWorldFrameBlocked('brainchain')).toBe(true);
    useBrainchainInteriorStore.getState().close();
    dom.window.document.querySelector('textarea')!.focus();
    expect(isWorldInputBlocked()).toBe(true);
    dom.window.document.querySelector('textarea')!.blur();
    selectWorldRendererMode('2d');
    expect(isWorldFrameBlocked('brainchain')).toBe(true);
    selectWorldRendererMode('3d');
    useStageStore.setState({ activeScene: 'world' });
    expect(isWorldFrameBlocked('brainchain')).toBe(true);
    expect(isWorldInputBlocked()).toBe(true);
  } finally {
    resetStageStore();
    useBrainchainInteriorStore.setState(previousOffice);
    selectWorldRendererMode('3d');
    dom.window.close();
    globals.forEach((key, index) => {
      if (originals[index]) Object.defineProperty(globalThis, key, originals[index]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
