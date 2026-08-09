'use client';

/**
 * salvage-gather-pill.tsx — proximity "Press E / Tap · Gather" affordance for
 * seabed salvage nodes (Land gamification P7b, §2.2/§2.5).
 *
 * Mirrors location-hud.tsx's bottom-center action-pill pattern (same
 * positioning formula, same Press-E/Tap language) and KelpRealmClaimHud's
 * claim-request flow (idempotency key + retry-once-on-conflict, guest gate,
 * typed error → copy). Hidden whenever a building or parcel prompt would
 * otherwise occupy the same slot — `nearLocation`/`nearParcelCode` take
 * precedence so the two pills never stack.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { api, ApiError } from '@/lib/api';
import { LAND_SALVAGE_REFRESH_EVENT } from '@/lib/land-query-keys';
import {
  freshSalvageIdempotencyKey,
  isSalvageIdempotencyConflict,
  salvageClaimErrorMessage,
} from '@/lib/land-salvage-client';
import { getSalvageNodeById } from '@/lib/three/land-salvage-nodes';
import { useGameStore } from '@/stores/game';
import { isSalvageNodeClaimable, useSalvageStore } from '@/stores/salvage';

type ClaimPhase = 'idle' | 'claiming';

const LOOK_LABEL: Readonly<Record<string, string>> = {
  shells: 'a shell pile',
  driftwood: 'driftwood',
  coral: 'a coral cluster',
};
const LOOK_ICON: Readonly<Record<string, string>> = {
  shells: '🐚',
  driftwood: '🪵',
  coral: '🪸',
};

function cooldownLabel(nextClaimAtMs: number): string {
  const remainingMs = nextClaimAtMs - Date.now();
  if (remainingMs <= 0) return 'Recovering…';
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.ceil((remainingMs % 3_600_000) / 60_000);
  if (hours >= 1) return `Recovers in ~${hours}h`;
  return `Recovers in ~${Math.max(1, minutes)}m`;
}

export default function SalvageGatherPill() {
  const controlMode = useGameStore((s) => s.controlMode);
  const nearSalvageNodeId = useGameStore((s) => s.nearSalvageNodeId);
  const nearLocation = useGameStore((s) => s.nearLocation);
  const nearParcelCode = useGameStore((s) => s.nearParcelCode);
  const chatOpen = useGameStore((s) => s.chatOpen);
  const guideChatOpen = useGameStore((s) => s.guideChatOpen);
  const landOfficeOpen = useGameStore((s) => s.landOfficeOpen);
  const addToast = useGameStore((s) => s.addToast);
  const nodeCooldowns = useSalvageStore((s) => s.nodeCooldowns);
  const applyClaimResult = useSalvageStore((s) => s.applyClaimResult);
  const isGuest = useIsGuest();
  const isMobile = useIsMobile();

  const [phase, setPhase] = useState<ClaimPhase>('idle');
  const requestInFlightRef = useRef(false);
  const nearNodeIdRef = useRef<string | null>(nearSalvageNodeId);
  nearNodeIdRef.current = nearSalvageNodeId;
  const isGuestRef = useRef(isGuest);
  isGuestRef.current = isGuest;

  const claimNode = useCallback(async () => {
    const nodeId = nearNodeIdRef.current;
    if (!nodeId || requestInFlightRef.current) return;
    if (isGuestRef.current) {
      addToast('🐚', 'Sign in to keep what you salvage.', 3600);
      return;
    }
    if (!isSalvageNodeClaimable(useSalvageStore.getState().nodeCooldowns, nodeId)) return;

    requestInFlightRef.current = true;
    setPhase('claiming');
    const attempt = (idempotencyKey: string) =>
      api.claimSalvageNode(nodeId, { idempotencyKey });
    try {
      let response;
      try {
        response = await attempt(freshSalvageIdempotencyKey());
      } catch (error) {
        if (!isSalvageIdempotencyConflict(error)) throw error;
        response = await attempt(freshSalvageIdempotencyKey());
      }
      applyClaimResult({
        nodeId,
        nextClaimAt: response.nextClaimAt,
        materialBalance: response.balanceAfter,
        avatarClaims: response.avatarClaims,
        ownerClaims: response.ownerClaims,
        receipt: {
          nodeId,
          materialsGranted: response.materialsGranted,
          flavour: response.flavour,
          claimedAt: new Date().toISOString(),
        },
      });
      addToast(
        '🐚',
        `+${response.materialsGranted} material${response.materialsGranted === 1 ? '' : 's'} salvaged`,
        3200,
      );
      window.dispatchEvent(new Event(LAND_SALVAGE_REFRESH_EVENT));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        addToast('🐚', 'Sign in to keep what you salvage.', 3600);
      } else {
        addToast('⚠️', salvageClaimErrorMessage(error), 3600);
      }
      // A refusal (cooldown/cap/etc.) may mean our client-side view is stale
      // (another tab, another avatar under the same owner) — reconcile.
      window.dispatchEvent(new Event(LAND_SALVAGE_REFRESH_EVENT));
    } finally {
      requestInFlightRef.current = false;
      setPhase('idle');
    }
  }, [addToast, applyClaimResult]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat || !nearNodeIdRef.current) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      event.preventDefault();
      void claimNode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [claimNode]);

  if (controlMode === 'explore') return null;
  if (chatOpen || guideChatOpen || landOfficeOpen) return null;
  // Building/parcel prompts occupy the same bottom-center slot — they win.
  if (nearLocation || nearParcelCode) return null;
  if (!nearSalvageNodeId) return null;

  const node = getSalvageNodeById(nearSalvageNodeId);
  if (!node) return null;
  const claimable = isSalvageNodeClaimable(nodeCooldowns, nearSalvageNodeId);
  const nextClaimAtMs = nodeCooldowns.get(nearSalvageNodeId) ?? 0;

  const hasBottomChatBar = controlMode === 'player' || controlMode === 'autonomous';
  const bottomOffset = isMobile
    ? 'max(calc(env(safe-area-inset-bottom, 0px) + 220px), 240px)'
    : `calc(env(safe-area-inset-bottom, 0px) + ${hasBottomChatBar ? 84 : 36}px)`;

  return (
    <button
      type="button"
      onClick={() => void claimNode()}
      disabled={!claimable || phase === 'claiming'}
      aria-label={claimable ? `Gather ${LOOK_LABEL[node.look] ?? 'salvage'}` : cooldownLabel(nextClaimAtMs)}
      style={{
        position: 'fixed',
        bottom: bottomOffset,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 45,
        minWidth: 260,
        minHeight: 44,
        maxWidth: 'min(420px, calc(100vw - 32px))',
        padding: '14px 28px',
        borderRadius: 999,
        background: claimable
          ? 'linear-gradient(135deg, rgba(6,32,26,0.96) 0%, rgba(11,58,48,0.96) 100%)'
          : 'linear-gradient(135deg, rgba(18,22,28,0.92) 0%, rgba(28,32,40,0.92) 100%)',
        border: claimable
          ? '1.5px solid rgba(94,234,212,0.6)'
          : '1.5px solid rgba(148,163,184,0.35)',
        boxShadow: claimable
          ? '0 0 0 1px rgba(94,234,212,0.2), 0 18px 44px -10px rgba(94,234,212,0.4), 0 0 38px rgba(94,234,212,0.28)'
          : 'none',
        color: '#e0f2fe',
        cursor: claimable && phase !== 'claiming' ? 'pointer' : 'not-allowed',
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
      }}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: claimable ? 'rgba(153, 246, 228, 0.85)' : 'rgba(186,196,210,0.7)',
          textTransform: 'uppercase',
        }}
      >
        {claimable ? (isMobile ? 'Tap' : 'Press E') + ' · Salvage' : 'Salvage'}
      </span>
      <span
        style={{
          fontSize: 18,
          fontWeight: 800,
          color: claimable ? '#fff' : 'rgba(226,232,240,0.65)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span aria-hidden style={{ fontSize: 22 }}>{LOOK_ICON[node.look] ?? '🐚'}</span>
        {phase === 'claiming'
          ? 'Gathering…'
          : claimable
            ? `Gather ${LOOK_LABEL[node.look] ?? 'salvage'}`
            : cooldownLabel(nextClaimAtMs)}
      </span>
    </button>
  );
}
