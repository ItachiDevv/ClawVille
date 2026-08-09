'use client';

/**
 * salvage-gather-pill.tsx — proximity gather affordance for seabed salvage
 * nodes (Land gamification P7a/P7b).
 *
 * ONE gather gesture (Press E / Tap) drives the WHOLE approach->claim
 * sequence as a single continuous action, per the frozen contract:
 *   1. POST /:nodeId/approach every ~1s with the live centered position
 *      (`salvageApproachPositionRef`). `anchor_pending`/`dwell_pending` are
 *      the EXPECTED steady state during the ~2s dwell — polled silently,
 *      not surfaced as errors ("gathering...", not a bug).
 *   2. Once an `approachToken` is issued, immediately POST /:nodeId/claim
 *      with it plus ONE idempotency key generated at gesture start (reused
 *      across any retry within the same gesture, per the frozen contract's
 *      "reuse on retry or it double-pays").
 * The whole sequence shows as one "Gathering..." state; it resolves into a
 * materials toast or a specific failure toast, never a silent hang (a
 * bounded attempt budget aborts a stuck sequence with a clear message).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SALVAGE_APPROACH_DWELL_MS } from '@clawville/shared';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { api, ApiError } from '@/lib/api';
import { LAND_SALVAGE_REFRESH_EVENT } from '@/lib/land-query-keys';
import {
  freshSalvageIdempotencyKey,
  isApproachInProgress,
  isSalvageIdempotencyConflict,
  isSalvageTokenInvalid,
  salvageApproachErrorMessage,
  salvageClaimErrorMessage,
} from '@/lib/land-salvage-client';
import { getSalvageNodeById, salvageApproachPositionRef, salvageNodeLook } from '@/lib/three/land-salvage-nodes';
import { useGameStore } from '@/stores/game';
import { isSalvageNodeClaimable, useSalvageStore } from '@/stores/salvage';

type GatherPhase = 'idle' | 'gathering';

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

// Bounds one gather gesture's approach-poll loop. At ~1 attempt/s this is a
// generous window over the real ~2s dwell + some margin for jitter/retry —
// past it something is genuinely wrong (walked off, poisoned a long time),
// so the sequence aborts with a clear message instead of polling forever.
const APPROACH_MAX_ATTEMPTS = 15;
const APPROACH_POLL_INTERVAL_MS = 1000;

/**
 * The "Gathering…" fill-bar duration — the real server-tracked dwell
 * (`SALVAGE_APPROACH_DWELL_MS`, 2s) plus a fixed buffer for the anchor-
 * establish poll (attempt 1 almost always returns `anchor_pending` before
 * the dwell clock even starts) and normal request latency. This is a VISUAL
 * approximation only — the server is the sole authority on when the token
 * actually issues; the bar is deliberately not exactly synced to it so a
 * slow network doesn't make the animation finish before the token exists,
 * which would read as more broken than an approximate fill.
 */
const GATHER_FILL_DURATION_MS = SALVAGE_APPROACH_DWELL_MS + 800;

function cooldownLabel(nextClaimAtMs: number): string {
  const remainingMs = nextClaimAtMs - Date.now();
  if (remainingMs <= 0) return 'Recovering…';
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.ceil((remainingMs % 3_600_000) / 60_000);
  if (hours >= 1) return `Recovers in ~${hours}h`;
  return `Recovers in ~${Math.max(1, minutes)}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const [phase, setPhase] = useState<GatherPhase>('idle');
  const requestInFlightRef = useRef(false);
  /** Bumped whenever the gathered node changes — a running loop checks this to abort if the player walks away or a new gesture starts. */
  const gestureIdRef = useRef(0);
  const nearNodeIdRef = useRef<string | null>(nearSalvageNodeId);
  nearNodeIdRef.current = nearSalvageNodeId;
  const isGuestRef = useRef(isGuest);
  isGuestRef.current = isGuest;

  // Walking away mid-gather aborts the in-flight sequence — bump the
  // gesture id so the running loop's staleness check fails on its next tick.
  useEffect(() => {
    if (nearSalvageNodeId === null) gestureIdRef.current += 1;
  }, [nearSalvageNodeId]);

  const gather = useCallback(async () => {
    const nodeId = nearNodeIdRef.current;
    if (!nodeId || requestInFlightRef.current) return;
    if (isGuestRef.current) {
      addToast('🐚', 'Sign in to keep what you salvage.', 3600);
      return;
    }
    if (!isSalvageNodeClaimable(useSalvageStore.getState().nodeCooldowns, nodeId)) return;

    const myGestureId = ++gestureIdRef.current;
    const idempotencyKey = freshSalvageIdempotencyKey();
    requestInFlightRef.current = true;
    setPhase('gathering');

    try {
      let approachToken: string | null = null;
      for (let attempt = 0; attempt < APPROACH_MAX_ATTEMPTS; attempt++) {
        if (gestureIdRef.current !== myGestureId) return; // walked away / superseded
        try {
          const response = await api.approachSalvageNode(nodeId, {
            x: salvageApproachPositionRef.x,
            z: salvageApproachPositionRef.z,
          });
          approachToken = response.approachToken;
          break;
        } catch (error) {
          if (isApproachInProgress(error)) {
            await sleep(APPROACH_POLL_INTERVAL_MS);
            continue;
          }
          // A real problem (out_of_range/movement_poisoned/impossible_movement/
          // node_unknown/rate_limited) — not the expected in-dwell state.
          addToast('⚠️', salvageApproachErrorMessage(error), 3600);
          return;
        }
      }
      if (gestureIdRef.current !== myGestureId) return;
      if (!approachToken) {
        addToast('⚠️', "Couldn't get close enough — try again.", 3600);
        return;
      }

      const attemptClaim = (token: string) =>
        api.claimSalvageNode(nodeId, { approachToken: token, idempotencyKey });
      let claimResponse;
      try {
        claimResponse = await attemptClaim(approachToken);
      } catch (error) {
        if (isSalvageIdempotencyConflict(error)) {
          addToast('⚠️', 'Try again.', 3200);
          return;
        }
        if (isSalvageTokenInvalid(error)) {
          // The 20s token window lapsed between issuance and the claim POST
          // (or was consumed by a concurrent tab) — re-approach ONCE, fresh.
          try {
            const reapproach = await api.approachSalvageNode(nodeId, {
              x: salvageApproachPositionRef.x,
              z: salvageApproachPositionRef.z,
            });
            claimResponse = await attemptClaim(reapproach.approachToken);
          } catch (retryError) {
            addToast('⚠️', salvageClaimErrorMessage(retryError), 3600);
            return;
          }
        } else {
          addToast('⚠️', salvageClaimErrorMessage(error), 3600);
          return;
        }
      }

      applyClaimResult(claimResponse);
      addToast(
        '🐚',
        `+${claimResponse.materialsGranted} material${claimResponse.materialsGranted === 1 ? '' : 's'} salvaged`,
        3200,
      );
      window.dispatchEvent(new Event(LAND_SALVAGE_REFRESH_EVENT));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        addToast('🐚', 'Sign in to keep what you salvage.', 3600);
      } else {
        addToast('⚠️', "Couldn't gather that — try again.", 3600);
      }
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
      void gather();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gather]);

  if (controlMode === 'explore') return null;
  if (chatOpen || guideChatOpen || landOfficeOpen) return null;
  // Building/parcel prompts occupy the same bottom-center slot — they win.
  if (nearLocation || nearParcelCode) return null;
  if (!nearSalvageNodeId) return null;

  const node = getSalvageNodeById(nearSalvageNodeId);
  if (!node) return null;
  const look = salvageNodeLook(node.band);
  const claimable = isSalvageNodeClaimable(nodeCooldowns, nearSalvageNodeId);
  const nextClaimAtMs = nodeCooldowns.get(nearSalvageNodeId) ?? 0;

  const hasBottomChatBar = controlMode === 'player' || controlMode === 'autonomous';
  const bottomOffset = isMobile
    ? 'max(calc(env(safe-area-inset-bottom, 0px) + 220px), 240px)'
    : `calc(env(safe-area-inset-bottom, 0px) + ${hasBottomChatBar ? 84 : 36}px)`;

  return (
    <button
      type="button"
      onClick={() => void gather()}
      disabled={!claimable || phase === 'gathering'}
      aria-label={claimable ? `Gather ${LOOK_LABEL[look] ?? 'salvage'}` : cooldownLabel(nextClaimAtMs)}
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
        cursor: claimable && phase !== 'gathering' ? 'pointer' : 'not-allowed',
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
        <span aria-hidden style={{ fontSize: 22 }}>{LOOK_ICON[look] ?? '🐚'}</span>
        {phase === 'gathering'
          ? 'Gathering…'
          : claimable
            ? `Gather ${LOOK_LABEL[look] ?? 'salvage'}`
            : cooldownLabel(nextClaimAtMs)}
      </span>
      {phase === 'gathering' && (
        <span
          aria-hidden
          style={{
            width: '100%',
            height: 4,
            marginTop: 2,
            borderRadius: 999,
            background: 'rgba(94,234,212,0.15)',
            overflow: 'hidden',
          }}
        >
          {/* Keyed by the gesture id so a retry (or the auto re-approach on
              an expired token) gets a FRESH DOM node and the CSS animation
              restarts from 0% instead of staying visually stuck at 100%. */}
          <span
            key={gestureIdRef.current}
            style={{
              display: 'block',
              height: '100%',
              borderRadius: 999,
              background: 'rgba(94,234,212,0.85)',
              animation: `cv-salvage-gather-fill ${GATHER_FILL_DURATION_MS}ms linear forwards`,
            }}
          />
        </span>
      )}
      <style jsx>{`
        @keyframes cv-salvage-gather-fill {
          from { width: 4%; }
          to { width: 96%; }
        }
      `}</style>
    </button>
  );
}
