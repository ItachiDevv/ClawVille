'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useAvatar } from '@/hooks/use-avatar';
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

const PixiCanvas = dynamic(() => import('@/components/pixi/PixiCanvas'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-legacytheme-bg-dark">
      <p className="font-legacyapp text-white text-xl animate-pulse">
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

const AvatarStatusBar = dynamic(() => import('@/components/game/avatar-status-bar'), {
  ssr: false,
});

const MobileControls = dynamic(() => import('@/components/game/mobile-controls'), {
  ssr: false,
});

export default function GamePage() {
  const router = useRouter();
  const { data: avatar, isLoading, isError } = useAvatar();

  useEffect(() => {
    if (!isLoading && !avatar && !isError) {
      router.push('/create-avatar');
    }
  }, [avatar, isLoading, isError, router]);

  // Sync avatar appearance to game store for PixiJS rendering
  useEffect(() => {
    if (avatar) {
      useGameStore.getState().setPetAppearance(avatar.species, avatar.color);
    }
  }, [avatar]);

  if (isLoading) {
    return (
      <div className="game-container flex items-center justify-center bg-legacytheme-bg-dark">
        <p className="font-legacyapp text-white text-2xl animate-pulse">
          Loading your avatar...
        </p>
      </div>
    );
  }

  if (!avatar) {
    return null;
  }

  return (
    <div className="game-container">
      <PixiCanvas />
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
    </div>
  );
}
