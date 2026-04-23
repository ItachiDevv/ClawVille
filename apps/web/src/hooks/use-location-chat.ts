'use client';

import { useState, useCallback, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useGameStore } from '@/stores/game';
import type { ChatMessage } from '@/types/chat';

export function useLocationChat(locationId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Load chat history
  const { data: historyData, isLoading: isLoadingHistory } = useQuery({
    queryKey: ['chat-history', locationId],
    queryFn: () => api.getChatHistory(locationId!),
    enabled: !!locationId,
  });

  // Clear messages when switching locations so stale history from the previous
  // location isn't shown while the new location's history loads.
  useEffect(() => {
    setMessages([]);
  }, [locationId]);

  // Sync fetched history into local messages state (onSuccess removed in TanStack Query v5)
  useEffect(() => {
    if (historyData?.messages?.length) {
      setMessages(historyData.messages);
    }
  }, [historyData]);

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: (content: string) => api.sendChat(locationId!, content),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: data.message.role as 'assistant',
          content: data.message.content,
          timestamp: data.message.timestamp,
        },
      ]);

      // Fire-and-forget: also route through connected agent if present
      const { agentConnected, agentSessionId } = useGameStore.getState();
      if (agentConnected && agentSessionId && locationId) {
        api.openclawLocationChat({
          sessionId: agentSessionId,
          locationId,
          content: data.message.content,
        }).catch(() => {}); // silent — this is supplementary
      }
    },
  });

  const sendMessage = useCallback(
    (content: string) => {
      if (!locationId || !content.trim()) return;

      // Optimistic add user message
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      sendMutation.mutate(content);
    },
    [locationId, sendMutation]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    sendMessage,
    clearMessages,
    isLoading: sendMutation.isPending,
    isLoadingHistory,
    error: sendMutation.error,
  };
}
