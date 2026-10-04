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
 *    inside the same Suspense, which runs only after every child resolved)
 *    or when the lobster itself failed. The reveal therefore never happens
 *    with no body while the lobster is still loading.
 * 3. Shows ONE notice per session through the existing game toast.
 */
import { Suspense, useCallback, useEffect, type ReactNode } from 'react';
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

const NOTICE_ICON = '⚠️';
const NOTICE_DURATION_MS = 8_000;

export type AddToast = (icon: string, message: string, durationMs?: number) => void;
export type LocalBodyKind = Extract<BootActorKind, 'player-vrm' | 'npc-body'>;

let noticeShown = false;
const RELEASED_CLAIMS = new WeakSet<BootActorClaimToken>();
let releaseCount = 0;

export function showLocalPlayerFallbackNotice(addToast: AddToast): void {
  if (noticeShown) return;
  noticeShown = true;
  addToast(NOTICE_ICON, LOCAL_PLAYER_MODEL_FALLBACK_NOTICE, NOTICE_DURATION_MS);
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
  const release = useCallback(() => releaseFailedBodyClaim(kind, failedPath), [kind, failedPath]);
  useEffect(() => {
    showLocalPlayerFallbackNotice(addToast);
  }, [addToast]);
  return (
    <ModelLoadBoundary
      assetUrl={fallbackUrl}
      label={`${label}-fallback`}
      resetKey={fallbackUrl}
      onModelFailed={release}
    >
      <Suspense fallback={null}>
        {children}
        <CommitSignal onCommit={release} />
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
