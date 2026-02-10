'use client';

import { useEffect, useRef } from 'react';
import { useNpcStore } from '@/stores/npc';

// NPC SSE always goes to the Hono API server, not Next.js
const NPC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function useNpcStream() {
  const updateFromSnapshot = useNpcStore((s) => s.updateFromSnapshot);
  const setConnected = useNpcStore((s) => s.setConnected);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = `${NPC_API_URL}/api/npc/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('snapshot', (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        updateFromSnapshot(snapshot);
      } catch (err) {
        console.error('[NPC Stream] Failed to parse snapshot:', err);
      }
    });

    es.onopen = () => {
      setConnected(true);
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [updateFromSnapshot, setConnected]);
}
