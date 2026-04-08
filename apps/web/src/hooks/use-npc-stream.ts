'use client';

import { useEffect, useRef } from 'react';
import { useNpcStore } from '@/stores/npc';

const NPC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

export function useNpcStream() {
  const updateFromSnapshot = useNpcStore((s) => s.updateFromSnapshot);
  const setConnected = useNpcStore((s) => s.setConnected);
  const retriesRef = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled || retriesRef.current >= MAX_RETRIES) return;

      const url = `${NPC_API_URL}/api/npc/stream`;
      es = new EventSource(url);

      es.addEventListener('snapshot', (event) => {
        try {
          retriesRef.current = 0;
          const snapshot = JSON.parse(event.data);
          if (snapshot.npcs?.length > 0) {
            setConnected(true);
            updateFromSnapshot(snapshot);
          }
        } catch { /* ignore parse errors */ }
      });

      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        retriesRef.current++;
        if (!cancelled && retriesRef.current < MAX_RETRIES) {
          retryTimeout = setTimeout(connect, RETRY_DELAY);
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
  }, [updateFromSnapshot, setConnected]);
}
