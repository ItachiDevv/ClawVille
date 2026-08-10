'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { useMiladyEmbed } from '@/hooks/use-milady-embed';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useGameStore, type GameState } from '@/stores/game';
import { useQuestStore } from '@/stores/quest';
import { api } from '@/lib/api';
import { isBoundAgentSessionMode } from '@/lib/agent-session-selectors';
import SeaLoadingScreen from '@/components/game/sea-loading-screen';
import { preloadWorldAssets } from '@/lib/three/asset-preload-manifest';
import { armDecorativeDeadline } from '@/lib/three/decorative-release';
import AvatarSettingsModal from '@/components/game/avatar-settings-modal';
import FirstTimeBackupModal from '@/components/game/first-time-backup-modal';
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import { GuestAvatarBootstrap } from '@/components/game/guest-avatar-bootstrap';
import Minimap from '@/components/game/minimap';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import TalkToCharacterBar from '@/components/game/talk-to-character-bar';
import LandOptionsPill from '@/components/game/land-options-pill';
import SalvageGatherPill from '@/components/game/land/salvage-gather-pill';
import YardEditorOverlay from '@/components/game/land/yard-editor-overlay';
import ChargeBar from '@/components/game/charge-bar';
import ShopOverlay from '@/components/game/shop-overlay';
import InventoryModal from '@/components/game/inventory-modal';
import CosmeticDrawer from '@/components/game/cosmetic-drawer';
import EmoteHotbar from '@/components/game/emote-hotbar';
import ActivityFeed from '@/components/game/activity-feed';
import AgentConnectModal from '@/components/game/agent-connect-modal';
import EmailVerifyBanner from '@/components/game/email-verify-banner';
import GameLanguageControl from '@/components/game/game-language-control';
import HatcherLaunchHandler from '@/components/game/hatcher-launch-handler';
import WarpOverlay from '@/components/game/warp-overlay';
import SpawnOnLoad from '@/components/game/spawn-on-load';

const BuildingPortalModal = dynamic(
  () => import('@/components/game/building-portal-modal'),
  { ssr: false },
);
const ActivityLobbyModal = dynamic(
  () => import('@/components/game/activity-lobby-modal'),
  { ssr: false },
);
const SkillBuilderModal = dynamic(() => import('@/components/game/skill-builder-modal'), { ssr: false });
const LandOfficeModal = dynamic(() => import('@/components/game/land/land-office-modal'), { ssr: false });
const QuestBoardModal = dynamic(() => import('@/components/game/quest-board-modal'), { ssr: false });
const BountyBoardModal = dynamic(() => import('@/components/game/bounty-board-modal'), { ssr: false });
const ExchangeModal = dynamic(() => import('@/components/game/exchange-modal'), { ssr: false });
const LeaderboardModal = dynamic(() => import('@/components/game/leaderboard-modal'), { ssr: false });
const WorldMapModal = dynamic(() => import('@/components/game/world-map-modal'), { ssr: false });
const WalletModal = dynamic(() => import('@/components/game/wallet/wallet-modal'), { ssr: false });
import BuildingTooltip from '@/components/game/building-tooltip';
import DailyLoginModal from '@/components/game/daily-login-modal';
import QuestTracker from '@/components/game/quest-tracker';
import NoriButton from '@/components/game/nori-button';
import ThoughtLog from '@/components/game/thought-log';
import ControlModeToggle from '@/components/game/control-mode-toggle';
import AutonomyHUD from '@/components/game/autonomy-hud';
import { useResearchStream } from '@/hooks/use-research-stream';
import SceneTransition from '@/components/transitions/SceneTransition';
import { useStageStore } from '@/components/three/world-stage/stage-store';
import { stampColdLoadPhaseOnce } from '@/lib/three/cold-load-stamp';

// Rung-4 slice A head decomposition: when the /game page chunk finishes
// evaluating on the client. Never-throw; no-op on the server.
stampColdLoadPhaseOnce('gamePageModuleEvalAt', performance.now());

// Module-level latch so re-renders pay ZERO stamp cost (no performance.now(),
// no global lookup) after the first render — the render-phase stamp below is
// on the hottest React path in the app (Codex R19 nit 7).
let gamePageFirstRenderStamped = false;

// arena-terrain.tsx evaluates FORCE_WEBGL_TERRAIN at module scope using
// navigator.userAgent. On the server navigator is undefined → false; on the
// client it may be true (iOS Safari). Static import causes React #418 hydration
// mismatch because the SandFloor useMemo returns a different material type on
// server vs client, making the React tree diverge. Dynamic + ssr:false prevents
// the module from executing on the server at all — safe because these
// compatibility mounts are now NO-OPS (all release-deferred demand belongs to
// the hidden Canvas consumers after their stagger ticks; the only live preload
// left in DeferredNpcPreloads covers future non-deferred slots).
const DeferredTerrainPreloads = dynamic(
  () => import('@/lib/three/arena-terrain').then(m => ({ default: m.DeferredTerrainPreloads })),
  { ssr: false, loading: () => null },
);
const DeferredNpcPreloads = dynamic(
  () => import('@/lib/three/arena-location-npcs').then(m => ({ default: m.DeferredNpcPreloads })),
  { ssr: false, loading: () => null },
);

const ChatPanel = dynamic(() => import('@/components/game/chat-panel'), {
  ssr: false,
});

const LocationHUD = dynamic(() => import('@/components/game/location-hud'), {
  ssr: false,
});

const AvatarStatusBar = dynamic(() => import('@/components/game/avatar-status-bar'), {
  ssr: false,
});

const MobileControls = dynamic(() => import('@/components/game/mobile-controls'), {
  ssr: false,
});

const PerfHud = dynamic(() => import('@/components/game/perf-hud'), {
  ssr: false,
});

const SidebarMenu = dynamic(() => import('@/components/game/sidebar-menu'), {
  ssr: false,
});

function NanoClawBanner({
  hasAvatar,
  isAuthenticated,
  isGuest,
  provisioningPending,
  agentSessionMode,
}: {
  hasAvatar: boolean;
  isAuthenticated: boolean;
  isGuest: boolean;
  /**
   * P2 (2026-07-04) — server-derived 'provisioning-pending' from the
   * ['agent-session'] query (D1: transitional state, NOT a durable tier).
   * The parent computes it as `isAuthenticated && !isGuest && mode ===
   * 'provisioning-pending'`, and this component ALSO renders the guest/
   * logged-out branch BEFORE the pending branch — belt-and-braces so a
   * guest can never see the pending surface.
   */
  provisioningPending: boolean;
  /**
   * Raw `mode` from the authoritative ['agent-session'] query — undefined
   * while unresolved. Drives the avatar-owner branch below (Codex finding
   * 2026-07-30): bound modes ⇒ connected pill; none ⇒ reconnect CTA;
   * 'dismissed' ⇒ suppressed; unresolved ⇒ render
   * nothing rather than flash a wrong claim either way.
   */
  agentSessionMode?: string;
}) {
  // Paired = reload-survivable "this user has a connected agent" (drives the
  // green pill). agentConnected is the union (paired and/or live bearer); the
  // pill shows for either. The bearer slice is appended ONLY when a live
  // in-session bearer is actually held — after a reload agentSessionId is null
  // (the server never re-emits it), so the pill reads "Bot Training Active"
  // without the session-id suffix rather than an empty span. (Codex finding #2.)
  const agentPaired = useGameStore((s: GameState) => s.agentPaired);
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const agentSessionId = useGameStore((s: GameState) => s.agentSessionId);
  const setAgentConnectModalOpen = useGameStore((s: GameState) => s.setAgentConnectModalOpen);
  const showPaired = agentPaired || agentConnected;

  // Banner has five states keyed on (isAuthenticated, showPaired,
  // provisioningPending, hasAvatar):
  //   showPaired=true                           → green "Bot Training Active" pill
  //   !isAuthenticated || guest user            → in-game Connect + Log In; Sign Up exits
  //   provisioningPending (non-guest only —
  //     evaluated AFTER the guest branch)       → single amber CTA → /create-agent
  //                                                (founder 2026-07-15: no second
  //                                                "Connect Your Agent" button here;
  //                                                server-side legacy backfill means
  //                                                avatar-owning hosted accounts skip
  //                                                this state entirely)
  //   isAuthenticated && !showPaired &&
  //     !hasAvatar                              → "Create Agent" + "Connect Your Agent"
  //   isAuthenticated && !showPaired &&
  //      hasAvatar                              → mode-driven (Codex 2026-07-14):
  //                                                bound session modes = green
  //                                                "Agent Connected" pill;
  //                                                none = reconnect CTA;
  //                                                dismissed or
  //                                                unresolved query = nothing

  if (showPaired) {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3">
        <button
          onClick={() => setAgentConnectModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-600/90 backdrop-blur-sm border border-green-400/40 shadow-lg hover:bg-green-600 transition-colors"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-green-300 shadow-[0_0_6px_rgba(74,222,128,0.6)] animate-pulse" />
          <span className="text-white font-bold text-sm">Bot Training Active</span>
          {agentSessionId && (
            <span className="text-green-200/70 text-xs font-mono hidden md:inline">{agentSessionId.slice(0, 12)}</span>
          )}
        </button>
      </div>
    );
  }

  if (!isAuthenticated || isGuest) {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAgentConnectModalOpen(true, 'connect')}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 backdrop-blur-sm border border-cyan-400/40 shadow-lg hover:from-cyan-400 hover:to-blue-400 hover:border-cyan-300/60 transition-all"
        >
          <span className="text-white font-bold text-sm">Connect Agent</span>
        </button>
        <button
          type="button"
          onClick={() => setAgentConnectModalOpen(true, 'login')}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-cyan-400/40 shadow-lg hover:bg-black/80 hover:border-cyan-300/60 transition-all"
        >
          <span className="text-cyan-200 font-bold text-sm">Log In</span>
        </button>
        <Link
          href="/login?mode=signup"
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-pink-600 to-pink-500 shadow-[0_0_18px_rgba(236,72,153,0.3)] hover:shadow-[0_0_24px_rgba(236,72,153,0.45)] transition-all"
        >
          <span className="text-white font-bold text-sm">Sign Up</span>
        </Link>
      </div>
    );
  }

  // P2 agent-provisioning-pending (D1) — the account exists but its agent
  // rows don't (fail-soft signup provisioning, or a legacy agent-less
  // account). Transitional surface, not a tier: route to /create-agent to
  // finish (customize-PATCH when an avatar row exists, POST-create when
  // not — the page detects which). Guests can never reach this branch (the
  // guest/logged-out return above runs first, and the parent already gates
  // the prop on !isGuest).
  // Founder directive 2026-07-15: this surface shows ONE clear CTA — the
  // duplicate "Connect Your Agent" button confused the state ("if they're
  // logged in through our hosting it should be connected"); the external-
  // connect path stays reachable via the agent-connect modal elsewhere.
  // Since the server now lazily backfills the missing agent row for
  // hosted-harness avatars (auth.ts /me/agent-session cold path), an
  // avatar-owning account essentially never lands here — this branch is
  // for accounts still missing an avatar (or non-hosted harness), where
  // /create-agent genuinely finishes the setup.
  if (provisioningPending) {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3">
        <Link
          href="/create-agent"
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-amber-400/50 shadow-lg hover:bg-black/80 hover:border-amber-300/70 transition-all"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.6)] animate-pulse" />
          <span className="text-amber-200 font-bold text-sm">
            {hasAvatar ? 'Your agent is being set up — finish customizing' : 'Finish creating your agent'}
          </span>
        </Link>
      </div>
    );
  }

  // P2 hosted-agent state (2026-07-14, founder report + Codex adversarial
  // finding #1): an avatar-owning account's banner is driven by the
  // AUTHORITATIVE `agentSessionMode` — NOT by avatar ownership alone, which
  // distinguishes durable account binding from runtime liveness.
  //   hosted / external-active / external-idle / external-expired → green
  //     "Agent Connected" pill.
  //   'none' → keep the reconnect CTA because the account is genuinely unbound.
  //   'dismissed' → render nothing (user suppressed the surface).
  //   undefined (query unresolved) → render nothing; never flash a claim.
  // `agentPaired`/`agentConnected` keep their paired-external semantics for
  // every other reader — only this banner branch reads the mode directly.
  if (hasAvatar) {
    if (agentSessionMode === undefined || agentSessionMode === 'dismissed') {
      return null;
    }
    if (isBoundAgentSessionMode(agentSessionMode)) {
      return (
        <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3">
          <button
            onClick={() => setAgentConnectModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-600/90 backdrop-blur-sm border border-green-400/40 shadow-lg hover:bg-green-600 transition-colors"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-green-300 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
            <span className="text-white font-bold text-sm">Agent Connected</span>
          </button>
        </div>
      );
    }
    // 'none' — reconnect CTA only (avatar exists, so no Create Agent button).
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3 flex items-center gap-2">
        <button
          onClick={() => setAgentConnectModalOpen(true, 'connect')}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-yellow-500/40 shadow-lg hover:bg-black/80 hover:border-yellow-400/60 transition-all animate-pulse-subtle"
        >
          <span className="text-lg">🔌</span>
          <span className="text-yellow-300 font-bold text-sm">Connect Your Agent</span>
        </button>
      </div>
    );
  }

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3 flex items-center gap-2">
      <button
        onClick={() => setAgentConnectModalOpen(true, 'create')}
        className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-cyan-400/40 shadow-lg hover:bg-black/80 hover:border-cyan-300/60 transition-all"
      >
        <span className="text-lg">✨</span>
        <span className="text-cyan-200 font-bold text-sm">Create Agent</span>
      </button>
      <button
        onClick={() => setAgentConnectModalOpen(true, 'connect')}
        className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-yellow-500/40 shadow-lg hover:bg-black/80 hover:border-yellow-400/60 transition-all animate-pulse-subtle"
      >
        <span className="text-lg">🔌</span>
        <span className="text-yellow-300 font-bold text-sm">Connect Your Agent</span>
      </button>
    </div>
  );
}

export default function GamePage() {
  // Rung-4 slice A: first client render of the page component (render-phase
  // stamp; the module latch + "once" contract keep the cold-boot value and
  // make every subsequent render free).
  if (!gamePageFirstRenderStamped) {
    gamePageFirstRenderStamped = true;
    stampColdLoadPhaseOnce('gamePageFirstRenderAt', performance.now());
  }
  const worldHadActivatedOnMount = useRef(
    useStageStore.getState().scenes.world?.hasEverActivated ?? false,
  );
  // Mount gate — eliminates React #418 hydration mismatch at the source.
  // The /game HUD tree pulls state from Zustand, localStorage, TanStack Query,
  // and dynamic imports (the Three.js stage belongs to the route-group
  // layout). Any of those returning a
  // different value on SSR vs client first-render triggers React #418.
  // Rather than fighting individual mismatches one-by-one, render `null`
  // on the SSR pass AND on the first client render (which must match SSR
  // for hydration to pass), then flip `mounted` in a post-commit effect
  // so the real tree mounts client-only. No SSR'd subtree to compare
  // against → impossible to hit #418. Trade-off: ~16ms extra before the
  // loading screen paints; acceptable vs an error spamming every load.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    stampColdLoadPhaseOnce('gamePageMountedEffectAt', performance.now());
    setMounted(true);
  }, []);
  // Kick off ALL heavy world assets the moment the page mounts, in parallel
  // with the group-owned stage mounting the shared world scene. Without this,
  // fetch starts until the canvas chunk resolves and React renders it — which
  // is why the loading screen used to feel idle. preloadWorldAssets() fires
  // useGLTF.preload() for every always-loaded GLB/VRM/KTX2 in the world
  // scene (see asset-preload-manifest.ts) so THREE.DefaultLoadingManager
  // starts emitting progress events and SeaLoadingScreen's __W3D_PROGRESS
  // bar actually fills. Fire-and-forget — duplicate preload calls inside
  // each mounting component are cheap (useGLTF.preload is idempotent).
  // armDecorativeDeadline rides the same first-mount effect (Codex Lever-1
  // review finding 1): WorldWarmup's own arm call only commits if the canvas
  // subtree survives to its passive effect — a renderer-init failure before
  // that would strand release-gated consumer subtrees with no 45s ceiling.
  // Arming here guarantees the ceiling exists the moment the loading screen can.
  useEffect(() => { armDecorativeDeadline(); preloadWorldAssets(); }, []);

  const { data: avatar, isLoading } = useAvatar();
  const controlMode = useGameStore((s: GameState) => s.controlMode);
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const openActivityLobby = useGameStore((s: GameState) => s.openActivityLobby);
  const activityLobbyId = useGameStore((s: GameState) => s.activityLobbyId);

  /**
   * Q2 Activity Portals — chunk #8.
   *
   * The Results screen "Play Again" button (chunk #9) deep-links back to
   * `/game?quickQueue=<activityId>`. With the portal flow live we route
   * that through the proper lobby + auto-fire Queue Solo (instead of the
   * legacy sidebar dev button — see sidebar-menu.tsx for that path's
   * deprecation behind NEXT_PUBLIC_ENABLE_DEV_QUEUE).
   *
   * NOTE: we read `window.location.search` directly instead of
   * `useSearchParams()` to avoid the Next 16 prerender bailout that
   * forces the entire `/game` route into a Suspense boundary. The page
   * is already `'use client'` and uses other window-only APIs throughout,
   * so this stays consistent.
   */
  // Manually rehydrate the quest store from localStorage AFTER the first
  // client render. The store is persist({ skipHydration: true }) — without
  // this trigger the counters stay at initial state. With it, the rehydrate
  // happens in a post-mount effect, so React's hydration pass has already
  // completed and the subsequent re-render with persisted state is a normal
  // state update (no #418 mismatch).
  useEffect(() => {
    useQuestStore.persist.rehydrate();
    // Same hydration-safety pattern as the quest store, but for visited
    // buildings (stored in localStorage as a plain JSON array — no zustand
    // persist middleware). Calling this AFTER first paint replaces the
    // empty initial Set with the actual visited IDs, so Minimap's
    // <rect opacity={isVisited ? 0.8 : 0.55}> matches between SSR HTML and
    // client first render (React #418 root cause).
    useGameStore.getState().hydrateVisitedFromStorage();
  }, []);

  const [autoQueuePending, setAutoQueuePending] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!avatar) return; // wait for the avatar to load — queue endpoint requires auth
    const params = new URLSearchParams(window.location.search);
    const target = params.get('quickQueue');
    if (!target) return;
    // Strip the param so refresh doesn't re-fire; preserve the rest.
    const url = new URL(window.location.href);
    url.searchParams.delete('quickQueue');
    window.history.replaceState({}, '', url.toString());
    openActivityLobby(target);
    setAutoQueuePending(true);
  }, [avatar, openActivityLobby]);

  // Milady embed detection — auto-exchanges the agent session for a Lucia
  // cookie so the viewer skips the login overlay. The hook invalidates
  // auth-me + avatar queries on success, causing the page to re-render
  // with the guest user authenticated.
  const miladyEmbed = useMiladyEmbed();

  // Check if user is authenticated (separate from avatar query). Shared
  // canonical fetcher — see hooks/use-auth-me.ts.
  const { data: authData, isLoading: authLoading } = useAuthMe();

  const isAuthenticated = !!authData?.user;
  const isGuest = !!authData?.user?.isGuest;

  // Phase 6 — hydrate `agentConnected` from the server on mount.
  //
  // Before this, the flag was client-only and defaulted false on every
  // page load; meanwhile the user's Hermes/OpenClaw agent could claim
  // "still connected" for a week because nothing ever invalidated the
  // stored sessionId. `/api/auth/me/agent-session` is the authoritative
  // answer — it checks `openclaw_bots.session_expires_at` (plus a Milady
  // carve-out where the Eliza runtime IS the avatar).
  //
  // Refetch on window focus so a tab that's been idle past the 24h TTL
  // picks up the expiry immediately when the user returns; `staleTime:
  // 30s` caps the background fetch noise.
  const { data: agentSession } = useQuery({
    queryKey: ['agent-session'],
    queryFn: api.getAgentSession,
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    if (!agentSession) return;
    const {
      agentPaired: clientSidePaired,
      agentConnected: clientSideConnected,
      agentSessionId: clientSideBearer,
      setAgentPaired,
    } = useGameStore.getState();

    if (agentSession.connected && agentSession.agentId) {
      // RELOAD-SURVIVABLE PAIRED HYDRATION (Codex finding #2, 2026-06-12).
      //
      // We mark the user PAIRED (UI: Bot-Training pill, Controlled/Autonomous
      // toggle, cove autonomous availability) but we DO NOT fabricate a session
      // bearer. The previous code passed `agentSession.agentId` into
      // setAgentConnection() as if it were the bearer; the next avatar chat then
      // sent that agentId as the sessionId → 404 (`agent_session_not_found`) →
      // the connection cleared ~1s after load. That was the partner's recurring
      // symptom. The server NEVER re-emits the real bearer after first connect
      // (a hard security invariant), so /me/agent-session genuinely cannot hand
      // us one — the only honest reload state is "paired, no live bearer".
      //
      // setAgentPaired sets agentSessionId=null, so the agent-bearer chat path
      // (`agentConnected && agentSessionId`) stays OFF and avatar-chat-bar falls
      // back to the normal authed avatar send (no 404, avatar stays mounted).
      //
      // Guard: only (re)apply when not already in the paired-no-bearer state, so
      // a useAvatar/auth refetch re-running this effect doesn't churn the store.
      // CRITICALLY we must NOT downgrade a LIVE in-session bearer: if a real
      // connect happened this session (agentSessionId is non-null), leave it
      // alone — re-pairing would null the bearer and break live agent chat.
      if (clientSideBearer) return; // live bearer held — already fully connected
      if (!(clientSidePaired && clientSideConnected)) {
        setAgentPaired(true, agentSession.agentId);
      }
    } else if (clientSidePaired || clientSideConnected) {
      // Server says no — clear the stale paired/connected flag. Covers the
      // "Hermes exited a week ago but UI still says Connected" case. Keep a
      // still-authenticated, non-guest owner embodied in their own avatar (D2
      // invariant): a server "no longer connected" answer must not evict the
      // user from their own body. Race-safe default: while auth-me is
      // unresolved, keep the body if an avatar exists.
      const user = authData?.user;
      const ownsAvatar = !!avatar && (authLoading || (!!user && !user.isGuest));
      setAgentPaired(false, null, { keepEmbodied: ownsAvatar });
    }
  }, [agentSession, avatar, authData, authLoading]);

  // Connect to research thought stream
  useResearchStream();

  // 2026-05-12: removed the auto-redirect to /create-agent for authenticated
  // users without an avatar. NPC mode is now a first-class landing surface —
  // the NanoClawBanner exposes a "Create Agent" CTA alongside "Connect Your
  // Agent" so the visitor can choose. The previous force-redirect made it
  // impossible to reach NPC mode while logged-in and short-circuited the
  // banner the same commit added.
  //
  // miladyEmbed, spectate, quickQueue gates were the only escape hatches
  // before — now everyone falls through to NPC mode by default. Anyone who
  // wants /create-agent reaches it via the banner button or the landing
  // page.

  // Sync store state to match auth/avatar reality:
  //   - No avatar  → spectator (isSpectator=true), controlMode stays 'explore'
  //   - Has avatar → spectator=false, promote out of 'explore' into 'player' so
  //               the camera follows the avatar and the UI shows Controlled /
  //               Autonomous modes. User mental model: "logged in with avatar
  //               = my agent is in the world" — avatar ownership IS the signal
  //               for the Autonomous/Controlled toggle set.
  useEffect(() => {
    if (isLoading || authLoading) return;
    const store = useGameStore.getState();
    store.setIsSpectator(!avatar);
    // GUESTS ARE EXEMPT from the explore→player promotion (2026-06-10).
    // Entering NPC mode auto-mints a guest avatar; when that creation (or ANY
    // useAvatar refetch — tab focus, query invalidation) resolved, this effect
    // saw `avatar && controlMode === 'explore'` and force-promoted the guest
    // into 'player' mode — hijacking the toggle (user flips to Explore, the
    // next refetch silently puts them back in character control; reproduced
    // live: an Explore click 2s after entering NPC mode never stuck). The
    // promotion exists for the "logged in with avatar = my agent is in the
    // world" mental model, which only applies to REAL accounts — guests stay
    // on the Explore ↔ NPC Mode pair.
    // Belt-and-braces (Codex finding): require a RESOLVED authenticated
    // non-guest user, not just "isGuest is falsy" — a stale auth-me cache of
    // null would otherwise read as not-a-guest while the freshly-minted guest
    // avatar resolves, re-opening the hijack.
    // Hatcher launch-spectate is ALSO exempt (2026-06-11): the owner is
    // watching their launched agent in 'explore'; without this guard a
    // useAvatar refetch (tab focus / query invalidation) would force-promote
    // them into 'player' and snap the camera off the watched agent onto their
    // own avatar — same hijack class the guest exemption above prevents. The
    // flag clears the moment they manually change mode (store.setControlMode).
    if (
      avatar &&
      isAuthenticated &&
      !isGuest &&
      !store.hatcherSpectate &&
      store.controlMode === 'explore'
    ) {
      store.setControlMode('player');
    }
    if (!avatar && store.controlMode !== 'explore' && store.controlMode !== 'npc') {
      store.setControlMode('explore');
    }
  }, [avatar, isLoading, authLoading, isGuest, isAuthenticated]);

  // Sync avatar appearance to game store for 3D rendering
  useEffect(() => {
    if (avatar) {
      // Phase 2: pass modelKey so player-avatar.tsx renders the correct GLB.
      // Falls back to 'lobster' inside setAvatarAppearance if modelKey is absent
      // (pre-Phase-2 rows and any row where the column is null).
      useGameStore.getState().setAvatarAppearance(avatar.species, avatar.color, undefined, avatar.modelKey);
    }
  }, [avatar]);

  // hasAvatar is safe to derive even while loading — avatar is undefined during
  // the fetch so this is false, which correctly hides avatar-gated UI until resolved.
  const hasAvatar = !!avatar;
  const showDemoProgressHud = !agentConnected && !isLoading;
  // P2 (2026-07-04) — derived from the EXISTING ['agent-session'] query (zero
  // new query keys; already in login purgeAuthCache + the logout clear).
  // Guests are excluded here AND server-side (guests always get mode 'none')
  // AND in the banner's branch order — triple gate by design.
  const provisioningPending =
    isAuthenticated && !isGuest && agentSession?.mode === 'provisioning-pending';

  // NOTE: do NOT conditionally return early here based on isLoading/authLoading.
  // An early-return swaps the whole React tree, which unmounts the first
  // SeaLoadingScreen and mounts a fresh second one — user sees the loading
  // animation reset from 0% ("loaded twice" on iOS). The group-owned stage
  // boots independently underneath and remains covered until the shared world
  // scene and this one loader complete their legacy-ready handshake.
  // miladyEmbed.exchanging is similarly safe: exchange is an auth side-effect
  // and the stage starts booting in parallel while the cookie is set.

  // Mount gate (see top of component). SSR + first client render both
  // return null; React's hydration check sees identical "no children",
  // passes, then the post-commit setMounted(true) triggers the real
  // mount. No SSR/client divergence is possible.
  if (!mounted) return null;

  return (
    <div className="game-container" suppressHydrationWarning>
      {/* Sea loading overlay — renders immediately, fades out once window.__W3D is set */}
      {!worldHadActivatedOnMount.current && <SeaLoadingScreen />}
      <BuildingTooltip />
      <NanoClawBanner
        hasAvatar={hasAvatar}
        isAuthenticated={isAuthenticated}
        isGuest={isGuest}
        provisioningPending={provisioningPending}
        agentSessionMode={agentSession?.mode}
      />
      {/* Soft email-verification nudge — renders only when the user is
          authenticated, NOT a guest, HAS a real email to confirm, and that
          email is still unverified (plus the 7d dismissal window inside the
          component). Agent-identity users (auto-created with email: null) and
          guests have nothing to confirm, so they're excluded here. The
          component re-checks the same gates internally (defense in depth).
          Docked at `bottom-4` and lifted above the chat pill to avoid the
          bottom-center collision. */}
      {isAuthenticated &&
        authData?.user &&
        !authData.user.isGuest &&
        typeof authData.user.email === 'string' &&
        authData.user.email.trim() !== '' &&
        !authData.user.emailVerified && (
          <EmailVerifyBanner
            userId={authData.user.id}
            verified={authData.user.emailVerified}
            isGuest={authData.user.isGuest}
            email={authData.user.email}
          />
        )}
      <AgentConnectModal />
      <BuildingPortalModal />
      {/* Lobby modal mounts whenever activityLobbyId is set; reads
          autoQueue from the local quickQueue deep-link guard. */}
      {activityLobbyId && (
        <ActivityLobbyModal
          autoQueue={autoQueuePending}
          onAutoQueueConsumed={() => setAutoQueuePending(false)}
        />
      )}
      <FirstTimeBackupModal />
      <SkillBuilderModal />
      <LandOfficeModal />
      <QuestBoardModal />
      <BountyBoardModal />
      <ExchangeModal />
      <LeaderboardModal />
      {/* World Map (fast-travel WARP surface). Opened from the minimap "⤢ Map"
          button via openWorldMap(); gates internally on worldMapOpen. */}
      <WorldMapModal />
      {/* Wallet-visibility modal — top-level so any authed avatar owner can
          open it regardless of control mode; gates internally on
          walletLinkModalOpen. Land Office deep-links here via openWalletLink(). */}
      <WalletModal />

      <SidebarMenu />
      <Minimap />
      <ControlModeToggle />
      <MobileControls />
      <PerfHud />
      <TutorialOverlay />
      <GameLanguageControl />
      <ToastNotifications />
      {/* Ask Nori HUD shortcut — opens the Town Guide chat from anywhere
          on the world surface so new players don't have to find her 3D
          model first. Hides itself when a chat is already open or
          inside an activity room. */}
      <NoriButton />
      {/* Listens for `clawville:ensure-guest-avatar` window events from the
          game store and bootstraps a guest avatar for un-authenticated
          visitors. No UI of its own. */}
      <GuestAvatarBootstrap />

      {/* Hatcher launch-entry — consumes the grant from the URL FRAGMENT
          (`#hatcher_agent=&hatcher_launch=`) once on mount, drops the owner into
          spectate focused on the agent's body (autonomous-mode v1). The grant
          lives in the fragment, not the query, so the bearer-style launch token
          never reaches access logs / Referer headers (Codex finding #3, 2026-06-12).
          Mounted unconditionally (no auth/avatar gate) so it runs on the portal
          redirect landing; renders nothing unless the params are present. See
          hatcher-launch-handler.tsx + GameFeatures §2f. */}
      <HatcherLaunchHandler />

      {/* World UI that's useful for ALL avatar-bearing visitors — including
          guests minted by the auto-create flow. Shows building labels, the
          ? help button, the land proximity pill, the global activity feed,
          AND the chat panel so
          NPC-mode guests can talk to building teachers (brand priority #2:
          open agent onboarding — no human account required). ChatPanel
          gates internally on chatOpen / guideChatOpen so it stays hidden
          until the guest actually taps a character. Backend /chat accepts
          guest avatars (isGuest carve-out in chat.ts). */}
      {hasAvatar && (
        <>
          <LocationHUD />
          <LandOptionsPill />
          <SalvageGatherPill />
          <YardEditorOverlay />
          <ActivityFeed />
          <ChatPanel />
          {/* AvatarChatBar lives only under the agent-connected branch below.
              KNOWLEDGE-BUILDING chat (all modes, incl. NPC) is now the single
              proximity prompt → enterBuilding → ChatPanel (full ElizaOS resident
              chat + skill-claim). The TalkToCharacterBar bottom bar below is
              gated to NOT show at a building (`!nearLocation`) so it no longer
              duplicates that prompt (founder report); it survives only for any
              wandering-NPC chat path. */}
        </>
      )}
      {showDemoProgressHud && (
        <>
          <AvatarStatusBar />
          <QuestTracker forceVisible />
        </>
      )}

      {/* NPC-mode chat with a non-building wandering character. Self-gates on
          `controlMode === 'npc' && !chatOpen && !nearLocation && !nearParcelCode`;
          at a building the proximity prompt → ChatPanel modal owns the chat,
          and on land the proximity pill owns the bottom slot. */}
      <TalkToCharacterBar />

      {/* Player-mode (agent-connected) UI — hidden in NPC/Explore mode.
          Per the brand structure: the toggle reads Explore/NPC for guests,
          Controlled/Autonomous for connected agents. Quest, progression,
          and shop surfaces below belong to the agent's Controlled/
          Autonomous flow — not to a guest controlling an NPC. The inner
          controlMode guard is defense-in-depth: in normal flow,
          agentConnected=true implies controlMode='player'|'autonomous'
          (setAgentConnection enforces it), but if any code path leaves
          controlMode='npc' while an agent is connected, we still hide the
          agent-only UI. (Chat moved up into the hasAvatar block.) */}
      {/* AvatarChatBar — mounts for any EMBODIED avatar-owner in player/
          autonomous mode, NOT only while an agent is connected (2026-06-12,
          regression D2). When a chat send hits a dead agent session the store
          clears agentConnected but keeps the still-authenticated owner in
          'player' mode (setAgentConnection keepEmbodied) — the bar must stay
          mounted so its in-panel "Agent session ended — reconnect" banner
          survives and the user can keep chatting with their own avatar via the
          non-agent api.sendAvatarChat path. Gated OUT of NPC/Explore so it
          can't leak into guest NPC mode or create Eliza state during Explore
          (the Phase 6.2 reason it left the hasAvatar block). The agent-only
          progression/shop surfaces below stay gated on agentConnected. */}
      {hasAvatar && controlMode !== 'npc' && controlMode !== 'explore' && (
        <AvatarChatBar />
      )}
      {agentConnected && controlMode !== 'npc' && controlMode !== 'explore' && (
        <>
          <AvatarStatusBar />
          <QuestTracker />
          <AvatarSettingsModal />
          <LocationConfigModal />
          <ChargeBar />
          <ShopOverlay />
          <InventoryModal />
          <DailyLoginModal />
          <CosmeticDrawerMount />
          {/* Emote hotbar — only renders when the player has equipped at
              least one emote cosmetic. Hotkeys 1-4 fire the slots; the
              bus-driven trigger plays one-shot animations on the player VRM. */}
          <EmoteHotbar />
        </>
      )}

      {/* Autonomy HUD — visible when agent is in autonomous mode */}
      <AutonomyHUD />

      {/* Research thought log — visible for all users */}
      <ThoughtLog />

      {/* Fast-travel warp flash — gates internally on warpTarget (set by the
          World Map's Quick Travel / map click via warpTo, player-mode only).
          DOM/CSS only (Iris-Xe-safe), performs the teleport at its midpoint. */}
      <WarpOverlay />

      {/* Home-vs-town spawn placement — renders nothing. Repositions a logged-in
          player to their owned home parcel on load when spawnPreference==='home'
          (one-shot, race-safe — never yanks a moving player). */}
      <SpawnOnLoad />

      {/* SceneTransition overlay — handles fade-to-black for cove walk-in
          (and future building entries). Sits at z-index 9999 above all HUD
          but below critical system modals. pointerEvents=none while transparent
          so it never blocks normal HUD interactions. */}
      <SceneTransition />

      {/* Deferred GLB preloads — fire after first paint via requestAnimationFrame.
          These components render nothing; they only schedule useGLTF.preload()
          calls for assets that aren't needed on the first frame (decorations,
          location NPCs, underwater-decorations.glb). */}
      <DeferredTerrainPreloads />
      <DeferredNpcPreloads />
    </div>
  );
}

/**
 * Q3 plan §4.4 — cosmetic drawer mount. Reads `cosmeticDrawerOpen` from the
 * zustand store and forwards close action. Lives inside the player-mode
 * tree because the drawer is irrelevant to guests/spectators.
 */
function CosmeticDrawerMount() {
  const open = useGameStore((s: GameState) => s.cosmeticDrawerOpen);
  const setOpen = useGameStore((s: GameState) => s.setCosmeticDrawerOpen);
  return <CosmeticDrawer open={open} onClose={() => setOpen(false)} />;
}
