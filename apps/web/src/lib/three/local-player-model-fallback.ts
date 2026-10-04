/**
 * local-player-model-fallback.ts
 *
 * Side effects when the LOCAL player's own body model fails all of its
 * request retries (player-avatar.tsx PlayerAvatarVRMInner, or
 * arena-npcs.tsx BootActorNpcBody for the possessed NPC body):
 *
 * 1. Release the boot-actor claim: commit the failed (kind, path) token so
 *    the reveal does not wait for the 8 s epoch deadline. The fallback body
 *    registers its own claim, which the gate treats as a stale commit
 *    (telemetry only), and attaches through the deferred warm queue.
 * 2. Show ONE short notice per session through the existing game toast.
 *
 * ModelLoadBoundary (fallback prop) renders the default lobster GLB body
 * and logs the one console.error with the URL.
 */
import {
  notifyBootActorCommitted,
  registerBootActorClaim,
  type BootActorKind,
} from './boot-actor';

/** Registry key of the body shown instead (MODEL_REGISTRY default GLB). */
export const LOCAL_PLAYER_FALLBACK_MODEL_KEY = 'lobster';

/** Player-facing copy (GameFeatures.md). Plain words, no dashes. */
export const LOCAL_PLAYER_MODEL_FALLBACK_NOTICE =
  'Your avatar could not load. You are shown with the default body. Reload to try again.';

const NOTICE_ICON = '⚠️';
const NOTICE_DURATION_MS = 8_000;

let noticeShown = false;

export type AddToast = (icon: string, message: string, durationMs?: number) => void;

export function onLocalPlayerModelFallback(
  kind: Extract<BootActorKind, 'player-vrm' | 'npc-body'>,
  failedPath: string,
  addToast: AddToast,
): void {
  notifyBootActorCommitted(registerBootActorClaim(kind, failedPath));
  if (noticeShown) return;
  noticeShown = true;
  addToast(NOTICE_ICON, LOCAL_PLAYER_MODEL_FALLBACK_NOTICE, NOTICE_DURATION_MS);
}

/** TEST-ONLY. */
export function __resetLocalPlayerFallbackNoticeForTests(): void {
  noticeShown = false;
}
