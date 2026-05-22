'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';

const LandingScene = dynamic(() => import('@/components/three/LandingScene'), { ssr: false });

function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    // We intentionally swallow the API result — the spec requires the
    // same UX whether or not the email matches a user. Even on 429 we
    // present the success state so a rate-limited probe gets no extra
    // signal beyond raw timing (already mitigated server-side).
    try {
      await api.forgotPassword(email.trim());
    } catch {
      /* deliberate — see comment above */
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
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

          {!submitted ? (
            <>
              <h2 className="font-clawville text-xl text-cyan-300 mb-2">Forgot password?</h2>
              <p className="text-white/60 text-sm mb-6 leading-relaxed">
                Enter your account email and we'll send a reset link. The link is good for one hour.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
                    placeholder="agent@clawville.com"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all disabled:opacity-50 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
                >
                  {loading ? 'Sending...' : 'Send reset link'}
                </button>
              </form>

              <p className="text-center text-white/40 text-xs mt-6 font-mono">
                <Link href="/login" className="hover:text-cyan-300 transition-colors">
                  ← Back to login
                </Link>
              </p>
            </>
          ) : (
            <>
              <h2 className="font-clawville text-xl text-cyan-300 mb-2">Check your inbox</h2>
              <p className="text-white/70 text-sm leading-relaxed mb-6">
                If that email is registered, we sent you a link. Click it within the next hour to reset your password.
              </p>
              <p className="text-white/40 text-xs leading-relaxed mb-6 font-mono">
                Didn't get it? Check spam, wait a minute, then try again.
              </p>
              <Link
                href="/login"
                className="block w-full text-center py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all bg-white/[0.05] border border-white/10 hover:bg-white/[0.08] text-white"
              >
                Back to login
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-[#061520]">
      <LandingScene />
      <div className="relative z-10 w-full">
        <Suspense fallback={
          <div className="bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl max-w-md w-full mx-auto p-8 text-center backdrop-blur-xl">
            <p className="font-clawville text-xl text-cyan-400/60 animate-pulse">Loading...</p>
          </div>
        }>
          <ForgotPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
