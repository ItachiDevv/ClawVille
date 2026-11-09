import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
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
    if (!file.endsWith('player-input.ts')) expect(source).toContain('isWorldFrameBlocked()');
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
