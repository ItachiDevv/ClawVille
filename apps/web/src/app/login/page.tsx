'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { api } from '@/lib/api';

const SHOWCASE_PETS = ['dragon', 'cat', 'fox', 'phoenix'];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isSignup, setIsSignup] = useState(false);

  useEffect(() => {
    if (searchParams.get('mode') === 'signup') {
      setIsSignup(true);
    }
  }, [searchParams]);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [activePet, setActivePet] = useState(0);

  // Rotate showcase avatar
  useEffect(() => {
    const interval = setInterval(() => {
      setActivePet((p) => (p + 1) % SHOWCASE_PETS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isSignup) {
        await api.signup({ email, password, name: name || undefined });
        router.push('/create-avatar');
      } else {
        await api.login({ email, password });
        router.push('/game');
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-5xl mx-auto flex flex-col lg:flex-row gap-8 items-center">
      {/* Left side: Game pitch */}
      <div className="flex-1 text-center lg:text-left space-y-5 max-w-md">
        <Link href="/" className="inline-block">
          <h1 className="font-legacyapp text-4xl md:text-5xl text-white drop-shadow-[0_3px_6px_rgba(0,0,0,0.5)] hover:scale-105 transition-transform">
            LegacyApp
          </h1>
        </Link>

        <p className="text-white/90 text-lg leading-relaxed">
          Adopt an <strong className="text-legacytheme-yellow">AI-powered avatar</strong> that
          thinks, remembers, and develops its own personality.
        </p>

        {/* Animated avatar showcase */}
        <div className="flex items-center gap-4 justify-center lg:justify-start">
          <div className="relative w-20 h-20">
            {SHOWCASE_PETS.map((species, i) => (
              <Image
                key={species}
                src={`/sprites/avatars/${species}.png`}
                alt={species}
                width={80}
                height={80}
                className={`absolute inset-0 drop-shadow-lg transition-all duration-500 ${
                  i === activePet
                    ? 'opacity-100 scale-100'
                    : 'opacity-0 scale-75'
                }`}
              />
            ))}
          </div>
          <div className="text-white/70 text-sm space-y-1">
            <p>8 species to choose from</p>
            <p>14 unique personality archetypes</p>
            <p>Every avatar is a real ElizaOS agent</p>
          </div>
        </div>

        {/* Quick feature list */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          {[
            { icon: '🗺️', text: 'Explore 15 locations' },
            { icon: '💬', text: 'Chat with AI agents' },
            { icon: '🎭', text: 'Custom personalities' },
            { icon: '🧠', text: 'Persistent memory' },
          ].map((f) => (
            <div
              key={f.text}
              className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2 border border-white/10"
            >
              <span>{f.icon}</span>
              <span className="text-white/80">{f.text}</span>
            </div>
          ))}
        </div>

        <p className="text-white/30 text-xs font-mono">
          Powered by ElizaOS autonomous agent framework
        </p>
      </div>

      {/* Right side: Auth form */}
      <div className="legacytheme-panel w-full max-w-md space-y-5">
        <h2 className="font-legacyapp text-2xl text-gray-900 text-center">
          {isSignup ? 'Create Account' : 'Welcome Back!'}
        </h2>

        {/* Toggle */}
        <div className="flex justify-center gap-4">
          <button
            type="button"
            onClick={() => { setIsSignup(false); setError(''); }}
            className={`font-legacyapp text-lg px-4 py-1 rounded-lg transition-colors ${
              !isSignup
                ? 'bg-legacytheme-green text-white shadow-legacytheme'
                : 'text-gray-700 hover:text-gray-900'
            }`}
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => { setIsSignup(true); setError(''); }}
            className={`font-legacyapp text-lg px-4 py-1 rounded-lg transition-colors ${
              isSignup
                ? 'bg-legacytheme-green text-white shadow-legacytheme'
                : 'text-gray-700 hover:text-gray-900'
            }`}
          >
            Sign Up
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignup && (
            <div>
              <label className="block font-bold text-gray-800 mb-1">Display Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
                placeholder="Your display name"
              />
            </div>
          )}

          <div>
            <label className="block font-bold text-gray-800 mb-1">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block font-bold text-gray-800 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-legacytheme-panel-border bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-legacytheme-green"
              placeholder="Enter password"
              minLength={6}
            />
          </div>

          {error && (
            <p className="text-red-700 font-bold text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full color-btn bg-legacytheme-green hover:bg-legacytheme-green-dark text-lg disabled:opacity-50"
          >
            {loading ? 'Loading...' : isSignup ? 'Create Account' : 'Login'}
          </button>
        </form>

        {isSignup && (
          <p className="text-center text-gray-700 text-xs leading-relaxed">
            After signup you&apos;ll pick your avatar&apos;s species, personality, and name.
            Your avatar starts chatting immediately.
          </p>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="star-bg min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <Suspense fallback={
        <div className="legacytheme-panel max-w-md w-full p-8 text-center">
          <p className="font-legacyapp text-xl text-gray-700">Loading...</p>
        </div>
      }>
        <LoginForm />
      </Suspense>
    </div>
  );
}
