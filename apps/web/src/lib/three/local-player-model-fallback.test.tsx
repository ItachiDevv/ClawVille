/**
 * LocalPlayerFallback through the REAL path: useGLTFWithKTX2 -> R3F
 * useLoader -> GLTFLoader -> FileLoader (fetch mocked), real boot-actor
 * state, real ModelLoadBoundary. Root onCaughtError = R3F's reportError.
 *
 * - B4: the failed boot claim is released only once the fallback body has
 *   COMMITTED (its Suspense resolved), exactly once.
 * - B3: if the fallback body itself fails, it renders nothing (no crash to
 *   the outer boundary) and the claim is still released once.
 * - one plain-words notice per session.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Component, StrictMode, Suspense, act, createElement, useEffect, type ReactNode } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const testWindow = new Window({ url: 'http://localhost/game' });
const globalNames = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'ErrorEvent', 'ProgressEvent', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;

let createRoot: typeof import('react-dom/client').createRoot;
let useGLTFWithKTX2: typeof import('./use-gltf-ktx2').useGLTFWithKTX2;
let fallbackModule: typeof import('./local-player-model-fallback');
let bootActor: typeof import('./boot-actor');

const VALID_GLTF = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'lobster-root' }] });
let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
const replies = new Map<string, 'valid-gated' | number>();
const requests = new Map<string, number>();

beforeAll(async () => {
  for (const name of globalNames) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value =
      name === 'IS_REACT_ACT_ENVIRONMENT'
        ? true
        : name === 'window'
          ? testWindow
          : (testWindow as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.set(url, (requests.get(url) ?? 0) + 1);
    const reply = replies.get(url) ?? 404;
    if (reply === 'valid-gated') {
      await gate;
      return new Response(new TextEncoder().encode(VALID_GLTF), { status: 200 });
    }
    return new Response('missing', { status: reply });
  }) as unknown as typeof fetch;
  ({ createRoot } = await import('react-dom/client'));
  ({ useGLTFWithKTX2 } = await import('./use-gltf-ktx2'));
  fallbackModule = await import('./local-player-model-fallback');
  bootActor = await import('./boot-actor');
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  await testWindow.happyDOM.close();
});

beforeEach(() => {
  bootActor.__resetBootActorForTests();
  fallbackModule.__resetLocalPlayerFallbackForTests();
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
});

class OuterBoundary extends Component<{ onCatch: (error: unknown) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onCatch(error);
  }
  render() {
    return this.state.failed ? createElement('b', { id: 'outer-failed' }) : (this.props.children ?? null);
  }
}

/** Stand-in for the lobster body: loads a REAL GLB through the shared loader. */
function LobsterBody({ url }: { url: string }) {
  const gltf = useGLTFWithKTX2(url);
  return createElement('span', { id: 'lobster', 'data-node': gltf.scene.getObjectByName('lobster-root') ? 'ok' : 'empty' });
}

/** Stand-in for a real body (PlayerAvatarVRMInner / BootActorNpcBodyInner):
 * registers its boot claim at render, suspends on its model, and commits the
 * claim from a passive effect once the model resolved. */
function ClaimingBody({ kind, path, url }: { kind: 'player-vrm' | 'npc-body'; path: string; url: string }) {
  const token = bootActor.registerBootActorClaim(kind, path);
  const gltf = useGLTFWithKTX2(url);
  useEffect(() => {
    bootActor.notifyBootActorCommitted(token);
  }, [token]);
  return createElement('span', { id: 'body', 'data-node': gltf.scene.getObjectByName('lobster-root') ? 'ok' : 'empty' });
}

type HappyErrorEvent = InstanceType<typeof testWindow.ErrorEvent>;
function r3fLikeRoot(container: Element, reported: HappyErrorEvent[]): Root {
  return createRoot(container, {
    onCaughtError: (error: unknown) => {
      const event = new testWindow.ErrorEvent('error', { error: error as Error, message: String((error as Error)?.message), cancelable: true });
      testWindow.dispatchEvent(event);
      reported.push(event);
    },
  });
}

async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function newContainer(): Element {
  const container = testWindow.document.createElement('div') as unknown as Element;
  testWindow.document.body.appendChild(container as never);
  return container;
}

function captureConsoleError() {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  return { logged, restore: () => (console.error = original) };
}

describe('LocalPlayerFallback', () => {
  test('B4: the failed claim is released only after the fallback body committed, exactly once; one notice', async () => {
    const failedPath = '/avatars/lpf-player.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-ok.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const toasts: string[] = [];
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    const tree = () =>
      createElement(
        fallbackModule.LocalPlayerFallback,
        { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: (_i: string, m: string) => toasts.push(m) },
        createElement(LobsterBody, { url: lobsterUrl }),
      );
    await act(async () => root.render(tree()));
    await settle(5);
    // Lobster still loading: no body yet, so the reveal must still wait.
    expect(container.querySelector('#lobster')).toBeNull();
    expect(bootActor.getBootActorStamps().readyAt).toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);
    expect(toasts).toEqual([]); // outcome unknown yet: no notice yet

    openGate();
    await settle();
    expect(container.querySelector('#lobster')?.getAttribute('data-node')).toBe('ok');
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    expect(toasts).toEqual([fallbackModule.LOCAL_PLAYER_MODEL_FALLBACK_NOTICE]);

    await act(async () => root.render(tree())); // re-render: no second commit, no second notice
    await settle(3);
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    expect(toasts.length).toBe(1);
    await act(async () => root.unmount());
  });

  test('B3 + SF2: the fallback lobster itself fails: renders nothing, no crash, claim released once, one console.error, the NO-BODY notice', async () => {
    const failedPath = '/avatars/lpf-player-2.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-missing.glb?v=1';
    replies.set(lobsterUrl, 404);
    bootActor.resolveBootActor('player-vrm', failedPath);
    const outer: unknown[] = [];
    const reported: HappyErrorEvent[] = [];
    const toasts: string[] = [];
    const container = newContainer();
    const root = r3fLikeRoot(container, reported);
    const cap = captureConsoleError();
    try {
      await act(async () =>
        root.render(
          createElement(
            OuterBoundary,
            { onCatch: (e) => outer.push(e) },
            createElement(
              fallbackModule.LocalPlayerFallback,
              { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: (_i: string, m: string) => toasts.push(m) },
              createElement(LobsterBody, { url: lobsterUrl }),
            ),
          ),
        ),
      );
      await settle();
    } finally {
      cap.restore();
    }
    expect(outer).toEqual([]);
    expect(container.querySelector('#outer-failed')).toBeNull();
    expect(container.querySelector('#lobster')).toBeNull();
    expect(requests.get(lobsterUrl)).toBe(1);
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    const lines = cap.logged.filter((args) => String(args[0]).startsWith('[3D] figure skipped'));
    expect(lines.length).toBe(1);
    expect(String(lines[0][0])).toContain(`player-avatar-fallback ${lobsterUrl}`);
    expect(reported.every((event) => event.defaultPrevented)).toBe(true);
    expect(toasts).toEqual(['Your avatar could not load. Reload to try again.']);
    expect(toasts[0]).toBe(fallbackModule.LOCAL_PLAYER_MODEL_NO_BODY_NOTICE);
    await act(async () => root.unmount());
  });

  test('SF1: the fallback unmounts while the lobster is still loading: the claim is released once anyway', async () => {
    const failedPath = '/avatars/lpf-player-unmount.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-unmount.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    await act(async () =>
      root.render(
        createElement(
          fallbackModule.LocalPlayerFallback,
          { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
          createElement(LobsterBody, { url: lobsterUrl }),
        ),
      ),
    );
    await settle(3);
    expect(bootActor.getBootActorStamps().readyAt).toBeNull();
    await act(async () => root.unmount());
    await settle(3);
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    openGate();
    await settle(3);
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
  });

  test('B2 (round 5): unmount + immediate remount for the SAME claim while the lobster loads: no early release; one release after the new body commits', async () => {
    const failedPath = '/avatars/lpf-player-remount.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-remount.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const element = () =>
      createElement(
        fallbackModule.LocalPlayerFallback,
        { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
        createElement(LobsterBody, { url: lobsterUrl }),
      );
    const rootA = r3fLikeRoot(newContainer(), []);
    await act(async () => rootA.render(element()));
    await settle(3);
    // A NEW instance mounts for the same claim as the old one unmounts.
    const containerB = newContainer();
    const rootB = r3fLikeRoot(containerB, []);
    await act(async () => {
      rootA.unmount();
      rootB.render(element());
    });
    await settle(5);
    expect(bootActor.getBootActorStamps().readyAt).toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);

    openGate();
    await settle();
    expect(containerB.querySelector('#lobster')).not.toBeNull();
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    await act(async () => rootB.unmount());
    await settle(3);
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
  });

  test('stale unmount timer: the boot state is reset (new epoch) before the old timer fires -> no release in the new state', async () => {
    const failedPath = '/avatars/lpf-player-stale.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-stale.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const element = () =>
      createElement(
        fallbackModule.LocalPlayerFallback,
        { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
        createElement(LobsterBody, { url: lobsterUrl }),
      );
    const rootA = r3fLikeRoot(newContainer(), []);
    await act(async () => rootA.render(element()));
    await settle(3);
    // Unmount (deferred release armed), then the boot state starts over
    // BEFORE that timer fires: a new resolution, and a NEW fallback for the
    // same kind + path registers its own claim (claim ids restart at 1).
    const containerB = newContainer();
    const rootB = r3fLikeRoot(containerB, []);
    await act(async () => {
      rootA.unmount();
      bootActor.__resetBootActorForTests();
      bootActor.resolveBootActor('player-vrm', failedPath);
      rootB.render(element());
    });
    await settle(5); // the old timer has fired by now
    expect(bootActor.getBootActorStamps().readyAt).toBeNull();

    openGate();
    await settle();
    expect(containerB.querySelector('#lobster')).not.toBeNull();
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    await act(async () => rootB.unmount());
  });

  test('the test reset cancels pending unmount releases', async () => {
    const failedPath = '/avatars/lpf-player-reset.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-reset.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const root = r3fLikeRoot(newContainer(), []);
    await act(async () =>
      root.render(
        createElement(
          fallbackModule.LocalPlayerFallback,
          { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
          createElement(LobsterBody, { url: lobsterUrl }),
        ),
      ),
    );
    await settle(3);
    await act(async () => {
      root.unmount();
      fallbackModule.__resetLocalPlayerFallbackForTests();
    });
    await settle(5);
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);
  });

  test('Codex E3 (1710e2b6): a body re-registers the SAME claim as the fallback unmounts: the stale unmount release never commits it; the body commit does', async () => {
    const failedPath = '/avatars/lpf-player-rereg.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-rereg.glb?v=1';
    const bodyUrl = 'http://localhost/models/lpf-body-rereg.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    replies.set(bodyUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const rootA = r3fLikeRoot(newContainer(), []);
    await act(async () =>
      rootA.render(
        createElement(
          fallbackModule.LocalPlayerFallback,
          { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
          createElement(LobsterBody, { url: lobsterUrl }),
        ),
      ),
    );
    await settle(3);
    // The fallback unmounts (deferred release armed) and, in the same
    // commit, a plain body for the same kind + path registers the SAME claim
    // (same epoch: registerBootActorClaim returns the existing token) and is
    // still loading.
    const containerB = newContainer();
    const rootB = r3fLikeRoot(containerB, []);
    await act(async () => {
      rootA.unmount();
      rootB.render(
        createElement(Suspense, { fallback: null }, createElement(ClaimingBody, { kind: 'player-vrm', path: failedPath, url: bodyUrl })),
      );
    });
    await settle(5); // the old deferred release would have fired by now
    expect(containerB.querySelector('#body')).toBeNull();
    expect(bootActor.getBootActorStamps().readyAt).toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);

    const openedAt = Math.round(performance.now());
    openGate();
    await settle();
    expect(containerB.querySelector('#body')?.getAttribute('data-node')).toBe('ok');
    // Committed by the body, after its model resolved, not by the old timer.
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    expect(bootActor.getBootActorStamps().readyAt!).toBeGreaterThanOrEqual(openedAt);
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);
    await act(async () => rootB.unmount());
    await settle(3);
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);
  });

  test('StrictMode simulated unmount + re-mount does not release while the lobster loads', async () => {
    const failedPath = '/avatars/lpf-player-strict.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-strict.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('player-vrm', failedPath);
    const root = r3fLikeRoot(newContainer(), []);
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            fallbackModule.LocalPlayerFallback,
            { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
            createElement(LobsterBody, { url: lobsterUrl }),
          ),
        ),
      ),
    );
    await settle(5);
    expect(bootActor.getBootActorStamps().readyAt).toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);
    openGate();
    await settle();
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    await act(async () => root.unmount());
  });

  test('Codex E3 NIT: resetting only this module also forgets released claims (the same token object released again after a remount)', async () => {
    const failedPath = '/avatars/lpf-player-nit.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-nit.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    openGate();
    bootActor.resolveBootActor('player-vrm', failedPath);
    const element = () =>
      createElement(
        fallbackModule.LocalPlayerFallback,
        { kind: 'player-vrm', failedPath, fallbackUrl: lobsterUrl, label: 'player-avatar', addToast: () => {} },
        createElement(LobsterBody, { url: lobsterUrl }),
      );
    const rootA = r3fLikeRoot(newContainer(), []);
    await act(async () => rootA.render(element()));
    await settle();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    await act(async () => rootA.unmount());
    await settle(3);
    // Reset THIS module only; the boot state (and so the claim token object)
    // is kept.
    fallbackModule.__resetLocalPlayerFallbackForTests();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(0);
    const rootB = r3fLikeRoot(newContainer(), []);
    await act(async () => rootB.render(element()));
    await settle();
    expect(fallbackModule.__getBootClaimReleaseCountForTests()).toBe(1);
    await act(async () => rootB.unmount());
  });

  test('npc-body claim (possessed NPC) is released the same way', async () => {
    const failedPath = '/avatars/lpf-npc.vrm';
    const lobsterUrl = 'http://localhost/models/lpf-lobster-npc.glb?v=1';
    replies.set(lobsterUrl, 'valid-gated');
    bootActor.resolveBootActor('npc-body', failedPath);
    const container = newContainer();
    const root = r3fLikeRoot(container, []);
    await act(async () =>
      root.render(
        createElement(
          fallbackModule.LocalPlayerFallback,
          { kind: 'npc-body', failedPath, fallbackUrl: lobsterUrl, label: 'possessed-npc-body', addToast: () => {} },
          createElement(LobsterBody, { url: lobsterUrl }),
        ),
      ),
    );
    openGate();
    await settle();
    expect(bootActor.getBootActorStamps().readyAt).not.toBeNull();
    await act(async () => root.unmount());
  });

  test('one plain-words notice per session, no dashes; the fallback body is the registry default lobster', () => {
    const toasts: string[] = [];
    fallbackModule.showLocalPlayerFallbackNotice((_i, m) => toasts.push(m), 'body');
    fallbackModule.showLocalPlayerFallbackNotice((_i, m) => toasts.push(m), 'none');
    expect(toasts).toEqual(['Your avatar could not load. You are shown with the default body. Reload to try again.']);
    // En and em dash as code-point data (never raw characters in source).
    const dashes = [0x2013, 0x2014].map((code) => String.fromCharCode(code));
    for (const text of [fallbackModule.LOCAL_PLAYER_MODEL_FALLBACK_NOTICE, fallbackModule.LOCAL_PLAYER_MODEL_NO_BODY_NOTICE]) {
      expect(dashes.some((dash) => text.includes(dash))).toBe(false);
    }
    expect(fallbackModule.LOCAL_PLAYER_FALLBACK_MODEL_KEY).toBe('lobster');
  });
});
