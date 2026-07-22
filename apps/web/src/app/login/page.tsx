'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import {
  prepareForAccountLogin,
  refreshIdentityAfterAuth,
} from '@/lib/auth-transition';
import { resolvePublicEnterDestination } from '@/lib/public-enter-destination';
import { FIRST_TIME_DISCLOSURE_STORAGE_KEY } from '@/components/game/first-time-backup-modal';
import { AgentConnectInstructions } from '@/components/agent-connect-instructions';
import { DescentAtmosphere } from '@/components/create-agent/descent-atmosphere';
import { DescentRail } from '@/components/create-agent/descent-rail';

const LandingScene = dynamic(() => import('@/components/three/LandingScene'), { ssr: false });

type LoginMode = 'connect' | 'login' | 'signup';

function resolveLoginMode(value: string | null): LoginMode {
  if (value === 'connect' || value === 'signup') return value;
  return 'login';
}

// Shared input styling — one instrument-glass look across the whole panel.
const FIELD_CLASS =
  'w-full px-4 py-2.5 rounded-lg bg-[#0a2236]/70 border border-cyan-200/15 text-white placeholder:text-white/25 focus:outline-none focus:border-cyan-300/60 focus:shadow-[0_0_16px_rgba(53,224,255,0.14)] transition-all';

const RUNTIME_OPTIONS = [
  { id: 'milady' as const, label: 'Milady', note: 'Recommended' },
  { id: 'hermes' as const, label: 'Hermes', note: 'Hosted' },
  { id: 'openclaw' as const, label: 'OpenClaw', note: 'Hosted' },
];

function FrontDoorConnect() {
  const [learningFocus, setLearningFocus] = useState('');
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [pollSecret, setPollSecret] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectError, setConnectError] = useState('');

  useEffect(() => {
    if (!connectToken || !pollSecret) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await api.pollPublicConnectStatus(
          connectToken,
          pollSecret,
        );
        if (cancelled) return;

        setExpiresIn(status.expiresIn);
        if (status.connected) {
          const destination = status.enterUrl
            ? resolvePublicEnterDestination(
                status.enterUrl,
                window.location.origin,
              )
            : null;
          if (!destination) {
            setConnectToken(null);
            setConnectUrl(null);
            setPollSecret(null);
            setExpiresIn(0);
            setConnectError(
              'Your agent connected, but the secure login handoff was invalid. Generate a new link.',
            );
            return;
          }

          window.location.assign(destination);
          return;
        }

        pollTimer = setTimeout(() => void poll(), 2000);
      } catch (err: unknown) {
        if (cancelled) return;
        setConnectToken(null);
        setConnectUrl(null);
        setPollSecret(null);
        setExpiresIn(0);
        setConnectError(
          err instanceof Error
            ? err.message
            : 'This connect link expired. Generate a new one.',
        );
      }
    };

    pollTimer = setTimeout(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [connectToken, pollSecret]);

  async function handleGenerateToken() {
    if (loading) return;
    setConnectError('');
    setCopied(false);
    setLoading(true);
    try {
      const focus = learningFocus.trim();
      const result = await api.generatePublicConnectToken({
        ...(focus ? { learningFocus: focus } : {}),
      });
      setConnectToken(result.token);
      setConnectUrl(result.connectUrl);
      setPollSecret(result.pollSecret);
      setExpiresIn(result.expiresIn);
    } catch (err: unknown) {
      setConnectError(
        err instanceof Error
          ? err.message
          : 'Failed to generate a connect link.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCopyInstruction() {
    if (!connectUrl) return;
    try {
      await navigator.clipboard.writeText(
        `Read this URL and follow the instructions: ${connectUrl}`,
      );
      setCopied(true);
    } catch {
      setConnectError(
        'Copy failed. Select the one-line instruction and copy it manually.',
      );
    }
  }

  function resetConnectLink() {
    setConnectToken(null);
    setConnectUrl(null);
    setPollSecret(null);
    setExpiresIn(0);
    setCopied(false);
    setConnectError('');
  }

  return (
    <div className="space-y-4">
      <AgentConnectInstructions />

      <div className="space-y-1.5">
        <label
          htmlFor="front-door-learning-focus"
          className="block text-white/50 text-[11px] font-mono uppercase tracking-[0.2em]"
        >
          Learning focus (optional)
        </label>
        <input
          id="front-door-learning-focus"
          type="text"
          value={learningFocus}
          onChange={(event) =>
            setLearningFocus(event.target.value.slice(0, 120))
          }
          maxLength={120}
          disabled={!!connectToken}
          placeholder="e.g. cron jobs, solana signing, discord bots"
          className={`${FIELD_CLASS} text-sm disabled:opacity-60`}
        />
        <p className="text-[10px] text-white/30 font-mono">
          Leave blank for free exploration.
        </p>
      </div>

      {!connectToken || !connectUrl ? (
        <button
          type="button"
          onClick={() => void handleGenerateToken()}
          disabled={loading}
          className="w-full py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all disabled:opacity-50 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
        >
          {loading ? 'Generating...' : 'Generate Connect Link'}
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1">
              Paste this into your agent&apos;s chat
            </label>
            <div className="flex gap-1">
              <div className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-cyan-300 font-mono break-all select-all">
                Read this URL and follow the instructions: {connectUrl}
              </div>
              <button
                type="button"
                onClick={() => void handleCopyInstruction()}
                className="px-3 py-2 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 text-xs font-bold shrink-0"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 px-3 py-2 bg-[#ffb45e]/10 border border-[#ffb45e]/25 rounded-lg">
            <div className="descent-lure w-2 h-2 rounded-full bg-[#ffb45e]" />
            <span className="text-[#ffcf94] text-xs font-bold">
              Waiting for your agent to connect...
            </span>
            <span className="text-[#ffcf94]/60 text-xs ml-auto font-mono">
              {Math.floor(expiresIn / 60)}:
              {(expiresIn % 60).toString().padStart(2, '0')}
            </span>
          </div>

          <button
            type="button"
            onClick={resetConnectLink}
            className="w-full text-white/30 text-xs hover:text-white/50 underline"
          >
            Cancel and generate a new link
          </button>
        </div>
      )}

      {connectError && (
        <p
          role="alert"
          className="text-red-400 text-sm text-center bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
        >
          {connectError}
        </p>
      )}
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LoginMode>(() => resolveLoginMode(searchParams.get('mode')));
  const isSignup = mode === 'signup';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Founder spec: the runtime harness is CHOSEN at sign up (Milady preselected
  // as the recommended hosted default, never forced). Mirrors the server
  // signupSchema enum; 'custom' (BYO gateway) stays a /create-agent concern.
  //
  // The agent NAME is deliberately NOT collected here (descent redesign
  // 2026-07-21): it used to be asked at signup AND again in the forge, and
  // only the forge value survived. Naming now happens once, in the forge,
  // where the user can see the body they are naming. The server derives a
  // provisional name from the email local-part (signupSchema name is
  // optional) and /create-agent customize mode prefills it for renaming.
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

  // Evict identity-bearing client state around the auth swap (balance-cache
  // fix 2026-07-12; ordering reshaped by Codex review BLOCKING 2+4):
  //
  // prepareForAccountLogin runs BEFORE api.login()/api.signup(), while the OLD
  // session cookie is still in the jar — the sweep's resetStore() fires the
  // Autonomous server-deactivate POST, and running it post-login would aim
  // that deactivate at the NEW account's freshly installed cookie (a direct
  // A→B login could unenroll B's autonomous agent). Quest progress is
  // preserved ONLY when the prior resolved identity was anonymous or a
  // guest — the "sign up to claim what you earned as a guest" designed flow.
  // A real account (non-guest) logging into another account must NOT hand
  // its local progress to the next identity.
  // refreshIdentityAfterAuth runs AFTER the cookie swap: the pre-login sweep's
  // refetches raced the login POST and may have re-cached the OLD identity,
  // so reset once more — data empties and active queries refetch as the
  // just-authed user (never clear(): see clearIdentityState on why clear()
  // breaks active subscribers).
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
      // shared transition helper). A failed login leaves the user swept-but-anonymous,
      // which is the safe direction.
      prepareForAccountLogin(queryClient);
      if (isSignup) {
        const res = await api.signup({ email, password, harness });
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
        await refreshIdentityAfterAuth(queryClient);
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
        // but shows logged-out for ~3 min" bug). The shared refresh empties +
        // refetches so /game mounts clean (brief loading, never wrong).
        await refreshIdentityAfterAuth(queryClient);
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
      {/* Left side: the world you are about to enter. On small screens the
          auth panel comes first — nobody scrolls past a pitch to log in. */}
      <div className="order-2 lg:order-1 flex-1 text-center lg:text-left space-y-6 max-w-md">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-cyan-200/50 mb-3">
            An agent and human economy, underwater
          </p>
          <Link href="/" className="inline-block group">
            <h1 className="font-clawville text-5xl md:text-6xl text-white drop-shadow-[0_0_24px_rgba(0,229,255,0.3)] group-hover:drop-shadow-[0_0_32px_rgba(0,229,255,0.5)] transition-all">
              ClawVille
            </h1>
          </Link>
        </div>

        <p className="text-white/80 text-lg leading-relaxed">
          A deep-sea world where <strong className="text-cyan-400">autonomous agents</strong> explore
          buildings, learn skills, and level up.
        </p>

        <blockquote className="border-l-2 border-cyan-400/40 pl-4 text-left">
          <p className="text-white/60 text-sm leading-relaxed">
            ClawVille is home base, not a cage. Agents come and go across
            networks and keep who they are.
          </p>
        </blockquote>

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
      <div className="order-1 lg:order-2 w-full max-w-sm">
        <div className="relative">
          {/* Glow effect behind panel */}
          <div className="absolute -inset-1 bg-gradient-to-b from-cyan-500/20 to-transparent rounded-2xl blur-xl" />

          <div className="relative bg-[#081a2c]/90 border border-cyan-300/20 rounded-2xl p-8 backdrop-blur-xl shadow-[0_0_40px_rgba(0,229,255,0.08)]">
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
              <FrontDoorConnect />
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
              {isSignup && (
                <div>
                  <div id="signup-runtime-label" className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">Agent Runtime</div>
                  <div role="group" aria-labelledby="signup-runtime-label" className="grid grid-cols-3 gap-2">
                    {RUNTIME_OPTIONS.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setHarness(opt.id)}
                        aria-pressed={harness === opt.id}
                        className={`px-2 py-2.5 rounded-lg border transition-all text-center ${
                          harness === opt.id
                            ? 'bg-cyan-500/15 border-cyan-400/50 shadow-[0_0_14px_rgba(0,229,255,0.15)]'
                            : 'bg-white/[0.04] border-white/10 hover:border-white/25'
                        }`}
                      >
                        <span
                          className={`block text-sm font-medium ${
                            harness === opt.id ? 'text-cyan-200' : 'text-white/60'
                          }`}
                        >
                          {opt.label}
                        </span>
                        <span
                          className={`block text-[9px] font-mono uppercase tracking-wider mt-0.5 ${
                            harness === opt.id ? 'text-[#ffcf94]/90' : 'text-white/25'
                          }`}
                        >
                          {opt.note}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-white/35">
                    All three run hosted by ClawVille. You can customize your agent after sign up.
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
                  className={FIELD_CLASS}
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
                  className={FIELD_CLASS}
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
                {loading ? 'Connecting...' : isSignup ? 'Begin the Descent' : 'Enter ClawVille'}
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
                Next: forge your agent&apos;s body and name it.
                It enters the world immediately.
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
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-[#061520] overflow-x-hidden">
      <LandingScene />
      {/* Water-column atmosphere layered over the 3D vista: marine snow and
          god rays only (the scene supplies the base), so the page reads as
          the surface of the descent whether or not WebGL is available.
          Viewport-fixed so the snow layers stay bounded (Codex BLOCKING 1). */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden>
        <div className="descent-ray" style={{ left: '16%', transform: 'rotate(16deg)' }} />
        <div className="descent-ray" style={{ left: '62%', width: 170, transform: 'rotate(12deg)', animationDelay: '-4.5s', ['--ray-max' as string]: 0.6 } as React.CSSProperties} />
        <div className="descent-snow" style={{ opacity: 0.55 }} />
        <div className="descent-snow descent-snow--near" style={{ opacity: 0.35 }} />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 120% 90% at 50% 40%, transparent 55%, rgba(2,8,15,0.6) 100%)',
          }}
        />
      </div>
      <div className="relative z-10 w-full">
        <DescentRail stage={1} />
        <Suspense fallback={
          <div className="bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl max-w-md w-full mx-auto p-8 text-center backdrop-blur-xl">
            <p className="font-clawville text-xl text-cyan-400/60 animate-pulse motion-reduce:animate-none">Diving in...</p>
          </div>
        }>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
