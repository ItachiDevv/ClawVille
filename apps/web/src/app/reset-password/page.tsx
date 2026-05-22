'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';

const LandingScene = dynamic(() => import('@/components/three/LandingScene'), { ssr: false });

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = searchParams.get('token');
    setToken(t && t.length >= 16 ? t : null);
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!token) {
      setError('Invalid or expired reset link.');
      return;
    }

    setLoading(true);
    try {
      await api.resetPassword(token, password);
      setSuccess(true);
      // Give the user a beat to read the confirmation, then bounce
      // to /login. Lucia sessions for this user were just invalidated
      // server-side, so any pre-existing cookie is dead and they MUST
      // log back in with the new password.
      setTimeout(() => router.push('/login'), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setLoading(false);
    }
  }

  // Token missing / malformed → present the error path immediately
  // with a direct link back to /forgot-password. We don't auto-redirect
  // because losing the URL would prevent the user from copy-pasting
  // the link they clicked into a bug report.
  if (token === null && !success) {
    return (
      <div className="w-full max-w-md mx-auto">
        <div className="relative bg-[#0a1628]/95 border border-rose-500/30 rounded-2xl p-8 backdrop-blur-xl shadow-[0_0_40px_rgba(255,100,100,0.08)]">
          <h2 className="font-clawville text-xl text-rose-300 mb-3">Invalid reset link</h2>
          <p className="text-white/70 text-sm mb-6 leading-relaxed">
            This password reset link is missing or malformed. Reset links expire after one hour and can only be used once.
          </p>
          <Link
            href="/forgot-password"
            className="block w-full text-center py-3 rounded-lg font-clawville text-sm uppercase tracking-wider bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white"
          >
            Request a new link
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="relative">
        <div className="absolute -inset-1 bg-gradient-to-b from-cyan-500/20 to-transparent rounded-2xl blur-xl" />

        <div className="relative bg-[#0a1628]/95 border border-cyan-500/20 rounded-2xl p-8 backdrop-blur-xl shadow-[0_0_40px_rgba(0,229,255,0.08)]">
          <Link href="/" className="inline-block group mb-6">
            <h1 className="font-clawville text-3xl text-white drop-shadow-[0_0_18px_rgba(0,229,255,0.3)] group-hover:drop-shadow-[0_0_24px_rgba(0,229,255,0.5)] transition-all">
              ClawVille
            </h1>
          </Link>

          {!success ? (
            <>
              <h2 className="font-clawville text-xl text-cyan-300 mb-2">Choose a new password</h2>
              <p className="text-white/60 text-sm mb-6 leading-relaxed">
                Pick something at least 8 characters. All other devices will be signed out.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">New password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
                    placeholder="Min. 8 characters"
                  />
                </div>
                <div>
                  <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">Confirm password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
                    placeholder="Repeat password"
                  />
                </div>

                {error && (
                  <p className="text-red-400 text-sm text-center bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all disabled:opacity-50 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
                >
                  {loading ? 'Resetting...' : 'Reset password'}
                </button>
              </form>

              <p className="text-center text-white/40 text-xs mt-6 font-mono">
                Link not working?{' '}
                <Link href="/forgot-password" className="text-cyan-400 hover:text-cyan-300 transition-colors">
                  Request a new one
                </Link>
              </p>
            </>
          ) : (
            <>
              <h2 className="font-clawville text-xl text-green-300 mb-3">Password reset</h2>
              <p className="text-white/70 text-sm leading-relaxed">
                Redirecting you to login...
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-[#061520]">
      <LandingScene />
      <div className="relative z-10 w-full">
        <Suspense fallback={
          <div className="bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl max-w-md w-full mx-auto p-8 text-center backdrop-blur-xl">
            <p className="font-clawville text-xl text-cyan-400/60 animate-pulse">Loading...</p>
          </div>
        }>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
