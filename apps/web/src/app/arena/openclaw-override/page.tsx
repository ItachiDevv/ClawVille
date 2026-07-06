'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { NPC_DEFINITIONS } from '@clawville/shared';
import { api } from '@/lib/api';

const ArenaCanvas = dynamic(() => import('@/components/pixi/ArenaCanvas'), { ssr: false });
const ArenaHUD = dynamic(() => import('@/components/game/arena-hud'), { ssr: false });

export default function OpenClawOverridePage() {
  const [phase, setPhase] = useState<'setup' | 'arena'>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Form state
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [agentId, setAgentId] = useState('');
  const [sessionKey, setSessionKey] = useState('default');
  const [targetNpcId, setTargetNpcId] = useState(NPC_DEFINITIONS[0].id);

  // Restore session from sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem('openclaw-override-session');
    if (saved) {
      setSessionId(saved);
      setPhase('arena');
    }
  }, []);

  async function handleConnect() {
    setError('');
    setLoading(true);
    try {
      const result = await api.registerAgentBot({
        mode: 'override',
        gatewayUrl,
        authToken,
        agentId,
        sessionKey,
        targetNpcId,
      });
      setSessionId(result.sessionId);
      sessionStorage.setItem('openclaw-override-session', result.sessionId);
      setPhase('arena');
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!sessionId) return;
    try {
      await api.unregisterAgentBot(sessionId);
    } catch {
      // Ignore — may already be gone
    }
    sessionStorage.removeItem('openclaw-override-session');
    setSessionId(null);
    setPhase('setup');
  }

  if (phase === 'arena') {
    return (
      <div className="relative w-full h-screen">
        <ArenaCanvas />
        <ArenaHUD />
        {/* Disconnect banner */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-purple-900/90 border border-purple-400/40 text-white px-4 py-2 rounded-xl backdrop-blur-sm">
          <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
          <span className="text-sm font-medium">OpenClaw Override Active</span>
          <button
            onClick={handleDisconnect}
            className="ml-2 text-xs bg-red-600 hover:bg-red-500 px-3 py-1 rounded-lg transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="star-bg min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-lg bg-white/5 border border-purple-500/30 rounded-2xl p-8 backdrop-blur-sm">
        <h1 className="font-clawville text-3xl text-white text-center mb-2">
          OpenClaw: Override NPC
        </h1>
        <p className="text-white/60 text-sm text-center mb-6">
          Take control of an existing NPC&apos;s conversations using your OpenClaw bot.
        </p>

        {error && (
          <div className="mb-4 bg-red-500/20 border border-red-500/40 text-red-300 text-sm px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-white/80 text-sm mb-1">Target NPC</label>
            <select
              value={targetNpcId}
              onChange={(e) => setTargetNpcId(e.target.value)}
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-400"
            >
              {NPC_DEFINITIONS.map((npc) => (
                <option key={npc.id} value={npc.id} className="bg-gray-900">
                  {npc.name} ({npc.species})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-white/80 text-sm mb-1">Gateway URL</label>
            <input
              type="url"
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="https://my-openclaw.example.com"
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-400 placeholder:text-white/30"
            />
          </div>

          <div>
            <label className="block text-white/80 text-sm mb-1">Auth Token</label>
            <input
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder="Bearer token"
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-400 placeholder:text-white/30"
            />
          </div>

          <div>
            <label className="block text-white/80 text-sm mb-1">Agent ID</label>
            <input
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="my-agent-id"
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-400 placeholder:text-white/30"
            />
          </div>

          <div>
            <label className="block text-white/80 text-sm mb-1">Session Key</label>
            <input
              type="text"
              value={sessionKey}
              onChange={(e) => setSessionKey(e.target.value)}
              placeholder="default"
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-purple-400 placeholder:text-white/30"
            />
          </div>

          <button
            onClick={handleConnect}
            disabled={loading || !gatewayUrl || !authToken || !agentId}
            className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            {loading ? 'Connecting...' : 'Test Connection & Enter Arena'}
          </button>
        </div>
      </div>
    </div>
  );
}
