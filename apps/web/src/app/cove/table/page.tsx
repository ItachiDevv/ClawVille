'use client';

import { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { HoldemControllerRuntime } from '@/lib/cove/holdem-controller';
import { SeatedHoldemHud } from '@/components/cove/holdem/SeatedHoldemHud';
import { useCoveStore } from '@/stores/cove';
import styles from '@/components/cove/holdem/SeatedHoldemHud.module.css';

const HoldemTableRoomCanvas = dynamic(
  () => import('@/lib/three/holdem-table-room'),
  {
    ssr: false,
    loading: () => (
      <div style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        background: '#100b16', color: '#f3ead8', fontFamily: 'monospace',
        fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase',
      }}>
        Preparing the table…
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'e' || event.repeat) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      event.preventDefault();
      handleBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleBack]);

  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#100b16' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <HoldemTableRoomCanvas />
      </div>

      <button
        type="button"
        onClick={handleBack}
        aria-label="Back to Cove"
        className={styles.backButton}
      >
        ← Back to Cove
      </button>

      <HoldemControllerRuntime />
      <SeatedHoldemHud />
    </main>
  );
}
