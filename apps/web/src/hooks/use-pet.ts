'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function usePet() {
  return useQuery({
    queryKey: ['pet'],
    queryFn: async () => {
      try {
        return await api.getMyPet();
      } catch {
        // Gracefully return null when unauthenticated (401) or no pet
        return { pet: null };
      }
    },
    select: (data) => data.pet,
    retry: false,
  });
}

export function useCreatePet() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.createPet,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pet'] });
    },
  });
}

export function useCheckPetName() {
  return useMutation({
    mutationFn: (name: string) => api.checkPetName(name),
  });
}

/**
 * Phase 4c Layer 1 — in-game appearance edits.
 *
 * Optimistic update pattern: we flip the pet's modelKey/color/gender in
 * the react-query cache immediately so the 3D world swaps avatars the
 * frame the user hits Save. On server error we roll back to the
 * pre-mutation snapshot. On success we invalidate so the server's
 * authoritative pet (with regenerated characterConfig.system + the
 * agents.config mirror) replaces our local guess.
 */
export function useEditPetAppearance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.editPetAppearance,
    onMutate: async (patch) => {
      // Cancel in-flight refetches so they don't race our optimistic write.
      await queryClient.cancelQueries({ queryKey: ['pet'] });
      // Snapshot for rollback.
      const previous = queryClient.getQueryData<{ pet: Record<string, unknown> | null }>(['pet']);
      if (previous?.pet) {
        queryClient.setQueryData<{ pet: Record<string, unknown> | null }>(['pet'], {
          ...previous,
          pet: { ...previous.pet, ...patch },
        });
      }
      return { previous };
    },
    onError: (_err, _patch, context) => {
      // Roll back to pre-mutation state so the UI doesn't show the
      // unapplied change after a server rejection (e.g. cross-pool 400).
      if (context?.previous) {
        queryClient.setQueryData(['pet'], context.previous);
      }
    },
    onSuccess: () => {
      // Server returns the authoritative pet including the regenerated
      // characterConfig.system — invalidate so we pick it up.
      queryClient.invalidateQueries({ queryKey: ['pet'] });
    },
  });
}
