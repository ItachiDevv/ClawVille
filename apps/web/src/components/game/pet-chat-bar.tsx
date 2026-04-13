'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Image from 'next/image';
import { usePet } from '@/hooks/use-pet';
import { useGameStore } from '@/stores/game';
import { api } from '@/lib/api';
import { PET_SPECIES, KNOWLEDGE_BOOKS } from '@clawville/shared';
import { SPECIES_SPRITE_MAP } from '@/lib/pixi/pet-sprites';
import type { PetSpecies } from '@clawville/shared';

interface PetMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export default function PetChatBar() {
  const { data: pet } = usePet();
  const chatOpen = useGameStore((s) => s.chatOpen); // location chat open
  const openclawConnected = useGameStore((s) => s.openclawConnected);
  const openclawSessionId = useGameStore((s) => s.openclawSessionId);
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<PetMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Derive learned book topics from characterConfig knowledge entries
  const knowledgeTopics = useMemo(() => {
    const knowledge: string[] = (pet?.characterConfig as any)?.knowledge ?? [];
    if (knowledge.length === 0) return [];
    const topicNames: string[] = [];
    for (const book of KNOWLEDGE_BOOKS) {
      const hasEntry = book.knowledgeEntries.some((e) => knowledge.includes(e));
      if (hasEntry) topicNames.push(book.name.replace(/\s+(101|Guide|Basics|Deep Dive)$/i, ''));
    }
    return topicNames;
  }, [pet?.characterConfig]);

  // Don't render when location chat is open or no pet
  if (chatOpen || !pet) return null;

  const species = pet.species as PetSpecies;
  const speciesData = PET_SPECIES.find((s) => s.id === species);
  const emoji = speciesData?.emoji ?? '?';
  const spritePath = SPECIES_SPRITE_MAP[species] ?? SPECIES_SPRITE_MAP.cat;

  const scrollToBottom = () => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const content = input.trim();
    setInput('');

    const userMsg: PetMessage = { id: crypto.randomUUID(), role: 'user', content };
    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom();

    setLoading(true);
    try {
      let res: { message: { role: string; content: string; timestamp: string } };

      if (openclawConnected && openclawSessionId) {
        // Route through OpenClaw gateway
        res = await api.openclawChat({
          sessionId: openclawSessionId,
          content,
          petContext: {
            name: pet.name,
            species: pet.species,
            archetype: (pet as any).archetype,
            clawTokens: (pet as any).clawTokens,
            knowledge: ((pet as any).characterConfig as any)?.knowledge,
          },
        });
      } else {
        res = await api.sendPetChat(content);
      }

      const assistantMsg: PetMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: res.message.content,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (!expanded) setHasUnread(true);
      scrollToBottom();
    } catch (err: any) {
      const errorMsg: PetMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `(Error: ${err.message || 'Could not reach pet agent'})`,
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
        <div className="w-full mb-2 bg-black/80 backdrop-blur-sm border border-yellow-500/40 rounded-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
          {/* Chat header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-600/80 to-yellow-500/80 border-b border-yellow-500/30">
            <img
              src={spritePath}
              alt={pet.name}
              width={24}
              height={24}
              className="w-6 h-6 object-contain"
            />
            <span className="text-white font-bold text-sm">{pet.name}</span>
            <span className="text-white/50 text-xs ml-auto">
              {knowledgeTopics.length > 0
                ? `Knows: ${knowledgeTopics.slice(0, 3).join(', ')}${knowledgeTopics.length > 3 ? '...' : ''}`
                : 'your pet'}
            </span>
          </div>

          {/* Messages */}
          <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 && (
              <p className="text-yellow-300/40 text-xs text-center py-4">
                Say something to {pet.name}...
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
                      ? 'bg-yellow-500/80 text-black'
                      : 'bg-white/10 text-yellow-100'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-white/10 rounded-lg px-4 py-2 flex gap-1.5 items-center">
                  <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2 border-t border-yellow-500/20">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Talk to ${pet.name}...`}
                className="flex-1 bg-white/10 text-white placeholder-white/30 rounded-lg px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-yellow-500/50"
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={loading || !input.trim()}
                className="bg-yellow-500 hover:bg-yellow-400 disabled:opacity-40 text-white font-bold rounded-lg px-3 py-1.5 text-sm transition-colors"
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
        className="group flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-yellow-500 to-yellow-400 border-2 border-yellow-600 shadow-claw hover:brightness-110 transition-all active:translate-y-0.5 active:shadow-none"
      >
        <img
          src={spritePath}
          alt={pet.name}
          width={28}
          height={28}
          className="w-7 h-7 object-contain drop-shadow-sm"
        />
        {openclawConnected && (
          <span className="text-green-700 text-xs" title="OpenClaw connected">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
            </svg>
          </span>
        )}
        <span className="text-white font-bold text-sm">
          {expanded ? 'Close' : `Chat with ${pet.name}`}
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
