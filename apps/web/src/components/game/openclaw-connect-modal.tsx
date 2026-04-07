'use client';

import { useState } from 'react';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { api } from '@/lib/api';
import { BUILDING_OPENCLAW_THEMES } from '@legacyapp/shared';

export default function OpenClawConnectModal() {
  const { openclawModalOpen, setOpenclawModalOpen, openclawConnected, openclawSessionId, setOpenclawConnection, addToast, setSkillBuilderOpen } = useGameStore();
  const { data: pet } = usePet();
  const [platform, setPlatform] = useState<'openclaw' | 'hermes' | 'custom'>('openclaw');
  const [gatewayUrl, setGatewayUrl] = useState('http://localhost:18789');
  const [authToken, setAuthToken] = useState('');
  const [agentId, setAgentId] = useState('default');
  const [protocol, setProtocol] = useState<'openai-compat' | 'anthropic' | 'custom-webhook'>('openai-compat');
  const [modelName, setModelName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Preset gateway URL and protocol when platform changes
  const handlePlatformChange = (p: typeof platform) => {
    setPlatform(p);
    if (p === 'openclaw') {
      setGatewayUrl('http://localhost:18789');
      setProtocol('openai-compat');
      setAgentId('default');
      setAuthToken('');
    } else if (p === 'hermes') {
      setGatewayUrl('http://localhost:8642');
      setProtocol('openai-compat');
      setAgentId('hermes-agent');
      setModelName('hermes-agent');
      setAuthToken('change-me-local-dev');
    } else {
      setGatewayUrl('');
      setProtocol('openai-compat');
    }
  };
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ knowledgeCount: number; markdown: string } | null>(null);
  const [error, setError] = useState('');

  if (!openclawModalOpen) return null;

  const handleConnect = async () => {
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
        ...(modelName ? { modelName } : {}),
        name: useGameStore.getState().petName || 'MyBot',
        species: useGameStore.getState().petSpecies || 'cat',
        color: 0x4caf50,
        stats: { hp: 100, attack: 15, defense: 10, speed: 12 },
        personality: 'A curious OpenClaw bot learning about agent development',
        homeX: 640,
        homeY: 400,
        patrolRadius: 128,
      });
      setOpenclawConnection(res.sessionId);
      addToast('🔌', `${platform === 'hermes' ? 'Hermes' : platform === 'openclaw' ? 'OpenClaw' : 'Custom'} agent connected!`);
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!pet?.id) return;
    setExporting(true);
    try {
      const data = await api.exportKnowledge(pet.id);
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
    // Auto-export knowledge before disconnecting
    if (pet?.id) {
      try {
        const data = await api.exportKnowledge(pet.id);
        const knowledgeCount = data.knowledge?.length ?? 0;
        setExportResult({ knowledgeCount, markdown: data.skillMd });
        addToast('📦', `Exported ${knowledgeCount} knowledge entries as SKILL.md`);
      } catch { /* export failure shouldn't block disconnect */ }
    }

    if (openclawSessionId) {
      try {
        await api.unregisterOpenClaw(openclawSessionId);
      } catch { /* ignore */ }
    }
    setOpenclawConnection(null);
    addToast('🔌', 'OpenClaw bot disconnected');
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
    a.download = `${pet?.name ?? 'pet'}-skill.md`;
    a.click();
    URL.revokeObjectURL(url);
    addToast('💾', 'SKILL.md downloaded!');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpenclawModalOpen(false)} />
      <div className="relative w-full max-w-md">
        <div className="legacytheme-panel space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-clawville text-xl text-gray-900">
              🔌 Connect OpenClaw
            </h2>
            <button
              onClick={() => setOpenclawModalOpen(false)}
              className="text-gray-600 hover:text-gray-900 font-bold text-lg"
            >
              ×
            </button>
          </div>

          {openclawConnected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-700">
                <span className="w-3 h-3 rounded-full bg-green-500 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
                <span className="font-bold">Connected</span>
              </div>
              <p className="text-gray-700 text-sm">
                Your OpenClaw bot is active in World mode. It&apos;s learning agent development knowledge from NPC conversations and building visits.
              </p>
              <p className="text-gray-500 text-xs font-mono">
                Session: {openclawSessionId}
              </p>
              <div className="bg-green-50 rounded-lg px-3 py-2">
                <p className="text-green-800 font-bold text-xs mb-1">Training in progress</p>
                <p className="text-green-700 text-xs">
                  Visit buildings and chat with NPCs — your bot absorbs agent development knowledge from every conversation.
                </p>
              </div>

              {/* Export result display */}
              {exportResult && (
                <div className="bg-blue-50 rounded-lg px-3 py-2 space-y-2">
                  <p className="text-blue-800 font-bold text-xs">
                    SKILL.md exported — {exportResult.knowledgeCount} knowledge entries
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCopySkillMd}
                      className="flex-1 text-xs px-2 py-1.5 rounded bg-blue-200 hover:bg-blue-300 text-blue-900 font-bold transition-colors"
                    >
                      Copy to Clipboard
                    </button>
                    <button
                      onClick={handleDownloadSkillMd}
                      className="flex-1 text-xs px-2 py-1.5 rounded bg-blue-200 hover:bg-blue-300 text-blue-900 font-bold transition-colors"
                    >
                      Download .md
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleExport}
                  disabled={exporting || !pet?.id}
                  className="flex-1 color-btn bg-blue-500 hover:bg-blue-600 text-sm py-2 disabled:opacity-50"
                >
                  {exporting ? 'Exporting...' : 'Export SKILL.md'}
                </button>
                <button
                  onClick={handleDisconnect}
                  className="flex-1 color-btn bg-red-500 hover:bg-red-600 text-sm py-2"
                >
                  Disconnect
                </button>
              </div>
              <button
                onClick={() => { setOpenclawModalOpen(false); setSkillBuilderOpen(true); }}
                className="w-full color-btn bg-purple-500 hover:bg-purple-600 text-sm py-2"
              >
                Build Skill
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Show export result after disconnect */}
              {exportResult && (
                <div className="bg-blue-50 rounded-lg px-3 py-2 space-y-2">
                  <p className="text-blue-800 font-bold text-xs">
                    Training complete — {exportResult.knowledgeCount} knowledge entries exported
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleCopySkillMd}
                      className="flex-1 text-xs px-2 py-1.5 rounded bg-blue-200 hover:bg-blue-300 text-blue-900 font-bold transition-colors"
                    >
                      Copy SKILL.md
                    </button>
                    <button
                      onClick={handleDownloadSkillMd}
                      className="flex-1 text-xs px-2 py-1.5 rounded bg-blue-200 hover:bg-blue-300 text-blue-900 font-bold transition-colors"
                    >
                      Download .md
                    </button>
                  </div>
                  <button
                    onClick={() => { setOpenclawModalOpen(false); setSkillBuilderOpen(true); }}
                    className="w-full text-xs px-2 py-1.5 rounded bg-purple-200 hover:bg-purple-300 text-purple-900 font-bold transition-colors"
                  >
                    Build Skill
                  </button>
                </div>
              )}

              <p className="text-white/60 text-sm">
                Connect your agent to take over pet conversations and learn skills from every building visit.
              </p>

              {/* Platform selector */}
              <div>
                <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-2">Agent Platform</label>
                <div className="flex gap-2">
                  {([
                    { id: 'openclaw' as const, label: '🦀 OpenClaw', color: 'cyan' },
                    { id: 'hermes' as const, label: '🔮 Hermes', color: 'purple' },
                    { id: 'custom' as const, label: '🤖 Custom', color: 'white' },
                  ]).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handlePlatformChange(p.id)}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
                        platform === p.id
                          ? `bg-${p.color}-500/20 text-${p.color}-300 border border-${p.color}-500/40`
                          : 'bg-white/5 text-white/40 border border-white/10 hover:border-white/20'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Platform info */}
              {platform === 'hermes' && (
                <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg px-3 py-2 text-xs text-purple-300/80">
                  Hermes Agent by Nous Research. Enable API server with <code className="bg-white/10 px-1 rounded">API_SERVER_ENABLED=true</code> in your .env, then run <code className="bg-white/10 px-1 rounded">hermes gateway</code>.
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

              <div>
                <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">Gateway URL</label>
                <input
                  type="text"
                  value={gatewayUrl}
                  onChange={(e) => setGatewayUrl(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-500/50 focus:outline-none"
                  placeholder="http://localhost:18789"
                />
              </div>

              <div>
                <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">Auth Token</label>
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
                <p className="text-gray-500 text-xs mt-1">
                  Model will be set to <code className="bg-gray-100 px-1 rounded">{modelName || `openclaw:${agentId}`}</code>
                </p>
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
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-gray-500 text-xs hover:text-gray-700 underline"
              >
                {showAdvanced ? 'Hide' : 'Show'} advanced options
              </button>

              {showAdvanced && (
                <div className="space-y-2 bg-gray-50 rounded-lg p-3">
                  <div>
                    <label className="block text-gray-700 text-xs font-bold mb-1">Custom Model Name</label>
                    <input
                      type="text"
                      value={modelName}
                      onChange={(e) => setModelName(e.target.value)}
                      className="w-full bg-white border border-gray-300 rounded px-2 py-1.5 text-xs text-white focus:border-cyan-500/50 focus:outline-none"
                      placeholder={`openclaw:${agentId}`}
                    />
                    <p className="text-gray-400 text-xs mt-0.5">Override the model name sent to your gateway</p>
                  </div>
                </div>
              )}

              {error && (
                <p className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <button
                onClick={handleConnect}
                disabled={loading || !gatewayUrl || !authToken}
                className="w-full color-btn bg-legacytheme-green hover:bg-legacytheme-green-dark text-sm py-2 disabled:opacity-50"
              >
                {loading ? 'Connecting...' : 'Connect Bot'}
              </button>
            </div>
          )}

          <div className="pt-2 border-t border-gray-200">
            <p className="text-gray-500 text-xs">
              Works with any OpenAI-compatible gateway — OpenClaw, PicoClaw, ZeroClaw, nanobot, and{' '}
              <a href="https://github.com/machinae/awesome-claws" target="_blank" rel="noopener" className="underline hover:text-gray-700">28+ more variants</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
