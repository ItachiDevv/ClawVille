'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Soft email-verification nudge. Renders only when:
 *   - The user is authenticated
 *   - users.emailVerified === false
 *   - users.isGuest === false (guests don't have real emails)
 *   - Not currently dismissed within the 7-day localStorage window
 *
 * Position: bottom-docked (`bottom-4`) so it stays clear of the
 * top-stack of fixed UI (NanoClawBanner at `top-3` + ControlModeToggle
 * at `top-[5rem]`). Earlier `top-14` placement crowded the mode toggle
 * — regress-auditor flagged the overlap 2026-05-22. The banner is
 * horizontally centered, narrow, and responsive (collapses to a
 * single line on small viewports).
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
}: {
  userId: string;
  verified: boolean;
  isGuest: boolean;
}) {
  // Tri-state so SSR / first-render returns null and the localStorage
  // check happens entirely client-side. Avoids React #418 hydration
  // mismatch — server has no `localStorage`, so any deterministic
  // rendering based on it must run AFTER hydration.
  const [dismissedReady, setDismissedReady] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTick, setSentTick] = useState<'ok' | 'err' | null>(null);

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
  // identical between renders.
  if (verified || isGuest) return null;
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
    <div className="fixed left-1/2 -translate-x-1/2 bottom-4 z-40 max-w-[calc(100vw-1rem)]">
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
