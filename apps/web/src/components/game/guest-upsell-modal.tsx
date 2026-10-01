'use client';

/**
 * GuestUpsellModal — the clean "create a free account" upsell shown to guests
 * on real-economy surfaces that CANNOT be safely simulated (real-CT escrow,
 * peer crypto trade). Founder directive (2026-07-09): a guest must NEVER see a
 * raw `guest_not_allowed` error toast — they see this designed sign-up pitch.
 *
 * Two ways it fires per surface:
 *   1. PREEMPTIVE — a guest clicks a real-economy action; the surface opens
 *      this modal instead of calling the server.
 *   2. BACKSTOP — a `guest_not_allowed` 403 slips through (e.g. the auth-me
 *      signal hadn't resolved yet); the error handler opens this instead of
 *      toasting the raw server string.
 *
 * Controlled component: the surface owns `open` + copy and renders one
 * instance. Self-contained (own backdrop at z-[120], above the RpgModal
 * backdrop at z-index 100) so it stacks cleanly ON TOP of the feature modal it
 * was opened from, with its own Escape/backdrop dismissal that does NOT close
 * the parent modal. Reused across surfaces (bounties, exchange, land, …).
 *
 * Styling: `.claw-panel` conventions — light text on the dark cyan panel
 * (no dark-on-dark), fits a 390px phone viewport, always dismissable.
 *
 * FITS ANY VIEWPORT (2026-09-30, verifier at 844x390 landscape: the panel was
 * 445 px tall in a 390 px viewport, close button off-screen). The panel is
 * bounded by the dynamic viewport height minus the backdrop's 16 px margins;
 * the icon, headline and body scroll inside it, while the close button and the
 * action row stay in view. On touch (`useIsMobile`, never a width query) the
 * close button and every action are at least 44 px; desktop keeps its sizes.
 */

import { useEffect, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';

/** The tap-target floor for touch devices (AGENTS.md mobile rule). */
export const GUEST_UPSELL_TOUCH_TARGET_PX = 44;

/**
 * The panel's height bound. `100vh` is the fallback a browser without `dvh`
 * keeps (an unsupported inline value is dropped and the class applies);
 * `100dvh` follows the visible area when the mobile browser bars show or hide.
 * 32 px = the backdrop's `p-4` above and below.
 */
export const GUEST_UPSELL_PANEL_MAX_HEIGHT = 'calc(100dvh - 32px)';
export const GUEST_UPSELL_PANEL_FALLBACK_CLASS = 'max-h-[calc(100vh-2rem)]';

/** Sizes that change with the input type. Desktop values are the pre-fix ones. */
export function guestUpsellSizing(touch: boolean): {
  closePx: number;
  actionStyle: CSSProperties | undefined;
} {
  return touch
    ? { closePx: GUEST_UPSELL_TOUCH_TARGET_PX, actionStyle: { minHeight: GUEST_UPSELL_TOUCH_TARGET_PX } }
    : { closePx: 28, actionStyle: undefined };
}

export interface GuestUpsellModalProps {
  open: boolean;
  onClose: () => void;
  /** Bold one-line hook, e.g. "Real bounties need a real account". */
  headline: string;
  /** 1–2 sentence body explaining WHY an account is required. */
  body: string;
  /** Primary CTA label. Defaults to "Create free account". */
  ctaLabel?: string;
}

export function GuestUpsellModal({
  open,
  onClose,
  headline,
  body,
  ctaLabel = 'Create free account',
}: GuestUpsellModalProps) {
  const router = useRouter();
  const touch = useIsMobile();
  const sizing = guestUpsellSizing(touch);
  const setAgentConnectModalOpen = useGameStore(
    (state) => state.setAgentConnectModalOpen,
  );

  // Own Escape handler — capture-phase + stopPropagation so it dismisses THIS
  // modal without the underlying RpgModal's window-level Escape listener also
  // firing and closing the parent feature modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      style={{
        background:
          'radial-gradient(ellipse at center, rgba(10,22,40,0.86) 0%, rgba(3,8,18,0.95) 100%)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={headline}
    >
      <div
        className={`claw-panel w-full max-w-sm relative flex flex-col overflow-hidden ${GUEST_UPSELL_PANEL_FALLBACK_CLASS}`}
        style={{ maxHeight: GUEST_UPSELL_PANEL_MAX_HEIGHT }}
        onClick={(e) => e.stopPropagation()}
        data-testid="guest-upsell-panel"
      >
        {/* Absolute on the panel, which never scrolls, so it stays in view. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 flex items-center justify-center rounded-full text-cyan-200/70 hover:text-white hover:bg-cyan-500/20 border border-cyan-500/20 transition-colors"
          style={{ width: sizing.closePx, height: sizing.closePx }}
        >
          ✕
        </button>

        {/* The only part that scrolls when the viewport is short. */}
        <div
          className="flex min-h-0 flex-1 flex-col items-center text-center gap-3 overflow-y-auto pt-2 px-1"
          data-testid="guest-upsell-scroll"
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 border border-cyan-400/30 text-2xl">
            🪙
          </div>

          <h2 className="text-white font-bold text-lg leading-tight">
            {headline}
          </h2>

          <p className="text-cyan-100/70 text-sm leading-relaxed">{body}</p>
        </div>

        {/* Always in view: the three actions and the footnote. */}
        <div
          className="flex shrink-0 flex-col items-center text-center gap-3 mt-3 pb-1 px-1"
          data-testid="guest-upsell-actions"
        >
          <div className="mt-2 flex w-full flex-col gap-2">
            <button
              type="button"
              onClick={() => router.push('/login?mode=signup')}
              className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-sm py-2.5 transition-colors"
              style={sizing.actionStyle}
            >
              {ctaLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                setAgentConnectModalOpen(true, 'login');
              }}
              className="w-full rounded-lg bg-transparent hover:bg-cyan-500/10 text-cyan-200 font-semibold text-sm py-2 border border-cyan-500/25 transition-colors"
              style={sizing.actionStyle}
            >
              I already have an account
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full text-cyan-200/50 hover:text-cyan-100/80 text-xs py-1 transition-colors"
              style={sizing.actionStyle}
            >
              Keep looking around
            </button>
          </div>

          <p className="text-cyan-300/40 text-[10px] leading-snug pt-1">
            Free · your demo progress carries over
          </p>
        </div>
      </div>
    </div>
  );
}
