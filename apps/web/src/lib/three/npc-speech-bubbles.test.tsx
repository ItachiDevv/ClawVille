/**
 * NPC speech bubbles commit only when the bubble set changes (web-load T10).
 *
 * Why: a 1 s setInterval tick re-rendered the layer (and so committed the
 * R3F root) every second, even with no bubble. Each such render discarded
 * pending Suspense retry work (gotchas/suspense-retry-lane-starvation-sync-
 * store-updates.md). Now ONE timeout to the earliest live expiry removes an
 * expired bubble, and the bubble selection ignores the store's later drop of
 * an already-removed bubble.
 *
 * Mounts the REAL NpcSpeechBubbles in a real R3F root (fake renderer,
 * frameloop 'never') inside a <Profiler>, with the real NPC store. Asserts:
 *   - no bubble: 0 commits over idle time;
 *   - a bubble: 1 commit to show, exactly 1 commit at its expiry, 0 for the
 *     store's later drop (cleanupExpired), 0 after;
 *   - two bubbles: one commit per expiry, earliest first; a NEW bubble that
 *     expires earlier re-arms the timer;
 *   - the bubble follows its walking speaker (in-place store moves) from the
 *     frame loop with 0 commits.
 * Runs in its own process.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Profiler, createElement, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type * as THREE from 'three';
import type { NpcChatBubble, NpcSpriteState } from '@/stores/npc';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'HTMLDivElement', 'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const threeCjs = require('three') as typeof import('three');

type R3F = typeof import('@react-three/fiber');
let r3f: R3F;
let NpcSpeechBubbles: () => ReactNode;
let useNpcStore: typeof import('@/stores/npc').useNpcStore;
let HALF_W = 0;
let HALF_H = 0;

beforeAll(async () => {
  for (const name of globalNames) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      name === 'IS_REACT_ACT_ENVIRONMENT'
        ? true
        : name === 'window'
          ? testWindow
          : name === 'requestAnimationFrame'
            ? (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number
            : name === 'cancelAnimationFrame'
              ? (id: number) => clearTimeout(id)
              : (testWindow as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  r3f = await import('@react-three/fiber');
  r3f.extend(threeCjs as never);
  NpcSpeechBubbles = (await import('./npc-speech-bubbles')).default as unknown as () => ReactNode;
  ({ useNpcStore } = await import('@/stores/npc'));
  const { MAP_WIDTH, MAP_HEIGHT } = await import('@/lib/pixi/tilemap-data');
  HALF_W = MAP_WIDTH / 2;
  HALF_H = MAP_HEIGHT / 2;
  // Connected: stops the client demo wander loop (a 100 ms store write).
  useNpcStore.getState().setConnected(true);
});

afterAll(async () => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

function fakeRenderer(canvas: unknown) {
  return {
    domElement: canvas,
    shadowMap: { enabled: false, type: 0, needsUpdate: false },
    outputColorSpace: '',
    toneMapping: 0,
    render() {},
    setSize() {},
    setPixelRatio() {},
    getPixelRatio: () => 1,
    dispose() {},
  };
}

function npc(id: string, x: number): NpcSpriteState {
  return {
    id,
    name: id,
    x,
    y: 2_000,
    prevX: x,
    prevY: 2_000,
    ts: 0,
    tsDelta: 200,
    direction: 'idle',
    species: 'lobster',
    color: 0xffffff,
    hp: 100,
    maxHp: 100,
    isDead: false,
    hasSword: false,
    inCombat: false,
    inConversation: true,
    inventory: [],
    isOpenClaw: false,
    combatAction: null,
    combatActionAt: 0,
    facingAngle: null,
  } as unknown as NpcSpriteState;
}

function bubble(npcId: string, text: string, ttlMs: number): NpcChatBubble {
  return { npcId, speaker: npcId, text, expiresAt: Date.now() + ttlMs };
}

/** Short act slices: one long act batches separate timer updates. */
async function idle(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await r3f.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function waitUntil(at: number): Promise<void> {
  await idle(Math.max(0, at - Date.now()));
}

let commits = 0;

async function mountLayer() {
  const canvas = testWindow.document.createElement('canvas');
  testWindow.document.body.appendChild(canvas);
  const root = r3f.createRoot(canvas as unknown as HTMLCanvasElement);
  await root.configure({
    gl: fakeRenderer(canvas) as never,
    size: { width: 320, height: 200, top: 0, left: 0 },
    frameloop: 'never',
  });
  let store!: ReturnType<typeof root.render>;
  await r3f.act(async () => {
    store = root.render(
      createElement(
        Profiler,
        {
          id: 'bubbles',
          onRender: () => {
            commits += 1;
          },
        },
        createElement(NpcSpeechBubbles),
      ),
    );
  });
  /** The bubble anchor groups (y = BUBBLE_Y 150) in the scene. */
  const anchors = () => {
    const out: THREE.Object3D[] = [];
    store.getState().scene.traverse((o) => {
      if ((o as THREE.Group).isGroup && o.position.y === 150) out.push(o);
    });
    return out;
  };
  const frame = async () => {
    await r3f.act(async () => {
      r3f.advance(performance.now(), true, store.getState());
    });
  };
  return { root, anchors, frame };
}

async function setStore(state: { npcs?: NpcSpriteState[]; chatBubbles?: NpcChatBubble[] }): Promise<void> {
  await r3f.act(async () => {
    useNpcStore.setState(state);
  });
}

describe('npc speech bubbles commit only on bubble changes (web-load T10)', () => {
  test('no bubble: 0 commits over idle time', async () => {
    await setStore({ npcs: [npc('a', 1_000)], chatBubbles: [] });
    const { root } = await mountLayer();
    commits = 0;
    await idle(2_600);
    expect(commits).toBe(0);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('one bubble: 1 commit to show, 1 at expiry, 0 for the store drop and after', async () => {
    await setStore({ npcs: [npc('a', 1_000)], chatBubbles: [] });
    const { root, anchors } = await mountLayer();
    commits = 0;
    const b = bubble('a', 'gm', 700);
    await setStore({ chatBubbles: [b] });
    expect(commits).toBe(1);
    expect(anchors()).toHaveLength(1);

    // Before the expiry: nothing commits.
    await waitUntil(b.expiresAt - 150);
    expect(commits).toBe(1);
    expect(anchors()).toHaveLength(1);

    // The expiry: exactly one commit removes it, close to expiresAt.
    await waitUntil(b.expiresAt + 120);
    expect(commits).toBe(2);
    expect(anchors()).toHaveLength(0);

    // The store drops the expired bubble later (snapshot / cleanupExpired):
    // the layer already removed it, so nothing commits.
    await r3f.act(async () => {
      useNpcStore.getState().cleanupExpired();
    });
    expect(useNpcStore.getState().chatBubbles).toHaveLength(0);
    await idle(1_200);
    expect(commits).toBe(2);
    await r3f.act(async () => root.unmount());
  }, 20_000);

  test('two bubbles expire in order; a new earlier bubble re-arms the timer', async () => {
    await setStore({ npcs: [npc('a', 1_000), npc('b', 1_400)], chatBubbles: [] });
    const { root, anchors } = await mountLayer();
    commits = 0;
    const late = bubble('a', 'late line', 1_400);
    await setStore({ chatBubbles: [late] });
    expect(commits).toBe(1);

    // A second bubble that expires FIRST arrives after the timer was armed.
    const early = bubble('b', 'early line', 500);
    await setStore({ chatBubbles: [late, early] });
    expect(commits).toBe(2);
    expect(anchors()).toHaveLength(2);

    await waitUntil(early.expiresAt + 120);
    expect(commits).toBe(3);
    expect(anchors()).toHaveLength(1);

    await waitUntil(late.expiresAt + 120);
    expect(commits).toBe(4);
    expect(anchors()).toHaveLength(0);

    await idle(800);
    expect(commits).toBe(4);
    await r3f.act(async () => root.unmount());
    await setStore({ chatBubbles: [] });
  }, 20_000);

  test('the bubble follows its walking speaker from the frame loop with 0 commits', async () => {
    const speaker = npc('a', 1_000);
    await setStore({ npcs: [speaker], chatBubbles: [bubble('a', 'walking and talking', 5_000)] });
    const { root, anchors, frame } = await mountLayer();
    expect(anchors()[0]!.position.x).toBe(1_000 - HALF_W);

    // updateFromSnapshot mutates position on the SAME object and writes a new
    // npcs array (and a new chatBubbles array with the same bubble).
    commits = 0;
    for (let i = 1; i <= 5; i += 1) {
      speaker.x = 1_000 + i * 44;
      speaker.y = 2_000 + i * 10;
      await setStore({
        npcs: [...useNpcStore.getState().npcs],
        chatBubbles: [...useNpcStore.getState().chatBubbles],
      });
    }
    expect(commits).toBe(0);
    await frame();
    expect(anchors()[0]!.position.x).toBe(1_220 - HALF_W);
    expect(anchors()[0]!.position.z).toBe(2_050 - HALF_H);
    await r3f.act(async () => root.unmount());
    await setStore({ chatBubbles: [] });
  }, 20_000);
});
