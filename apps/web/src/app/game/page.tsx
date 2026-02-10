'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePet } from '@/hooks/use-pet';
import { useNpcStream } from '@/hooks/use-npc-stream';
import { useGameStore } from '@/stores/game';
import GameMenu from '@/components/game/game-menu';
import PetSettingsModal from '@/components/game/pet-settings-modal';
import LocationConfigModal from '@/components/game/location-config-modal';
import TutorialOverlay from '@/components/game/tutorial-overlay';
import ToastNotifications from '@/components/game/toast-notifications';
import Minimap from '@/components/game/minimap';
import PetChatBar from '@/components/game/pet-chat-bar';
import ShopOverlay from '@/components/game/shop-overlay';
import InventoryModal from '@/components/game/inventory-modal';
import SpectatorBanner from '@/components/game/spectator-banner';

const PixiCanvas = dynamic(() => import('@/components/pixi/PixiCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-neopets-bg-dark">
      <p className="font-elizapet text-white text-xl animate-pulse">
        Loading world...
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

const PetStatusBar = dynamic(() => import('@/components/game/pet-status-bar'), {
  ssr: false,
});

const MobileControls = dynamic(() => import('@/components/game/mobile-controls'), {
  ssr: false,
});

export default function GamePage() {
  const { data: pet, isLoading } = usePet();
  const [isSpectator, setIsSpectator] = useState(false);

  // Connect to NPC simulation stream (always — NPCs visible in both modes)
  useNpcStream();

  // Determine spectator mode
  useEffect(() => {
    if (!isLoading) {
      const spectating = !pet;
      setIsSpectator(spectating);
      useGameStore.getState().setIsSpectator(spectating);
    }
  }, [pet, isLoading]);

  // Sync pet appearance to game store for PixiJS rendering
  useEffect(() => {
    if (pet) {
      useGameStore.getState().setPetAppearance(pet.species, pet.color);
    }
  }, [pet]);

  if (isLoading) {
    return (
      <div className="game-container flex items-center justify-center bg-neopets-bg-dark">
        <p className="font-elizapet text-white text-2xl animate-pulse">
          Loading world...
        </p>
      </div>
    );
  }

  return (
    <div className="game-container">
      <PixiCanvas isSpectator={isSpectator} />

      {/* Spectator mode: show banner, hide pet-specific UI */}
      {isSpectator && <SpectatorBanner />}

      {/* Authenticated/pet UI — only shown when pet exists */}
      {!isSpectator && (
        <>
          <ChatPanel />
          <LocationHUD />
          <PetStatusBar />
          <MobileControls />
          <Minimap />
          <GameMenu />
          <PetSettingsModal />
          <LocationConfigModal />
          <PetChatBar />
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
