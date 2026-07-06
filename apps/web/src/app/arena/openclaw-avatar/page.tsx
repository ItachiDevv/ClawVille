'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';

const ArenaCanvas = dynamic(() => import('@/components/pixi/ArenaCanvas'), { ssr: false });
const ArenaHUD = dynamic(() => import('@/components/game/arena-hud'), { ssr: false });

const SPECIES_OPTIONS = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'];

export default function OpenClawAvatarPage() {
  const [phase, setPhase] = useState<'setup' | 'arena'>('setup');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Connection fields
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [agentId, setAgentId] = useState('');
  const [sessionKey, setSessionKey] = useState('default');

  // Avatar fields
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('dragon');
  const [color, setColor] = useState('#00bcd4');
  const [personality, setPersonality] = useState('');
  const [hp, setHp] = useState(100);
  const [attack, setAttack] = useState(15);
  const [defense, setDefense] = useState(12);
  const [speed, setSpeed] = useState(14);

  // Restore session from sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem('openclaw-avatar-session');
    if (saved) {
      setSessionId(saved);
      setPhase('arena');
    }
  }, []);

  function hexToNumber(hex: string): number {
    return parseInt(hex.replace('#', ''), 16);
  }

  async function handleConnect() {
    setError('');
    setLoading(true);
    try {
      const result = await api.registerAgentBot({
        mode: 'avatar',
        gatewayUrl,
        authToken,
        agentId,
        sessionKey,
        name,
        species,
        color: hexToNumber(color),
        stats: { hp, attack, defense, speed },
        personality,
        homeX: 2560,
        homeY: 2560,
        patrolRadius: 128,
      });
      setSessionId(result.sessionId);
      sessionStorage.setItem('openclaw-avatar-session', result.sessionId);
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
      // Ignore
    }
    sessionStorage.removeItem('openclaw-avatar-session');
    setSessionId(null);
    setPhase('setup');
  }

  if (phase === 'arena') {
    return (
      <div className="relative w-full h-screen">
        <ArenaCanvas />
        <ArenaHUD />
        {/* Disconnect banner */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-cyan-900/90 border border-cyan-400/40 text-white px-4 py-2 rounded-xl backdrop-blur-sm">
          <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse" />
          <span className="text-sm font-medium">OpenClaw Avatar Active: {name || 'Bot'}</span>
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

  const canConnect = gatewayUrl && authToken && agentId && name && personality;

  return (
    <div className="star-bg min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg bg-white/5 border border-cyan-500/30 rounded-2xl p-8 backdrop-blur-sm">
        <h1 className="font-clawville text-3xl text-white text-center mb-2">
          OpenClaw: Bot Avatar
        </h1>
        <p className="text-white/60 text-sm text-center mb-6">
          Inject a custom bot character into the arena powered by your OpenClaw agent.
        </p>

        {error && (
          <div className="mb-4 bg-red-500/20 border border-red-500/40 text-red-300 text-sm px-4 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {/* --- Avatar Config --- */}
          <h3 className="text-white/90 text-sm font-semibold border-b border-white/10 pb-1">
            Avatar
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-white/80 text-xs mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bot name"
                maxLength={24}
                className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/30"
              />
            </div>
            <div>
              <label className="block text-white/80 text-xs mb-1">Species</label>
              <select
                value={species}
                onChange={(e) => setSpecies(e.target.value)}
                className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400"
              >
                {SPECIES_OPTIONS.map((s) => (
                  <option key={s} value={s} className="bg-gray-900">
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-white/80 text-xs mb-1">Color</label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-full h-9 bg-white/10 border border-white/20 rounded-lg cursor-pointer"
              />
            </div>
            <div />
          </div>

          <div>
            <label className="block text-white/80 text-xs mb-1">Personality</label>
            <textarea
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="A fierce warrior who speaks in riddles..."
              maxLength={200}
              rows={2}
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/30 resize-none"
            />
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-2">
            {([
              ['HP', hp, setHp, 50, 150],
              ['ATK', attack, setAttack, 5, 25],
              ['DEF', defense, setDefense, 5, 25],
              ['SPD', speed, setSpeed, 5, 25],
            ] as const).map(([label, val, setter, min, max]) => (
              <div key={label}>
                <label className="block text-white/80 text-xs mb-1 text-center">{label}</label>
                <input
                  type="number"
                  value={val}
                  onChange={(e) => (setter as (v: number) => void)(Number(e.target.value))}
                  min={min}
                  max={max}
                  className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:border-cyan-400"
                />
              </div>
            ))}
          </div>

          {/* --- Connection Config --- */}
          <h3 className="text-white/90 text-sm font-semibold border-b border-white/10 pb-1 mt-2">
            OpenClaw Connection
          </h3>

          <div>
            <label className="block text-white/80 text-xs mb-1">Gateway URL</label>
            <input
              type="url"
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="https://my-openclaw.example.com"
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/30"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-white/80 text-xs mb-1">Auth Token</label>
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder="Bearer token"
                className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/30"
              />
            </div>
            <div>
              <label className="block text-white/80 text-xs mb-1">Agent ID</label>
              <input
                type="text"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="my-agent-id"
                className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/30"
              />
            </div>
          </div>

          <div>
            <label className="block text-white/80 text-xs mb-1">Session Key</label>
            <input
              type="text"
              value={sessionKey}
              onChange={(e) => setSessionKey(e.target.value)}
              placeholder="default"
              className="w-full bg-white/10 border border-white/20 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/30"
            />
          </div>

          <button
            onClick={handleConnect}
            disabled={loading || !canConnect}
            className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"
          >
            {loading ? 'Connecting...' : 'Test Connection & Enter Arena'}
          </button>
        </div>
      </div>
    </div>
  );
}
