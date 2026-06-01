'use client';

import { useState, useRef, useMemo } from 'react';
import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';
import { useQuestStore, triggerQuestCheck } from '@/stores/quest';
import { api } from '@/lib/api';
import { KNOWLEDGE_BOOKS, type AgentCategory } from '@clawville/shared';
import { MODEL_REGISTRY } from '@/lib/three/agent-model-registry';

// Per-model glyph fallback for the chat pill when no preview PNG exists
// (mostly the GLB crustaceans + sea creatures). VRM models — every Milady,
// Hermes, and Tekk variant — render their actual preview thumbnail instead,
// so the chat pill matches what walks around in the 3D world.
const MODEL_GLYPH: Record<string, string> = {
  lobster: '🦞',
  sweet_crab: '🦀',
  lobster_plush: '🧸',
  hermitcrab: '🐚',
  jellyfish: '🪼',
  octopus: '🐙',
  seahorse: '🐉',
};

const CATEGORY_GLYPH: Record<AgentCategory, string> = {
  openclaw: '🦞',
  hermes: '⚡',
  milady: '💗',
  other: '🐠',
  // Hatcher (partner #2, added 2026-06-01) — egg/hatch motif. Phase 2 art is
  // the placeholder Milady VRM fleet, but the chat-pill glyph stays distinct.
  hatcher: '🐣',
};

function getAgentChatPreview(modelKey: string | undefined): string | undefined {
  if (!modelKey) return undefined;
  return (MODEL_REGISTRY as Record<string, { preview?: string }>)[modelKey]?.preview;
}

function getAgentChatGlyph(modelKey: string | undefined, category: AgentCategory | undefined): string {
  if (modelKey && MODEL_GLYPH[modelKey]) return MODEL_GLYPH[modelKey];
  if (category && CATEGORY_GLYPH[category]) return CATEGORY_GLYPH[category];
  return '🦞';
}

interface AvatarMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export default function AvatarChatBar() {
  const { data: avatar } = useAvatar();
  const chatOpen = useGameStore((s) => s.chatOpen); // location chat open
  const agentConnected = useGameStore((s) => s.agentConnected);
  const agentSessionId = useGameStore((s) => s.agentSessionId);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<AvatarMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derive learned book topics from characterConfig knowledge entries
  const knowledgeTopics = useMemo(() => {
    const knowledge: string[] = (avatar?.characterConfig as any)?.knowledge ?? [];
    if (knowledge.length === 0) return [];
    const topicNames: string[] = [];
    for (const book of KNOWLEDGE_BOOKS) {
      const hasEntry = book.knowledgeEntries.some((e) => knowledge.includes(e));
      if (hasEntry) topicNames.push(book.name.replace(/\s+(101|Guide|Basics|Deep Dive)$/i, ''));
    }
    return topicNames;
  }, [avatar?.characterConfig]);

  // Don't render when location chat is open or no avatar
  if (chatOpen || !avatar) return null;

  // Prefer a real avatar thumbnail (Milady/Hermes PNG previews) so the chat
  // pill matches the 3D character; fall back to a category-aware emoji for
  // models without a registered preview (mostly OpenClaw GLB crustaceans).
  const modelKey = (avatar as { modelKey?: string }).modelKey;
  const agentCategory = (avatar as { agentCategory?: AgentCategory }).agentCategory;
  const agentPreview = getAgentChatPreview(modelKey);
  const agentGlyph = getAgentChatGlyph(modelKey, agentCategory);

  function AgentIcon({ size }: { size: number }) {
    if (agentPreview) {
      return (
        <img
          src={agentPreview}
          alt=""
          aria-hidden
          width={size}
          height={size}
          className="rounded-full object-cover shrink-0 ring-1 ring-cyan-300/40 shadow-[0_0_8px_rgba(0,229,255,0.35)]"
          style={{ width: size, height: size }}
        />
      );
    }
    return (
      <span
        className="leading-none drop-shadow-[0_0_6px_rgba(0,229,255,0.35)]"
        style={{ fontSize: Math.round(size * 0.9) }}
        aria-hidden
      >
        {agentGlyph}
      </span>
    );
  }

  const scrollToBottom = () => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const content = input.trim();
    setInput('');

    const userMsg: AvatarMessage = { id: crypto.randomUUID(), role: 'user', content };
    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom();

    // Quest counter — Tier 1 "Meet Your Agent" + Tier 2 "Bonded" both
    // gate on avatarMessagesSent. Server validates against agent.chat.turn
    // (chatType=avatar) before crediting tokens.
    useQuestStore.getState().incrementCounter('avatarMessagesSent', 1);
    triggerQuestCheck();

    setLoading(true);
    try {
      let res: { message: { role: string; content: string; timestamp: string } };

      if (agentConnected && agentSessionId) {
        // Route through connected agent gateway
        res = await api.openclawChat({
          sessionId: agentSessionId,
          content,
          avatarContext: {
            name: avatar.name,
            species: avatar.species,
            archetype: (avatar as any).archetype,
            clawTokens: avatar.clawTokens,
            knowledge: ((avatar as any).characterConfig as any)?.knowledge,
          },
        });
      } else {
        res = await api.sendAvatarChat(content);
      }

      const assistantMsg: AvatarMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: res.message.content,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (!expanded) setHasUnread(true);
      scrollToBottom();
    } catch (err: any) {
      const errorMsg: AvatarMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `(Error: ${err.message || 'Could not reach agent'})`,
      };
      setMessages((prev) => [...prev, errorMsg]);
      scrollToBottom();
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Prevent game controls while typing
    e.stopPropagation();
  };

  const toggleExpand = () => {
    setExpanded((e) => !e);
    if (!expanded) {
      setHasUnread(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center w-full max-w-lg px-4 pb-3">
      {/* Expanded chat area */}
      {expanded && (
        <div className="w-full mb-2 claw-panel !p-0 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
          {/* Chat header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-cyan-600/25 to-cyan-500/10 border-b border-cyan-500/25">
            <AgentIcon size={22} />
            <span className="text-white font-bold text-sm">{avatar.name}</span>
            <span className="text-white/45 text-xs ml-auto font-mono">
              {knowledgeTopics.length > 0
                ? `Knows: ${knowledgeTopics.slice(0, 3).join(', ')}${knowledgeTopics.length > 3 ? '…' : ''}`
                : 'your agent'}
            </span>
          </div>

          {/* Messages */}
          <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 && (
              <p className="text-cyan-300/40 text-xs text-center py-4 font-mono uppercase tracking-[0.2em]">
                Say something to {avatar.name}…
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-1.5 text-sm ${
                    msg.role === 'user'
                      ? 'bg-cyan-500/90 text-white shadow-[0_0_12px_rgba(0,229,255,0.25)]'
                      : 'bg-white/[0.08] text-cyan-50 border border-white/[0.06]'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-white/[0.08] rounded-lg px-4 py-2 flex gap-1.5 items-center">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2 border-t border-cyan-500/15">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Talk to ${avatar.name}…`}
                className="flex-1 bg-black/40 border border-cyan-500/15 text-white placeholder-white/30 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30 transition-colors"
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                className="bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-40 text-white font-bold uppercase tracking-wider rounded-lg px-4 py-1.5 text-xs transition-all shadow-[0_0_15px_rgba(0,229,255,0.2)]"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toggle pill */}
      <button
        onClick={toggleExpand}
        className="group flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-cyan-600 to-cyan-500 border border-cyan-400/40 shadow-[0_0_25px_rgba(0,229,255,0.35)] hover:shadow-[0_0_35px_rgba(0,229,255,0.55)] hover:brightness-110 transition-all active:translate-y-0.5"
      >
        <AgentIcon size={26} />
        {agentConnected && (
          <span className="text-emerald-300 text-xs" title="Agent connected">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </span>
        )}
        <span className="text-white font-bold text-sm">
          {expanded ? 'Close' : `Chat with ${avatar.name}`}
        </span>
        {hasUnread && !expanded && (
          <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
        )}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="m18 15-6-6-6 6" />
        </svg>
      </button>
    </div>
  );
}
