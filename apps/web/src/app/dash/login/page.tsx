'use client';

/**
 * Shared-password login surface for /dash. Reviewers paste the password
 * shared in chat, get a 30-day cookie, land on /dash. No user account
 * needed — complements the ADMIN_USER_IDS allowlist (still preferred for
 * individual admins because it's traceable).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
      const res = await fetch(`${apiBase}/api/dash-auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = (json as { error?: string }).error ?? 'unknown';
        const msg = (json as { message?: string }).message;
        if (code === 'not_configured') {
          setError('Shared-password access is not configured on this deployment.');
        } else if (code === 'rate_limited') {
          setError(msg ?? 'Too many attempts. Try again in a few minutes.');
        } else if (code === 'invalid_password') {
          setError('That password is incorrect.');
        } else {
          setError(msg ?? `Login failed (${res.status}).`);
        }
        return;
      }
      // Success — cookie set. Land on the dashboard.
      router.push('/dash');
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#061520] px-4 py-12">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-cyan-400/20 bg-black/40 p-6 shadow-[0_0_40px_rgba(0,229,255,0.12)] backdrop-blur"
      >
        <h1 className="font-clawville text-xl text-white">Dashboard access</h1>
        <p className="mt-2 text-xs font-mono text-slate-400">
          Paste the shared dashboard password to view <code>/dash</code>.
          Already have an admin account? Just visit{' '}
          <a href="/dash" className="text-cyan-300 underline">/dash</a> directly.
        </p>

        <label htmlFor="dash-pw" className="mt-5 block font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">
          Password
        </label>
        <input
          id="dash-pw"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          required
          minLength={1}
          className="mt-2 w-full rounded-lg border border-cyan-400/20 bg-black/50 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-cyan-300/60 focus:outline-none"
          placeholder="••••••••"
        />

        {error ? (
          <p className="mt-3 rounded border border-red-500/30 bg-red-500/5 p-2 font-mono text-[11px] text-red-300">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 w-full rounded-lg bg-gradient-to-r from-cyan-500/80 to-cyan-400/70 px-4 py-2 font-mono text-sm text-white shadow-[0_0_18px_rgba(0,229,255,0.25)] transition-all hover:from-cyan-400/90 hover:to-cyan-300/80 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="mt-4 font-mono text-[9px] text-slate-500">
          Cookie lasts 30 days · HttpOnly + Secure · 10 attempts per 5 min per IP
        </p>
      </form>
    </main>
  );
}
