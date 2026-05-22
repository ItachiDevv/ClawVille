'use client';

/**
 * /preview/slot-modal — visual verification route for the Phase 6.1.15 slot
 * rig polish (clean cells, brass cabinet + rivets, 3D pull-lever, animated
 * win highlights).
 *
 * DEV-ONLY: bypasses the cove walk-in + slot-cabinet click handler so you
 * can iterate on the modal in isolation without loading the heavy game scene
 * (the latter crashes Iris Xe).
 *
 * Hits the REAL backend `/api/casino/slots/*` so spin pacing, win cells,
 * scatters, bonus paytable switching all match production behavior.
 *
 * Switch paytables via the buttons at the top of the page — clicking either
 * re-opens the modal with that paytableId.
 */

export const dynamic = 'force-dynamic';

import { useEffect } from 'react';
import SlotScreenModal from '@/components/cove/SlotScreenModal';
import { useCoveStore } from '@/stores/cove';

type Pid = 'classic-3x5' | 'classic-3x5-bonus';

export default function SlotModalPreviewPage() {
  const slotScreenOpen = useCoveStore((s) => s.slotScreenOpen);
  const paytableId     = useCoveStore((s) => s.paytableId);
  const openSlotScreen = useCoveStore((s) => s.openSlotScreen);
  const closeSlotScreen = useCoveStore((s) => s.closeSlotScreen);

  // Auto-open with classic on first mount.
  useEffect(() => {
    if (!slotScreenOpen) {
      openSlotScreen('classic-3x5', 'classic-3x5', 1000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAs = (next: Pid) => {
    closeSlotScreen();
    // next tick so the open-edge re-fires
    setTimeout(() => openSlotScreen(next, next, 1000), 30);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #062e3b 0%, #021018 100%)',
        color: '#fdf6e3',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        padding: 20,
      }}
    >
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20 }}>
        <strong style={{ color: '#00d4ff' }}>SLOT MODAL PREVIEW</strong>
        <span style={{ opacity: 0.7 }}>Phase 6.1.15 — clean cabinet + lever</span>
        <button
          type="button"
          onClick={() => openAs('classic-3x5')}
          style={{
            padding: '6px 14px',
            background: paytableId === 'classic-3x5' ? '#ffd54f' : '#0a3a4a',
            color: paytableId === 'classic-3x5' ? '#000' : '#fdf6e3',
            border: '1px solid #00d4ff',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          CLASSIC
        </button>
        <button
          type="button"
          onClick={() => openAs('classic-3x5-bonus')}
          style={{
            padding: '6px 14px',
            background: paytableId === 'classic-3x5-bonus' ? '#ffd54f' : '#0a3a4a',
            color: paytableId === 'classic-3x5-bonus' ? '#000' : '#fdf6e3',
            border: '1px solid #00d4ff',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          BONUS
        </button>
        <button
          type="button"
          onClick={() => slotScreenOpen ? closeSlotScreen() : openAs((paytableId as Pid) ?? 'classic-3x5')}
          style={{
            padding: '6px 14px',
            background: '#062e3b',
            color: '#fdf6e3',
            border: '1px solid #fdf6e3aa',
            cursor: 'pointer',
            marginLeft: 'auto',
          }}
        >
          {slotScreenOpen ? 'CLOSE MODAL' : 'OPEN MODAL'}
        </button>
      </header>

      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 13 }}>
        Click the red ball on the right side of the cabinet to spin. Win cells
        should pop in with a marching marquee + halo throb. Switch CLASSIC ↔
        BONUS above to verify both paytables render the same polish. Requires
        an authenticated session (the real `/api/casino/slots/*` endpoints).
      </p>

      <SlotScreenModal />
    </div>
  );
}
