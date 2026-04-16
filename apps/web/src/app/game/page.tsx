'use client';

import { useEffect } from 'react';
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
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import Minimap from '@/components/game/minimap';
import PetChatBar from '@/components/game/pet-chat-bar';
import ShopOverlay from '@/components/game/shop-overlay';
import InventoryModal from '@/components/game/inventory-modal';
import ActivityFeed from '@/components/game/activity-feed';
import AgentConnectModal from '@/components/game/agent-connect-modal';

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

  // Sync spectator state to game store (no pet = explore mode, has pet = player mode)
  useEffect(() => {
    if (!isLoading && !authLoading) {
      useGameStore.getState().setIsSpectator(!pet);
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

      {/* Pet-specific UI — only when agent exists AND not in explore mode (pure spectator) */}
      {hasPet && controlMode !== 'explore' && (
        <>
          <ChatPanel />
          <LocationHUD />
          <PetStatusBar />
          <QuestTracker />
          <PetSettingsModal />
          <LocationConfigModal />
          <PetChatBar />
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
