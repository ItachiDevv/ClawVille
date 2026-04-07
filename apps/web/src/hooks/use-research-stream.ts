'use client';

import { useEffect, useRef } from 'react';
import { useResearchStore } from '@/stores/research';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

export function useResearchStream() {
  const addThought = useResearchStore((s) => s.addThought);
  const retriesRef = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled || retriesRef.current >= MAX_RETRIES) return;

      const url = `${API_URL}/api/research/stream`;
      es = new EventSource(url);

      es.addEventListener('research_thought', (event) => {
        try {
          retriesRef.current = 0;
          const data = JSON.parse(event.data);
          addThought(data);
        } catch { /* ignore */ }
      });

      es.onerror = () => {
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
    };
  }, [addThought]);
}
