'use client';

import { useEffect, useRef } from 'react';
import { useResearchStore } from '@/stores/research';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function useResearchStream() {
  const addThought = useResearchStore((s) => s.addThought);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = `${API_URL}/api/research/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('research_thought', (event) => {
      try {
        const data = JSON.parse(event.data);
        addThought(data);
      } catch (err) {
        console.error('[Research Stream] Parse error:', err);
      }
    });

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [addThought]);
}
