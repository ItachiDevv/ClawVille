'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LAND_PARCELS_QUERY_KEY } from '@/lib/land-query-keys';
import { WorldPresenceController } from '@/lib/world-presence-controller';
import { useNpcStore } from '@/stores/npc';
import { usePlayerStore } from '@/stores/players';
import { useResearchStore } from '@/stores/research';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { useWatchHeartbeat } from '@/hooks/use-watch-heartbeat';
import type { WorldPresencePolicy } from '@/hooks/world-stream-machine';

const WORLD_API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function useWorldStream(
  policy: WorldPresencePolicy,
  remoteActivity?: string,
): void {
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const remoteActivityRef = useRef(remoteActivity);
  remoteActivityRef.current = remoteActivity;

  useWatchHeartbeat(policy === 'active');

  const updateNpcsFromSnapshot = useNpcStore((state) => state.updateFromSnapshot);
  const setNpcConnected = useNpcStore((state) => state.setConnected);
  const updatePlayersFromSnapshot = usePlayerStore(
    (state) => state.updateFromSnapshot,
  );
  const setLocalSessionId = usePlayerStore(
    (state) => state.setLocalSessionId,
  );
  const setRoomId = usePlayerStore((state) => state.setRoomId);
  const clearPlayers = usePlayerStore((state) => state.clear);
  const addCollaborationEntries = useResearchStore(
    (state) => state.addCollaborationEntries,
  );
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new WorldPresenceController({
      apiBaseUrl: WORLD_API_URL,
      callbacks: {
        updateNpcsFromSnapshot: (snapshot) =>
          updateNpcsFromSnapshot(
            snapshot as Parameters<typeof updateNpcsFromSnapshot>[0],
          ),
        setNpcConnected,
        updatePlayersFromSnapshot,
        setLocalSessionId,
        setRoomId,
        clearPlayers,
        addCollaborationEntries: (entries) =>
          addCollaborationEntries(
            entries as Parameters<typeof addCollaborationEntries>[0],
          ),
        invalidateLandQuery: () => {
          void queryClient.invalidateQueries({
            queryKey: LAND_PARCELS_QUERY_KEY,
          });
        },
        addToast: (icon, message, durationMs) => {
          try {
            useGameStore
              .getState()
              .addToast(icon, message, durationMs);
          } catch {
            // Best effort.
          }
        },
        readPolicy: () => policyRef.current,
        readRemoteActivity: () => remoteActivityRef.current,
        readControlMode: () => useGameStore.getState().controlMode,
        readAvatarPosition: () => avatarPositionRef,
      },
    });
    controller.start();
    return () => controller.stop();
  }, [
    updateNpcsFromSnapshot,
    setNpcConnected,
    updatePlayersFromSnapshot,
    setLocalSessionId,
    setRoomId,
    clearPlayers,
    addCollaborationEntries,
    queryClient,
  ]);
}
