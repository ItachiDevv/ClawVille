'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { useMiladyEmbed } from '@/hooks/use-milady-embed';
import { useNpcStream } from '@/hooks/use-npc-stream';
import { useGameStore, type GameState } from '@/stores/game';
import { api } from '@/lib/api';
import SeaLoadingScreen from '@/components/game/sea-loading-screen';
import AvatarSettingsModal from '@/components/game/avatar-settings-modal';
import FirstTimeBackupModal from '@/components/game/first-time-backup-modal';
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import { GuestAvatarBootstrap } from '@/components/game/guest-avatar-bootstrap';
import Minimap from '@/components/game/minimap';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import ChargeBar from '@/components/game/charge-bar';
import ShopOverlay from '@/components/game/shop-overlay';
import InventoryModal from '@/components/game/inventory-modal';
import ActivityFeed from '@/components/game/activity-feed';
import AgentConnectModal from '@/components/game/agent-connect-modal';

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
const LeaderboardModal = dynamic(() => import('@/components/game/leaderboard-modal'), { ssr: false });
import BuildingTooltip from '@/components/game/building-tooltip';
import DailyLoginModal from '@/components/game/daily-login-modal';
import QuestTracker from '@/components/game/quest-tracker';
import ThoughtLog from '@/components/game/thought-log';
import ControlModeToggle from '@/components/game/control-mode-toggle';
import AutonomyHUD from '@/components/game/autonomy-hud';
import { useResearchStream } from '@/hooks/use-research-stream';
import { DeferredTerrainPreloads } from '@/lib/three/arena-terrain';
import { DeferredNpcPreloads } from '@/lib/three/arena-location-npcs';

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

function NanoClawBanner() {
  const agentConnected = useGameStore((s: GameState) => s.agentConnected);
  const agentSessionId = useGameStore((s: GameState) => s.agentSessionId);
  const setAgentConnectModalOpen = useGameStore((s: GameState) => s.setAgentConnectModalOpen);

  // Banner gates strictly on `agentConnected`:
  //   true  → green "Bot Training Active" pill (with session id)
  //   false → "Connect Your Agent" CTA (visible to guests + logged-in users
  //           who haven't connected yet — guest-avatar auto-create no longer
  //           hides this; the guest needs the upgrade path)

  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-50 top-3">
      {agentConnected ? (
        <button
          onClick={() => setAgentConnectModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-600/90 backdrop-blur-sm border border-green-400/40 shadow-lg hover:bg-green-600 transition-colors"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-green-300 shadow-[0_0_6px_rgba(74,222,128,0.6)] animate-pulse" />
          <span className="text-white font-bold text-sm">Bot Training Active</span>
          <span className="text-green-200/70 text-xs font-mono hidden md:inline">{agentSessionId?.slice(0, 12)}</span>
        </button>
      ) : (
        <button
          onClick={() => setAgentConnectModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-yellow-500/40 shadow-lg hover:bg-black/80 hover:border-yellow-400/60 transition-all animate-pulse-subtle"
        >
          <span className="text-lg">🔌</span>
          <span className="text-yellow-300 font-bold text-sm">Connect Your Agent</span>
        </button>
      )}
    </div>
  );
}

export default function GamePage() {
  const router = useRouter();
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

  // Redirect authenticated users with no active agent to /create-agent
  // EXCEPT: embed mode, spectate mode (user explicitly chose to explore)
  useEffect(() => {
    if (miladyEmbed.isEmbed) return;
    // Allow spectating via ?spectate=1 query param or localStorage flag
    const params = new URLSearchParams(window.location.search);
    if (params.get('spectate') === '1' || localStorage.getItem('clawville-spectate-mode') === '1') {
      return;
    }
    if (!isLoading && !authLoading && isAuthenticated && !avatar) {
      router.push('/create-agent');
    }
  }, [avatar, isLoading, authLoading, isAuthenticated, miladyEmbed.isEmbed, router]);

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
      // Falls back to 'lobster' inside setPetAppearance if modelKey is absent
      // (pre-Phase-2 rows and any row where the column is null).
      useGameStore.getState().setPetAppearance(avatar.species, avatar.color, undefined, avatar.modelKey);
    }
  }, [avatar]);

  // While embed session exchange is in flight, show loading
  if (isLoading || authLoading || miladyEmbed.exchanging) {
    return (
      <div className="game-container">
        <SeaLoadingScreen />
      </div>
    );
  }

  const hasAvatar = !!avatar;

  return (
    <div className="game-container">
      {/* Sea loading overlay — renders immediately, fades out once window.__W3D is set */}
      <SeaLoadingScreen />
      <World3DCanvas mode="game" />
      <BuildingTooltip />
      <NanoClawBanner />
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
      <LeaderboardModal />

      {/* Always visible — sidebar menu, minimap, controls for all visitors */}
      <SidebarMenu />
      <Minimap />
      <ControlModeToggle />
      <MobileControls />
      <PerfHud />
      <ToastNotifications />
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
              hasAvatar block. The Phase 6.1 placement leaked the bar into
              Explore mode any time a guest avatar was auto-created (which
              fires on NPC-mode entry, then sticks around when the user
              flips back to Explore). It also created Eliza state for
              the user's stored avatar during NPC mode, which is wrong:
              the player NPC in mode 2 is a transient possession, not
              a persistent agent. Strict gate: only render when the
              agent IS connected and in player/autonomous mode (3/4).
              NPC-mode chat with the nearest wandering character will
              be wired as a separate non-Eliza endpoint + its own
              TalkToCharacterBar component (Phase B). */}
        </>
      )}

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
        </>
      )}

      {/* Autonomy HUD — visible when agent is in autonomous mode */}
      <AutonomyHUD />

      {/* Research thought log — visible for all users */}
      <ThoughtLog />

      {/* Deferred GLB preloads — fire after first paint via requestAnimationFrame.
          These components render nothing; they only schedule useGLTF.preload()
          calls for assets that aren't needed on the first frame (decorations,
          location NPCs, underwater-decorations.glb). */}
      <DeferredTerrainPreloads />
      <DeferredNpcPreloads />
    </div>
  );
}
