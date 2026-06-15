'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGameStore } from '@/stores/game';
import { api } from '@/lib/api';

/**
 * Hatcher launch-entry handler (plan §B — `.claude/plans/hatcher-launch-exchange.md`).
 *
 * Hatcher's dashboard launches an owner into ClawVille to *watch* their hosted
 * agent by appending the grant to the /game URL. The portal flow logs the owner
 * in BEFORE the redirect, so by the time this mounts the Lucia session already
 * exists — we just consume the grant via the signed exchange endpoint and drop
 * the viewer into spectate with the camera focused on the agent's in-world body.
 *
 * Phasing: v1 is `autonomous` only — exchange + spectate. The `controlled`
 * possession path is a separate follow-up; this handler always lands the owner
 * in 'explore' (free spectate camera) regardless of the agent's mode.
 *
 * Design notes:
 * - CARRIER: the grant is read from BOTH the URL FRAGMENT (`location.hash`) AND
 *   the QUERY string (`location.search`), QUERY WINS on conflict (2026-06-13,
 *   FIX-1). Hatcher's PRODUCTION dashboard emits the grant as a `?query` string
 *   (`/game?hatcher_agent=…&hatcher_launch=…`) — the partner's backend builds
 *   the launchUrl verbatim and ClawVille has zero control over the carrier
 *   (`hatcher-types.ts` `ClawVilleLaunchResponse.launchUrl`,
 *   `ClawVilleWalletPanel.tsx` `launchWindow.location.href = launchUrl`). A
 *   fragment-only read silently no-op'd the ENTIRE owner-launch feature against
 *   their deployed behavior (browser-proven on staging: a `?query` launch never
 *   fired the exchange). The query form is SAFE to accept: the `launchToken` is
 *   not an independently exploitable bearer — redemption requires OUR ed25519
 *   service-issuer signature on the server-to-server exchange
 *   (`partner-hatcher-launch.ts`), so the signed exchange, not the token, is the
 *   trust boundary. We still STRIP the params from whichever carrier they
 *   arrived on immediately (below) so the token doesn't linger in the address
 *   bar / history / a later Referer.
 *   NOTE FOR HATCHER: query is your current form and is fully supported. The
 *   FRAGMENT form (`/game#hatcher_agent=…&hatcher_launch=…`) is preferred as a
 *   log-hygiene HARDENING follow-up (a fragment is never sent to the server,
 *   never logged, never lands in a Referer) — but it is NOT a hard dependency.
 *   Both carriers are accepted; migrate at your convenience.
 *   (We use plain string parsing rather than useSearchParams to match the
 *   sibling `quickQueue` deep-link guard and avoid the Next 16 prerender
 *   Suspense bailout on the already-'use client' /game route.)
 * - The exchange fires AT MOST ONCE per mount (firedRef re-entry guard) — even
 *   though api.hatcherLaunchExchange never throws, a StrictMode double-effect or
 *   a re-render must not double-POST. firedRef is RESET only for a TRANSIENT
 *   failure so the in-page Retry / 401 cookie-race re-attempt can re-run.
 * - On a successful READ we capture {agentId, launchToken} into grantRef BEFORE
 *   stripping the URL (FIX-12) so a transient failure can re-POST the same body
 *   even though the carrier params are already gone from the address bar. The
 *   server treats redemption idempotently, so a re-POST of the same grant is safe.
 * - On success we strip the consumed params from BOTH carriers via
 *   history.replaceState immediately, so a refresh can't replay the (now-consumed)
 *   launch token.
 * - Renders nothing on the happy path beyond a small auto-dismissing toast
 *   (existing store toast surface). The transient/auth/error banner docks
 *   bottom-centre per the game top-stack rule (new banners dock bottom-centre,
 *   never top-14), lifted to `bottom-20` so it clears the `<AvatarChatBar>` chat
 *   pill (`bottom-0`, band ~12–54px) instead of overlapping it, and uses light
 *   tokens only on the dark .claw-panel.
 * - While the banner is showing it sets `hatcherLaunchBannerActive` in the game
 *   store; the soft `<EmailVerifyBanner>` reads that flag and suppresses itself
 *   so the two bottom-centre surfaces never stack/occlude (the Hatcher panel
 *   wraps to ~1/3 of the screen at mobile width, which no positional lift can
 *   clear). The Hatcher banner is the higher-priority transient and wins the
 *   slot; the email nudge returns once the banner is dismissed.
 */

type Grant = { agentId: string; launchToken: string };

// `transient` = recoverable client-side (network blip, our issuer momentarily
// unconfigured, or a 401 set-cookie/redirect race) → offer an in-page Retry and
// keep the captured grant for a re-POST. `auth` = the relaunch-from-dashboard
// dead-end shown only AFTER a 401 re-attempt also fails (a genuinely missing
// session, not a timing race). `error` = a TERMINAL failure (agent_not_registered,
// definitive exchange_rejected, invalid_request) — hard dead-end, no retry.
type LaunchBanner = { kind: 'transient' } | { kind: 'auth' } | { kind: 'error' } | null;

// One short auto re-attempt for the 401 cookie-race (portal set-cookie-then-redirect
// can land here before the Lucia cookie is committed). Absorbs the common case
// before we ever show the relaunch banner.
const COOKIE_RACE_RETRY_DELAY_MS = 800;

export default function HatcherLaunchHandler() {
  const firedRef = useRef(false);
  // The consumed grant, captured BEFORE the URL is stripped so a transient
  // failure can re-POST the same body (the carrier params are already gone).
  const grantRef = useRef<Grant | null>(null);
  // Guards the single delayed 401 cookie-race re-attempt so we don't loop it.
  const cookieRaceRetriedRef = useRef(false);
  // Set true by the mount-effect cleanup; both the mount exchange, the delayed
  // 401 re-attempt, and the Retry button read it to abort a late resolve after
  // unmount. One shared flag (the component stays mounted across a retry).
  const cancelledRef = useRef(false);
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

  // Runs the signed exchange for the captured grant and routes the outcome.
  // Stable identity (no deps) so the mount effect and the Retry button share one
  // implementation. Reads the shared `cancelledRef` to abort a late resolve.
  const runExchange = useCallback(
    async (grant: Grant) => {
      const result = await api.hatcherLaunchExchange({
        agentId: grant.agentId,
        launchToken: grant.launchToken,
      });
      if (cancelledRef.current) return;

      if (result.ok) {
        const { name } = result.agent;
        const store = useGameStore.getState();
        // Controlled launch (the shipped deliverable): land the owner IN CONTROL
        // of the agent's avatar, not spectating it. 'player' mode mounts the
        // PlayerAvatar follow-camera path; the magic-link session already logged
        // the owner into the agent's bound user, so the player body IS the
        // agent's avatar. We deliberately do NOT set explore / hatcherSpectate /
        // requestCameraFocus — those are spectate-only and would suppress the
        // explore→player promotion. The server hides the duplicate autonomous
        // proxy NPC for as long as we keep uploading position (markHuman... was
        // primed by the exchange; /api/world/position refreshes the TTL).
        store.setControlMode('player');
        // Defensively clear any stale spectate flag from a prior launch in this
        // browser session so neither the explore→player promotion guard
        // (game/page.tsx) nor setAgentPaired's keepSpectate branch (game.ts) can
        // read a leftover `true` and pull us back out of player control.
        store.setHatcherSpectate(false);
        store.addToast('🎮', `Controlling ${name} · launched from Hatcher`, 6000);
        setBanner(null);
        return;
      }

      // Classify the failure. `status` is surfaced on the failure shape by the
      // api.ts wrapper for every non-2xx (so a 401 `launch_requires_session`
      // carries status 401 even though the server body omits it).
      const status = 'status' in result ? result.status : undefined;
      const is401 =
        status === 401 || result.error === 'launch_requires_session';

      // 401 cookie-race: the portal mints the Lucia session then redirects, so a
      // set-cookie-then-redirect race can land us here before the cookie commits.
      // Try ONCE more after a short delay before giving up; the grant re-POST is
      // idempotent server-side. Only after that retry also 401s do we show the
      // relaunch banner (a genuinely missing session, not a timing blip).
      if (is401) {
        if (!cookieRaceRetriedRef.current) {
          cookieRaceRetriedRef.current = true;
          window.setTimeout(() => {
            if (cancelledRef.current) return;
            void runExchange(grant);
          }, COOKIE_RACE_RETRY_DELAY_MS);
          return;
        }
        // Re-attempt also failed → genuine missing session. Keep the grant +
        // firedRef reset so the manual Retry button still works (the owner may
        // log in in another tab and retry), but surface the relaunch guidance.
        firedRef.current = false;
        setBanner({ kind: 'auth' });
        return;
      }

      // Other TRANSIENT outcomes — a network/parse blip (`network_error`, no
      // status) or our issuer momentarily unconfigured (`launch_issuer_unconfigured`,
      // 503). Recoverable: reset firedRef, keep the grant, offer in-page Retry.
      const isTransient =
        result.error === 'network_error' ||
        result.error === 'launch_issuer_unconfigured';
      if (isTransient) {
        firedRef.current = false;
        setBanner({ kind: 'transient' });
        return;
      }

      // TERMINAL outcomes (`agent_not_registered`, definitive `exchange_rejected`,
      // `invalid_request`, `rate_limited`) — a re-POST won't help. Hard dead-end:
      // leave firedRef latched and drop the captured grant so Retry is hidden.
      grantRef.current = null;
      setBanner({ kind: 'error' });
    },
    [],
  );

  // Retry handler for the in-page button — re-runs the exchange with the captured
  // grant. The component stays mounted across a retry; the mount effect's cleanup
  // governs unmount, so the shared `cancelledRef` already gates a late resolve.
  const handleRetry = useCallback(() => {
    const grant = grantRef.current;
    if (!grant || firedRef.current) return;
    firedRef.current = true;
    cookieRaceRetriedRef.current = false;
    setBanner(null);
    void runExchange(grant);
  }, [runExchange]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (firedRef.current) return;
    // Re-arm the shared cancellation flag for this mount (a StrictMode
    // mount→cleanup→remount would otherwise leave it latched true).
    cancelledRef.current = false;

    // Read the grant from BOTH carriers, QUERY WINS (FIX-1). Hatcher PROD emits
    // a `?query` launch URL; the fragment is the preferred-but-not-required
    // hardening form. Merge with the query taking precedence on a key collision.
    // `location.search` / `location.hash` both include their leading delimiter;
    // strip it before parsing as form-encoded pairs.
    const queryParams = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(
      window.location.hash.replace(/^#/, ''),
    );
    const agentId =
      queryParams.get('hatcher_agent') ?? hashParams.get('hatcher_agent');
    const launchToken =
      queryParams.get('hatcher_launch') ?? hashParams.get('hatcher_launch');

    // Params absent on BOTH carriers → ZERO behaviour change. Both must be present.
    if (!agentId || !launchToken) return;

    firedRef.current = true;
    // Capture the grant BEFORE stripping the URL so a transient failure can
    // re-POST the same body (the carrier params are about to be removed).
    grantRef.current = { agentId, launchToken };

    // Strip BOTH launch params from BOTH carriers immediately (before the network
    // round-trip resolves) so a refresh mid-flight can't replay the token, and so
    // the sensitive launchToken never lingers in the address bar / history. Any
    // unrelated query/fragment keys are preserved; an emptied carrier collapses to
    // no '?'/'#' so the URL is clean.
    queryParams.delete('hatcher_agent');
    queryParams.delete('hatcher_launch');
    hashParams.delete('hatcher_agent');
    hashParams.delete('hatcher_launch');
    const url = new URL(window.location.href);
    const survivingQuery = queryParams.toString();
    const survivingHash = hashParams.toString();
    url.search = survivingQuery ? `?${survivingQuery}` : '';
    url.hash = survivingHash ? `#${survivingHash}` : '';
    window.history.replaceState({}, '', url.toString());

    void runExchange(grantRef.current);

    return () => {
      cancelledRef.current = true;
    };
  }, [runExchange]);

  if (!banner) return null;

  const canRetry = grantRef.current !== null && banner.kind !== 'error';

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-20 z-50 max-w-[90vw] px-2">
      <div className="claw-panel pointer-events-auto flex items-start gap-3 px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <span className="text-xl leading-none mt-0.5">
          {banner.kind === 'auth' ? '🔑' : banner.kind === 'transient' ? '🔄' : '⚠️'}
        </span>
        <div className="min-w-0">
          {/* Light tokens only on the dark navy .claw-panel — see
              [[feedback_no_dark_text_on_dark_panel]]. */}
          <p className="text-sm font-bold text-cyan-50">
            {banner.kind === 'auth'
              ? 'Open ClawVille from your Hatcher dashboard to launch this agent'
              : banner.kind === 'transient'
                ? 'Could not reach the launch service — try again'
                : 'Could not launch this agent right now'}
          </p>
          <p className="text-xs text-slate-200/90 mt-0.5">
            {banner.kind === 'auth'
              ? 'The launch link needs an active session — relaunch from Hatcher to watch your agent.'
              : banner.kind === 'transient'
                ? 'A temporary hiccup reaching the launch service. Retry to watch your agent — no need to relaunch.'
                : 'The game has loaded normally. Try relaunching from Hatcher in a moment.'}
          </p>
          {canRetry && (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 rounded-full bg-cyan-400/20 hover:bg-cyan-400/30 px-3 py-1 text-xs font-semibold text-cyan-50 transition-colors"
            >
              Retry
            </button>
          )}
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
