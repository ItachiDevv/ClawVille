import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetBootActorForTests,
  getBootActorStamps,
  resolveBootActor,
} from './boot-actor';
import {
  LOCAL_PLAYER_FALLBACK_MODEL_KEY,
  LOCAL_PLAYER_MODEL_FALLBACK_NOTICE,
  __resetLocalPlayerFallbackNoticeForTests,
  onLocalPlayerModelFallback,
} from './local-player-model-fallback';

describe('onLocalPlayerModelFallback', () => {
  beforeEach(() => {
    __resetBootActorForTests();
    __resetLocalPlayerFallbackNoticeForTests();
  });

  test('releases the failed body claim so the reveal does not wait for the 8 s deadline', () => {
    const path = '/avatars/milady-official-1.vrm';
    resolveBootActor('player-vrm', path);
    expect(getBootActorStamps().readyAt).toBeNull();

    onLocalPlayerModelFallback('player-vrm', path, () => {});

    expect(getBootActorStamps().readyAt).not.toBeNull();
  });

  test('the possessed NPC body (npc-body) claim is released the same way', () => {
    const path = '/avatars/milady-official-4.vrm';
    resolveBootActor('npc-body', path);
    onLocalPlayerModelFallback('npc-body', path, () => {});
    expect(getBootActorStamps().readyAt).not.toBeNull();
  });

  test('shows ONE plain-words notice per session, even if both bodies fail', () => {
    const toasts: Array<[string, string, number | undefined]> = [];
    const addToast = (icon: string, message: string, durationMs?: number) => {
      toasts.push([icon, message, durationMs]);
    };
    onLocalPlayerModelFallback('player-vrm', '/avatars/a.vrm', addToast);
    onLocalPlayerModelFallback('player-vrm', '/avatars/a.vrm', addToast);
    onLocalPlayerModelFallback('npc-body', '/avatars/b.vrm', addToast);

    expect(toasts.length).toBe(1);
    expect(toasts[0][1]).toBe(
      'Your avatar could not load. You are shown with the default body. Reload to try again.',
    );
    expect(toasts[0][1]).toBe(LOCAL_PLAYER_MODEL_FALLBACK_NOTICE);
    expect(LOCAL_PLAYER_MODEL_FALLBACK_NOTICE).not.toMatch(/[–—]/);
  });

  test('the fallback body is the registry default GLB (lobster)', () => {
    expect(LOCAL_PLAYER_FALLBACK_MODEL_KEY).toBe('lobster');
  });
});
