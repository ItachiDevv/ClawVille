'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useGameStore } from '@/stores/game';

/**
 * Soft email-verification nudge. Renders only when:
 *   - The user is authenticated
 *   - users.emailVerified === false
 *   - users.isGuest === false (guests don't have real emails)
 *   - users.email is a non-empty string — agent-identity users are
 *     auto-created with `email: null` (resolveOrCreateUserByIdentity) and
 *     have NOTHING to confirm, so the banner must never show for them. The
 *     parent (game/page.tsx) gates on the same predicate; this internal
 *     gate is defense-in-depth so the banner can't render for an email-less
 *     user even if a future caller forgets the mount-site check.
 *   - Not currently dismissed within the 7-day localStorage window
 *
 * Position: docked at `bottom-24` (6rem → bottom at 96px) so it clears the
 * `<AvatarChatBar>` "Chat with <agent>" pill (`bottom-0` + `pb-3`, band
 * ~12–54px) on its own whenever it is shown. `bottom-28`/`bottom-32` are NOT
 * generated in this build's Tailwind (they fall back to `auto` → top of
 * viewport), so `bottom-24` is the highest usable default token. The banner is
 * horizontally centered, narrow, and responsive (collapses to a single line on
 * small viewports).
 *
 * Email ⇄ Hatcher exclusion (2026-06-12): the Hatcher launch banner
 * (`hatcher-launch-handler.tsx`) also docks bottom-center and was lifted to
 * `bottom-20`; on mobile (390px) it wraps to ~319px tall, so NO positional
 * offset can guarantee the two never overlap. The real guard is therefore a
 * runtime MUTUAL EXCLUSION, not the pixel math: this banner reads the
 * `hatcherLaunchBannerActive` game-store flag and returns null while a Hatcher
 * launch banner is showing (see the early-return below), yielding the
 * bottom-center slot to that higher-priority transient and returning once it
 * is dismissed. The `bottom-24` lift is just the standalone-case spacing; the
 * flag is what prevents the email-vs-Hatcher stack the partner screenshot
 * flagged 2026-06-11.
 *
 * Dismissal is per-user (`cv:email-verify-dismissed-{userId}`) and
 * 7-day TTL — once a week the banner returns to nudge the user again.
 * If the user verifies in the meantime, the parent prop `verified`
 * flips and the banner unmounts without needing to read storage.
 */
export default function EmailVerifyBanner({
  userId,
  verified,
  isGuest,
  email,
}: {
  userId: string;
  verified: boolean;
  isGuest: boolean;
  /** Non-empty for users with a real email. `null`/empty ⇒ nothing to
   *  confirm (agent-identity user) ⇒ banner is suppressed. */
  email: string | null;
}) {
  // Tri-state so SSR / first-render returns null and the localStorage
  // check happens entirely client-side. Avoids React #418 hydration
  // mismatch — server has no `localStorage`, so any deterministic
  // rendering based on it must run AFTER hydration.
  const [dismissedReady, setDismissedReady] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTick, setSentTick] = useState<'ok' | 'err' | null>(null);

  // Mutual exclusion with the Hatcher launch banner: while that transient
  // banner occupies the bottom-center slot, this soft nudge yields so the two
  // never stack/occlude (the Hatcher panel can't be cleared by position at
  // mobile width). Selected as a scalar so this only re-renders on the flag
  // flip, not on unrelated store writes.
  const hatcherLaunchBannerActive = useGameStore(
    (s) => s.hatcherLaunchBannerActive,
  );

  // S5 — yield to the in-world action prompt (LocationHUD). When near a building
  // the "Press E · Enter / Talk" prompt owns the bottom-center slot; three
  // centered bottom surfaces read as noise even when technically non-overlapping.
  // Boolean selector → re-renders only when the visibility flips.
  const locationHudVisible = useGameStore(
    (s) =>
      s.controlMode !== 'explore' &&
      !!s.nearLocation &&
      !s.chatOpen &&
      !s.guideChatOpen,
  );

  const storageKey = `cv:email-verify-dismissed-${userId}`;
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setDismissedReady(false);
        return;
      }
      const ts = Number.parseInt(raw, 10);
      if (!Number.isFinite(ts) || Date.now() - ts > TTL_MS) {
        // Expired — clear so we don't accumulate stale entries and
        // re-show the banner.
        window.localStorage.removeItem(storageKey);
        setDismissedReady(false);
        return;
      }
      setDismissedReady(true);
    } catch {
      // Private browsing / quota — fall through to showing the banner.
      setDismissedReady(false);
    }
  }, [storageKey]);

  // Always-hide gates checked AFTER the hook so hook count stays
  // identical between renders. An email-less (agent-identity) user, a guest,
  // or an already-verified user has nothing to confirm — suppress.
  const hasRealEmail = typeof email === 'string' && email.trim() !== '';
  if (verified || isGuest || !hasRealEmail) return null;
  // Yield the bottom-center slot to the transient Hatcher launch banner.
  if (hatcherLaunchBannerActive) return null;
  // Yield to the in-world building-action prompt (LocationHUD) — see S5.
  if (locationHudVisible) return null;
  if (dismissedReady !== false) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey, String(Date.now()));
    } catch {
      /* ignore — non-persistent dismiss is fine */
    }
    setDismissedReady(true);
  }

  async function resend() {
    if (sending) return;
    setSending(true);
    setSentTick(null);
    try {
      const result = await api.sendVerification();
      // Server's `sent:false` for "already verified" or "no email" is
      // still a benign success state from the user's perspective.
      setSentTick(result.ok ? 'ok' : 'err');
    } catch {
      setSentTick('err');
    } finally {
      setSending(false);
      // Auto-clear the tick after 4s so the button can be re-used
      // without a stale "Sent!" hanging around.
      setTimeout(() => setSentTick(null), 4000);
    }
  }

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-40 max-w-[calc(100vw-1rem)]">
      <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-amber-500/15 backdrop-blur-sm border border-amber-400/30 shadow-lg">
        <span className="text-amber-300 text-base leading-none">✉️</span>
        <span className="text-amber-100/90 text-xs sm:text-sm font-medium truncate">
          Confirm your email to secure your account
        </span>
        <button
          type="button"
          onClick={resend}
          disabled={sending}
          className="ml-1 px-2.5 py-1 rounded-full text-[11px] sm:text-xs font-mono bg-amber-500/25 hover:bg-amber-500/40 text-amber-50 border border-amber-300/40 disabled:opacity-60 transition-colors"
        >
          {sending ? 'Sending…' : sentTick === 'ok' ? 'Sent!' : sentTick === 'err' ? 'Try later' : 'Resend confirmation'}
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss email verification banner"
          className="px-2 py-1 text-amber-100/70 hover:text-amber-50 text-sm leading-none transition-colors"
        >
          ×
        </button>
      </div>
    </div>
  );
}
