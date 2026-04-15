'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';

type ConnectTab = 'easy' | 'manual';

export default function OpenClawConnectModal() {
  const { openclawModalOpen, setOpenclawModalOpen, openclawConnected, openclawSessionId, setOpenclawConnection, addToast, setSkillBuilderOpen } = useGameStore();
  const { data: avatar } = useAvatar();
  const { data: authData } = useQuery({ queryKey: ['auth-me'], queryFn: () => api.me(), retry: false });

  const [tab, setTab] = useState<ConnectTab>('easy');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ knowledgeCount: number; markdown: string } | null>(null);
  const [error, setError] = useState('');

  // --- Easy connect (Moltbook pattern) ---
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [expiresIn, setExpiresIn] = useState(0);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Manual connect (legacy) ---
  const isProduction = typeof window !== 'undefined' && !window.location.hostname.includes('localhost');
  const [gatewayUrl, setGatewayUrl] = useState(isProduction ? '' : 'http://localhost:18789');
  const [authToken, setAuthToken] = useState('');
  const [agentId, setAgentId] = useState('default');
  const [protocol, setProtocol] = useState<'openai-compat' | 'anthropic' | 'custom-webhook'>('openai-compat');

  // Cleanup polling on unmount or close
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Stop polling when modal closes
  useEffect(() => {
    if (!openclawModalOpen && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setPolling(false);
    }
  }, [openclawModalOpen]);

  const handleGenerateToken = useCallback(async () => {
    if (!avatar?.id || !authData?.user?.id) {
      setError('You need a avatar to connect an agent. Create one first.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await api.generateConnectToken({
        avatarId: avatar.id,
        avatarName: avatar.name ?? 'MyBot',
        userId: authData.user.id,
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
            setOpenclawConnection(status.sessionId);
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
  }, [avatar, authData, addToast, setOpenclawConnection]);

  const handleCopyUrl = () => {
    if (!connectUrl) return;
    navigator.clipboard.writeText(connectUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleManualConnect = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await api.registerOpenClaw({
        mode: 'avatar',
        gatewayUrl,
        authToken,
        agentId,
        sessionKey: `world-${Date.now()}`,
        protocol,
        name: useGameStore.getState().avatarName || 'MyBot',
        species: useGameStore.getState().avatarSpecies || 'cat',
        color: 0x4caf50,
        stats: { hp: 100, attack: 15, defense: 10, speed: 12 },
        personality: 'A curious OpenClaw bot learning about agent development',
        homeX: 2560,
        homeY: 2560,
        patrolRadius: 128,
      });
      setOpenclawConnection(res.sessionId);
      addToast('🔌', 'Agent connected!');
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

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
    if (openclawSessionId) {
      try { await api.unregisterOpenClaw(openclawSessionId); } catch { /* ignore */ }
    }
    setOpenclawConnection(null);
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

  if (!openclawModalOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpenclawModalOpen(false)} />
      <div className="relative w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="bg-[rgba(8,20,40,0.95)] border border-cyan-500/20 rounded-2xl shadow-[0_0_40px_rgba(0,229,255,0.08)] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Connect Agent</h2>
            <button
              onClick={() => setOpenclawModalOpen(false)}
              className="text-white/40 hover:text-white/80 text-lg"
            >
              ×
            </button>
          </div>

          {openclawConnected ? (
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
                Session: {openclawSessionId}
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

              <div className="flex gap-2">
                <button onClick={handleExport} disabled={exporting || !avatar?.id} className="flex-1 px-3 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 text-xs font-bold disabled:opacity-50">
                  {exporting ? 'Exporting...' : 'Export SKILL.md'}
                </button>
                <button onClick={handleDisconnect} className="flex-1 px-3 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs font-bold">
                  Disconnect
                </button>
              </div>
              <button
                onClick={() => { setOpenclawModalOpen(false); setSkillBuilderOpen(true); }}
                className="w-full px-3 py-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 text-xs font-bold"
              >
                Build Skill
              </button>
            </div>
          ) : (
            /* ─── Not connected ─── */
            <div className="space-y-3">
              <p className="text-white/50 text-sm">
                Connect your AI agent to explore ClawVille and learn skills from 10 buildings.
              </p>

              {/* Tab selector */}
              <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
                <button
                  onClick={() => setTab('easy')}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
                    tab === 'easy'
                      ? 'bg-cyan-500/20 text-cyan-300 shadow-sm'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                >
                  Quick Connect
                </button>
                <button
                  onClick={() => setTab('manual')}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-bold transition-all ${
                    tab === 'manual'
                      ? 'bg-cyan-500/20 text-cyan-300 shadow-sm'
                      : 'text-white/40 hover:text-white/60'
                  }`}
                >
                  Manual
                </button>
              </div>

              {tab === 'easy' ? (
                /* ─── Easy connect (Moltbook pattern) ─── */
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
                    <button
                      onClick={handleGenerateToken}
                      disabled={loading}
                      className="w-full px-4 py-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-bold text-sm transition-all disabled:opacity-50"
                    >
                      {loading ? 'Generating...' : 'Generate Connect Link'}
                    </button>
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
              ) : (
                /* ─── Manual connect (legacy gateway form) ─── */
                <div className="space-y-3">
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-xs text-yellow-300/80">
                    Advanced: directly connect to your agent&apos;s OpenAI-compatible gateway. Your agent must have a publicly accessible API endpoint.
                  </div>

                  <div>
                    <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">Gateway URL</label>
                    <input
                      type="text"
                      value={gatewayUrl}
                      onChange={(e) => setGatewayUrl(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-500/50 focus:outline-none"
                      placeholder={isProduction ? 'https://your-gateway.com:18789' : 'http://localhost:18789'}
                    />
                  </div>

                  <div>
                    <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">Auth Token (optional)</label>
                    <input
                      type="password"
                      value={authToken}
                      onChange={(e) => setAuthToken(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-500/50 focus:outline-none"
                      placeholder="Your gateway auth token"
                    />
                  </div>

                  <div>
                    <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">Agent ID</label>
                    <input
                      type="text"
                      value={agentId}
                      onChange={(e) => setAgentId(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-500/50 focus:outline-none"
                      placeholder="default"
                    />
                  </div>

                  <div>
                    <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">Protocol</label>
                    <select
                      value={protocol}
                      onChange={(e) => setProtocol(e.target.value as typeof protocol)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-500/50 focus:outline-none"
                    >
                      <option value="openai-compat">OpenAI Compatible (/v1/chat/completions)</option>
                      <option value="anthropic">Anthropic (/v1/messages)</option>
                      <option value="custom-webhook">Custom Webhook (POST to root)</option>
                    </select>
                  </div>

                  <button
                    onClick={handleManualConnect}
                    disabled={loading || !gatewayUrl}
                    className="w-full px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-bold text-sm transition-all disabled:opacity-50"
                  >
                    {loading ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
              )}

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
