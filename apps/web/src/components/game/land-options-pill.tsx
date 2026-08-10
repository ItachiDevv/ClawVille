'use client';

import type { CSSProperties } from 'react';
import { parcelDisplayName } from '@clawville/shared';
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
  const structures = useLandStore((s) => s.structures);
  const buildMode = useLandStore((s) => s.buildMode);
  const enterBuildMode = useLandStore((s) => s.enterBuildMode);
  const { data: avatar } = useAvatar();
  const isGuest = useIsGuest();
  const isMobile = useIsMobile();

  if (controlMode === 'explore') return null;
  if (chatOpen || guideChatOpen || landOfficeOpen || buildMode) return null;
  if (nearLocation) return null;
  if (!nearParcelCode) return null;

  const state = parcels.get(nearParcelCode);
  if (!state) return null;
  if (state.status === 'reserved' || state.status === 'retired') return null;

  const slot = getParcelSlotByCode(nearParcelCode);
  const tier = slot?.tier ?? null;
  const displayName = tier ? parcelDisplayName(nearParcelCode, tier) : nearParcelCode;
  const myId = (avatar as { id?: string } | null | undefined)?.id ?? null;
  const ownedByMe =
    state.status === 'owned' && !!myId && state.ownerAvatarId === myId;
  const canDecorate = ownedByMe && structures.has(nearParcelCode);

  let secondaryLine: string;
  let actionLabel: string | null;

  if (state.status === 'available') {
    secondaryLine = isGuest
      ? 'Preview the Land Office'
      : tier === 'founder'
        ? 'CLV hold door · auction allocation'
        : 'Choose CLV hold or vCLAW rent';
    actionLabel = 'View in Land Office';
  } else if (ownedByMe) {
    secondaryLine = 'Manage your land';
    actionLabel = 'Manage';
  } else {
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
    cursor: 'default',
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
        <span aria-hidden>🏝️</span> {displayName}
        {state.status === 'available' ? ' · Available' : ownedByMe ? ' · Yours' : ' · Claimed'}
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
    </>
  );

  return (
    <div style={style}>
      {content}
      {actionLabel ? (
        <span style={{ display: 'flex', gap: 8, marginTop: 5 }}>
          <button
            type="button"
            onClick={() => openLandOffice(nearParcelCode)}
            aria-label={`${actionLabel}: ${displayName} (${nearParcelCode})`}
            style={{
              minHeight: 44,
              borderRadius: 999,
              padding: '8px 16px',
              border: '1px solid rgba(125,211,252,0.42)',
              background: 'rgba(8,47,73,0.82)',
              color: '#e0f2fe',
              fontWeight: 850,
              cursor: 'pointer',
              touchAction: 'manipulation',
            }}
          >
            {actionLabel}
          </button>
          {canDecorate ? (
            <button
              type="button"
              onClick={() => enterBuildMode(nearParcelCode)}
              aria-label={`Decorate: ${displayName} (${nearParcelCode})`}
              style={{
                minHeight: 44,
                borderRadius: 999,
                padding: '8px 16px',
                border: '1px solid rgba(251,191,36,0.64)',
                background: 'rgba(180,83,9,0.74)',
                color: '#fff7ed',
                fontWeight: 900,
                cursor: 'pointer',
                touchAction: 'manipulation',
              }}
            >
              Decorate
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
