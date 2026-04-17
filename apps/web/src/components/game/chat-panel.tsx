'use client';

import { useState, useRef, useEffect } from 'react';
import { useGameStore } from '@/stores/game';
import { useLocationChat } from '@/hooks/use-location-chat';
import { useLocationAgent } from '@/hooks/use-locations';
import { MAP_LOCATIONS, isShopBuilding } from '@clawville/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function ChatPanel() {
  const { chatOpen, currentLocation, currentCharacter, exitBuilding, openShop, addToast } = useGameStore();
  const { messages, sendMessage, isLoading } = useLocationChat(currentLocation);
  const { data: agent, isLoading: isAgentLoading } = useLocationAgent(currentLocation);

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const location = MAP_LOCATIONS.find((l) => l.id === currentLocation);
  // Prefer the character name the player was standing next to when they
  // opened chat; fall back to the system-seeded agent's name (e.g. Gary),
  // and finally the building name if neither is available.
  const headerName = currentCharacter ?? agent?.agentName ?? location?.name ?? 'Unknown';

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!chatOpen || !currentLocation) return null;

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * Claim the building's compiled SKILL.md — works for humans (downloads
   * the markdown file so they can hand it to their own agent) and is the
   * same payload the agent-gateway returns to autonomous agents. The
   * `/api/skills/:buildingId/skill.md` route serves it as text/markdown
   * straight from `building_skills.content`.
   */
  const handleClaimSkill = async () => {
    if (!currentLocation) return;
    try {
      const res = await fetch(`${API_BASE}/api/skills/${currentLocation}/skill.md`);
      if (!res.ok) {
        addToast?.('⚠️', `No skill available for ${currentLocation}`);
        return;
      }
      const md = await res.text();
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clawville-${currentLocation}.skill.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast?.('📥', `${headerName}'s skill claimed!`);
    } catch (err) {
      console.error('[ChatPanel] claim skill failed:', err);
      addToast?.('⚠️', 'Skill download failed — check your connection');
    }
  };

  return (
    <div className="chat-panel-enter fixed right-0 top-0 h-full w-full md:w-96 z-50 flex flex-col bg-black/80 backdrop-blur-sm border-l-2 border-yellow-500/50">
      {/* Header — character name on top, building name as eyebrow subtitle */}
      <div className="flex items-start justify-between px-4 py-3 bg-gradient-to-r from-yellow-600 to-yellow-500 text-white">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0 font-bold">
            <span className="truncate">💬 {headerName}</span>
            <button
              onClick={handleClaimSkill}
              className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-500/30 hover:bg-emerald-400/50 transition-colors shrink-0 flex items-center gap-1"
              title="Download this character's SKILL.md — drop it into your agent's skills folder"
            >
              <span aria-hidden>📥</span> Claim Skill
            </button>
            {currentLocation && isShopBuilding(currentLocation) && (
              <button
                onClick={openShop}
                className="text-[11px] font-bold px-2 py-0.5 rounded bg-white/10 hover:bg-black/30 transition-colors shrink-0"
                title="Browse shop items"
              >
                Shop
              </button>
            )}
          </div>
          {location?.name && (
            <span className="text-[10px] font-mono uppercase tracking-[0.15em] text-white/60 truncate">
              {location.icon} {location.name}
            </span>
          )}
        </div>
        <button
          onClick={exitBuilding}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-black/40 text-white font-bold transition-colors shrink-0"
          aria-label="Close"
        >
          X
        </button>
      </div>

      {/* Body */}
      {isAgentLoading ? (
        <div className="flex-1 flex items-center justify-center text-yellow-300/70 text-sm">
          Loading...
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center mt-8 space-y-2">
                {agent?.agentName && (
                  <p className="text-yellow-300 text-sm font-bold">
                    {agent.agentName}
                  </p>
                )}
                {agent?.characterConfig?.greeting ? (
                  <p className="text-yellow-200/70 text-xs leading-relaxed px-4">
                    {agent.characterConfig.greeting}
                  </p>
                ) : (
                  <p className="text-yellow-300/50 text-sm">Start a conversation...</p>
                )}
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user'
                      ? 'bg-yellow-500/90 text-black'
                      : 'bg-white/10 text-yellow-100'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white/10 rounded-lg px-4 py-3 flex gap-1.5 items-center">
                  <span className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-yellow-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 border-t border-yellow-500/20">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                className="flex-1 bg-white/10 text-white placeholder-white/40 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-yellow-500/50"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-white font-bold rounded-lg px-4 py-2 text-sm transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
