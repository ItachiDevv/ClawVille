'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function usePet() {
  return useQuery({
    queryKey: ['pet'],
    queryFn: () => api.getMyPet(),
    select: (data) => data.pet,
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
