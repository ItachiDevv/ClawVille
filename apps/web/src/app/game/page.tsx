'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { useNpcStream } from '@/hooks/use-npc-stream';
import { useGameStore, type GameState } from '@/stores/game';
import { api } from '@/lib/api';
import GameMenu from '@/components/game/game-menu';
import AvatarSettingsModal from '@/components/game/avatar-settings-modal';
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import Minimap from '@/components/game/minimap';
import AvatarChatBar from '@/components/game/avatar-chat-bar';
import ShopOverlay from '@/components/game/shop-overlay';
import InventoryModal from '@/components/game/inventory-modal';
import SpectatorBanner from '@/components/game/spectator-banner';
import ActivityFeed from '@/components/game/activity-feed';
import OpenClawConnectModal from '@/components/game/openclaw-connect-modal';
import SkillBuilderModal from '@/components/game/skill-builder-modal';
import MarketplaceModal from '@/components/game/marketplace-modal';
import BazaarModal from '@/components/game/bazaar-modal';
import AuctionModal from '@/components/game/auction-modal';
import QuestBoardModal from '@/components/game/quest-board-modal';
import BountyBoardModal from '@/components/game/bounty-board-modal';
import BuildingTooltip from '@/components/game/building-tooltip';
import DailyLoginModal from '@/components/game/daily-login-modal';
import QuestTracker from '@/components/game/quest-tracker';
import ThoughtLog from '@/components/game/thought-log';
import { useResearchStream } from '@/hooks/use-research-stream';

const World3DCanvas = dynamic(() => import('@/components/three/World3DCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-claw-bg-dark">
      <p className="font-clawville text-white text-xl animate-pulse">
        Loading 3D world...
      </p>
    </div>
  ),
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

function NanoClawBanner({ isSpectator }: { isSpectator: boolean }) {
  const openclawConnected = useGameStore((s: GameState) => s.openclawConnected);
  const openclawSessionId = useGameStore((s: GameState) => s.openclawSessionId);
  const setOpenclawModalOpen = useGameStore((s: GameState) => s.setOpenclawModalOpen);

  return (
    <div className={`fixed left-1/2 -translate-x-1/2 z-50 ${isSpectator ? 'top-[4.5rem]' : 'top-3'}`}>
      {openclawConnected ? (
        <button
          onClick={() => setOpenclawModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-600/90 backdrop-blur-sm border border-green-400/40 shadow-lg hover:bg-green-600 transition-colors"
        >
          <span className="w-2.5 h-2.5 rounded-full bg-green-300 shadow-[0_0_6px_rgba(74,222,128,0.6)] animate-pulse" />
          <span className="text-white font-bold text-sm">Bot Training Active</span>
          <span className="text-green-200/70 text-xs font-mono hidden md:inline">{openclawSessionId?.slice(0, 12)}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpenclawModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 backdrop-blur-sm border border-yellow-500/40 shadow-lg hover:bg-black/80 hover:border-yellow-400/60 transition-all animate-pulse-subtle"
        >
          <span className="text-lg">🔌</span>
          <span className="text-yellow-300 font-bold text-sm">Connect Your OpenClaw Bot</span>
        </button>
      )}
    </div>
  );
}

export default function GamePage() {
  const router = useRouter();
  const { data: avatar, isLoading } = useAvatar();
  const [isSpectator, setIsSpectator] = useState(false);

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

  // NPC SSE stream disabled — server sim sends idle NPCs that override client wander.
  // Re-enable when server-side NPC simulation is actively moving NPCs.
  // useNpcStream();

  // Connect to research thought stream
  useResearchStream();

  // Redirect authenticated users with no active agent to /select-agent
  useEffect(() => {
    if (!isLoading && !authLoading && isAuthenticated && !avatar) {
      router.push('/select-agent');
    }
  }, [avatar, isLoading, authLoading, isAuthenticated, router]);

  // Determine spectator mode
  useEffect(() => {
    if (!isLoading && !authLoading) {
      const spectating = !avatar;
      setIsSpectator(spectating);
      useGameStore.getState().setIsSpectator(spectating);
    }
  }, [avatar, isLoading, authLoading]);

  // Sync avatar appearance to game store for 3D rendering
  useEffect(() => {
    if (avatar) {
      useGameStore.getState().setPetAppearance(avatar.species, avatar.color);
    }
  }, [avatar]);

  if (isLoading || authLoading) {
    return (
      <div className="game-container flex items-center justify-center bg-claw-bg-dark">
        <p className="font-clawville text-white text-2xl animate-pulse">
          Loading world...
        </p>
      </div>
    );
  }

  return (
    <div className="game-container">
      <World3DCanvas mode={isSpectator ? 'arena' : 'game'} />
      <BuildingTooltip />
      <NanoClawBanner isSpectator={isSpectator} />
      <OpenClawConnectModal />
      <SkillBuilderModal />
      <MarketplaceModal />
      <BazaarModal />
      <AuctionModal />
      <QuestBoardModal />
      <BountyBoardModal />

      {/* Always visible — game menu and minimap for all visitors */}
      <GameMenu />
      <Minimap />

      {/* Spectator mode: show banner, hide avatar-specific UI */}
      {isSpectator && <SpectatorBanner />}

      {/* Authenticated/avatar UI — only shown when avatar exists */}
      {!isSpectator && (
        <>
          <ChatPanel />
          <LocationHUD />
          <AvatarStatusBar />
          <MobileControls />
          <QuestTracker />
          <AvatarSettingsModal />
          <LocationConfigModal />
          <AvatarChatBar />
          <ShopOverlay />
          <InventoryModal />
          <TutorialOverlay />
          <ToastNotifications />
          <ActivityFeed />
          <DailyLoginModal />
        </>
      )}

      {/* Mobile controls also available for spectators to move camera */}
      {isSpectator && <MobileControls />}

      {/* Research thought log — visible for all users */}
      <ThoughtLog />
    </div>
  );
}
