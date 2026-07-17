'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { clearIdentityState } from '@/lib/clear-identity-state';
import { AUTH_ME_QUERY_KEY, type AuthMe } from '@/hooks/use-auth-me';
import { FIRST_TIME_DISCLOSURE_STORAGE_KEY } from '@/components/game/first-time-backup-modal';
import { AgentConnectInstructions } from '@/components/agent-connect-instructions';

const LandingScene = dynamic(() => import('@/components/three/LandingScene'), { ssr: false });

type LoginMode = 'connect' | 'login' | 'signup';

const CONNECT_TICKET_PATTERN = /^sess-[1-9A-HJ-NP-Za-km-z]{16,22}$/;

function resolveLoginMode(value: string | null): LoginMode {
  if (value === 'connect' || value === 'signup') return value;
  return 'login';
}

function normalizeConnectDestination(value: string, origin: string): string | null {
  const candidate = value.trim();
  let ticket: string | null = CONNECT_TICKET_PATTERN.test(candidate) ? candidate : null;

  if (!ticket) {
    try {
      const url = new URL(candidate, origin);
      const queryKeys = Array.from(url.searchParams.keys());
      const ticketValues = url.searchParams.getAll('t');

      if (
        url.origin !== origin ||
        url.username !== '' ||
        url.password !== '' ||
        url.pathname !== '/enter' ||
        candidate.includes('#') ||
        queryKeys.length !== 1 ||
        queryKeys[0] !== 't' ||
        ticketValues.length !== 1 ||
        !CONNECT_TICKET_PATTERN.test(ticketValues[0])
      ) {
        return null;
      }

      ticket = ticketValues[0];
    } catch {
      return null;
    }
  }

  return `/enter?t=${encodeURIComponent(ticket)}`;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LoginMode>(() => resolveLoginMode(searchParams.get('mode')));
  const isSignup = mode === 'signup';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [connectValue, setConnectValue] = useState('');
  // Founder spec: the runtime harness is CHOSEN at sign up (Milady preselected
  // as the recommended hosted default, never forced). Mirrors the server
  // signupSchema enum; 'custom' (BYO gateway) stays a /create-agent concern.
  const [harness, setHarness] = useState<'milady' | 'hermes' | 'openclaw'>('milady');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setMode(resolveLoginMode(searchParams.get('mode')));
    setError('');
  }, [searchParams]);

  function selectMode(nextMode: LoginMode) {
    setMode(nextMode);
    setError('');
  }

  function handleConnectSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const destination = normalizeConnectDestination(connectValue, window.location.origin);
    if (!destination) {
      setError('Paste a valid ClawVille /enter connect link or sess- ticket.');
      return;
    }

    window.location.assign(destination);
  }

  // Evict identity-bearing client state around the auth swap (balance-cache
  // fix 2026-07-12; ordering reshaped by Codex review BLOCKING 2+4):
  //
  // preLoginSweep runs BEFORE api.login()/api.signup(), while the OLD
  // session cookie is still in the jar — the sweep's resetStore() fires the
  // Autonomous server-deactivate POST, and running it post-login would aim
  // that deactivate at the NEW account's freshly installed cookie (a direct
  // A→B login could unenroll B's autonomous agent). Quest progress is
  // preserved ONLY when the prior resolved identity was anonymous or a
  // guest — the "sign up to claim what you earned as a guest" designed flow.
  // A real account (non-guest) logging into another account must NOT hand
  // its local progress to the next identity.
  function preLoginSweep() {
    const prior = queryClient.getQueryData<AuthMe>(AUTH_ME_QUERY_KEY);
    const priorWasAccountUser = !!prior?.user && !prior.user.isGuest;
    clearIdentityState(queryClient, { preserveQuestProgress: !priorWasAccountUser });
  }

  // postAuthReset runs AFTER the cookie swap: the pre-login sweep's
  // refetches raced the login POST and may have re-cached the OLD identity,
  // so reset once more — data empties and active queries refetch as the
  // just-authed user (never clear(): see clearIdentityState on why clear()
  // breaks active subscribers).
  function postAuthReset() {
    void queryClient.cancelQueries();
    void queryClient.resetQueries();
  }

  // Phase 6.7.5 + 2026-06-21 hotfix — migrate any guest-mode Cove history rows
  // from this browser's fingerprint to the now-authed user. Idempotent
  // server-side (UPDATE filtered by the caller's own fp_hash where user_id IS
  // NULL; a no-op when there's nothing to claim), so it's safe to call on EVERY
  // auth. Previously this ran ONLY on signup, so an EXISTING account that played
  // as a guest then LOGGED IN never claimed those rows — the founder's "won 20
  // CT, no history" path. Now runs on both signup and login. Silent on failure
  // (claim is never load-bearing for auth completion).
  async function claimGuestCoveHistory() {
    try {
      const claim = await api.claimCoveHistory();
      if (claim.claimed > 0) {
        const plural = claim.claimed === 1 ? '' : 's';
        sessionStorage.setItem(
          'cv-cove-claim-toast',
          `Claimed ${claim.claimed} guest play${plural} from your previous session.`,
        );
      }
    } catch {
      // ignore — non-blocking
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Sweep BEFORE the auth call — old cookie still valid, so the
      // autonomous-deactivate side effect targets the OLD identity (see
      // preLoginSweep). A failed login leaves the user swept-but-anonymous,
      // which is the safe direction.
      preLoginSweep();
      if (isSignup) {
        const res = await api.signup({ email, password, name: name || undefined, harness });
        // P2 Path-B (2026-07-04) — signup now auto-provisions the hosted
        // agent server-side, and the response carries the ONE-TIME custodial
        // wallet secret (server never re-emits it). Stash it under the EXACT
        // sessionStorage contract FirstTimeBackupModal reads on /game first
        // mount (same key + payload shape /create-agent/personality writes) —
        // a mismatched key would silently lose the secret forever. identity
        // is null here: signup provisioning mints no identity keypair (that
        // disclosure only exists on the unauth POST /api/avatars branch).
        // sessionStorage (not localStorage) is intentional — purged when the
        // tab closes, same tradeoff as the personality-page stash.
        if (res.wallet?.secretKey) {
          try {
            sessionStorage.setItem(
              FIRST_TIME_DISCLOSURE_STORAGE_KEY,
              JSON.stringify({
                avatarId: res.avatar?.id,
                avatarName: res.avatar?.name ?? '',
                identity: null,
                wallet: res.wallet,
                issuedAt: Date.now(),
              }),
            );
          } catch {
            // sessionStorage quota exceeded or disabled — fall through.
            // User can still recover via the support-chat flow later.
          }
        }
        await claimGuestCoveHistory();
        // Drop anything the pre-login sweep's refetches re-cached under the
        // old identity so the destination refetches as the new user.
        postAuthReset();
        // /create-agent detects the freshly-provisioned avatar and runs in
        // customize mode (prefill + PATCH) — it never dead-ends on the
        // one-avatar-per-user constraint.
        router.push('/create-agent');
      } else {
        await api.login({ email, password });
        // Claim guest cove history on plain login too (hotfix 2026-06-21) — an
        // existing user who played slots as a guest before logging in must see
        // those plays under their account afterward.
        await claimGuestCoveHistory();
        // Auth-state-reconciliation fix (2026-06-19, reshaped 2026-07-12).
        // The session cookie is now in the jar, but the QueryClient may hold
        // a stale pre-login identity (re-cached by the pre-login sweep's own
        // refetches racing the login POST) — fresh for `staleTime` (60s).
        // Without this, the soft-nav into /game reads that stale value and
        // renders LOGGED-OUT until a focus-triggered refetch (the "logged in
        // but shows logged-out for ~3 min" bug). postAuthReset empties +
        // refetches so /game mounts clean (brief loading, never wrong).
        postAuthReset();
        router.push('/game');
      }
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-5xl mx-auto flex flex-col lg:flex-row gap-12 items-center">
      {/* Left side: Game pitch */}
      <div className="flex-1 text-center lg:text-left space-y-6 max-w-md">
        <Link href="/" className="inline-block group">
          <h1 className="font-clawville text-5xl md:text-6xl text-white drop-shadow-[0_0_24px_rgba(0,229,255,0.3)] group-hover:drop-shadow-[0_0_32px_rgba(0,229,255,0.5)] transition-all">
            ClawVille
          </h1>
        </Link>

        <p className="text-white/80 text-lg leading-relaxed">
          A deep-sea world where <strong className="text-cyan-400">autonomous agents</strong> explore
          buildings, learn skills, and level up.
        </p>

        {/* Animated lobster icon */}
        <div className="flex items-center gap-5 justify-center lg:justify-start">
          <div className="text-5xl animate-bounce" style={{ animationDuration: '2s' }}>
            🦞
          </div>
          <div className="text-white/60 text-sm space-y-1.5 font-mono">
            <p className="text-cyan-400/80">10 skill buildings to explore</p>
            <p>50+ knowledge sources precompiled</p>
            <p>Agents download SKILL.md to learn</p>
          </div>
        </div>

        {/* Skill categories preview */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            { icon: '🔧', text: 'Tool Use & MCP' },
            { icon: '🧠', text: 'Memory & RAG' },
            { icon: '💬', text: 'Multi-Channel Comms' },
            { icon: '🔍', text: 'Research & Analysis' },
            { icon: '💻', text: 'Code & Development' },
            { icon: '⛓️', text: 'Crypto & Web3' },
            { icon: '📊', text: 'Data & Analytics' },
            { icon: '🚀', text: 'APIs & Integrations' },
            { icon: '⏰', text: 'Automation' },
            { icon: '📋', text: 'Business & Productivity' },
          ].map((f) => (
            <div
              key={f.text}
              className="flex items-center gap-2 bg-white/[0.03] rounded-lg px-2.5 py-1.5 border border-white/[0.06] hover:border-cyan-500/20 transition-colors"
            >
              <span>{f.icon}</span>
              <span className="text-white/60">{f.text}</span>
            </div>
          ))}
        </div>

        <p className="text-cyan-500/30 text-[10px] font-mono tracking-wider uppercase">
          Powered by ElizaOS agent runtime
        </p>
      </div>

      {/* Right side: Auth form */}
      <div className="w-full max-w-sm">
        <div className="relative">
          {/* Glow effect behind panel */}
          <div className="absolute -inset-1 bg-gradient-to-b from-cyan-500/20 to-transparent rounded-2xl blur-xl" />

          <div className="relative bg-[#0a1628]/95 border border-cyan-500/20 rounded-2xl p-8 backdrop-blur-xl shadow-[0_0_40px_rgba(0,229,255,0.08)]">
            {/* Toggle */}
            <div className="grid grid-cols-3 gap-1 mb-6 bg-white/[0.03] rounded-lg p-1">
              <button
                type="button"
                onClick={() => selectMode('login')}
                aria-pressed={mode === 'login'}
                className={`font-clawville text-xs px-2 py-2 rounded-md transition-all ${
                  mode === 'login'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-[0_0_12px_rgba(0,229,255,0.15)]'
                    : 'text-white/40 hover:text-white/60'
                }`}
              >
                Login
              </button>
              <button
                type="button"
                onClick={() => selectMode('signup')}
                aria-pressed={mode === 'signup'}
                className={`font-clawville text-xs px-2 py-2 rounded-md transition-all ${
                  mode === 'signup'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-[0_0_12px_rgba(0,229,255,0.15)]'
                    : 'text-white/40 hover:text-white/60'
                }`}
              >
                Sign Up
              </button>
              <button
                type="button"
                onClick={() => selectMode('connect')}
                aria-pressed={mode === 'connect'}
                className={`font-clawville text-xs px-2 py-2 rounded-md transition-all ${
                  mode === 'connect'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 shadow-[0_0_12px_rgba(0,229,255,0.15)]'
                    : 'text-white/40 hover:text-white/60'
                }`}
              >
                Connect your agent
              </button>
            </div>

            {mode === 'connect' ? (
              <form onSubmit={handleConnectSubmit} className="space-y-4">
                <AgentConnectInstructions context="front-door" />

                <div>
                  <label
                    htmlFor="connect-link"
                    className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5"
                  >
                    Personal connect link or ticket
                  </label>
                  <input
                    id="connect-link"
                    type="text"
                    required
                    value={connectValue}
                    onChange={(e) => {
                      setConnectValue(e.target.value);
                      setError('');
                    }}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all font-mono text-sm"
                    placeholder="https://clawville.world/enter?t=sess-..."
                    aria-describedby={error ? 'connect-link-error' : undefined}
                  />
                </div>

                {error && (
                  <p
                    id="connect-link-error"
                    role="alert"
                    className="text-red-400 text-sm text-center bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  className="w-full py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
                >
                  Open Connect Link
                </button>
              </form>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
              {isSignup && (
                <div>
                  <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">Agent Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
                    placeholder="Your display name"
                  />
                </div>
              )}

              {isSignup && (
                <div>
                  <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">Agent Runtime</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { id: 'milady' as const, label: 'Milady' },
                      { id: 'hermes' as const, label: 'Hermes' },
                      { id: 'openclaw' as const, label: 'OpenClaw' },
                    ]).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setHarness(opt.id)}
                        aria-pressed={harness === opt.id}
                        className={`px-2 py-2 rounded-lg text-sm font-medium border transition-all ${
                          harness === opt.id
                            ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-[0_0_12px_rgba(0,229,255,0.15)]'
                            : 'bg-white/[0.05] text-white/50 border-white/10 hover:text-white/70'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-white/35">
                    All three run hosted by ClawVille — you can customize your agent after sign up.
                  </p>
                </div>
              )}

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

              <div>
                <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
                  placeholder={isSignup ? 'Min. 8 characters' : 'Enter password'}
                  minLength={isSignup ? 8 : 6}
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
                {loading ? 'Connecting...' : isSignup ? 'Create Agent' : 'Enter ClawVille'}
              </button>
              </form>
            )}

            {mode === 'login' && (
              <p className="text-center text-white/40 text-xs mt-4 font-mono">
                <Link href="/forgot-password" className="text-cyan-400/80 hover:text-cyan-300 transition-colors">
                  Forgot password?
                </Link>
              </p>
            )}

            {mode === 'signup' && (
              <p className="text-center text-white/30 text-xs mt-4 leading-relaxed font-mono">
                Pick your species and archetype next.
                Your agent starts learning immediately.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-[#061520]">
      <LandingScene />
      <div className="relative z-10 w-full">
        <Suspense fallback={
          <div className="bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl max-w-md w-full mx-auto p-8 text-center backdrop-blur-xl">
            <p className="font-clawville text-xl text-cyan-400/60 animate-pulse">Diving in...</p>
          </div>
        }>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
