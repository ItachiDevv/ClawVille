'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KELP_REALM_SPORE_COUNT } from '@clawville/shared';
import { z } from 'zod';
import { useIsGuest } from '@/hooks/use-is-guest';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import {
  KELP_MOBILE_CLAIM_PANEL_BOTTOM,
  shouldShowKelpGuestEntryBanner,
  shouldShowKelpSporeCounter,
} from './kelp-realm-hud-layout';
import {
  KELP_COLLECTIBLE_CLAIM_SUCCESS,
  deriveKelpRealmClaimPrompt,
  describeKelpClaimFailure,
  getKelpRealmClaimSnapshot,
  setKelpRealmSporeProgress,
  subscribeKelpRealmClaimState,
} from '@/lib/three/kelp-realm-visit-state';

const KELP_API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const GUEST_ENTRY_BANNER =
  'Exploring as a guest — sign in to claim the collectible at the center';

type ClaimPhase = 'idle' | 'claiming' | 'claimed';

interface ClaimFeedback {
  readonly centerToken: string;
  readonly message: string;
}

interface KelpClaimErrorPayload {
  readonly code?: string;
  readonly found?: number;
  readonly total?: number;
}

const kelpClaimErrorPayloadSchema = z.union([
  z.object({
    code: z.literal('spores_missing'),
    found: z.number().int().min(0).max(KELP_REALM_SPORE_COUNT),
    total: z.literal(KELP_REALM_SPORE_COUNT),
  }).strict(),
  z.object({
    error: z.string().optional(),
    code: z.string().refine((code) => code !== 'spores_missing').optional(),
  }).strict(),
]);

export function parseKelpClaimErrorPayload(payload: unknown): KelpClaimErrorPayload {
  const result = kelpClaimErrorPayloadSchema.safeParse(payload);
  return result.success ? result.data : {};
}

export function KelpRealmClaimHud() {
  const queryClient = useQueryClient();
  const isGuest = useIsGuest();
  const isMobile = useIsMobile();
  const snapshot = useSyncExternalStore(
    subscribeKelpRealmClaimState,
    getKelpRealmClaimSnapshot,
    getKelpRealmClaimSnapshot,
  );
  const prompt = deriveKelpRealmClaimPrompt(snapshot, isGuest);
  const [phase, setPhase] = useState<ClaimPhase>('idle');
  const [claimFeedback, setClaimFeedback] = useState<ClaimFeedback | null>(null);
  const requestInFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const phaseRef = useRef<ClaimPhase>('idle');
  const isGuestRef = useRef(isGuest);
  const snapshotRef = useRef(snapshot);
  isGuestRef.current = isGuest;
  snapshotRef.current = snapshot;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const claimCollectible = useCallback(async () => {
    const currentSnapshot = snapshotRef.current;
    const currentPrompt = deriveKelpRealmClaimPrompt(currentSnapshot, isGuestRef.current);
    if (!currentSnapshot.nearCenter || !currentPrompt?.canClaim || !currentSnapshot.centerToken) return;
    if (requestInFlightRef.current || phaseRef.current === 'claimed') return;

    requestInFlightRef.current = true;
    phaseRef.current = 'claiming';
    setPhase('claiming');
    setClaimFeedback({
      centerToken: currentSnapshot.centerToken,
      message: 'Claiming the collectible…',
    });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`${KELP_API_BASE}/api/kelp/claim`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ centerToken: currentSnapshot.centerToken }),
        signal: controller.signal,
      });
      const rawPayload = await response.json().catch(() => null) as unknown;
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!response.ok) {
        const payload = parseKelpClaimErrorPayload(rawPayload);
        if (
          payload.code === 'spores_missing' &&
          typeof payload.found === 'number' &&
          typeof payload.total === 'number'
        ) {
          setKelpRealmSporeProgress(payload.found, payload.total);
        }
        phaseRef.current = 'idle';
        setPhase('idle');
        setClaimFeedback({
          centerToken: currentSnapshot.centerToken,
          message: describeKelpClaimFailure(
            response.status,
            payload.code,
            payload.found,
            payload.total,
          ),
        });
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ['cosmetics', 'owned'] });
      if (!mountedRef.current || controller.signal.aborted) return;
      phaseRef.current = 'claimed';
      setPhase('claimed');
      setClaimFeedback({
        centerToken: currentSnapshot.centerToken,
        message: KELP_COLLECTIBLE_CLAIM_SUCCESS,
      });
      useGameStore.getState().addToast('🫧', KELP_COLLECTIBLE_CLAIM_SUCCESS, 5000);
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted) return;
      phaseRef.current = 'idle';
      setPhase('idle');
      setClaimFeedback({
        centerToken: currentSnapshot.centerToken,
        message: error instanceof Error
          ? `The claim request could not reach the reef (${error.message}). Please try again.`
          : 'The claim request could not reach the reef. Please try again.',
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      requestInFlightRef.current = false;
    }
  }, [queryClient]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || event.repeat || !snapshotRef.current.nearCenter) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      event.preventDefault();
      void claimCollectible();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [claimCollectible]);

  const claimStatus = claimFeedback?.centerToken === snapshot.centerToken
    ? claimFeedback.message
    : null;
  // At the center, the exact guest/incomplete/ready claim state must outrank
  // an older traversal notice (for example the anonymous entry-beacon 401).
  const liveMessage = claimStatus ?? prompt?.message ?? snapshot.notice ?? null;

  return (
    <>
      {shouldShowKelpSporeCounter(snapshot.sporesTotal) && (
        <div
          role="status"
          aria-live="polite"
          aria-label={`Kelp Forest spores ${snapshot.sporesFound} of ${snapshot.sporesTotal}`}
          style={{
            position: 'fixed',
            top: isMobile ? 126 : 16,
            right: isMobile ? 16 : 20,
            zIndex: 71,
            padding: '8px 11px',
            border: '1px solid rgba(112,255,226,0.62)',
            borderRadius: 999,
            background: 'rgba(1,18,17,0.92)',
            boxShadow: '0 0 24px rgba(72,255,222,0.16)',
            color: '#d9fff7',
            font: '800 13px/1 monospace',
            pointerEvents: 'none',
          }}
        >
          Spores: {snapshot.sporesFound}/{snapshot.sporesTotal}
        </div>
      )}
      {shouldShowKelpGuestEntryBanner(isGuest, snapshot.nearCenter) && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: isMobile ? 72 : 16,
            left: '50%',
            zIndex: 70,
            maxWidth: isMobile
              ? 'calc(100vw - 32px)'
              : 'min(620px, calc(100vw - 180px))',
            transform: 'translateX(-50%)',
            padding: '10px 14px',
            border: '1px solid rgba(255,209,102,0.65)',
            borderRadius: 10,
            background: 'rgba(28,20,4,0.9)',
            color: '#ffe7a0',
            font: '700 13px/1.4 monospace',
            textAlign: 'center',
          }}
        >
          {GUEST_ENTRY_BANNER}
        </div>
      )}

      {(snapshot.notice || snapshot.nearCenter || claimStatus) && (
        <section
          aria-label="Kelp Forest collectible claim"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: isMobile
              ? KELP_MOBILE_CLAIM_PANEL_BOTTOM
              : 'max(24px, calc(env(safe-area-inset-bottom, 0px) + 16px))',
            zIndex: 70,
            width: 'min(520px, calc(100vw - 32px))',
            transform: 'translateX(-50%)',
            padding: '14px 16px',
            border: '1px solid rgba(112,255,226,0.58)',
            borderRadius: 12,
            background: 'rgba(1,18,17,0.92)',
            boxShadow: '0 0 32px rgba(72,255,222,0.18)',
            color: '#d9fff7',
            fontFamily: 'monospace',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, lineHeight: 1.45 }}>
            {liveMessage}
          </p>
          {snapshot.nearCenter && (
            <button
              type="button"
              onClick={claimCollectible}
              disabled={!prompt?.canClaim || phase !== 'idle'}
              aria-describedby="kelp-claim-state"
              style={{
                minWidth: 190,
                minHeight: 48,
                marginTop: 12,
                padding: '10px 18px',
                border: '1px solid rgba(112,255,226,0.72)',
                borderRadius: 10,
                background: prompt?.canClaim && phase === 'idle'
                  ? 'rgba(31,139,120,0.88)'
                  : 'rgba(25,64,58,0.72)',
                color: prompt?.canClaim && phase === 'idle' ? '#ffffff' : '#9bbdb6',
                font: '800 14px monospace',
                cursor: prompt?.canClaim && phase === 'idle' ? 'pointer' : 'not-allowed',
                pointerEvents: 'auto',
              }}
            >
              {phase === 'claiming'
                ? 'Claiming…'
                : phase === 'claimed'
                  ? 'Collectible claimed'
                  : 'Claim collectible'}
            </button>
          )}
          <span id="kelp-claim-state" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            {liveMessage}
          </span>
        </section>
      )}
    </>
  );
}
