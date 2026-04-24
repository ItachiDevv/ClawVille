/**
 * Guest avatar auto-create bootstrap helper (2026-04-23).
 *
 * Two entry points trigger this:
 *   A) `setControlMode('npc')` in stores/game.ts — visitor switches into
 *      NPC mode but has no avatar yet, so we silently mint a guest avatar so
 *      the world has something to puppet.
 *   B) `handleQueue` in components/game/activity-lobby-modal.tsx — POST
 *      /queue returned 401 because the visitor never went through NPC
 *      mode. Bootstrap a guest, retry queue once.
 *
 * Single-flight guard: concurrent callers share one in-flight promise so
 * we never accidentally mint two guest avatars for the same visitor (e.g.
 * the queue 401 race + the NPC-mode trigger firing simultaneously).
 *
 * The helper is best-effort and silently no-ops on failure — the caller
 * decides how loud to be. The lobby surfaces a toast on retry success;
 * the NPC-mode trigger fires a welcome toast asynchronously.
 *
 * The avatar provider invalidation is the caller's responsibility (because
 * the helper has no access to the QueryClient outside React) — but a
 * convenience hook `useEnsureGuestPet` does that automatically.
 */

import { api, type GuestSignupResponse } from './api';

let inflight: Promise<GuestSignupResponse | null> | null = null;

/**
 * Ensure the visitor has a Lucia session + avatar. If they already do
 * (cookie present), the server returns the existing pair and `reused`
 * is true. If not, mints a guest user + guest avatar and sets a session
 * cookie.
 *
 * Returns the response on success, `null` on failure (rate-limited,
 * network error, etc.). Never throws — callers should treat null as
 * "still un-authenticated" and surface a toast accordingly.
 *
 * Single-flight: concurrent calls share one network request.
 */
export function ensureGuestPet(
  options?: { requestedName?: string },
): Promise<GuestSignupResponse | null> {
  if (inflight) return inflight;
  inflight = api
    .guestSignup(options)
    .catch((err) => {
      // Likely 429 rate-limit OR network failure. Surface to console for
      // debugging but don't throw — UX should degrade to "you need to
      // sign up to play" via the existing 401 path.
      console.warn('[guest-bootstrap] guestSignup failed:', err);
      return null;
    })
    .finally(() => {
      // Clear the single-flight slot AFTER the promise settles so the
      // next call (e.g. a retry after the cooldown) re-fires the network
      // request rather than re-using the failed result.
      inflight = null;
    }) as Promise<GuestSignupResponse | null>;
  return inflight;
}
