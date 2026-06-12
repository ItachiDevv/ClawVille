'use client';

import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/stores/game';
import { api } from '@/lib/api';

/**
 * Hatcher launch-entry handler (plan §B — `.claude/plans/hatcher-launch-exchange.md`).
 *
 * Hatcher's dashboard launches an owner into ClawVille to *watch* their hosted
 * agent by appending the grant to the /game URL FRAGMENT:
 * `#hatcher_agent=<agentId>&hatcher_launch=<launchToken>`. The portal flow logs
 * the owner in BEFORE the redirect, so by the time this mounts the Lucia session
 * already exists — we just consume the grant via the signed exchange endpoint
 * and drop the viewer into spectate with the camera focused on the agent's
 * in-world body.
 *
 * Phasing: v1 is `autonomous` only — exchange + spectate. The `controlled`
 * possession path is a separate follow-up; this handler always lands the owner
 * in 'explore' (free spectate camera) regardless of the agent's mode.
 *
 * Design notes:
 * - The grant is read from the URL FRAGMENT (`location.hash`), NOT the query
 *   string (2026-06-12, Codex finding #3). A bearer-style `hatcher_launch` token
 *   in `?query=` is captured by CDN/web-server access logs and leaks into the
 *   `Referer` header of every early sub-resource request BEFORE the post-mount
 *   strip runs — so it is already exfiltrated by the time we clear it. The
 *   fragment is NEVER sent to the server, never logged, and never appears in a
 *   Referer, so it is the correct carrier for a short-lived bearer. (We still
 *   use plain string parsing rather than useSearchParams to match the sibling
 *   `quickQueue` deep-link guard and avoid the Next 16 prerender Suspense
 *   bailout on the already-'use client' /game route.)
 *   NOTE FOR HATCHER: the dashboard MUST emit the grant in the fragment
 *   (`/game#hatcher_agent=…&hatcher_launch=…`), not the query — a query-string
 *   launch silently no-ops now (and would re-introduce the log leak).
 * - The exchange fires AT MOST ONCE per mount (firedRef re-entry guard) — even
 *   though api.hatcherLaunchExchange never throws, a StrictMode double-effect or
 *   a re-render must not double-POST.
 * - On success we strip the WHOLE fragment via history.replaceState immediately,
 *   so a refresh can't replay the (now-consumed) launch token.
 * - Renders nothing on the happy path beyond a small auto-dismissing toast
 *   (existing store toast surface). The 401 / error banner docks bottom-centre
 *   per the game top-stack rule (new banners dock bottom-centre, never top-14),
 *   lifted to `bottom-20` so it clears the `<AvatarChatBar>` chat pill
 *   (`bottom-0`, band ~12–54px) instead of overlapping it, and uses light
 *   tokens only on the dark .claw-panel.
 * - While the banner is showing it sets `hatcherLaunchBannerActive` in the game
 *   store; the soft `<EmailVerifyBanner>` reads that flag and suppresses itself
 *   so the two bottom-centre surfaces never stack/occlude (the Hatcher panel
 *   wraps to ~1/3 of the screen at mobile width, which no positional lift can
 *   clear). The Hatcher banner is the higher-priority transient and wins the
 *   slot; the email nudge returns once the banner is dismissed.
 */

type LaunchBanner = { kind: 'auth' } | { kind: 'error' } | null;

export default function HatcherLaunchHandler() {
  const firedRef = useRef(false);
  const [banner, setBanner] = useState<LaunchBanner>(null);
  const setHatcherLaunchBannerActive = useGameStore(
    (s) => s.setHatcherLaunchBannerActive,
  );

  // Mirror banner visibility into the store so <EmailVerifyBanner> can suppress
  // itself while this banner occupies the bottom-center slot (mutual exclusion).
  // Cleanup clears the flag on unmount so a navigation away can't strand the
  // email nudge hidden.
  useEffect(() => {
    setHatcherLaunchBannerActive(banner !== null);
    return () => setHatcherLaunchBannerActive(false);
  }, [banner, setHatcherLaunchBannerActive]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (firedRef.current) return;

    // Read the grant from the URL FRAGMENT, not the query string (finding #3 —
    // a fragment is never sent to the server, so the bearer-style launchToken
    // can't land in access logs or a Referer header). `location.hash` includes
    // the leading '#'; strip it before parsing as form-encoded pairs.
    const rawHash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(rawHash);
    const agentId = params.get('hatcher_agent');
    const launchToken = params.get('hatcher_launch');

    // Params absent → ZERO behaviour change. Both must be present.
    if (!agentId || !launchToken) return;

    firedRef.current = true;

    // Strip BOTH launch params from the fragment immediately (before the network
    // round-trip resolves) so a refresh mid-flight can't replay the token, and
    // so the sensitive launchToken never lingers in the address bar / history.
    // Any unrelated fragment keys are preserved; if nothing else remains we drop
    // the '#' entirely so the URL is clean.
    params.delete('hatcher_agent');
    params.delete('hatcher_launch');
    const survivingHash = params.toString();
    const url = new URL(window.location.href);
    url.hash = survivingHash ? `#${survivingHash}` : '';
    window.history.replaceState({}, '', url.toString());

    let cancelled = false;

    (async () => {
      const result = await api.hatcherLaunchExchange({ agentId, launchToken });
      if (cancelled) return;

      if (result.ok) {
        const { name, x, y } = result.agent;
        const store = useGameStore.getState();
        // Land in spectate (free camera). v1 is observe-only regardless of the
        // agent's own mode; do NOT possess. setControlMode('explore') also sets
        // isSpectator and clears any stale near-location state.
        store.setControlMode('explore');
        // Mark launch-spectate AFTER setControlMode (which itself clears the
        // flag) so the game-page explore→player auto-promotion can't yank the
        // camera off the watched agent on the next useAvatar refetch. Cleared
        // when the owner manually changes mode.
        store.setHatcherSpectate(true);
        // Focus the explore camera on the agent's in-world body. The three
        // layer (WASDCameraController) drains this on its next frame.
        store.requestCameraFocus(x, y);
        store.addToast('🛰️', `Watching ${name} · launched from Hatcher`, 6000);
        return;
      }

      // 401 → the viewer isn't logged in (portal flow should have handled this;
      // if we're here the session is missing/expired). Tell them to relaunch
      // from the dashboard rather than dead-ending. Any other failure (incl. the
      // additive network_error, which carries no status) → a non-blocking error
      // banner; the game has already loaded normally.
      const status = 'status' in result ? result.status : undefined;
      if (status === 401 || result.error === 'launch_requires_session') {
        setBanner({ kind: 'auth' });
      } else {
        setBanner({ kind: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!banner) return null;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-20 z-50 max-w-[90vw] px-2">
      <div className="claw-panel pointer-events-auto flex items-start gap-3 px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <span className="text-xl leading-none mt-0.5">
          {banner.kind === 'auth' ? '🔑' : '⚠️'}
        </span>
        <div className="min-w-0">
          {/* Light tokens only on the dark navy .claw-panel — see
              [[feedback_no_dark_text_on_dark_panel]]. */}
          <p className="text-sm font-bold text-cyan-50">
            {banner.kind === 'auth'
              ? 'Open ClawVille from your Hatcher dashboard to launch this agent'
              : 'Could not launch this agent right now'}
          </p>
          <p className="text-xs text-slate-200/90 mt-0.5">
            {banner.kind === 'auth'
              ? 'The launch link needs an active session — relaunch from Hatcher to watch your agent.'
              : 'The game has loaded normally. Try relaunching from Hatcher in a moment.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setBanner(null)}
          aria-label="Dismiss"
          className="ml-1 shrink-0 rounded-full px-2 py-0.5 text-slate-200 hover:text-white hover:bg-white/10 transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
