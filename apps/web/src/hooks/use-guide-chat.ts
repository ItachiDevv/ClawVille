'use client';

import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { ensureGuestAvatar } from '@/lib/guest-bootstrap';
import { AUTH_ME_QUERY_KEY } from '@/hooks/use-auth-me';
import { useQuestStore, triggerQuestCheck } from '@/stores/quest';
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
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      try {
        return await api.sendSystemChat(GUIDE_SLUG, content);
      } catch (error) {
        // Explore visitors can open Nori before they have a session. Only a
        // confirmed 401 bootstraps a guest; network/5xx errors never change
        // identity. requireAuth rejects before the server processes a turn.
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        const guest = await ensureGuestAvatar();
        if (!guest) throw new Error('Could not start guest chat. Please try again.');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['avatar'] }),
          queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY }),
        ]);
        return api.sendSystemChat(GUIDE_SLUG, content);
      }
    },
    onSuccess: (data) => {
      // Failed requests are not conversations and must not advance a quest.
      useQuestStore.getState().incrementCounter('systemAgentMessagesSent', 1);
      triggerQuestCheck();
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
