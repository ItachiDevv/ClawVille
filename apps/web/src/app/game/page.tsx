'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useAvatar } from '@/hooks/use-avatar';
import { useNpcStream } from '@/hooks/use-npc-stream';
import { useGameStore } from '@/stores/game';
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

const World3DCanvas = dynamic(() => import('@/components/three/World3DCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-legacytheme-bg-dark">
      <p className="font-legacyapp text-white text-xl animate-pulse">
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

export default function GamePage() {
  const { data: avatar, isLoading } = useAvatar();
  const [isSpectator, setIsSpectator] = useState(false);

  // Connect to NPC simulation stream (always — NPCs visible in both modes)
  useNpcStream();

  // Determine spectator mode
  useEffect(() => {
    if (!isLoading) {
      const spectating = !avatar;
      setIsSpectator(spectating);
      useGameStore.getState().setIsSpectator(spectating);
    }
  }, [avatar, isLoading]);

  // Sync avatar appearance to game store for 3D rendering
  useEffect(() => {
    if (avatar) {
      useGameStore.getState().setPetAppearance(avatar.species, avatar.color);
    }
  }, [avatar]);

  if (isLoading) {
    return (
      <div className="game-container flex items-center justify-center bg-legacytheme-bg-dark">
        <p className="font-legacyapp text-white text-2xl animate-pulse">
          Loading world...
        </p>
      </div>
    );
  }

  return (
    <div className="game-container">
      <World3DCanvas mode={isSpectator ? 'arena' : 'game'} />

      {/* Spectator mode: show banner, hide avatar-specific UI */}
      {isSpectator && <SpectatorBanner />}

      {/* Authenticated/avatar UI — only shown when avatar exists */}
      {!isSpectator && (
        <>
          <ChatPanel />
          <LocationHUD />
          <AvatarStatusBar />
          <MobileControls />
          <Minimap />
          <GameMenu />
          <AvatarSettingsModal />
          <LocationConfigModal />
          <AvatarChatBar />
          <ShopOverlay />
          <InventoryModal />
          <TutorialOverlay />
          <ToastNotifications />
        </>
      )}

      {/* Mobile controls also available for spectators to move camera */}
      {isSpectator && <MobileControls />}
    </div>
  );
}
