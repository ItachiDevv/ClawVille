'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SpawnPreferenceMode, SpawnPreferenceResponse } from '@/components/game/land/types';

export function useAvatar() {
  return useQuery({
    queryKey: ['avatar'],
    queryFn: async () => {
      try {
        return await api.getMyAvatar();
      } catch {
        // Gracefully return null when unauthenticated (401) or no avatar
        return { avatar: null };
      }
    },
    select: (data) => data.avatar,
    retry: false,
  });
}

export function useCreateAvatar() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.createAvatar,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
    },
  });
}

export function useCheckAvatarName() {
  return useMutation({
    mutationFn: (name: string) => api.checkAvatarName(name),
  });
}

/**
 * Phase 4c Layer 1 — in-game appearance edits.
 *
 * Optimistic update pattern: we flip the avatar's modelKey/color/gender in
 * the react-query cache immediately so the 3D world swaps avatars the
 * frame the user hits Save. On server error we roll back to the
 * pre-mutation snapshot. On success we invalidate so the server's
 * authoritative avatar (with regenerated characterConfig.system + the
 * agents.config mirror) replaces our local guess.
 */
export function useEditAvatarAppearance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.editAvatarAppearance,
    onMutate: async (patch) => {
      // Cancel in-flight refetches so they don't race our optimistic write.
      await queryClient.cancelQueries({ queryKey: ['avatar'] });
      // Snapshot for rollback.
      const previous = queryClient.getQueryData<{ avatar: Record<string, unknown> | null }>(['avatar']);
      if (previous?.avatar) {
        queryClient.setQueryData<{ avatar: Record<string, unknown> | null }>(['avatar'], {
          ...previous,
          avatar: { ...previous.avatar, ...patch },
        });
      }
      return { previous };
    },
    onError: (_err, _patch, context) => {
      // Roll back to pre-mutation state so the UI doesn't show the
      // unapplied change after a server rejection (e.g. cross-pool 400).
      if (context?.previous) {
        queryClient.setQueryData(['avatar'], context.previous);
      }
    },
    onSuccess: () => {
      // Server returns the authoritative avatar including the regenerated
      // characterConfig.system — invalidate so we pick it up.
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
    },
  });
}

/**
 * Set the avatar's spawn preference — town center vs an owned home parcel
 * (town-fast-travel, 2026-06-19). Wraps `api.setSpawnPreference` and invalidates
 * the avatar query on success so `avatar.spawnPreference` / `avatar.homeParcelId`
 * refresh (the Land Office reflects the new choice immediately, and SpawnOnLoad
 * reads the fresh values on the next world load).
 *
 * Body contract (FROZEN — see land/types.ts):
 *   { mode: 'town' }                         → clears the home spawn
 *   { mode: 'home', parcelId: <owned uuid> } → server 403 code:'not_owned' if
 *                                              the parcel isn't owned by the caller
 * honoRequest throws ApiError{status,code}; callers branch on err.code.
 */
export function useSetSpawnPreference() {
  const queryClient = useQueryClient();

  return useMutation<SpawnPreferenceResponse, unknown, { mode: SpawnPreferenceMode; parcelId?: string }>({
    mutationFn: (body) => api.setSpawnPreference(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
    },
  });
}
