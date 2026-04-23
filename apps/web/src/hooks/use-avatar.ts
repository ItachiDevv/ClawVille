'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

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

export function useCreatePet() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.createAvatar,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
    },
  });
}

export function useCheckPetName() {
  return useMutation({
    mutationFn: (name: string) => api.checkPetName(name),
  });
}

/**
 * Phase 4c Layer 1 — in-game appearance edits. Invalidates ['avatar'] on
 * success so the modal, AvatarStatusBar, and the 3D world re-render with
 * the new avatar/color/gender.
 */
export function useEditPetAppearance() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.editPetAppearance,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['avatar'] });
    },
  });
}
