'use client';

import { useEffect, useRef } from 'react';
import { useNpcStore } from '@/stores/npc';
import { useResearchStore } from '@/stores/research';
import { measureSpike } from '@/lib/perf-tracker';
import { useWatchHeartbeat } from '@/hooks/use-watch-heartbeat';

const NPC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const MAX_RETRIES = 20;
const RETRY_DELAY_BASE = 3000;
const RETRY_DELAY_MAX = 60000;

export function useNpcStream() {
  // Ambient-banter watcher heartbeat — visible-tab-only "a human is watching"
  // signal for the server's banter inference gate (covers the legacy /arena +
  // /perf viewers). See use-watch-heartbeat.ts.
  useWatchHeartbeat();
  const updateFromSnapshot = useNpcStore((s) => s.updateFromSnapshot);
  const setConnected = useNpcStore((s) => s.setConnected);
  const addCollaborationEntries = useResearchStore((s) => s.addCollaborationEntries);
  const retriesRef = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled || retriesRef.current >= MAX_RETRIES) return;

      const url = `${NPC_API_URL}/api/npc/stream`;
      es = new EventSource(url);

      // Reset retry counter on successful open rather than on first snapshot —
      // transient connect errors that fire before any event arrived would
      // otherwise deplete the retry budget prematurely.
      es.addEventListener('open', () => {
        retriesRef.current = 0;
        setConnected(true);
      });

      es.addEventListener('snapshot', (event) => {
        try {
          const snapshot = measureSpike('sse:parse', () => JSON.parse(event.data));
          // Mark connected whenever any valid snapshot arrives — not gated
          // on npcs.length. A collab-only snapshot still means the stream
          // is alive.
          setConnected(true);
          if (snapshot.npcs?.length > 0) {
            measureSpike('sse:npcUpdate', () => updateFromSnapshot(snapshot));
          }
          // Phase 3: drain collaboration events into the research store
          if (Array.isArray(snapshot.collaborationEvents) && snapshot.collaborationEvents.length > 0) {
            measureSpike('sse:collabUpdate', () => addCollaborationEntries(snapshot.collaborationEvents));
          }
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn('[useNpcStream] snapshot parse/dispatch failed', err);
          }
        }
      });

      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        retriesRef.current++;
        if (!cancelled && retriesRef.current < MAX_RETRIES) {
          // Exponential backoff: 3s, 6s, 12s, ... capped at 60s
          const delay = Math.min(RETRY_DELAY_BASE * Math.pow(2, retriesRef.current - 1), RETRY_DELAY_MAX);
          retryTimeout = setTimeout(connect, delay);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      es?.close();
      if (retryTimeout) clearTimeout(retryTimeout);
      setConnected(false);
    };
  }, [updateFromSnapshot, setConnected, addCollaborationEntries]);
}
