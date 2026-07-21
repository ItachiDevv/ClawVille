'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  claimGuestCoveHistoryAfterAuth,
  prepareForAccountLogin,
  refreshIdentityAfterAuth,
} from '@/lib/auth-transition';
import { useGameStore } from '@/stores/game';

export interface InGameLoginFormProps {
  /** Called after the cookie swap and auth/avatar/session cache refresh. */
  onSuccess?: () => void;
  /** Optional modal-owned affordance for returning to the connect flow. */
  onCancel?: () => void;
}

/**
 * Minimal email/password login that stays inside the mounted game.
 * Signup intentionally remains an exit-only flow because it includes avatar
 * creation/customization.
 */
export function InGameLoginForm({
  onSuccess,
  onCancel,
}: InGameLoginFormProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setError('');
    setLoading(true);

    const priorControlMode = useGameStore.getState().controlMode;
    try {
      // Run while the old anonymous/guest cookie is still installed. The
      // shared sweep resets the game store, including this modal, so reopen the
      // login intent synchronously before React commits the reset.
      prepareForAccountLogin(queryClient);
      useGameStore.getState().setAgentConnectModalOpen(true, 'login');

      await api.login({ email, password });

      // NPC mode is deliberately exempt from game/page's automatic avatar
      // promotion. Move to Explore before refreshed auth/avatar data lands so
      // the existing auth-sync effect can promote a real avatar to `player`.
      // Avatar-less accounts correctly remain in Explore.
      useGameStore.getState().setControlMode('explore');

      await claimGuestCoveHistoryAfterAuth();
      await refreshIdentityAfterAuth(queryClient);
      onSuccess?.();
    } catch (err: unknown) {
      // A failed credential check must leave an NPC-mode visitor in the game,
      // with this form still visible so the server error is actionable.
      if (priorControlMode === 'npc') {
        useGameStore.getState().setControlMode('npc');
      }
      useGameStore.getState().setAgentConnectModalOpen(true, 'login');
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="in-game-login-email"
          className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5"
        >
          Email
        </label>
        <input
          id="in-game-login-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={loading}
          className="w-full px-3 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 transition-all text-sm disabled:opacity-60"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="in-game-login-password"
            className="text-white/50 text-xs font-mono uppercase tracking-wider"
          >
            Password
          </label>
          <Link
            href="/forgot-password"
            className="text-[11px] text-cyan-400/80 hover:text-cyan-300 transition-colors"
          >
            Forgot password?
          </Link>
        </div>
        <input
          id="in-game-login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={loading}
          className="w-full px-3 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 transition-all text-sm disabled:opacity-60"
          placeholder="Your password"
        />
      </div>

      {error && (
        <p
          role="alert"
          className="text-red-400 text-sm text-center bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full px-4 py-3 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-white font-bold text-sm transition-all disabled:opacity-50"
      >
        {loading ? 'Logging in...' : 'Log In'}
      </button>

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="w-full text-white/40 text-xs hover:text-white/60 underline disabled:opacity-50"
        >
          Back to connect
        </button>
      )}
    </form>
  );
}
