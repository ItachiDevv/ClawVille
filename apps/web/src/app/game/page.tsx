'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useAvatar } from '@/hooks/use-avatar';

const GameCanvas = dynamic(() => import('@/components/game/game-canvas'), {
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

export default function GamePage() {
  const router = useRouter();
  const { data: avatar, isLoading, isError } = useAvatar();

  useEffect(() => {
    if (!isLoading && !avatar && !isError) {
      router.push('/create-avatar');
    }
  }, [avatar, isLoading, isError, router]);

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
      <GameCanvas />
      <ChatPanel />
      <LocationHUD />
      <AvatarStatusBar />
    </div>
  );
}
