'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuthMe } from '@/hooks/use-auth-me';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';

export default function AgentConnectModal() {
  const router = useRouter();
  const { agentConnectModalOpen, agentConnectModalIntent, setAgentConnectModalOpen, agentConnected, agentSessionId, setAgentConnection, addToast, setSkillBuilderOpen } = useGameStore();
  const { data: avatar } = useAvatar();
  const { data: authData } = useAuthMe();
  // Same query the game page uses to hydrate the banner — TanStack dedupes
  // so this is essentially free. `mode` tells us whether the "connected"
  // state comes from a server-hosted avatar (no real disconnect possible,
  // just dismissal) or a live external bot (auto-derived from recent
  // activity; no button needed — bot liveness is the source of truth).
  const { data: agentSession } = useQuery({
    queryKey: ['agent-session'],
    queryFn: api.getAgentSession,
    enabled: !!authData?.user?.id,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const sessionMode = (agentSession as { mode?: string } | undefined)?.mode;
  const isHosted = sessionMode === 'hosted';
  const isExternalActive = sessionMode === 'external-active';

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ knowledgeCount: number; markdown: string } | null>(null);
  const [error, setError] = useState('');

  // --- Connect link state ---
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [, setPolling] = useState(false);
  const [expiresIn, setExpiresIn] = useState(0);
  const [copied, setCopied] = useState(false);
  // Phase 6.1 — learning focus the human picks before the magic link is
  // issued. Flows through `/api/agent/connect-token` → pending connection
  // → avatar.learning_focus on /connect claim → system prompt injection.
  const [learningFocus, setLearningFocus] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount or close
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Stop polling when modal closes
  useEffect(() => {
    if (!agentConnectModalOpen && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setPolling(false);
    }
  }, [agentConnectModalOpen]);

  const handleGenerateToken = useCallback(async () => {
    // Avatar-gate is enforced upstream by the render branch (the "create your
    // agent" block replaces this button when no avatar exists), so this path
    // shouldn't be reachable without an avatar. Guard remains as a defense-in-
    // depth check — but the message is short because the user never sees it.
    if (!avatar?.id || !authData?.user?.id) {
      setError('Avatar required — close this modal and click Create Your Agent.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await api.generateConnectToken({
        avatarId: avatar.id,
        avatarName: avatar.name ?? 'MyBot',
        userId: authData.user.id,
        ...(learningFocus.trim() ? { learningFocus: learningFocus.trim() } : {}),
      });
      setConnectToken(res.token);
      setConnectUrl(res.connectUrl);
      setInstruction(res.instruction);
      setExpiresIn(res.expiresIn);
      setPolling(true);

      // Start polling for connection
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.pollConnectStatus(res.token);
          setExpiresIn(status.expiresIn);
          if (status.connected && status.sessionId) {
            // Agent connected!
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setPolling(false);
            setAgentConnection(status.sessionId);
            addToast('🔌', 'Agent connected to ClawVille!');
          }
        } catch {
          // Token expired or error — stop polling
          clearInterval(pollRef.current!);
          pollRef.current = null;
          setPolling(false);
          setConnectToken(null);
          setError('Connection token expired. Generate a new one.');
        }
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Failed to generate connection token');
    } finally {
      setLoading(false);
    }
  }, [avatar, authData, addToast, setAgentConnection, learningFocus]);

  const handleCopyUrl = () => {
    if (!connectUrl) return;
    navigator.clipboard.writeText(connectUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Manual gateway-form connect flow removed 2026-04-16 — Quick Connect
  // is now the single agent-onboarding surface. The `/api/openclaw/register`
  // endpoint is kept for backwards-compat per CLAUDE.md §6.4, just not
  // exposed in the UI anymore.

  const handleExport = async () => {
    if (!avatar?.id) return;
    setExporting(true);
    try {
      const data = await api.exportKnowledge(avatar.id);
      const knowledgeCount = data.knowledge?.length ?? 0;
      setExportResult({ knowledgeCount, markdown: data.skillMd });
      addToast('📦', `Exported ${knowledgeCount} knowledge entries as SKILL.md`);
    } catch {
      addToast('❌', 'Failed to export knowledge');
    } finally {
      setExporting(false);
    }
  };

  const handleDisconnect = async () => {
    if (avatar?.id) {
      try {
        const data = await api.exportKnowledge(avatar.id);
        setExportResult({ knowledgeCount: data.knowledge?.length ?? 0, markdown: data.skillMd });
      } catch { /* non-blocking */ }
    }
    if (agentSessionId) {
      try { await api.unregisterAgentBot(agentSessionId); } catch { /* ignore */ }
    }
    // Persist the dismissal — without this, the Milady server-hosted carve-out
    // in /api/auth/me/agent-session re-asserts connected:true on every reload
    // for users who don't have an external bot row to expire. Flag is cleared
    // again the next time they mint a Connect URL.
    try { await api.dismissAgentBanner(); } catch { /* ignore — local state already cleared */ }
    setAgentConnection(null);
    addToast('🔌', 'Agent disconnected');
  };

  const handleCopySkillMd = () => {
    if (!exportResult?.markdown) return;
    navigator.clipboard.writeText(exportResult.markdown);
    addToast('📋', 'SKILL.md copied to clipboard!');
  };

  const handleDownloadSkillMd = () => {
    if (!exportResult?.markdown) return;
    const blob = new Blob([exportResult.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${avatar?.name ?? 'avatar'}-skill.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!agentConnectModalOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setAgentConnectModalOpen(false)} />
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="bg-[rgba(8,20,40,0.95)] border border-cyan-500/20 rounded-2xl shadow-[0_0_40px_rgba(0,229,255,0.08)] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Connect Agent</h2>
            <button
              onClick={() => setAgentConnectModalOpen(false)}
              className="text-white/40 hover:text-white/80 text-lg"
            >
              ×
            </button>
          </div>

          {agentConnected ? (
            /* ─── Connected state ─── */
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-green-500 shadow-[0_0_6px_rgba(74,222,128,0.6)] animate-pulse" />
                <span className="text-green-400 font-bold text-sm">Agent Connected</span>
              </div>
              <p className="text-white/50 text-xs">
                Your agent is exploring ClawVille and learning skills from every building visit.
              </p>
              <p className="text-white/30 text-xs font-mono">
                Session: {agentSessionId}
              </p>

              {exportResult && (
                <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-3 py-2 space-y-2">
                  <p className="text-cyan-300 font-bold text-xs">
                    SKILL.md exported — {exportResult.knowledgeCount} knowledge entries
                  </p>
                  <div className="flex gap-2">
                    <button onClick={handleCopySkillMd} className="flex-1 text-xs px-2 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 font-bold">Copy</button>
                    <button onClick={handleDownloadSkillMd} className="flex-1 text-xs px-2 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 font-bold">Download</button>
                  </div>
                </div>
              )}

              {/* Status detail — paired-active gets a status line + last-seen
                  timestamp; hosted avatars get a "this lives on our servers"
                  hint. */}
              {isExternalActive && (agentSession as any)?.lastSeenAt && (
                <p className="text-cyan-300/60 text-[11px] font-mono">
                  Last action: {new Date((agentSession as any).lastSeenAt).toLocaleTimeString()} · auto-grays after 5 min idle
                </p>
              )}
              {isHosted && (
                <p className="text-cyan-300/60 text-[11px]">
                  Server-hosted runtime ({(agentSession as any)?.harness}) — always reachable. Nothing to disconnect; hide the banner instead.
                </p>
              )}

              <div className="flex gap-2">
                <button onClick={handleExport} disabled={exporting || !avatar?.id} className="flex-1 px-3 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 text-xs font-bold disabled:opacity-50">
                  {exporting ? 'Exporting...' : 'Export SKILL.md'}
                </button>
                {/* Disconnect makes sense only for hosted avatars (UI-only
                    dismissal flag) and legacy external-active sessions where
                    the user explicitly wants to invalidate the sessionId.
                    For pure hosted avatars rename to "Hide banner" so the
                    label matches what the action does. For external bots
                    that are actively training, killing their sessionId
                    server-side while they're alive locally is the "lying
                    to the local bot" problem — so we hide the button and
                    let liveness auto-derive instead. */}
                {isHosted ? (
                  <button onClick={handleDisconnect} className="flex-1 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 text-xs font-bold">
                    Hide banner
                  </button>
                ) : isExternalActive ? null : (
                  <button onClick={handleDisconnect} className="flex-1 px-3 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs font-bold">
                    Disconnect
                  </button>
                )}
              </div>
              <button
                onClick={() => { setAgentConnectModalOpen(false); setSkillBuilderOpen(true); }}
                className="w-full px-3 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 text-xs font-bold"
              >
                Build Skill
              </button>
            </div>
          ) : (agentConnectModalIntent === 'create' || !avatar?.id) ? (
            /* ─── Create-Agent explainer ────────────────────────────────
                Shown when:
                  - user clicked "Create Agent" in the banner (intent='create')
                  - OR they clicked "Connect Your Agent" but have no avatar yet,
                    in which case connect can't proceed and we route them
                    through avatar creation first.
                User flow split intentionally so the two banner CTAs feel
                distinct: Create Agent always lands here; Connect Your Agent
                only lands here as a fallback. */
            <div className="space-y-3">
              <p className="text-white/70 text-sm leading-relaxed">
                Before you can connect an external AI agent, you need an{' '}
                <span className="text-cyan-300 font-bold">in-game agent character</span>{' '}
                for it to control. Your external bot (Hermes, OpenClaw, ElizaOS, custom)
                will pilot this character — moving around the world, visiting buildings,
                buying skills, and talking to teachers.
              </p>

              <div className="bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-3 py-2.5 space-y-2">
                <p className="text-cyan-300/80 font-bold text-xs">What this gives you:</p>
                <ul className="text-[11px] text-white/50 space-y-1 list-disc list-inside">
                  <li>A persistent character your bot owns — its on-chain avatar wallet, its accumulated knowledge, its leaderboard rank</li>
                  <li>An identity the server attaches every connect URL, magic link, and skill purchase to</li>
                  <li>An avatar — pick a species, color, archetype, and personality once</li>
                </ul>
              </div>

              <button
                onClick={() => {
                  setAgentConnectModalOpen(false);
                  router.push('/create-agent');
                }}
                className="w-full px-4 py-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-bold text-sm transition-all"
              >
                Create Your Agent →
              </button>

              <p className="text-[11px] text-white/30 text-center">
                Takes about 30 seconds. After that, come back here to generate
                a connect link for your external bot.
              </p>
            </div>
          ) : (
            /* ─── Not connected (has avatar) ─── */
            <div className="space-y-3">
              <p className="text-white/50 text-sm">
                Connect your AI agent to explore ClawVille and learn skills from 10 buildings.
              </p>

              {/* ─── Quick Connect (single surface) ─── */}
              <div className="space-y-3">
                <div className="bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-3 py-2">
                  <p className="text-cyan-300/70 font-bold text-xs mb-1">How it works:</p>
                  <ol className="text-[11px] text-white/40 space-y-1 list-decimal list-inside">
                    <li>Click &ldquo;Generate Connect Link&rdquo; below</li>
                    <li>Copy the link and paste it into your agent&apos;s chat</li>
                    <li>Your agent reads the instructions and connects automatically</li>
                  </ol>
                </div>

                {!connectToken ? (
                  <>
                    <div className="space-y-1.5">
                      <label className="block text-white/50 text-[11px] font-mono uppercase tracking-[0.2em]">
                        ⟐ learning focus (optional)
                      </label>
                      <input
                        type="text"
                        value={learningFocus}
                        onChange={(e) => setLearningFocus(e.target.value.slice(0, 120))}
                        maxLength={120}
                        placeholder="e.g. cron jobs, solana signing, discord bots"
                        className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-white placeholder:text-white/25 focus:outline-none focus:border-cyan-400/60 transition-all text-sm"
                      />
                      <p className="text-[10px] text-white/30 font-mono">
                        Biases your agent toward the matching building teacher. Leave blank for free exploration.
                      </p>
                    </div>
                    <button
                      onClick={handleGenerateToken}
                      disabled={loading}
                      className="w-full px-4 py-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-bold text-sm transition-all disabled:opacity-50"
                    >
                      {loading ? 'Generating...' : 'Generate Connect Link'}
                    </button>
                  </>
                ) : (
                  <div className="space-y-3">
                    {/* Copyable URL */}
                    <div>
                      <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">
                        Paste this into your agent&apos;s chat
                      </label>
                      <div className="flex gap-1">
                        <div className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-cyan-300 font-mono break-all select-all">
                          Read this URL and follow the instructions: {connectUrl}
                        </div>
                        <button
                          onClick={handleCopyUrl}
                          className="px-3 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 text-xs font-bold shrink-0"
                        >
                          {copied ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                    </div>

                    {/* Polling status */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                      <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                      <span className="text-yellow-300/80 text-xs font-bold">
                        Waiting for your agent to connect...
                      </span>
                      <span className="text-yellow-300/50 text-xs ml-auto font-mono">
                        {Math.floor(expiresIn / 60)}:{(expiresIn % 60).toString().padStart(2, '0')}
                      </span>
                    </div>

                    <button
                      onClick={() => {
                        if (pollRef.current) clearInterval(pollRef.current);
                        pollRef.current = null;
                        setPolling(false);
                        setConnectToken(null);
                        setConnectUrl(null);
                      }}
                      className="w-full text-white/30 text-xs hover:text-white/50 underline"
                    >
                      Cancel and generate a new link
                    </button>
                  </div>
                )}

                {/* Skills preview */}
                <div className="bg-cyan-500/5 border border-cyan-500/15 rounded-lg px-3 py-2">
                  <p className="text-cyan-300/70 font-bold text-xs mb-1.5">Your agent will learn 10 skill domains:</p>
                  <div className="grid grid-cols-2 gap-1 text-[10px] text-white/40">
                    {Object.values(BUILDING_OPENCLAW_THEMES).map((theme: any) => (
                      <span key={theme.label}>&#8226; {theme.category}</span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Previous export result */}
              {exportResult && (
                <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-3 py-2 space-y-2">
                  <p className="text-cyan-300 font-bold text-xs">
                    Previous session — {exportResult.knowledgeCount} knowledge entries
                  </p>
                  <div className="flex gap-2">
                    <button onClick={handleCopySkillMd} className="flex-1 text-xs px-2 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 font-bold">Copy SKILL.md</button>
                    <button onClick={handleDownloadSkillMd} className="flex-1 text-xs px-2 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 font-bold">Download</button>
                  </div>
                </div>
              )}

              {error && (
                <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
            </div>
          )}

          <div className="pt-2 border-t border-white/10">
            <p className="text-white/30 text-xs">
              Works with any AI agent — OpenClaw, Hermes, ElizaOS, custom bots, and{' '}
              <a href="https://github.com/machinae/awesome-claws" target="_blank" rel="noopener" className="underline hover:text-white/50">28+ more</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
