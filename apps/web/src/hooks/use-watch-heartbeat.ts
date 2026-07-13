'use client';

import { useEffect } from 'react';
import { useNpcStore } from '@/stores/npc';

const WORLD_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
/**
 * Visibility-heartbeat cadence for the ambient-banter watcher gate (server
 * latch expires at ~90s = tolerates two missed beats).
 */
const WATCH_HEARTBEAT_MS = 30_000;

/**
 * Ambient-banter watcher heartbeat (2026-07-13 OpenAI-usage audit, Codex
 * rounds). Tells the server a HUMAN is actually SEEING the world, so
 * NPC↔NPC banter is worth spending inference on: `POST /api/npc/watch`
 * immediately when the tab is (or becomes) visible, then every
 * WATCH_HEARTBEAT_MS; stops while hidden.
 *
 * Two health conditions gate the beat (both required):
 * - `document.visibilityState === 'visible'` — an open-but-hidden tab is not
 *   an audience. (The EventSource itself stays open in hidden tabs for
 *   join-budget protection, which is exactly why a mere connection must not
 *   arm the server latch.)
 * - the NPC stream is CONNECTED (`useNpcStore.connected`, set by both stream
 *   hooks) — a visible tab whose stream died (retry exhaustion, failed join,
 *   API restart window) cannot RECEIVE banter, so it must not pay for it
 *   (Codex round 4). Beats stop the moment the stream drops and resume when
 *   it reconnects; the server's 90s grace rides out reconnect blips.
 *
 * Mounted by BOTH stream hooks (`useWorldStream` for /game, legacy
 * `useNpcStream` for /arena + /perf). Fire-and-forget — a failed beat just
 * means banter degrades to canned lines for a bit.
 */
export function useWatchHeartbeat() {
  const connected = useNpcStore((s) => s.connected);
  useEffect(() => {
    // Dead or never-opened stream: this tab can't see banter — never arm the
    // paid-inference latch from it. The effect re-runs when the stream hook
    // flips `connected`, restarting beats on recovery.
    if (!connected) return;
    let watchInterval: ReturnType<typeof setInterval> | null = null;

    function sendWatchBeat() {
      fetch(`${WORLD_API_URL}/api/npc/watch`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => { /* best-effort */ });
    }
    function startWatchBeat() {
      if (watchInterval) return;
      sendWatchBeat();
      watchInterval = setInterval(sendWatchBeat, WATCH_HEARTBEAT_MS);
    }
    function stopWatchBeat() {
      if (watchInterval) {
        clearInterval(watchInterval);
        watchInterval = null;
      }
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') startWatchBeat();
      else stopWatchBeat();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.visibilityState === 'visible') startWatchBeat();

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopWatchBeat();
    };
  }, [connected]);
}
