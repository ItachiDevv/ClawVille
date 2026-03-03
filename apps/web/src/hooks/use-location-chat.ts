'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useGameStore } from '@/stores/game';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export function useLocationChat(locationId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Load chat history
  const { isLoading: isLoadingHistory } = useQuery({
    queryKey: ['chat-history', locationId],
    queryFn: () => api.getChatHistory(locationId!),
    enabled: !!locationId,
    onSuccess: (data: { messages: ChatMessage[] }) => {
      if (data.messages.length > 0) {
        setMessages(data.messages);
      }
    },
  } as any);

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

      // Fire-and-forget: also route through OpenClaw if connected
      const { openclawConnected, openclawSessionId } = useGameStore.getState();
      if (openclawConnected && openclawSessionId && locationId) {
        api.openclawLocationChat({
          sessionId: openclawSessionId,
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
