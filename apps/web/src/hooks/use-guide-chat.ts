'use client';

import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ChatMessage } from '@/types/chat';

const GUIDE_SLUG = 'town-guide';

/**
 * Town-guide (system-agent) chat hook. Mirrors `useLocationChat` minus the
 * history query + OpenClaw tagalong — the guide's RAG memory lives server-side
 * in Eliza (`characterRoomId('town-guide', userId)`) and we don't render past
 * turns on re-open. The consumer (GuideChatBody) is responsible for calling
 * `clearMessages()` when the panel closes so re-opening presents an empty view.
 */
export function useGuideChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const sendMutation = useMutation({
    mutationFn: (content: string) => api.sendSystemChat(GUIDE_SLUG, content),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.message.content,
          timestamp: data.message.timestamp,
        },
      ]);
    },
  });

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;
      // Optimistic user-bubble append — matches useLocationChat pattern.
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content,
          timestamp: new Date().toISOString(),
        },
      ]);
      sendMutation.mutate(content);
    },
    [sendMutation]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    sendMessage,
    clearMessages,
    isLoading: sendMutation.isPending,
    error: sendMutation.error,
  };
}
