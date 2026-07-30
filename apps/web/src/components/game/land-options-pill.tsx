'use client';

import type { CSSProperties } from 'react';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { getParcelSlotByCode } from '@/lib/land-proximity';
import { useGameStore, type GameState } from '@/stores/game';
import { useLandStore } from '@/stores/land';

export default function LandOptionsPill() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const nearLocation = useGameStore((s: GameState) => s.nearLocation);
  const nearParcelCode = useGameStore((s: GameState) => s.nearParcelCode);
  const chatOpen = useGameStore((s: GameState) => s.chatOpen);
  const guideChatOpen = useGameStore((s: GameState) => s.guideChatOpen);
  const landOfficeOpen = useGameStore((s: GameState) => s.landOfficeOpen);
  const openLandOffice = useGameStore((s: GameState) => s.openLandOffice);
  const parcels = useLandStore((s) => s.parcels);
  const { data: avatar } = useAvatar();
  const isGuest = useIsGuest();
  const isMobile = useIsMobile();

  if (controlMode === 'explore') return null;
  if (chatOpen || guideChatOpen || landOfficeOpen) return null;
  if (nearLocation) return null;
  if (!nearParcelCode) return null;

  const state = parcels.get(nearParcelCode);
  if (!state) return null;
  if (state.status === 'reserved' || state.status === 'retired') return null;

  const slot = getParcelSlotByCode(nearParcelCode);
  const tier = slot?.tier ?? null;
  const myId = (avatar as { id?: string } | null | undefined)?.id ?? null;
  const ownedByMe =
    state.status === 'owned'
    && !!myId
    && state.ownerAvatarId === myId;

  let titlePrefix: string;
  let secondaryLine: string;
  let actionLabel: string | null;

  if (state.status === 'available') {
    titlePrefix = 'Parcel';
    secondaryLine = isGuest
      ? 'Preview the Land Office'
      : tier === 'starter'
        ? 'Refundable vCLAW deposit'
        : 'Hold $CLAWVILLE to keep';
    actionLabel = 'View in Land Office';
  } else if (ownedByMe) {
    titlePrefix = 'Your parcel';
    secondaryLine = 'Manage your land';
    actionLabel = 'Manage';
  } else {
    titlePrefix = 'Claimed parcel';
    secondaryLine = 'Someone already holds this lot';
    actionLabel = null;
  }

  const hasBottomChatBar =
    controlMode === 'player' || controlMode === 'autonomous';
  // Keep character-identical with location-hud.tsx:95 when that formula changes.
  const bottomOffset = isMobile
    ? 'max(calc(env(safe-area-inset-bottom, 0px) + 220px), 240px)'
    : `calc(env(safe-area-inset-bottom, 0px) + ${hasBottomChatBar ? 84 : 36}px)`;

  const style: CSSProperties = {
    position: 'fixed',
    bottom: bottomOffset,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 45,
    minWidth: 280,
    maxWidth: 'min(420px, calc(100vw - 32px))',
    borderRadius: 999,
    padding: '14px 28px',
    background:
      'linear-gradient(135deg, rgba(8,28,52,0.96) 0%, rgba(14,52,96,0.96) 100%)',
    border: '1.5px solid rgba(251, 191, 36, 0.55)',
    boxShadow:
      '0 0 0 1px rgba(251,191,36,0.2), 0 18px 44px -10px rgba(251,191,36,0.4), 0 0 38px rgba(251,191,36,0.3)',
    color: '#e0f2fe',
    cursor: actionLabel ? 'pointer' : 'default',
    textAlign: 'center',
    touchAction: 'manipulation',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    backdropFilter: 'blur(8px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    font: 'inherit',
  };

  const content = (
    <>
      <span
        style={{
          color: '#fff',
          fontSize: 16,
          fontWeight: 800,
          lineHeight: 1.25,
        }}
      >
        <span aria-hidden>🏝️</span>{' '}
        {titlePrefix}{' '}
        <code style={{ color: '#fff', fontFamily: 'inherit', fontWeight: 800 }}>
          {nearParcelCode}
        </code>
        {state.status === 'available' ? ' · Available' : null}
      </span>
      <span
        style={{
          color: 'rgba(253, 230, 138, 0.85)',
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.25,
        }}
      >
        {secondaryLine}
      </span>
      {actionLabel && (
        <span
          style={{
            color: '#e0f2fe',
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '0.08em',
            lineHeight: 1.25,
            textTransform: 'uppercase',
          }}
        >
          {actionLabel}
        </span>
      )}
    </>
  );

  if (!actionLabel) {
    return <div style={style}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={() => openLandOffice(nearParcelCode)}
      aria-label={`${actionLabel}: ${nearParcelCode}`}
      style={style}
    >
      {content}
    </button>
  );
}
