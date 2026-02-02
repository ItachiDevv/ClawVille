'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isSignup, setIsSignup] = useState(false);

  // Check for mode query param on mount
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
    <div className="legacytheme-panel max-w-md w-full space-y-6">
      {/* Header */}
      <h1 className="font-legacyapp text-3xl text-gray-900 text-center">
        {isSignup ? 'Create Account' : 'Welcome Back!'}
      </h1>

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

      {/* Back link */}
      <p className="text-center text-gray-700 text-sm">
        <Link href="/" className="underline hover:text-gray-900">
          Back to home
        </Link>
      </p>
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
