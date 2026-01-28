'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useLocations() {
  return useQuery({
    queryKey: ['locations'],
    queryFn: () => api.getLocations(),
    select: (data) => data.locations,
  });
}

export function useLocationAgent(locationId: string | null) {
  return useQuery({
    queryKey: ['location-agent', locationId],
    queryFn: () => api.getLocationAgent(locationId!),
    enabled: !!locationId,
    select: (data) => data.agent,
  });
}

export function useSaveLocationAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      locationId,
      data,
    }: {
      locationId: string;
      data: Parameters<typeof api.saveLocationAgent>[1];
    }) => api.saveLocationAgent(locationId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['location-agent', variables.locationId],
      });
    },
  });
}
