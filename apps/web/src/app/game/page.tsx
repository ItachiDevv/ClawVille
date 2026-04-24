'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { usePet } from '@/hooks/use-pet';
import { useMiladyEmbed } from '@/hooks/use-milady-embed';
import { useNpcStream } from '@/hooks/use-npc-stream';
import { useGameStore, type GameState } from '@/stores/game';
import { api } from '@/lib/api';
import SeaLoadingScreen from '@/components/game/sea-loading-screen';
import PetSettingsModal from '@/components/game/pet-settings-modal';
import FirstTimeBackupModal from '@/components/game/first-time-backup-modal';
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import { GuestPetBootstrap } from '@/components/game/guest-pet-bootstrap';
import Minimap from '@/components/game/minimap';
import PetChatBar from '@/components/game/pet-chat-bar';
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

const PetStatusBar = dynamic(() => import('@/components/game/pet-status-bar'), {
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
  const { data: pet, isLoading: isPetLoading } = usePet();
  const hasPet = !!pet;

  // Suppress during initial pet fetch — otherwise the banner renders
  // "Connect Your Agent" for the ~300-800ms before usePet() resolves and then
  // flips to hidden once the pet loads, which flashes a misleading CTA at
  // logged-in users and makes the UI look inconsistent with the sidebar
  // (which already shows a loading skeleton during the same window).
  if (isPetLoading) return null;

  // Hide the banner entirely for logged-in users who have a pet: the sidebar
  // already shows their agent, the toggle already reads Controlled/Autonomous,
  // and a "Connect Your Agent" CTA here would make the UI look inconsistent
  // with itself. Only render when there's an active gateway session (to show
  // the green "Bot Training Active" indicator) OR when the user has no pet
  // (= not logged in, show the connect CTA so spectators can onboard).
  if (hasPet && !agentConnected) return null;

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
  const { data: pet, isLoading } = usePet();
  const controlMode = useGameStore((s: GameState) => s.controlMode);
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
    if (!pet) return; // wait for the pet to load — queue endpoint requires auth
    const params = new URLSearchParams(window.location.search);
    const target = params.get('quickQueue');
    if (!target) return;
    // Strip the param so refresh doesn't re-fire; preserve the rest.
    const url = new URL(window.location.href);
    url.searchParams.delete('quickQueue');
    window.history.replaceState({}, '', url.toString());
    openActivityLobby(target);
    setAutoQueuePending(true);
  }, [pet, openActivityLobby]);

  // Milady embed detection — auto-exchanges the agent session for a Lucia
  // cookie so the viewer skips the login overlay. The hook invalidates
  // auth-me + pet queries on success, causing the page to re-render
  // with the guest user authenticated.
  const miladyEmbed = useMiladyEmbed();

  // Check if user is authenticated (separate from pet query)
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
    if (!isLoading && !authLoading && isAuthenticated && !pet) {
      router.push('/create-agent');
    }
  }, [pet, isLoading, authLoading, isAuthenticated, miladyEmbed.isEmbed, router]);

  // Sync store state to match auth/pet reality:
  //   - No pet  → spectator (isSpectator=true), controlMode stays 'explore'
  //   - Has pet → spectator=false, promote out of 'explore' into 'player' so
  //               the camera follows the pet and the UI shows Controlled /
  //               Autonomous modes. User mental model: "logged in with pet
  //               = my agent is in the world" — pet ownership IS the signal
  //               for the Autonomous/Controlled toggle set.
  useEffect(() => {
    if (isLoading || authLoading) return;
    const store = useGameStore.getState();
    store.setIsSpectator(!pet);
    if (pet && store.controlMode === 'explore') {
      store.setControlMode('player');
    }
    if (!pet && store.controlMode !== 'explore' && store.controlMode !== 'npc') {
      store.setControlMode('explore');
    }
  }, [pet, isLoading, authLoading]);

  // Sync pet appearance to game store for 3D rendering
  useEffect(() => {
    if (pet) {
      // Phase 2: pass modelKey so player-pet.tsx renders the correct GLB.
      // Falls back to 'lobster' inside setPetAppearance if modelKey is absent
      // (pre-Phase-2 rows and any row where the column is null).
      useGameStore.getState().setPetAppearance(pet.species, pet.color, undefined, pet.modelKey);
    }
  }, [pet]);

  // While embed session exchange is in flight, show loading
  if (isLoading || authLoading || miladyEmbed.exchanging) {
    return (
      <div className="game-container">
        <SeaLoadingScreen />
      </div>
    );
  }

  const hasPet = !!pet;

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
      {/* Listens for `clawville:ensure-guest-pet` window events from the
          game store and bootstraps a guest pet for un-authenticated
          visitors. No UI of its own. */}
      <GuestPetBootstrap />

      {/* Pet-specific UI — rendered whenever the user owns a pet. With the
          Controlled/Autonomous toggle semantics, having a pet = "my agent is
          in the world", so stats/quests/inventory/chat all belong on screen.
          PetChatBar has its own `controlMode !== 'explore'` gate (user rule:
          always visible except when floating as spectator). */}
      {hasPet && (
        <>
          <ChatPanel />
          <LocationHUD />
          <PetStatusBar />
          <QuestTracker />
          <PetSettingsModal />
          <LocationConfigModal />
          {controlMode !== 'explore' && <PetChatBar />}
          {controlMode !== 'explore' && <ChargeBar />}
          <ShopOverlay />
          <InventoryModal />
          <TutorialOverlay />
          <ActivityFeed />
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
