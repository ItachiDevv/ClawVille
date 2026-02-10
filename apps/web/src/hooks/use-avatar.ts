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
