'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { useMiladyEmbed } from '@/hooks/use-milady-embed';
import { useNpcStream } from '@/hooks/use-npc-stream';
import { useGameStore, type GameState } from '@/stores/game';
import { useQuestStore } from '@/stores/quest';
import { api } from '@/lib/api';
import SeaLoadingScreen from '@/components/game/sea-loading-screen';
import { preloadWorldAssets } from '@/lib/three/asset-preload-manifest';
import AvatarSettingsModal from '@/components/game/avatar-settings-modal';
import FirstTimeBackupModal from '@/components/game/first-time-backup-modal';
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import { GuestAvatarBootstrap } from '@/components/game/guest-avatar-bootstrap';
import Minimap from '@/components/game/minimap';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import TalkToCharacterBar from '@/components/game/talk-to-character-bar';
import ChargeBar from '@/components/game/charge-bar';
import ShopOverlay from '@/components/game/shop-overlay';
import InventoryModal from '@/components/game/inventory-modal';
import CosmeticDrawer from '@/components/game/cosmetic-drawer';
import EmoteHotbar from '@/components/game/emote-hotbar';
import ActivityFeed from '@/components/game/activity-feed';
import AgentConnectModal from '@/components/game/agent-connect-modal';
import EmailVerifyBanner from '@/components/game/email-verify-banner';

const BuildingPortalModal = dynamic(
  () => import('@/components/game/building-portal-modal'),
  { ssr: false },
);
const ActivityLobbyModal = dynamic(
  () => import('@/components/game/activity-lobby-modal'),
  { ssr: false },
);
const SkillBuilderModal = dynamic(() => import('@/components/game/skill-builder-modal'), { ssr: false });
const MarketplaceModal = dynamic(() => import('@/components/game/marketplace-modal'), { ssr: false });
const BazaarModal = dynamic(() => import('@/components/game/bazaar-modal'), { ssr: false });
const AuctionModal = dynamic(() => import('@/components/game/auction-modal'), { ssr: false });
const QuestBoardModal = dynamic(() => import('@/components/game/quest-board-modal'), { ssr: false });
const BountyBoardModal = dynamic(() => import('@/components/game/bounty-board-modal'), { ssr: false });
const ExchangeModal = dynamic(() => import('@/components/game/exchange-modal'), { ssr: false });
const LeaderboardModal = dynamic(() => import('@/components/game/leaderboard-modal'), { ssr: false });
import BuildingTooltip from '@/components/game/building-tooltip';
import DailyLoginModal from '@/components/game/daily-login-modal';
import QuestTracker from '@/components/game/quest-tracker';
import NoriButton from '@/components/game/nori-button';
import ThoughtLog from '@/components/game/thought-log';
import ControlModeToggle from '@/components/game/control-mode-toggle';
import AutonomyHUD from '@/components/game/autonomy-hud';
import { useResearchStream } from '@/hooks/use-research-stream';
import SceneTransition from '@/components/transitions/SceneTransition';

// arena-terrain.tsx evaluates FORCE_WEBGL_TERRAIN at module scope using
// navigator.userAgent. On the server navigator is undefined → false; on the
// client it may be true (iOS Safari). Static import causes React #418 hydration
// mismatch because the SandFloor useMemo returns a different material type on
// server vs client, making the React tree diverge. Dynamic + ssr:false prevents
// the module from executing on the server at all — safe because DeferredTerrainPreloads
// and DeferredNpcPreloads only fire useGLTF.preload() in useEffect (no server output).
const DeferredTerrainPreloads = dynamic(
  () => import('@/lib/three/arena-terrain').then(m => ({ default: m.DeferredTerrainPreloads })),
  { ssr: false, loading: () => null },
);
const DeferredNpcPreloads = dynamic(
  () => import('@/lib/three/arena-location-npcs').then(m => ({ default: m.DeferredNpcPreloads })),
  { ssr: false, loading: () => null },
);

const World3DCanvas = dynamic(() => import('@/components/three/World3DCanvas'), {
  ssr: false,
  // SeaLoadingScreen handles the loading state — no separate fallback needed here
  loading: () => null,
});

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
}: {
  hasAvatar: boolean;
  isAuthenticated: boolean;
  isGuest: boolean;
}) {
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const agentSessionId = useGameStore((s: GameState) => s.agentSessionId);
  const setAgentConnectModalOpen = useGameStore((s: GameState) => s.setAgentConnectModalOpen);

  // Banner has four states keyed on (isAuthenticated, agentConnected, hasAvatar):
  //   agentConnected=true                       → green "Bot Training Active" pill
  //   !isAuthenticated || guest user            → "Log In" + "Sign Up" (agent CTAs hidden:
  //                                                connecting an agent requires an account,
  //                                                so showing them to a logged-out visitor
  //                                                just routes them through the connect
  //                                                modal which then bounces them to /login)
  //   isAuthenticated && !agentConnected &&
  //     !hasAvatar                              → "Create Agent" + "Connect Your Agent"
  //   isAuthenticated && !agentConnected &&
  //      hasAvatar                              → "Connect Your Agent" alone

  if (agentConnected) {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3">
        <button
          onClick={() => setAgentConnectModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-600/90 backdrop-blur-sm border border-green-400/40 shadow-lg hover:bg-green-600 transition-colors"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-green-300 shadow-[0_0_6px_rgba(74,222,128,0.6)] animate-pulse" />
          <span className="text-white font-bold text-sm">Bot Training Active</span>
          <span className="text-green-200/70 text-xs font-mono hidden md:inline">{agentSessionId?.slice(0, 12)}</span>
        </button>
      </div>
    );
  }

  if (!isAuthenticated || isGuest) {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3 flex items-center gap-2">
        <Link
          href="/login"
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-cyan-400/40 shadow-lg hover:bg-black/80 hover:border-cyan-300/60 transition-all"
        >
          <span className="text-cyan-200 font-bold text-sm">Log In</span>
        </Link>
        <Link
          href="/login?mode=signup"
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-pink-600 to-pink-500 shadow-[0_0_18px_rgba(236,72,153,0.3)] hover:shadow-[0_0_24px_rgba(236,72,153,0.45)] transition-all"
        >
          <span className="text-white font-bold text-sm">Sign Up</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3 flex items-center gap-2">
      {!hasAvatar && (
        <button
          onClick={() => setAgentConnectModalOpen(true, 'create')}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-cyan-400/40 shadow-lg hover:bg-black/80 hover:border-cyan-300/60 transition-all"
        >
          <span className="text-lg">✨</span>
          <span className="text-cyan-200 font-bold text-sm">Create Agent</span>
        </button>
      )}
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
  // Mount gate — eliminates React #418 hydration mismatch at the source.
  // The /game tree pulls state from Zustand, localStorage, TanStack Query,
  // dynamic imports and a Three.js Canvas. Any of those returning a
  // different value on SSR vs client first-render triggers React #418.
  // Rather than fighting individual mismatches one-by-one, render `null`
  // on the SSR pass AND on the first client render (which must match SSR
  // for hydration to pass), then flip `mounted` in a post-commit effect
  // so the real tree mounts client-only. No SSR'd subtree to compare
  // against → impossible to hit #418. Trade-off: ~16ms extra before the
  // loading screen paints; acceptable vs an error spamming every load.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Kick off ALL heavy world assets the moment the page mounts, in parallel
  // with the dynamic() World3DCanvas chunk download. Without this, no asset
  // fetch starts until the canvas chunk resolves and React renders it — which
  // is why the loading screen used to feel idle. preloadWorldAssets() fires
  // useGLTF.preload() for every always-loaded GLB/VRM/KTX2 in the world
  // scene (see asset-preload-manifest.ts) so THREE.DefaultLoadingManager
  // starts emitting progress events and SeaLoadingScreen's __W3D_PROGRESS
  // bar actually fills. Fire-and-forget — duplicate preload calls inside
  // each mounting component are cheap (useGLTF.preload is idempotent).
  useEffect(() => { preloadWorldAssets(); }, []);

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

  // Check if user is authenticated (separate from avatar query)
  const { data: authData, isLoading: authLoading } = useQuery({
    queryKey: ['auth-me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch {
        return null;
      }
    },
    retry: false,
  });

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
    const { agentConnected: clientSideConnected, setAgentConnection } =
      useGameStore.getState();
    if (agentSession.connected && agentSession.agentId) {
      if (!clientSideConnected) {
        setAgentConnection(agentSession.agentId);
      }
    } else if (clientSideConnected) {
      // Server says no — clear the stale optimistic flag. Covers the
      // "Hermes exited a week ago but UI still says Connected" case
      // the user reported this session.
      setAgentConnection(null);
    }
  }, [agentSession]);

  // NPC SSE stream — populates npc store for NPC mode possession + rendering
  useNpcStream();

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
    if (avatar && store.controlMode === 'explore') {
      store.setControlMode('player');
    }
    if (!avatar && store.controlMode !== 'explore' && store.controlMode !== 'npc') {
      store.setControlMode('explore');
    }
  }, [avatar, isLoading, authLoading]);

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

  // NOTE: do NOT conditionally return early here based on isLoading/authLoading.
  // An early-return swaps the whole React tree, which unmounts the first
  // SeaLoadingScreen and mounts a fresh second one — user sees the loading
  // animation reset from 0% ("loaded twice" on iOS). The Canvas is safe to
  // mount immediately; it renders nothing visible until the 3D scene is ready
  // and the SeaLoadingScreen covers the viewport the whole time anyway.
  // miladyEmbed.exchanging is similarly safe: exchange is an auth side-effect
  // and the canvas starts booting in parallel while the cookie is set.

  // Mount gate (see top of component). SSR + first client render both
  // return null; React's hydration check sees identical "no children",
  // passes, then the post-commit setMounted(true) triggers the real
  // mount. No SSR/client divergence is possible.
  if (!mounted) return null;

  return (
    <div className="game-container" suppressHydrationWarning>
      {/* Sea loading overlay — renders immediately, fades out once window.__W3D is set */}
      <SeaLoadingScreen />
      <World3DCanvas mode="game" />
      <BuildingTooltip />
      <NanoClawBanner hasAvatar={hasAvatar} isAuthenticated={isAuthenticated} isGuest={isGuest} />
      {/* Soft email-verification nudge — renders only when the user is
          authenticated, not a guest, and hasn't dismissed within the
          last 7d. Positioned at top-14 to clear NanoClawBanner. */}
      {isAuthenticated && authData?.user && (
        <EmailVerifyBanner
          userId={authData.user.id}
          verified={authData.user.emailVerified}
          isGuest={authData.user.isGuest}
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
      <MarketplaceModal />
      <BazaarModal />
      <AuctionModal />
      <QuestBoardModal />
      <BountyBoardModal />
      <ExchangeModal />
      <LeaderboardModal />

      {/* Always visible — sidebar menu, minimap, controls for all visitors */}
      <SidebarMenu />
      <Minimap />
      <ControlModeToggle />
      <MobileControls />
      <PerfHud />
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

      {/* World UI that's useful for ALL avatar-bearing visitors — including
          guests minted by the auto-create flow. Shows building labels, the
          ? help button, the global activity feed, AND the chat panel so
          NPC-mode guests can talk to building teachers (brand priority #2:
          open agent onboarding — no human account required). ChatPanel
          gates internally on chatOpen / guideChatOpen so it stays hidden
          until the guest actually taps a character. Backend /chat accepts
          guest avatars (isGuest carve-out in chat.ts). */}
      {hasAvatar && (
        <>
          <LocationHUD />
          <TutorialOverlay />
          <ActivityFeed />
          <ChatPanel />
          {/* Phase 6.2 (2026-04-27) — AvatarChatBar moved BACK out of the
              hasAvatar block; lives only under the agent-connected branch
              below. NPC-mode chat is now handled by TalkToCharacterBar
              against /api/chat/transient (no Eliza, no DB, no rooms).
              See talk-to-character-bar.tsx + chat-transient.ts. */}
        </>
      )}

      {/* NPC-mode chat: talk to nearest wandering world character.
          Stateless one-shot Gemini — no Eliza store. Component
          self-gates on `controlMode === 'npc'`. */}
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
      {agentConnected && controlMode !== 'npc' && controlMode !== 'explore' && (
        <>
          <AvatarStatusBar />
          <QuestTracker />
          <AvatarSettingsModal />
          <LocationConfigModal />
          {/* AvatarChatBar — restored to agent-connected-only gate (Phase 6.2).
              The Phase 6.1 move into hasAvatar leaked it into Explore mode
              and created Eliza state for the user's avatar during NPC mode,
              both wrong. Mode 2 (NPC) chat lives in a separate
              TalkToCharacterBar component (non-Eliza, transient). */}
          <AvatarChatBar />
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
