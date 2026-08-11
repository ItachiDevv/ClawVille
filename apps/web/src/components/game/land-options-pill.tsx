'use client';

import type { CSSProperties } from 'react';
import { parcelDisplayName } from '@clawville/shared';
import { useAvatar } from '@/hooks/use-avatar';
import {
  bottomPromptOffset,
  useBottomPromptOwner,
} from '@/hooks/use-bottom-prompt-slot';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { getParcelSlotByCode } from '@/lib/land-proximity';
import { availableLotDoorCaption, tierDoorModel } from '@/lib/land-tenure-doors';
import { useGameStore, type GameState } from '@/stores/game';
import { useLandStore } from '@/stores/land';

export default function LandOptionsPill() {
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const nearParcelCode = useGameStore((s: GameState) => s.nearParcelCode);
  const openLandOffice = useGameStore((s: GameState) => s.openLandOffice);
  const parcels = useLandStore((s) => s.parcels);
  const structures = useLandStore((s) => s.structures);
  const enterBuildMode = useLandStore((s) => s.enterBuildMode);
  const { data: avatar } = useAvatar();
  const isGuest = useIsGuest();
  const isMobile = useIsMobile();
  // ONE authority for the bottom-centre slot (hooks/use-bottom-prompt-slot):
  // explore mode, the chat panels, the Land Office modal, the yard editor, and
  // the building-vs-parcel priority all resolve there. Standing on a lot you
  // own now hands this pill the slot ahead of the building prompt.
  const promptOwner = useBottomPromptOwner();

  if (promptOwner !== 'parcel') return null;
  // Narrowing only — `promptOwner === 'parcel'` already implies this.
  if (!nearParcelCode) return null;

  const state = parcels.get(nearParcelCode);
  if (!state) return null;
  if (state.status === 'reserved' || state.status === 'retired') return null;

  const slot = getParcelSlotByCode(nearParcelCode);
  const tier = slot?.tier ?? null;
  const displayName = tier ? parcelDisplayName(nearParcelCode, tier) : nearParcelCode;
  const myId = (avatar as { id?: string } | null | undefined)?.id ?? null;
  // Same derivation the slot arbiter uses for `nearParcelOwnedByViewer`
  // (hooks/use-bottom-prompt-slot) — same store, same avatar query, so the two
  // cannot disagree. This copy drives the CTA and the caption; that one decides
  // whether this pill outranks the building prompt. Change both together.
  const ownedByMe =
    state.status === 'owned' && !!myId && state.ownerAvatarId === myId;
  const canDecorate = ownedByMe && structures.has(nearParcelCode);

  let secondaryLine: string;
  let actionLabel: string | null;

  if (state.status === 'available') {
    // DERIVED from the ONE door model (lib/land-tenure-doors), the same model
    // the claim card renders its doors from. The caption used to hand-write
    // "Choose CLV hold or vCLAW rent" for every non-founder tier, which
    // promised a rent door to tiers b and a that have none — and captioned
    // Founders' Row as "auction allocation" while the card under it rendered a
    // working Claim-with-hold button.
    secondaryLine = isGuest
      ? 'Preview the Land Office'
      : availableLotDoorCaption(tierDoorModel(tier));
    actionLabel = 'View in Land Office';
  } else if (ownedByMe) {
    // "Open Land Office", not "Manage": inside the modal "Manage building"
    // opens the Build tab, so one word meaning two destinations was the exact
    // confusion this pass exists to remove. This button opens the office on
    // THIS lot; the modal's button manages the building on it.
    secondaryLine = canDecorate
      ? 'Open the Land Office, or decorate the yard here'
      : 'Open the Land Office for this lot';
    actionLabel = 'Open Land Office';
  } else {
    // A lot held by ANOTHER resident. This branch used to render no button at
    // all, which left the Land Office's "held by another resident" panel
    // reachable only from a console `openLandOffice(code)` call: a state we
    // built that no player could open. The action is a LOOKUP, not a claim, so
    // the caption says so and the button only opens the office on this lot.
    // One short line on purpose: the slot's top reserve
    // (hooks/use-bottom-prompt-slot) is derived from a two-line pill, so a
    // wrapping third line would push this pill under the control-mode toggle.
    secondaryLine = 'Someone else holds this lot. You can look it up.';
    actionLabel = 'Open Land Office';
  }

  // Shared with the building prompt + salvage pill so all three sit on exactly
  // the same line. See hooks/use-bottom-prompt-slot.
  const bottomOffset = bottomPromptOffset(isMobile, controlMode);

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
