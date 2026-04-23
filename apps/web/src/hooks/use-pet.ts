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
 * Phase 4c Layer 1 — in-game appearance edits. Invalidates ['pet'] on
 * success so the modal, PetStatusBar, and the 3D world re-render with
 * the new avatar/color/gender.
 */
export function useEditPetAppearance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.editPetAppearance,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pet'] });
    },
  });
}
