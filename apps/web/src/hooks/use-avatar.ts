'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useAvatar() {
  return useQuery({
    queryKey: ['avatar'],
    queryFn: () => api.getMyAvatar(),
    select: (data) => data.avatar,
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
