'use client';

import { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { HoldemControllerRuntime } from '@/lib/cove/holdem-controller';
import { SeatedHoldemHud } from '@/components/cove/holdem/SeatedHoldemHud';
import { useCoveStore } from '@/stores/cove';

const HoldemTableRoomCanvas = dynamic(
  () => import('@/lib/three/holdem-table-room'),
  {
    ssr: false,
    loading: () => (
      <div style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        background: '#100b16', color: '#d8e8dc', fontFamily: 'monospace',
      }}>
        Loading table room…
      </div>
    ),
  },
);

export default function HoldemTableRoomPage() {
  const router = useRouter();
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const wasSeatedRef = useRef(false);

  useEffect(() => {
    useCoveStore.getState().sitAtTable('T1', 0);
    return () => { useCoveStore.getState().standFromTable(); };
  }, []);

  useEffect(() => {
    if (seatedTable?.tableId === 'T1') {
      wasSeatedRef.current = true;
      return;
    }
    if (wasSeatedRef.current) router.push('/cove');
  }, [router, seatedTable]);

  const handleBack = useCallback(() => {
    useCoveStore.getState().standFromTable();
    router.push('/cove');
  }, [router]);

  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <HoldemTableRoomCanvas />
      </div>

      <button
        type="button"
        onClick={handleBack}
        aria-label="Back to Cove"
        style={{
          position: 'absolute', top: 'max(16px, env(safe-area-inset-top))', left: 16,
          zIndex: 60, minHeight: 44, padding: '0 16px', borderRadius: 8,
          border: '1px solid rgba(60,180,120,0.32)', background: 'rgba(8,14,18,0.88)',
          color: '#d8e8dc', fontFamily: 'monospace', fontSize: 13, fontWeight: 700,
          cursor: 'pointer', backdropFilter: 'blur(6px)',
        }}
      >
        ← Back to Cove
      </button>

      <HoldemControllerRuntime />
      <SeatedHoldemHud />
    </main>
  );
}
