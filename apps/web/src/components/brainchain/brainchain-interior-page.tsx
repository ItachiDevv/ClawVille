'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { BrainchainOffice } from './brainchain-office';
import { useBrainchainInteriorStore } from './brainchain-interior-store';
import TradingFloorMobileControls from '@/components/trading-floor/TradingFloorMobileControls';
import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { getStageRendererFailure, getStageRendererFailureServerSnapshot, subscribeStageRendererFailure } from '@/components/three/world-stage/stage-renderer-status';
import { releaseBootSplash } from '@/components/three/world-stage/boot-splash';
import { useWorldRendererMode } from '@/lib/world-renderer-mode';
import { placeAtBrainchainOfficeExit } from '@/lib/three/brainchain-office-transition';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useAvatar } from '@/hooks/use-avatar';
import { BRAINCHAIN_STATIONS } from '@/lib/three/brainchain/brainchain-room';
import { USE_BUTTON_BOTTOM_CSS } from '@/components/trading-floor/trading-floor-touch-layout';
import { useGameStore } from '@/stores/game';

export function BrainchainInteriorPage() {
  const router = useRouter();
  const mode = useWorldRendererMode();
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();
  const nearbyStation = useBrainchainInteriorStore((state) => state.nearbyStation);
  const section = useBrainchainInteriorStore((state) => state.section);
  const teacherFocus = useBrainchainInteriorStore((state) => state.teacherFocus);
  const exitRequest = useBrainchainInteriorStore((state) => state.exitRequest);
  const failed = useBrainchainInteriorStore((state) => state.failed);
  const exitSeen = useRef(exitRequest);
  const failure = useSyncExternalStore(subscribeStageRendererFailure, getStageRendererFailure, getStageRendererFailureServerSnapshot);
  const transitionError = useStageStore((state) => state.transition?.phase === 'error');
  const fallback = mode === '2d' || !!failure || failed || transitionError;
  const close = useBrainchainInteriorStore((state) => state.close);
  useEffect(() => { releaseBootSplash(); }, []);
  useEffect(() => {
    if (avatar) useGameStore.getState().setAvatarAppearance(avatar.species, avatar.color, undefined, avatar.modelKey);
  }, [avatar]);
  useEffect(() => () => close(), [close]);
  useEffect(() => {
    if (!section) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [section, close]);
  useEffect(() => {
    if (!section) return;
    const target = teacherFocus > 0 ? document.getElementById('office-question') ?? document.getElementById('office-teacher') : document.querySelector<HTMLElement>('[aria-label="Close Office"]');
    target?.scrollIntoView({ block: 'center' });
    target?.focus();
  }, [section, teacherFocus]);
  const back = useCallback(() => {
    close();
    document.body.style.cursor = 'default';
    const requested = requestWorldStageNavigation({ to: '/game', onMidway: placeAtBrainchainOfficeExit,
      onExpired: () => { if (window.location.pathname === '/brainchain') { placeAtBrainchainOfficeExit(); router.push('/game'); } },
    });
    if (!requested) { placeAtBrainchainOfficeExit(); router.push('/game'); }
  }, [close, router]);
  useEffect(() => { if (exitSeen.current !== exitRequest) { exitSeen.current = exitRequest; back(); } }, [exitRequest, back]);
  const interact = useCallback(() => {
    // Keep Three.js out of the full-screen 2D panel bundle.
    void import('@/lib/three/brainchain/brainchain-interior').then(({ activateBrainchainUse }) => activateBrainchainUse());
  }, []);
  if (fallback) return <div style={{ height: '100%', position: 'relative', pointerEvents: 'auto' }}>
    {mode !== '2d' && <button type="button" onClick={() => window.location.reload()} style={{ position: 'absolute', right: 18, bottom: 18, zIndex: 80, minHeight: 44, padding: '10px 18px', background: '#f386a1', color: '#0b0b0b', borderRadius: 8 }}>Retry 3D view</button>}
    <BrainchainOffice />
  </div>;
  return <div className="game-container" style={{ background: 'transparent', color: '#f8f7f4', pointerEvents: 'none', fontFamily: 'var(--font-geist), sans-serif' }}>
    <button type="button" onClick={back} style={{ position: 'absolute', top: 'max(16px, env(safe-area-inset-top))', left: 16, zIndex: 50, minHeight: 44, padding: '10px 18px', border: '1px solid #f386a1', borderRadius: 10, background: '#1d1d1d', color: '#f8f7f4', pointerEvents: 'auto' }}>Back to town</button>
    {!section && <TradingFloorMobileControls onUse={interact} accent="#f386a1" foreground="#f8f7f4" showUse={false} />}
    {!section && isMobile && nearbyStation !== null && <div style={{ position: 'fixed', right: 16, bottom: USE_BUTTON_BOTTOM_CSS, zIndex: 51, height: 76, width: 'min(440px, calc(100vw - 180px))', display: 'flex', gap: 8, pointerEvents: 'auto' }}>
      <button type="button" onClick={interact} style={{ flex: 1, minWidth: 44, minHeight: 44, border: '1px solid #f386a1', borderRadius: 10, padding: 6, background: '#1d1d1d', color: '#f8f7f4', fontSize: 12 }}>{BRAINCHAIN_STATIONS[nearbyStation]?.label}<br />Tap to open</button>
      {nearbyStation === 0 && <button type="button" onClick={useBrainchainInteriorStore.getState().talk} style={{ flex: 1, minWidth: 44, minHeight: 44, borderRadius: 10, padding: 6, background: '#f386a1', color: '#0b0b0b', fontSize: 12 }}>Talk to Cortex</button>}
    </div>}
    {!section && !isMobile && <div style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', padding: '10px 18px', background: '#1d1d1de6', borderRadius: 8, whiteSpace: 'nowrap' }}>BrainChain Office | WASD to walk | E at a station</div>}
    {section && <div role="dialog" aria-modal="true" aria-label="BrainChain Office" onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter((item) => item.getClientRects().length > 0);
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} style={{ position: 'absolute', inset: isMobile ? 'max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom))' : '5% 7%', zIndex: 70, border: '1px solid #f386a1', borderRadius: 14, overflow: 'hidden', pointerEvents: 'auto', boxShadow: '0 24px 100px #000b' }}>
      <BrainchainOffice initialSection={section} windowed onClose={close} />
    </div>}
  </div>;
}
