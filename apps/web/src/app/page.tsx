'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';

const AVATAR_SPECIES = ['cat', 'dragon', 'fox', 'owl', 'wolf', 'bunny', 'phoenix', 'turtle'];

function FloatingPets() {
  const positions = [
    { species: 'dragon', x: '5%', y: '15%', delay: 0 },
    { species: 'fox', x: '85%', y: '20%', delay: 0.5 },
    { species: 'owl', x: '10%', y: '70%', delay: 1 },
    { species: 'phoenix', x: '80%', y: '65%', delay: 1.5 },
    { species: 'wolf', x: '90%', y: '42%', delay: 0.8 },
    { species: 'bunny', x: '3%', y: '45%', delay: 1.2 },
  ];

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {positions.map((p) => (
        <div
          key={p.species}
          className="absolute opacity-20"
          style={{
            left: p.x,
            top: p.y,
            animation: `petFloat 3s ease-in-out ${p.delay}s infinite`,
          }}
        >
          <Image
            src={`/sprites/avatars/${p.species}.png`}
            alt={p.species}
            width={60}
            height={60}
          />
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="star-bg min-h-screen overflow-x-hidden flex flex-col">
      {/* Float animation keyframes */}
      <style jsx global>{`
        @keyframes petFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-12px); }
        }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-up {
          animation: fadeSlideUp 0.6s ease-out forwards;
          opacity: 0;
        }
      `}</style>

      {/* Background avatars */}
      {mounted && <FloatingPets />}

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-16 relative z-10">
        {/* Logo */}
        <div className="animate-fade-up text-center mb-12" style={{ animationDelay: '0.1s' }}>
          <h1 className="font-legacyapp text-5xl md:text-7xl text-white drop-shadow-[0_3px_6px_rgba(0,0,0,0.5)]">
            LegacyApp
          </h1>
          <p className="text-white/60 text-lg mt-2">
            Choose your experience
          </p>
        </div>

        {/* Four-card environment selector */}
        <div
          className="animate-fade-up grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl w-full"
          style={{ animationDelay: '0.3s' }}
        >
          {/* LegacyApp — Open World */}
          <Link
            href="/game"
            className="group relative bg-gradient-to-br from-green-900/60 to-emerald-900/40 rounded-2xl p-8 border-2 border-green-500/20 hover:border-green-400/50 backdrop-blur-sm transition-all hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(72,187,120,0.15)]"
          >
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="flex -space-x-2">
                  {['cat', 'fox', 'owl'].map((s) => (
                    <Image
                      key={s}
                      src={`/sprites/avatars/${s}.png`}
                      alt={s}
                      width={48}
                      height={48}
                      className="drop-shadow-md group-hover:scale-110 transition-transform"
                    />
                  ))}
                </div>
              </div>
            </div>
            <h2 className="font-legacyapp text-2xl text-white text-center mb-2">
              LegacyApp
            </h2>
            <p className="text-white/70 text-sm text-center leading-relaxed mb-4">
              Raise your AI avatar, explore ClawVille, learn crypto, and chat with autonomous agents.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 mb-4">
              {['AI Avatars', 'Explore', 'Crypto', 'Chat'].map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-green-500/20 text-green-300 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="text-center">
              <span className="inline-block color-btn bg-green-600 hover:bg-green-500 text-white px-6 py-2 text-sm font-medium group-hover:shadow-lg transition-shadow">
                Enter World
              </span>
            </div>
          </Link>

          {/* LegacyApp Arena */}
          <Link
            href="/arena"
            className="group relative bg-gradient-to-br from-red-900/60 to-orange-900/40 rounded-2xl p-8 border-2 border-red-500/20 hover:border-red-400/50 backdrop-blur-sm transition-all hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(239,68,68,0.15)]"
          >
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="flex -space-x-2">
                  {['wolf', 'dragon', 'phoenix'].map((s) => (
                    <Image
                      key={s}
                      src={`/sprites/avatars/${s}.png`}
                      alt={s}
                      width={48}
                      height={48}
                      className="drop-shadow-md group-hover:scale-110 transition-transform"
                    />
                  ))}
                </div>
              </div>
            </div>
            <h2 className="font-legacyapp text-2xl text-white text-center mb-2">
              LegacyApp Arena
            </h2>
            <p className="text-white/70 text-sm text-center leading-relaxed mb-4">
              Watch autonomous AI agents battle, converse, steal loot, and respawn in real-time combat.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 mb-4">
              {['Combat', 'AI NPCs', 'Loot', 'Spectate'].map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-red-500/20 text-red-300 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="text-center">
              <span className="inline-block color-btn bg-red-600 hover:bg-red-500 text-white px-6 py-2 text-sm font-medium group-hover:shadow-lg transition-shadow">
                Enter Arena
              </span>
            </div>
          </Link>

          {/* OpenClaw: Override NPC */}
          <Link
            href="/arena/openclaw-override"
            className="group relative bg-gradient-to-br from-purple-900/60 to-violet-900/40 rounded-2xl p-8 border-2 border-purple-500/20 hover:border-purple-400/50 backdrop-blur-sm transition-all hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(168,85,247,0.15)]"
          >
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="flex -space-x-2">
                  {['cat', 'owl', 'bunny'].map((s) => (
                    <Image
                      key={s}
                      src={`/sprites/avatars/${s}.png`}
                      alt={s}
                      width={48}
                      height={48}
                      className="drop-shadow-md group-hover:scale-110 transition-transform"
                    />
                  ))}
                </div>
              </div>
            </div>
            <h2 className="font-legacyapp text-2xl text-white text-center mb-2">
              OpenClaw: Override NPC
            </h2>
            <p className="text-white/70 text-sm text-center leading-relaxed mb-4">
              Take control of an existing NPC&apos;s conversations using your OpenClaw bot gateway.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 mb-4">
              {['OpenClaw', 'Override NPC', 'Your Bot', 'Arena'].map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="text-center">
              <span className="inline-block color-btn bg-purple-600 hover:bg-purple-500 text-white px-6 py-2 text-sm font-medium group-hover:shadow-lg transition-shadow">
                Override NPC
              </span>
            </div>
          </Link>

          {/* OpenClaw: Bot Avatar */}
          <Link
            href="/arena/openclaw-avatar"
            className="group relative bg-gradient-to-br from-cyan-900/60 to-teal-900/40 rounded-2xl p-8 border-2 border-cyan-500/20 hover:border-cyan-400/50 backdrop-blur-sm transition-all hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(34,211,238,0.15)]"
          >
            <div className="flex justify-center mb-4">
              <div className="relative">
                <div className="flex -space-x-2">
                  {['dragon', 'turtle', 'phoenix'].map((s) => (
                    <Image
                      key={s}
                      src={`/sprites/avatars/${s}.png`}
                      alt={s}
                      width={48}
                      height={48}
                      className="drop-shadow-md group-hover:scale-110 transition-transform"
                    />
                  ))}
                </div>
              </div>
            </div>
            <h2 className="font-legacyapp text-2xl text-white text-center mb-2">
              OpenClaw: Bot Avatar
            </h2>
            <p className="text-white/70 text-sm text-center leading-relaxed mb-4">
              Inject a custom bot character into the arena powered by your OpenClaw agent.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 mb-4">
              {['OpenClaw', 'Custom Bot', 'Avatar', 'Arena'].map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="text-center">
              <span className="inline-block color-btn bg-cyan-600 hover:bg-cyan-500 text-white px-6 py-2 text-sm font-medium group-hover:shadow-lg transition-shadow">
                Launch Avatar
              </span>
            </div>
          </Link>
        </div>

        {/* Login link */}
        <div className="animate-fade-up mt-8 text-center" style={{ animationDelay: '0.5s' }}>
          <p className="text-white/40 text-sm">
            Both modes support spectator access. No login required to watch.
          </p>
          <Link
            href="/login"
            className="text-legacytheme-yellow/70 hover:text-legacytheme-yellow text-sm mt-2 inline-block underline underline-offset-2"
          >
            Login / Sign Up
          </Link>
        </div>

        {/* Powered by badge */}
        <div className="animate-fade-up mt-4" style={{ animationDelay: '0.6s' }}>
          <span className="inline-block text-xs text-white/30 font-mono bg-white/5 px-3 py-1 rounded-full border border-white/10">
            Powered by ElizaOS autonomous agents
          </span>
        </div>
      </div>
    </div>
  );
}
