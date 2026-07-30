'use client';

/**
 * TalkToCharacterBar — NPC-mode chat with the nearest wandering NPC.
 *
 * Renders only when `controlMode === 'npc'`. Reads `nearCharacter` from
 * the game store (set by npc-controller / player-avatar proximity passes
 * via `findNearestCharacter()` against character-positions.ts).
 *
 * - When no nearCharacter: disabled pill "Walk closer to a character to talk"
 * - When near: pill "Talk to {name}", expandable into a chat panel
 * - Submits to /api/chat/transient — stateless OpenAI one-shot, no Eliza,
 *   no DB writes, no persistent memory. Conversation history is held
 *   in-component memory only and resets when the user walks away (and
 *   nearCharacter changes) or when control mode flips out of 'npc'.
 *
 * Avatar chat (AvatarChatBar) is mounted only in player/autonomous modes per
 * Phase 6.2 — see /game/page.tsx. This component fills the mode-2 gap.
 */

import { useState, useRef, useEffect } from 'react';
import { useGameStore } from '@/stores/game';
import { api } from '@/lib/api';

interface TalkMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export default function TalkToCharacterBar() {
  const controlMode = useGameStore((s) => s.controlMode);
  const nearCharacter = useGameStore((s) => s.nearCharacter);
  const nearLocation = useGameStore((s) => s.nearLocation); // building in range
  const nearParcelCode = useGameStore((s) => s.nearParcelCode);
  const chatOpen = useGameStore((s) => s.chatOpen); // location chat (full panel) open

  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<TalkMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset transcript whenever the nearby character changes (you walked
  // away from one and approached another). Per session-only memory.
  useEffect(() => {
    setMessages([]);
    setExpanded(false);
    setHasUnread(false);
  }, [nearCharacter]);

  // Don't render outside NPC mode, when the full ChatPanel is open, at a
  // BUILDING (`nearLocation` set), or on a parcel (`nearParcelCode` set).
  // Knowledge-building chat is owned by the
  // proximity prompt → ChatPanel modal (full ElizaOS resident chat + skill-claim,
  // 2026-06-20); the parcel pill owns the same bottom slot on land. This bar
  // exists only for any non-building, non-parcel wandering-NPC chat.
  if (controlMode !== 'npc' || chatOpen || nearLocation || nearParcelCode) return null;

  const characterName = nearCharacter;
  const enabled = !!characterName;

  const scrollToBottom = () => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const handleSend = async () => {
    if (!input.trim() || loading || !characterName) return;
    const content = input.trim();
    setInput('');

    const userMsg: TalkMessage = { id: crypto.randomUUID(), role: 'user', content };
    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom();

    // Build history payload — last ~10 turns. Client owns memory; server
    // re-reads it each request.
    const history = messages.slice(-10).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setLoading(true);
    try {
      const res = await api.sendTransientChat(characterName, content, history);
      const assistantMsg: TalkMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: res.message.content,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (!expanded) setHasUnread(true);
      scrollToBottom();
    } catch (err: any) {
      const errorMsg: TalkMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `(Error: ${err?.message || 'Could not reach character'})`,
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
    e.stopPropagation();
  };

  const toggleExpand = () => {
    if (!enabled) return;
    setExpanded((e) => !e);
    if (!expanded) {
      setHasUnread(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const glyph = '💬';

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center w-full max-w-lg px-4 pb-3">
      {expanded && enabled && (
        <div className="w-full mb-2 claw-panel !p-0 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-cyan-600/25 to-cyan-500/10 border-b border-cyan-500/25">
            <span className="text-xl leading-none drop-shadow-[0_0_6px_rgba(0,229,255,0.35)]" aria-hidden>{glyph}</span>
            <span className="text-white font-bold text-sm">{characterName}</span>
            <span className="text-white/45 text-xs ml-auto font-mono uppercase tracking-[0.18em]">transient</span>
          </div>

          <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 && (
              <p className="text-cyan-300/40 text-xs text-center py-4 font-mono uppercase tracking-[0.2em]">
                Say something to {characterName}…
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

          <div className="px-3 py-2 border-t border-cyan-500/15">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Talk to ${characterName}…`}
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

      <button
        onClick={toggleExpand}
        disabled={!enabled}
        className={`group flex items-center gap-2 px-4 py-2 rounded-full border transition-all active:translate-y-0.5 ${
          enabled
            ? 'bg-gradient-to-r from-cyan-600 to-cyan-500 border-cyan-400/40 shadow-[0_0_25px_rgba(0,229,255,0.35)] hover:shadow-[0_0_35px_rgba(0,229,255,0.55)] hover:brightness-110'
            : 'bg-white/[0.06] border-white/[0.08] cursor-not-allowed opacity-60'
        }`}
      >
        <span className="text-2xl leading-none drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]" aria-hidden>{glyph}</span>
        <span className="text-white font-bold text-sm">
          {!enabled
            ? 'Walk closer to a character to talk'
            : expanded
              ? 'Close'
              : `Talk to ${characterName}`}
        </span>
        {hasUnread && !expanded && enabled && (
          <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
        )}
        {enabled && (
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
        )}
      </button>
    </div>
  );
}
