'use client';

/**
 * local-player-model-fallback.tsx
 *
 * The LOCAL player's own body when its model failed every request retry
 * (player-avatar.tsx PlayerAvatarRouter in Player mode, arena-npcs.tsx
 * BootActorNpcBody for the possessed NPC-mode body). Rendered as the
 * `fallback` of that body's ModelLoadBoundary:
 *
 * 1. Shows the default lobster body (`children`) inside its OWN
 *    ModelLoadBoundary: if the lobster also fails, it renders nothing (the
 *    player is invisible) instead of crashing the world canvas.
 * 2. Releases the failed boot-actor claim exactly once (per epoch claim
 *    token) and only when the lobster body has COMMITTED (a sibling effect
 *    inside the same Suspense, which runs only after every child resolved),
 *    when the lobster itself failed, or when this fallback unmounts before
 *    either (deferred one tick so a StrictMode simulated unmount + re-mount
 *    does not release early). The reveal never runs with no body while the
 *    lobster is still loading, and never waits for the 8 s deadline.
 * 3. Shows ONE notice per session through the existing game toast, with the
 *    text that matches the outcome (lobster shown, or no body at all).
 */
import { Suspense, useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  notifyBootActorCommitted,
  registerBootActorClaim,
  type BootActorClaimToken,
  type BootActorKind,
} from './boot-actor';
import { ModelLoadBoundary } from './model-load-boundary';

/** Registry key of the body shown instead (MODEL_REGISTRY default GLB). */
export const LOCAL_PLAYER_FALLBACK_MODEL_KEY = 'lobster';

/** Player-facing copy (GameFeatures.md §9c). Plain words, no dashes. */
export const LOCAL_PLAYER_MODEL_FALLBACK_NOTICE =
  'Your avatar could not load. You are shown with the default body. Reload to try again.';
/** When the default body could not load either. */
export const LOCAL_PLAYER_MODEL_NO_BODY_NOTICE =
  'Your avatar could not load. Reload to try again.';

export type FallbackOutcome = 'body' | 'none';

const NOTICE_ICON = '⚠️';
const NOTICE_DURATION_MS = 8_000;

export type AddToast = (icon: string, message: string, durationMs?: number) => void;
export type LocalBodyKind = Extract<BootActorKind, 'player-vrm' | 'npc-body'>;

let noticeShown = false;
const RELEASED_CLAIMS = new WeakSet<BootActorClaimToken>();
let releaseCount = 0;

export function showLocalPlayerFallbackNotice(addToast: AddToast, outcome: FallbackOutcome): void {
  if (noticeShown) return;
  noticeShown = true;
  const text = outcome === 'body' ? LOCAL_PLAYER_MODEL_FALLBACK_NOTICE : LOCAL_PLAYER_MODEL_NO_BODY_NOTICE;
  addToast(NOTICE_ICON, text, NOTICE_DURATION_MS);
}

/** Commit the failed body claim once (registerBootActorClaim returns the
 * same token for the same epoch + kind + path). */
function releaseFailedBodyClaim(kind: LocalBodyKind, failedPath: string): void {
  const token = registerBootActorClaim(kind, failedPath);
  if (RELEASED_CLAIMS.has(token)) return;
  RELEASED_CLAIMS.add(token);
  releaseCount += 1;
  notifyBootActorCommitted(token);
}

function CommitSignal({ onCommit }: { onCommit: () => void }) {
  useEffect(() => {
    onCommit();
  }, [onCommit]);
  return null;
}

export function LocalPlayerFallback({
  kind,
  failedPath,
  fallbackUrl,
  label,
  addToast,
  children,
}: {
  kind: LocalBodyKind;
  /** URL of the model that failed (its boot claim is released). */
  failedPath: string;
  /** URL of the fallback body model (for the log / reset key). */
  fallbackUrl: string;
  label: string;
  addToast: AddToast;
  /** The fallback body (lobster GLB). */
  children?: ReactNode;
}) {
  const onBodyCommitted = useCallback(() => {
    releaseFailedBodyClaim(kind, failedPath);
    showLocalPlayerFallbackNotice(addToast, 'body');
  }, [kind, failedPath, addToast]);
  const onBodyFailed = useCallback(() => {
    releaseFailedBodyClaim(kind, failedPath);
    showLocalPlayerFallbackNotice(addToast, 'none');
  }, [kind, failedPath, addToast]);

  // Unmount before any outcome: release the claim anyway (once; the token
  // guard makes it a no-op after an outcome). Deferred one tick and
  // cancelled by a re-mount for the SAME claim (StrictMode simulated
  // unmount), so it never releases while the body is still loading.
  const pendingUnmountRelease = useRef<{ timer: ReturnType<typeof setTimeout>; claim: string } | null>(null);
  useEffect(() => {
    const claim = `${kind}|${failedPath}`;
    const pending = pendingUnmountRelease.current;
    if (pending && pending.claim === claim) {
      clearTimeout(pending.timer);
      pendingUnmountRelease.current = null;
    }
    return () => {
      const timer = setTimeout(() => {
        if (pendingUnmountRelease.current?.timer === timer) pendingUnmountRelease.current = null;
        releaseFailedBodyClaim(kind, failedPath);
      }, 0);
      pendingUnmountRelease.current = { timer, claim };
    };
  }, [kind, failedPath]);

  return (
    <ModelLoadBoundary
      assetUrl={fallbackUrl}
      label={`${label}-fallback`}
      resetKey={fallbackUrl}
      onModelFailed={onBodyFailed}
    >
      <Suspense fallback={null}>
        {children}
        <CommitSignal onCommit={onBodyCommitted} />
      </Suspense>
    </ModelLoadBoundary>
  );
}

/** TEST-ONLY. */
export function __resetLocalPlayerFallbackForTests(): void {
  noticeShown = false;
  releaseCount = 0;
}

/** TEST-ONLY: number of claim releases actually performed. */
export function __getBootClaimReleaseCountForTests(): number {
  return releaseCount;
}
