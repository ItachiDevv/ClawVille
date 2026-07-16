'use client';

import { useState, useRef, useEffect } from 'react';
import { useGameStore } from '@/stores/game';
import { useLocationChat } from '@/hooks/use-location-chat';
import { useGuideChat } from '@/hooks/use-guide-chat';
import { useLocationAgent } from '@/hooks/use-locations';
import { useAuthMe } from '@/hooks/use-auth-me';
import { MAP_LOCATIONS, isShopBuilding } from '@clawville/shared';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export default function ChatPanel() {
  const chatOpen = useGameStore((s) => s.chatOpen);
  const guideChatOpen = useGameStore((s) => s.guideChatOpen);
  const currentLocation = useGameStore((s) => s.currentLocation);

  // Global ESC handler — closes whichever chat is open. Prevents the
  // "movementFrozen stuck on" state: if a code path ever opens chat
  // without rendering a close button (old bug: ChatPanel was gated on
  // agentConnected; mobile LocationHUD tap in NPC mode froze movement
  // with no way to recover), ESC is always an escape hatch. Registered
  // unconditionally so it also catches the chatOpen-without-location
  // degenerate case below.
  useEffect(() => {
    if (!chatOpen && !guideChatOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const store = useGameStore.getState();
      if (store.guideChatOpen) store.closeGuideChat();
      else if (store.chatOpen) store.exitBuilding();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [chatOpen, guideChatOpen]);

  // Early returns — bail before rendering either body if neither chat is open,
  // or if a teacher chat is requested without a resolved location. Note: the
  // ESC hook above still fires for the chatOpen-without-location case so the
  // user can always unfreeze movement.
  if (!chatOpen && !guideChatOpen) return null;
  if (chatOpen && !currentLocation) {
    // Degenerate state — chat was opened but currentLocation never resolved.
    // Render a minimal close button rather than nothing, so the user can
    // recover without keyboard (mobile has no ESC key).
    return <RecoveryCloseButton />;
  }

  // Guide mode wins when both flags are true (guard in openGuideChat should
  // prevent that state, but resolve deterministically if it ever happens).
  if (guideChatOpen) {
    return <GuideChatBody />;
  }

  // chatOpen && currentLocation guaranteed by early-returns above
  return <LocationChatBody locationId={currentLocation as string} />;
}

/* --------------------------------------------------------------------- */
/* Recovery close — rendered when chatOpen=true but currentLocation is    */
/* null (degenerate state). A single floating button so the user — who    */
/* has movementFrozen=true — can unstick themselves on touch devices      */
/* where ESC isn't available.                                             */
/* --------------------------------------------------------------------- */

function RecoveryCloseButton() {
  const exitBuilding = useGameStore((s) => s.exitBuilding);
  return (
    <button
      onClick={exitBuilding}
      className="fixed top-4 right-4 z-50 w-11 h-11 rounded-full bg-red-500/90 hover:bg-red-500 text-white font-bold shadow-lg flex items-center justify-center"
      aria-label="Close chat"
    >
      X
    </button>
  );
}

/* --------------------------------------------------------------------- */
/* Guide (Town Guide / system-agent) body                                 */
/* --------------------------------------------------------------------- */

function GuideChatBody() {
  const closeGuideChat = useGameStore((s) => s.closeGuideChat);
  const guideChatOpen = useGameStore((s) => s.guideChatOpen);
  const { messages, sendMessage, clearMessages, isLoading } = useGuideChat();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Reset the displayed conversation whenever the panel is closed so the next
  // open shows an empty view. Server-side Eliza RAG still retains history.
  useEffect(() => {
    if (!guideChatOpen) clearMessages();
  }, [guideChatOpen, clearMessages]);

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

  return (
    <div className="chat-panel-enter fixed right-0 top-0 h-full w-full md:w-96 z-50 flex flex-col bg-gradient-to-b from-[#0a1a2e]/95 to-[#04111e]/95 backdrop-blur-md border-l border-cyan-400/25 shadow-[0_0_40px_rgba(0,229,255,0.15)]">
      {/* Header — guide name only; no Claim Skill, no Shop, no location subtitle */}
      <div className="flex items-start justify-between px-4 py-3 bg-gradient-to-r from-cyan-600/25 via-cyan-500/10 to-transparent border-b border-cyan-500/25 text-white">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0 font-bold">
            <span className="truncate">💬 Nori</span>
          </div>
        </div>
        <button
          onClick={closeGuideChat}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-black/40 text-white font-bold transition-colors shrink-0"
          aria-label="Close"
        >
          X
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center mt-8 space-y-2">
            <p className="text-cyan-300 text-sm font-bold">Nori</p>
            <p className="text-cyan-100/70 text-xs leading-relaxed px-4">
              Hi! I&apos;m Nori, your town guide.
            </p>
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
                  ? 'bg-cyan-500/90 text-white shadow-[0_0_12px_rgba(0,229,255,0.25)]'
                  : 'bg-white/[0.08] text-cyan-50 border border-white/[0.06]'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white/[0.08] rounded-lg px-4 py-3 flex gap-1.5 items-center">
              <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-cyan-500/15">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message…"
            className="flex-1 bg-black/40 border border-cyan-500/15 text-white placeholder-white/30 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30 transition-colors"
            disabled={isLoading}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-40 text-white font-bold uppercase tracking-wider rounded-lg px-4 py-2 text-xs transition-all shadow-[0_0_15px_rgba(0,229,255,0.2)]"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Location (building teacher) body — preserves original behavior         */
/* --------------------------------------------------------------------- */

function LocationChatBody({ locationId }: { locationId: string }) {
  const currentCharacter = useGameStore((s) => s.currentCharacter);
  const exitBuilding = useGameStore((s) => s.exitBuilding);
  const openShop = useGameStore((s) => s.openShop);
  const addToast = useGameStore((s) => s.addToast);

  const { messages, sendMessage, isLoading } = useLocationChat(locationId);
  const { data: agent, isLoading: isAgentLoading } = useLocationAgent(locationId);
  const { data: authData, isLoading: isAuthLoading } = useAuthMe();

  const [input, setInput] = useState('');
  const [isClaimingSkill, setIsClaimingSkill] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const location = MAP_LOCATIONS.find((l) => l.id === locationId);
  // Prefer the character name the player was standing next to when they
  // opened chat; fall back to the system-seeded agent's name (e.g. Gary),
  // and finally the building name if neither is available.
  const headerName = currentCharacter ?? agent?.agentName ?? location?.name ?? 'Unknown';
  const canInstallSkill =
    !isAuthLoading && !!authData?.user && !authData.user.isGuest;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  const handleDownloadSkill = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/skills/${locationId}/skill.md`, {
        credentials: 'include',
      });
      if (!res.ok) {
        addToast?.('⚠️', `No skill available for ${locationId}`);
        return;
      }
      const md = await res.text();
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clawville-${locationId}.skill.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast?.('📥', `${headerName}'s skill file downloaded`);
    } catch (err) {
      console.error('[ChatPanel] skill download failed:', err);
      addToast?.('⚠️', 'Skill download failed — check your connection');
    }
  };

  const handleClaimSkill = async () => {
    if (!canInstallSkill) {
      await handleDownloadSkill();
      return;
    }

    setIsClaimingSkill(true);
    try {
      const res = await fetch(`${API_BASE}/api/skills/${locationId}/claim`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            installed?: 'runtime' | 'marker' | 'already';
            hint?: string;
          }
        | null;
      if (!res.ok || body?.ok !== true || !body.installed) {
        addToast?.('⚠️', body?.hint ?? 'Skill install failed — try again');
        return;
      }

      const message = {
        runtime: "Installed into your agent's memory",
        marker: 'Claimed — your agent can fetch it via its session',
        already: 'Already installed',
      }[body.installed];
      addToast?.('🧠', message);
    } catch (err) {
      console.error('[ChatPanel] claim skill failed:', err);
      addToast?.('⚠️', 'Skill install failed — check your connection');
    } finally {
      setIsClaimingSkill(false);
    }
  };

  return (
    <div className="chat-panel-enter fixed right-0 top-0 h-full w-full md:w-96 z-50 flex flex-col bg-gradient-to-b from-[#0a1a2e]/95 to-[#04111e]/95 backdrop-blur-md border-l border-cyan-400/25 shadow-[0_0_40px_rgba(0,229,255,0.15)]">
      {/* Header — character name on top, building name as eyebrow subtitle */}
      <div className="flex items-start justify-between px-4 py-3 bg-gradient-to-r from-cyan-600/25 via-cyan-500/10 to-transparent border-b border-cyan-500/25 text-white">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0 font-bold">
            <span className="truncate">💬 {headerName}</span>
            <button
              onClick={handleClaimSkill}
              disabled={isClaimingSkill}
              className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-500/30 hover:bg-emerald-400/50 transition-colors shrink-0 flex items-center gap-1"
              title={
                canInstallSkill
                  ? "Install this character's skill into your agent"
                  : "Download this character's SKILL.md"
              }
            >
              <span aria-hidden>{isClaimingSkill ? '…' : '📥'}</span> Claim Skill
            </button>
            {canInstallSkill && (
              <button
                onClick={handleDownloadSkill}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] hover:bg-white/15 text-white/65 hover:text-white transition-colors shrink-0"
                title="Download the SKILL.md file"
                aria-label={`Download ${headerName}'s SKILL.md file`}
              >
                ↓ .md
              </button>
            )}
            {isShopBuilding(locationId) && (
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
        <div className="flex-1 flex items-center justify-center text-cyan-300/70 text-sm font-mono uppercase tracking-[0.2em]">
          Loading…
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="text-center mt-8 space-y-2">
                {agent?.agentName && (
                  <p className="text-cyan-300 text-sm font-bold">
                    {agent.agentName}
                  </p>
                )}
                {agent?.characterConfig?.greeting ? (
                  <p className="text-cyan-100/70 text-xs leading-relaxed px-4">
                    {agent.characterConfig.greeting}
                  </p>
                ) : (
                  <p className="text-cyan-300/50 text-sm font-mono uppercase tracking-[0.2em]">Start a conversation…</p>
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
                      ? 'bg-cyan-500/90 text-white shadow-[0_0_12px_rgba(0,229,255,0.25)]'
                      : 'bg-white/[0.08] text-cyan-50 border border-white/[0.06]'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white/[0.08] rounded-lg px-4 py-3 flex gap-1.5 items-center">
                  <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-cyan-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 border-t border-cyan-500/15">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message…"
                className="flex-1 bg-black/40 border border-cyan-500/15 text-white placeholder-white/30 rounded-lg px-3 py-2 text-sm outline-none focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30 transition-colors"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={isLoading || !input.trim()}
                className="bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:opacity-40 text-white font-bold uppercase tracking-wider rounded-lg px-4 py-2 text-xs transition-all shadow-[0_0_15px_rgba(0,229,255,0.2)]"
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
