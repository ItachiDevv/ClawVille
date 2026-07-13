'use client';

import { useEffect } from 'react';

const WORLD_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
/**
 * Visibility-heartbeat cadence for the ambient-banter watcher gate (server
 * latch expires at ~90s = tolerates two missed beats).
 */
const WATCH_HEARTBEAT_MS = 30_000;

/**
 * Ambient-banter watcher heartbeat (2026-07-13 OpenAI-usage audit, Codex
 * round). Tells the server a HUMAN is actually looking at the world, so
 * NPC↔NPC banter is worth spending inference on: `POST /api/npc/watch`
 * immediately when the tab is (or becomes) visible, then every
 * WATCH_HEARTBEAT_MS; stops while hidden.
 *
 * Deliberately independent of the SSE/join lifecycle: EventSource stays open
 * in hidden tabs (join-budget protection), and the server must not read a
 * mere connection as an audience. Mounted by BOTH stream hooks
 * (`useWorldStream` for /game, legacy `useNpcStream` for /arena + /perf).
 * Fire-and-forget — a failed beat just means banter degrades to canned lines
 * for a bit.
 */
export function useWatchHeartbeat() {
  useEffect(() => {
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
  }, []);
}
