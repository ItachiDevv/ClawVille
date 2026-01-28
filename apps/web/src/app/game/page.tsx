'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { usePet } from '@/hooks/use-pet';

const GameCanvas = dynamic(() => import('@/components/game/game-canvas'), {
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

export default function GamePage() {
  const router = useRouter();
  const { data: pet, isLoading, isError } = usePet();

  useEffect(() => {
    if (!isLoading && !pet && !isError) {
      router.push('/create-pet');
    }
  }, [pet, isLoading, isError, router]);

  if (isLoading) {
    return (
      <div className="game-container flex items-center justify-center bg-neopets-bg-dark">
        <p className="font-elizapet text-white text-2xl animate-pulse">
          Loading your pet...
        </p>
      </div>
    );
  }

  if (!pet) {
    return null;
  }

  return (
    <div className="game-container">
      <GameCanvas />
      <ChatPanel />
      <LocationHUD />
      <PetStatusBar />
    </div>
  );
}
