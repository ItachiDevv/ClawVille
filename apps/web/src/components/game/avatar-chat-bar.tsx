'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';
import { useQuestStore, triggerQuestCheck } from '@/stores/quest';
import { api, ApiError } from '@/lib/api';
import { AUTH_ME_QUERY_KEY, fetchAuthMe } from '@/hooks/use-auth-me';
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
  chibi: '🦞',
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
  // 'directive' (P3 slice 2) = a command the human sent to their autonomous
  // agent (persisted server-side), NOT a chat turn — rendered distinctly.
  id: string;
  role: 'user' | 'assistant' | 'directive';
  content: string;
}

export default function AvatarChatBar() {
  const queryClient = useQueryClient();
  const { data: avatar } = useAvatar();
  // Read the SHARED auth-me cache (same queryKey game/page.tsx populates — no
  // extra fetch). Used to decide whether a dead-agent-session clear should keep
  // the user embodied. `isFetched` lets us distinguish "loaded, not a guest"
  // from "still loading" so we never evict on a race (default to keeping the
  // body when auth state is unresolved — D2 guidance 2026-06-12).
  const { data: authData, isFetched: authFetched } = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: fetchAuthMe,
    staleTime: 30_000,
    retry: false,
  });
  // F2 (2026-06-21): read the SAME ['agent-session'] cache game/page.tsx populates
  // (enabled:false → pure cache subscription, no extra fetch). `mode === 'hosted'`
  // means the avatar IS a server-hosted Eliza runtime (Milady/Hermes) — there is no
  // external bearer to lose and nothing to "reconnect", so the paired-no-bearer
  // "Reconnect your agent to chat as it" CTA below is meaningless and must not show.
  // Chatting already talks to the hosted agent via the authed avatar-chat path.
  const { data: agentSession } = useQuery({
    queryKey: ['agent-session'],
    queryFn: api.getAgentSession,
    enabled: false,
    staleTime: 30_000,
  });
  const agentHosted = agentSession?.connected === true && agentSession?.mode === 'hosted';
  const chatOpen = useGameStore((s) => s.chatOpen); // location chat open
  const controlMode = useGameStore((s) => s.controlMode);
  const agentPaired = useGameStore((s) => s.agentPaired);
  const agentConnected = useGameStore((s) => s.agentConnected);
  const agentSessionId = useGameStore((s) => s.agentSessionId);
  const setAgentConnection = useGameStore((s) => s.setAgentConnection);
  const setAgentConnectModalOpen = useGameStore((s) => s.setAgentConnectModalOpen);

  // Paired (the server says this user has a connected agent) but NO live bearer
  // in memory — the canonical post-reload state. The server emits the agent
  // bearer exactly once at connect and never again, so a reload cannot hold one
  // (Codex finding #2). In this state `routedThroughAgent` below is false and we
  // chat with the user's OWN avatar via the authed path; we surface a quiet
  // "reconnect to chat as your agent" affordance so the distinction is legible
  // (chatting WITH your avatar vs AS your connected agent). Never a fabricated
  // bearer — the only way to chat as the agent again is the in-session connect
  // flow that actually receives a bearer.
  // A hosted agent (Milady/Hermes runtime that IS the avatar) is paired with no
  // bearer too, but it has nothing to reconnect — exclude it so F2's bogus
  // "reconnect your agent" prompt never shows for hosted avatars.
  const pairedNoBearer = agentPaired && !agentSessionId && !agentHosted;
  // P3 slice 2 — in Autonomous mode with a HOSTED agent (a ClawVille-run Eliza
  // runtime, no external bearer), the bottom chatter is a DIRECTIVE channel:
  // the human directs the agent (persisted server-side + biases the autonomous
  // planner) rather than a Q&A chat. Bearer-connected agents (agentSessionId
  // present) keep the openclawChat routing untouched.
  const isDirectiveMode = controlMode === 'autonomous' && agentHosted && !agentSessionId;
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<AvatarMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  // Set when a chat send hits a dead agent session (404 + code
  // 'agent_session_not_found'). Surfaces a non-blocking "session ended —
  // reconnect" prompt in the expanded panel. We do NOT auto-reconnect: there
  // are no stored credentials to replay the agent handshake with.
  const [sessionEnded, setSessionEnded] = useState(false);
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

  // Once the agent reconnects (agentConnected flips back true), drop the
  // stale "session ended" banner so it can't linger after a successful
  // reconnect. Runs before the early returns to keep hook order stable.
  useEffect(() => {
    if (agentConnected && sessionEnded) setSessionEnded(false);
  }, [agentConnected, sessionEnded]);

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

    // P3 slice 2 — Autonomous + hosted: this is a DIRECTIVE, not a Q&A turn.
    // Persist it server-side (goal stream + planner bias); render it distinctly.
    if (isDirectiveMode) {
      const directiveMsg: AvatarMessage = { id: crypto.randomUUID(), role: 'directive', content };
      setMessages((prev) => [...prev, directiveMsg]);
      scrollToBottom();
      setLoading(true);
      try {
        await api.setDirective(content);
        void queryClient.invalidateQueries({ queryKey: ['autonomy-status'] });
        const okMsg: AvatarMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Directive set — ${avatar.name} will act on it autonomously.`,
        };
        setMessages((prev) => [...prev, okMsg]);
      } catch (err: any) {
        const code = err instanceof ApiError ? err.code : undefined;
        const msg =
          code === 'agent_provisioning_pending'
            ? `${avatar.name} is still being provisioned — try again shortly.`
            : code === 'guest_not_allowed'
              ? 'Sign up to direct your own agent.'
              : code === 'rate_limited'
                ? 'Too many directives — try again in a minute.'
                : `(Could not set directive: ${err?.message || 'unknown error'})`;
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: msg }]);
      } finally {
        setLoading(false);
        if (!expanded) setHasUnread(true);
        scrollToBottom();
      }
      return;
    }

    const userMsg: AvatarMessage = { id: crypto.randomUUID(), role: 'user', content };
    setMessages((prev) => [...prev, userMsg]);
    scrollToBottom();

    // Quest counter — Tier 1 "Meet Your Agent" + Tier 2 "Bonded" both
    // gate on avatarMessagesSent. Server validates against agent.chat.turn
    // (chatType=avatar) before crediting tokens.
    useQuestStore.getState().incrementCounter('avatarMessagesSent', 1);
    triggerQuestCheck();

    setLoading(true);
    // Whether this send went through the connected-agent gateway — only then
    // does a 404 mean a dead agent session worth clearing. A 404 on the local
    // avatar-chat path must NOT trip the reconnect flow.
    const routedThroughAgent = !!(agentConnected && agentSessionId);
    try {
      let res: { message: { role: string; content: string; timestamp: string } };

      if (routedThroughAgent) {
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
      // Dead agent session — the server lost the in-memory session (API
      // restart/deploy) or it expired. Detect via the stable machine code
      // (`agent_session_not_found`), never by matching the de-branded copy.
      // Clear the stale connected-state so the "Bot Training Active" pill +
      // connection routing stop, and surface a reconnect prompt. No
      // auto-retry: we hold no credentials to redo the agent handshake.
      //
      // The `status === 404` arm is a DELIBERATE fail-safe, not redundancy:
      // the code is the precise primary signal (POST /api/openclaw/chat emits
      // it on BOTH its 404s today — openclaw.ts), and the fallback keeps the
      // stale-clear working if the API ever ships a session-dead 404 without
      // the code. It's safe to keep broad because (a) it's gated by
      // `routedThroughAgent` so only the connected-agent send path can reach
      // it, and (b) that endpoint has no non-session 404 — so the worst case
      // even on a future change is a harmless false "session ended" the user
      // clears by clicking Reconnect. (Adversary audit 2026-06-12: fail-safe,
      // approved.)
      const dead =
        routedThroughAgent &&
        err instanceof ApiError &&
        (err.code === 'agent_session_not_found' || err.status === 404);
      if (dead) {
        // The dead AGENT session must NOT evict the user from their OWN
        // avatar. Keep a still-authenticated, non-guest owner embodied in
        // 'player' mode (avatar stays mounted, camera keeps following) — only
        // the agent-specific state clears. A guest or avatar-less user falls
        // back to 'explore' as before. Race-safe: if auth-me hasn't resolved
        // yet we DEFAULT to keeping the body (the user is mid-game with an
        // avatar), reconciled by game/page.tsx's auth-sync effect once auth
        // loads. See setAgentConnection's keepEmbodied doc + regression D2.
        const user = authData?.user;
        const ownsAvatar = !!avatar && (!authFetched || (!!user && !user.isGuest));
        setAgentConnection(null, { keepEmbodied: ownsAvatar }); // wipes agentConnected + agentSessionId + Bot-Training pill
        setSessionEnded(true);
        const endedMsg: AvatarMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'Your agent session ended. Reconnect your agent to keep training.',
        };
        setMessages((prev) => [...prev, endedMsg]);
        if (!expanded) setHasUnread(true);
        scrollToBottom();
        return;
      }
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

  // P3 slice 2 (spec A1) — clear the standing directive from the "Directing"
  // badge. Confirms in the thread; the agent resumes free autonomous behavior.
  const handleClearDirective = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await api.clearDirective();
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Directive cleared — ${avatar.name} resumes free exploration.`,
        },
      ]);
    } catch (err: any) {
      const code = err instanceof ApiError ? err.code : undefined;
      const msg =
        code === 'guest_not_allowed'
          ? 'Sign up to direct your own agent.'
          : code === 'rate_limited'
            ? 'Too many requests — try again in a minute.'
            : `(Could not clear directive: ${err?.message || 'unknown error'})`;
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: msg }]);
    } finally {
      setLoading(false);
      if (!expanded) setHasUnread(true);
      scrollToBottom();
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
    // z-[60]: must WIN the hit test over the autonomy-hud (z-50, left-anchored
    // w-80) — at 390px-wide portrait they horizontally collide and the hud
    // swallowed taps on the Directing clear-✕ (viewport-sweep DEFECT 1).
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center w-full max-w-lg px-4 pb-3">
      {/* Expanded chat area */}
      {expanded && (
        <div className="w-full mb-2 claw-panel !p-0 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
          {/* Chat header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-cyan-600/25 to-cyan-500/10 border-b border-cyan-500/25">
            <AgentIcon size={22} />
            <span className="text-white font-bold text-sm">{avatar.name}</span>
            {isDirectiveMode && (
              <span className="flex items-center gap-1 pl-1.5 pr-1 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider bg-violet-500/25 text-violet-100 border border-violet-300/40">
                Directing
                <button
                  type="button"
                  onClick={handleClearDirective}
                  disabled={loading}
                  aria-label="Clear directive — resume free exploration"
                  title="Clear directive"
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-violet-100/90 hover:bg-violet-400/30 hover:text-white disabled:opacity-40 transition-colors"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            )}
            <span className="text-white/45 text-xs ml-auto font-mono">
              {isDirectiveMode
                ? 'autonomous'
                : knowledgeTopics.length > 0
                  ? `Knows: ${knowledgeTopics.slice(0, 3).join(', ')}${knowledgeTopics.length > 3 ? '…' : ''}`
                  : 'your agent'}
            </span>
          </div>

          {/* Agent-session-ended banner — shown when a send hit a dead
              session. Non-blocking: the user can still chat with the
              local avatar (api.sendAvatarChat path) since agentConnected is
              now false. The button opens the existing connect modal. */}
          {sessionEnded && (
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/15 border-b border-amber-400/30">
              <span className="text-amber-300 text-sm leading-none">⚠️</span>
              <span className="text-amber-100/90 text-xs font-medium flex-1">
                Agent session ended — reconnect your agent.
              </span>
              <button
                type="button"
                onClick={() => {
                  setSessionEnded(false);
                  setAgentConnectModalOpen(true, 'connect');
                }}
                className="px-2.5 py-1 rounded-full text-[11px] font-mono bg-amber-500/25 hover:bg-amber-500/40 text-amber-50 border border-amber-300/40 transition-colors shrink-0"
              >
                Reconnect
              </button>
            </div>
          )}

          {/* Paired-but-no-live-bearer notice (post-reload). Non-blocking: the
              user is chatting with their OWN avatar via the authed path; the
              agent-bearer chat requires re-running the in-session connect flow
              (the server never re-emits the bearer). Hidden when the
              session-ended banner is already showing the same reconnect CTA.
              Light tokens only on the dark .claw-panel. */}
          {pairedNoBearer && !sessionEnded && (
            <div className="flex items-center gap-2 px-3 py-2 bg-cyan-500/10 border-b border-cyan-400/20">
              <span className="text-cyan-200 text-sm leading-none">💬</span>
              <span className="text-cyan-100/90 text-xs font-medium flex-1">
                Chatting with {avatar.name}. Reconnect your agent to chat as it.
              </span>
              <button
                type="button"
                onClick={() => setAgentConnectModalOpen(true, 'connect')}
                className="px-2.5 py-1 rounded-full text-[11px] font-mono bg-cyan-500/20 hover:bg-cyan-500/35 text-cyan-50 border border-cyan-300/30 transition-colors shrink-0"
              >
                Reconnect
              </button>
            </div>
          )}

          {/* Messages */}
          <div className="max-h-64 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 && (
              <p className="text-cyan-300/40 text-xs text-center py-4 font-mono uppercase tracking-[0.2em]">
                {isDirectiveMode ? `Direct ${avatar.name}…` : `Say something to ${avatar.name}…`}
              </p>
            )}
            {messages.map((msg) =>
              msg.role === 'directive' ? (
                // P3 slice 2 — a directive the human sent to their autonomous
                // agent. Distinct violet chip w/ label so it never reads as a
                // chat question.
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg px-3 py-1.5 text-sm bg-gradient-to-r from-violet-600/90 to-fuchsia-600/80 text-white border border-violet-300/40 shadow-[0_0_12px_rgba(139,92,246,0.3)]">
                    <span className="block text-[10px] font-mono uppercase tracking-[0.15em] text-violet-100/85 mb-0.5">
                      ⟶ Directive
                    </span>
                    {msg.content}
                  </div>
                </div>
              ) : (
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
              ),
            )}
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
                placeholder={isDirectiveMode ? 'Direct your agent…' : `Talk to ${avatar.name}…`}
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
