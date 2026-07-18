'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthMe } from '@/hooks/use-auth-me';
import { useAvatar, useCreateAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';
import { api } from '@/lib/api';
import { FIRST_TIME_DISCLOSURE_STORAGE_KEY } from '@/components/game/first-time-backup-modal';
import {
  AVATAR_ARCHETYPES,
  AGENT_CATEGORIES,
  AGENT_HARNESSES,
  AGENT_MODEL_KEYS,
} from '@clawville/shared';
import type {
  AvatarArchetypeId,
  AgentCategory,
  AgentHarness,
} from '@clawville/shared';

// COLOR_HEX used for info display fallback only (no 3D canvas on this page)
const COLOR_HEX: Record<string, string> = {
  green:  '#30ff70',
  red:    '#ff3030',
  blue:   '#3070ff',
  yellow: '#ffd700',
};

const HABITAT_OPTIONS = [
  { value: 'forest', label: 'Forest' },
  { value: 'sea', label: 'Sea' },
  { value: 'mountain', label: 'Mountain' },
  { value: 'sky', label: 'Sky' },
  { value: 'desert', label: 'Desert' },
  { value: 'cave', label: 'Cave' },
];

const HOBBY_OPTIONS = [
  { value: 'reading-and-learning', label: 'Reading and Learning' },
  { value: 'exploring', label: 'Exploring' },
  { value: 'battling', label: 'Battling' },
  { value: 'collecting', label: 'Collecting' },
  { value: 'cooking', label: 'Cooking' },
  { value: 'art', label: 'Art' },
];

const GREETING_OPTIONS = [
  { value: 'run-away', label: 'Run Awaaaay!!!' },
  { value: 'wave-hello', label: 'Wave Hello' },
  { value: 'tackle-hug', label: 'Tackle Hug!' },
  { value: 'shy-peek', label: 'Shy Peek...' },
  { value: 'bow-politely', label: 'Bow Politely' },
  { value: 'roar', label: 'ROAR!!!' },
];

// Same stat calculation as the API
const HABITAT_STATS: Record<string, { s: number; d: number; m: number }> = {
  forest: { s: 3, d: 4, m: 3 },
  sea: { s: 2, d: 3, m: 5 },
  mountain: { s: 5, d: 4, m: 1 },
  sky: { s: 2, d: 2, m: 6 },
  desert: { s: 4, d: 3, m: 3 },
  cave: { s: 5, d: 5, m: 0 },
};

const HOBBY_STATS: Record<string, { s: number; d: number; m: number }> = {
  'reading-and-learning': { s: 0, d: 2, m: 3 },
  exploring: { s: 1, d: 1, m: 3 },
  battling: { s: 4, d: 1, m: 0 },
  collecting: { s: 1, d: 1, m: 3 },
  cooking: { s: 1, d: 3, m: 1 },
  art: { s: 0, d: 3, m: 2 },
};

const GREETING_STATS: Record<string, { s: number; d: number; m: number }> = {
  'run-away': { s: 0, d: 1, m: 4 },
  'wave-hello': { s: 1, d: 2, m: 2 },
  'tackle-hug': { s: 3, d: 0, m: 2 },
  'shy-peek': { s: 0, d: 4, m: 1 },
  'bow-politely': { s: 1, d: 3, m: 1 },
  roar: { s: 4, d: 1, m: 0 },
};

interface Step1Data {
  species: string;   // legacy field — equals modelKey for API compat
  modelKey?: string;
  category?: string;
  color: string;
  name: string;
  gender: string;
  harness?: string;
  thumb?: string;    // base64 JPEG thumbnail captured from SelectAgentCanvas
}

const ARCHETYPE_COLORS: Record<string, string> = {
  'brave-adventurer': '#D97706',
  'curious-scholar': '#2563EB',
  'mischievous-trickster': '#F59E0B',
  'gentle-healer': '#10B981',
  'fierce-battler': '#DC2626',
  'creative-dreamer': '#EC4899',
  'noble-guardian': '#6366F1',
  'cunning-trader': '#059669',
  'mystical-seer': '#7C3AED',
  'loyal-companion': '#F97316',
  'wild-explorer': '#65A30D',
  'royal-diplomat': '#0891B2',
  'chaotic-jester': '#E11D48',
  'quiet-mystic': '#6B7280',
};

export default function PersonalityPage() {
  const router = useRouter();
  const createAvatarMutation = useCreateAvatar();
  const queryClient = useQueryClient();

  // P2 customize mode (2026-07-04) — signup auto-provisions the avatar, so a
  // fresh signup arrives here already OWNING one. One avatar per user is a
  // hard server constraint (POST would 400), so when an avatar exists this
  // page submits via PATCH /api/avatars/me (+ /me/appearance for cosmetics)
  // instead of POST, sending ONLY the fields that actually changed. No-avatar
  // users (legacy / provisioning-pending) keep the POST path untouched.
  const { data: avatar, isLoading: avatarLoading } = useAvatar();

  // Guest gate (P2 post-panel BLOCKING #2, 2026-07-04). Mirror /create-agent:
  // a guest ACCOUNT (is_guest=true) can't provision or customize an agent —
  // the server 403s the customize PATCH with code:'guest_not_allowed'. A guest
  // could still deep-link here with a stale createAvatarStep1 draft, so bounce
  // them to /login before they submit. SCOPED to is_guest ONLY: an un-authed
  // visitor (api.me 401s → authData null) is the legitimate POST-create
  // auto-provision path and must reach the CREATE branch unchanged
  // (`null?.user?.isGuest === true` is false → not redirected).
  const { data: authData } = useAuthMe();
  const isGuestAccount = authData?.user?.isGuest === true;
  useEffect(() => {
    if (isGuestAccount) router.replace('/login');
  }, [isGuestAccount, router]);

  const customizeMode = !isGuestAccount && !!avatar;
  const [isSaving, setIsSaving] = useState(false);

  const [step1, setStep1] = useState<Step1Data | null>(null);
  const [habitat, setHabitat] = useState('forest');
  const [hobby, setHobby] = useState('reading-and-learning');
  const [greetingStyle, setGreetingStyle] = useState('run-away');
  const [selectedArchetype, setSelectedArchetype] = useState<AvatarArchetypeId | null>(null);
  const [error, setError] = useState('');

  // Load step 1 data from sessionStorage
  useEffect(() => {
    const raw = sessionStorage.getItem('createAvatarStep1');
    if (!raw) {
      router.push('/create-agent');
      return;
    }
    try {
      setStep1(JSON.parse(raw));
    } catch {
      router.push('/create-agent');
    }
  }, [router]);

  // Customize-mode prefill — hydrate archetype + personality from the
  // provisioned avatar ONCE when it resolves (usually instantly from the
  // ['avatar'] cache warmed by step 1), validated against the current option
  // registries so a legacy row can't inject an unknown value. Functional
  // archetype update so a user pick that raced the fetch is never clobbered.
  const prefilledFromAvatarRef = useRef(false);
  useEffect(() => {
    if (!avatar || prefilledFromAvatarRef.current) return;
    prefilledFromAvatarRef.current = true;
    if (
      typeof avatar.archetype === 'string' &&
      AVATAR_ARCHETYPES.some((a) => a.id === avatar.archetype)
    ) {
      setSelectedArchetype((prev) => prev ?? (avatar.archetype as AvatarArchetypeId));
    }
    const p = avatar.personality as
      | { habitat?: string; hobby?: string; greeting?: string }
      | null
      | undefined;
    if (p?.habitat && HABITAT_OPTIONS.some((o) => o.value === p.habitat)) setHabitat(p.habitat);
    if (p?.hobby && HOBBY_OPTIONS.some((o) => o.value === p.hobby)) setHobby(p.hobby);
    if (p?.greeting && GREETING_OPTIONS.some((o) => o.value === p.greeting)) {
      setGreetingStyle(p.greeting);
    }
  }, [avatar]);

  // Calculate stats from personality choices (mirrors API logic)
  const stats = useMemo(() => {
    const h = HABITAT_STATS[habitat] ?? { s: 0, d: 0, m: 0 };
    const ho = HOBBY_STATS[hobby] ?? { s: 0, d: 0, m: 0 };
    const g = GREETING_STATS[greetingStyle] ?? { s: 0, d: 0, m: 0 };

    return {
      strength: h.s + ho.s + g.s,
      defence: h.d + ho.d + g.d,
      movement: h.m + ho.m + g.m,
    };
  }, [habitat, hobby, greetingStyle]);

  const maxStat = 15; // theoretical max per stat (5+4+4 for strength via mountain+battling+roar)

  async function handleCreate() {
    if (!step1) return;
    // Don't race the avatar fetch: PATCH-vs-POST branches on whether an
    // avatar exists, and guessing wrong dead-ends on the one-avatar-per-user
    // 400. The button is disabled while loading; this is belt-and-braces.
    if (avatarLoading) return;
    setError('');

    if (!selectedArchetype) {
      setError('Please choose an archetype for your agent');
      return;
    }

    try {
      // Phase 2 audit Fix E — validate the Phase 2 fields loaded from
      // sessionStorage against the current shared registry before
      // forwarding them to the server. A stale step-1 draft could hold
      // values that were valid in an earlier build (e.g. a retired harness
      // label or a color id from the 9-color era).
      // The previous `as 'openclaw' | ...` cast was unsafe — it silently
      // forwarded the stale value, which the server would then 400 on,
      // leaving the user stuck on the personality screen with no
      // actionable recovery. Here we drop invalid values to `undefined`
      // and let the server fall back to its defaults
      // (DEFAULT_AGENT_MODEL_KEY / DEFAULT_AGENT_CATEGORY /
      // DEFAULT_AGENT_HARNESS — same values as the DB column DEFAULTs).
      // Cross-validation with the modelKey's real category happens
      // server-side (apps/api/src/routes/avatars.ts), so we don't need to
      // re-derive here.
      // Surface — don't silently default — when the picker forwarded a model the
      // shared registry doesn't know. Root cause of the 2026-06-21 "picked a chibi
      // at signup, loaded as the default Milady" bug: the chibi keys were offered
      // by the web picker but absent from AGENT_MODEL_KEYS, so this check below
      // dropped them to `undefined` and the server applied DEFAULT_AGENT_MODEL_KEY
      // (a Milady) with NO feedback. chibi is now first-class, but if the web
      // picker and the shared registry EVER drift again, fail loud here instead of
      // silently substituting an avatar the user did not choose.
      if (
        step1.modelKey &&
        !(AGENT_MODEL_KEYS as readonly string[]).includes(step1.modelKey)
      ) {
        setError(
          "That avatar isn't available right now — go back and pick another one.",
        );
        return;
      }
      const safeModelKey =
        step1.modelKey && (AGENT_MODEL_KEYS as readonly string[]).includes(step1.modelKey)
          ? step1.modelKey
          : undefined;
      const safeAgentCategory: AgentCategory | undefined =
        step1.category && (AGENT_CATEGORIES as readonly string[]).includes(step1.category)
          ? (step1.category as AgentCategory)
          : undefined;
      const safeHarness: AgentHarness | undefined =
        step1.harness && (AGENT_HARNESSES as readonly string[]).includes(step1.harness)
          ? (step1.harness as AgentHarness)
          : undefined;

      // ---- P2 CUSTOMIZE (PATCH) PATH — the avatar already exists. ----
      // One avatar per user is a hard server constraint, so we PATCH the
      // provisioned row instead of POSTing a second one. Only fields that
      // actually CHANGED are sent: an empty PATCH body 400s server-side, and
      // unchanged values would just burn the 30/min/IP customize budget.
      if (customizeMode && avatar) {
        setIsSaving(true);
        try {
          // Identity/persona diffs → PATCH /api/avatars/me.
          const customizeBody: {
            name?: string;
            species?: string;
            archetypeId?: string;
            personality?: { habitat: string; hobby: string; greeting: string };
          } = {};
          if (step1.name && step1.name !== avatar.name) customizeBody.name = step1.name;
          if (step1.species && step1.species !== avatar.species) {
            customizeBody.species = step1.species;
          }
          if (selectedArchetype !== avatar.archetype) {
            customizeBody.archetypeId = selectedArchetype;
          }
          const prevP = avatar.personality as
            | { habitat?: string; hobby?: string; greeting?: string }
            | null
            | undefined;
          if (
            prevP?.habitat !== habitat ||
            prevP?.hobby !== hobby ||
            prevP?.greeting !== greetingStyle
          ) {
            customizeBody.personality = { habitat, hobby, greeting: greetingStyle };
          }
          if (Object.keys(customizeBody).length > 0) {
            await api.customizeAvatar(customizeBody);
          }

          // Cosmetic diffs → PATCH /me/appearance (modelKey/color/gender live
          // there — harness-pool guard enforced server-side; step 1 already
          // pre-filters the picker to the server-accepted pool).
          const appearanceBody: {
            modelKey?: string;
            color?: 'green' | 'red' | 'blue' | 'yellow';
            gender?: 'male' | 'female';
          } = {};
          if (safeModelKey && safeModelKey !== avatar.modelKey) {
            appearanceBody.modelKey = safeModelKey;
          }
          if (
            (step1.color === 'green' ||
              step1.color === 'red' ||
              step1.color === 'blue' ||
              step1.color === 'yellow') &&
            step1.color !== avatar.color
          ) {
            appearanceBody.color = step1.color;
          }
          if (
            (step1.gender === 'male' || step1.gender === 'female') &&
            step1.gender !== avatar.gender
          ) {
            appearanceBody.gender = step1.gender;
          }
          if (Object.keys(appearanceBody).length > 0) {
            await api.editAvatarAppearance(appearanceBody);
          }

          // Refresh the authoritative row + the agent-session probe so /game
          // never mounts against a stale 'provisioning-pending' answer cached
          // ≤30s ago. Both keys pre-exist (purged on login, cleared on
          // logout) — zero new query keys.
          queryClient.invalidateQueries({ queryKey: ['avatar'] });
          queryClient.invalidateQueries({ queryKey: ['agent-session'] });

          // Deliberately NO one-time-secret stash here: the wallet secret was
          // emitted EXACTLY ONCE at signup (the /login page stashes it for
          // FirstTimeBackupModal) and the server never re-emits — these PATCH
          // responses carry no secrets to stash.

          sessionStorage.removeItem('createAvatarStep1');

          // BEARER DISCIPLINE (P2 slice C): never fabricate an agent-session
          // bearer. For a ClawVille-hosted avatar — milady/hermes harness +
          // platformAgentId, the exact predicate /me/agent-session uses for
          // mode 'hosted' — mark the user PAIRED without a bearer:
          // setAgentPaired flips agentPaired/agentConnected/hasAgent, embodies
          // them in 'player', and forces agentSessionId=null so the
          // agent-bearer chat path stays OFF by construction (the server only
          // emits a real bearer once, at an actual connect). Non-hosted
          // avatars just normalise the mode.
          const hosted =
            (avatar.harness === 'milady' || avatar.harness === 'hermes') &&
            !!avatar.platformAgentId;
          if (hosted) {
            useGameStore.getState().setAgentPaired(true, avatar.platformAgentId as string);
          } else {
            useGameStore.getState().setControlMode('player');
          }

          router.push('/game');
        } finally {
          setIsSaving(false);
        }
        return;
      }

      const createRes = await createAvatarMutation.mutateAsync({
        name: step1.name,
        species: step1.species,
        color: step1.color,
        gender: step1.gender,
        archetypeId: selectedArchetype,
        personality: { habitat, hobby, greeting: greetingStyle },
        modelKey: safeModelKey,
        agentCategory: safeAgentCategory,
        harness: safeHarness,
      });

      // Phase 4d — capture one-time identity + wallet secrets for
      // self-custody backup. Per Phase 5.1 doctrine, these are
      // disclosed by the server EXACTLY ONCE on auto-provision; the
      // server never re-exposes them after this response. We stash
      // them in sessionStorage (not localStorage — intentional, so
      // they're purged when the tab closes if the user dismissed the
      // modal without saving). The /game page reads + renders the
      // mandatory backup modal on first mount.
      if (createRes.identity || createRes.wallet) {
        try {
          sessionStorage.setItem(
            FIRST_TIME_DISCLOSURE_STORAGE_KEY,
            JSON.stringify({
              avatarId: createRes.avatar?.id,
              avatarName: createRes.avatar?.name,
              identity: createRes.identity ?? null,
              wallet: createRes.wallet ?? null,
              issuedAt: Date.now(),
            }),
          );
        } catch {
          // sessionStorage quota exceeded or disabled — fall through.
          // User can still recover via the support-chat flow later.
        }
      }

      sessionStorage.removeItem('createAvatarStep1');

      // The POST just provisioned the agent — refresh the agent-session probe
      // so /game never mounts against a stale 'provisioning-pending' answer
      // cached ≤30s ago (['avatar'] is already invalidated by useCreateAvatar).
      queryClient.invalidateQueries({ queryKey: ['agent-session'] });

      // Mark the agent as PAIRED before the redirect. User feedback
      // 2026-04-24: a fresh Milady avatar has no gateway session (the agent
      // IS the avatar's Eliza runtime), so nothing flipped the toggle to
      // "Controlled / Autonomous" and the UI kept offering "Connect Your
      // Agent" even though the agent was already alive server-side.
      //
      // P2 slice C fix (2026-07-04) — FABRICATED-BEARER KILL: this used to
      // call setAgentConnection(platformAgentId), passing the platform agent
      // id AS an agent-session BEARER. The first agent-routed chat then sent
      // that fake bearer to POST /api/openclaw/chat →
      // validateLiveAgentSession 404 `agent_session_not_found` → "Agent
      // session ended — reconnect" banner, and the /game hydration effect
      // couldn't correct it (its clientSideBearer early-return shields a
      // held bearer). The server emits a real bearer EXACTLY ONCE at an
      // actual connect and never re-emits — a bearer can never be
      // reconstructed client-side (game/page.tsx hydration comment is the
      // canonical rationale).
      //
      // setAgentPaired(true, agentId) is the honest state: it flips
      // agentPaired/agentConnected/hasAgent, embodies in 'player', and
      // forces agentSessionId=null so the agent-bearer chat path stays OFF
      // by construction — the chat bar uses the normal authed avatar path
      // (which IS the hosted agent). The agentId is diagnostics/display
      // only, never a bearer. For OpenClaw/Hermes self-hosted agents we
      // skip this (those still need the Moltbook handshake via the Connect
      // Agent modal to hand us their gateway URL + token).
      const agentIdForSession = createRes.agentId ?? createRes.avatar?.id;
      if (safeHarness === 'milady' && agentIdForSession) {
        useGameStore.getState().setAgentPaired(true, agentIdForSession);
      } else {
        // Non-Milady fallback: still normalise the mode so a stale
        // spectator/npc state from a prior session doesn't leak into
        // the new avatar's first frame.
        useGameStore.getState().setControlMode('player');
      }

      router.push('/game');
    } catch (err: any) {
      const message = String(err?.message ?? '');
      // The API enforces one avatar per user — when the user already has
      // one, POST /api/avatars 400s with "You already have an avatar".
      // The user reached this page in good faith (the /game banner's
      // Create Agent button never shows when an avatar exists, so the
      // most likely cause is a stale guest avatar auto-provisioned on a
      // prior visit). Bounce them to /game instead of leaving them
      // stuck on the personality form with a dead Create button.
      if (/already have an avatar/i.test(message)) {
        sessionStorage.removeItem('createAvatarStep1');
        router.push('/game');
        return;
      }
      setError(message || 'Failed to create agent');
    }
  }

  if (!step1) {
    return (
      <div className="relative min-h-screen bg-[#061520] flex items-center justify-center">
        <p className="text-white font-clawville text-xl">Loading...</p>
      </div>
    );
  }

  const colorHex = COLOR_HEX[step1.color] || '#30ff70';

  return (
    <div className="relative min-h-screen bg-[#061520] flex flex-col items-center px-4 py-6">
      {/* Back-to-avatar link — sessionStorage persists so step 1 re-hydrates. */}
      <div className="w-full max-w-xl mb-3">
        <button
          type="button"
          onClick={() => router.push('/create-agent')}
          className="text-white/40 hover:text-cyan-300 text-xs font-mono uppercase tracking-wider transition-colors"
        >
          &larr; Edit Avatar
        </button>
      </div>
      {/* Agent preview + info */}
      <div className="w-full max-w-xl flex flex-col sm:flex-row items-center gap-4 mb-6">
        {/* 3D thumbnail captured from SelectAgentCanvas on step 1 */}
        <div
          className="w-48 h-48 rounded-xl overflow-hidden border border-white/10 shrink-0 flex items-center justify-center"
          style={{ backgroundColor: colorHex + '22' }}
        >
          {step1.thumb ? (
            <img
              src={step1.thumb}
              alt={`${step1.name} preview`}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-white/30 text-xs font-mono text-center px-2">
              <span>Preview unavailable</span>
              <button
                type="button"
                onClick={() => router.push('/create-agent')}
                className="text-cyan-400/70 hover:text-cyan-300 underline text-[11px]"
              >
                Re-render
              </button>
            </div>
          )}
        </div>

        {/* Info display */}
        <div className="text-white text-lg space-y-1 text-center sm:text-left">
          <p>
            <span className="font-bold">Name:</span> {step1.name}
          </p>
          <p>
            <span className="font-bold">Gender:</span> {step1.gender}
          </p>
          <p>
            <span className="font-bold">Model:</span>{' '}
            {(step1.modelKey ?? step1.species).charAt(0).toUpperCase() + (step1.modelKey ?? step1.species).slice(1).replace(/_/g, ' ')}
          </p>
          <p>
            <span className="font-bold">Colour:</span>{' '}
            {step1.color.charAt(0).toUpperCase() + step1.color.slice(1)}
          </p>
        </div>
      </div>

      {/* ARCHETYPE section */}
      <div className="w-full max-w-xl mb-4">
        <div className="flex justify-end mb-1">
          <span className="claw-panel px-4 py-1 font-bold text-white uppercase tracking-wide text-sm">
            Choose Archetype
          </span>
        </div>
        <div className="claw-panel">
          <p className="text-white/60 text-sm mb-3">
            Your agent's archetype determines their AI personality, knowledge, and speaking style.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {AVATAR_ARCHETYPES.map((archetype) => {
              const isSelected = selectedArchetype === archetype.id;
              const accentColor = ARCHETYPE_COLORS[archetype.id] || '#6B7280';
              return (
                <button
                  key={archetype.id}
                  type="button"
                  onClick={() => setSelectedArchetype(archetype.id)}
                  className={`text-left p-3 rounded-lg border-3 transition-all duration-200 ${
                    isSelected
                      ? 'border-cyan-500 bg-cyan-500/10 ring-1 ring-cyan-500/50'
                      : 'border-white/10 bg-white/5 hover:border-white/10 hover:bg-cyan-500/5'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: accentColor }}
                    />
                    <span className="font-bold text-white text-sm leading-tight">
                      {archetype.label}
                    </span>
                  </div>
                  <p className="text-xs text-white/50 leading-tight">
                    {archetype.description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* PERSONALITY section (stats) */}
      <div className="w-full max-w-xl mb-4">
        <div className="flex justify-end mb-1">
          <span className="claw-panel px-4 py-1 font-bold text-white uppercase tracking-wide text-sm">
            Personality
          </span>
        </div>
        <div className="claw-panel space-y-4">
          {/* Habitat */}
          <div>
            <label className="block font-bold text-white/80 mb-1">
              Where does your agent prefer to operate?
            </label>
            <select
              value={habitat}
              onChange={(e) => setHabitat(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-white/10 bg-[#0a1628] text-white focus:outline-none focus:ring-2 focus:ring-claw-green"
            >
              {HABITAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Hobby */}
          <div>
            <label className="block font-bold text-white/80 mb-1">
              What does your agent specialize in?
            </label>
            <select
              value={hobby}
              onChange={(e) => setHobby(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-white/10 bg-[#0a1628] text-white focus:outline-none focus:ring-2 focus:ring-claw-green"
            >
              {HOBBY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Greeting Style */}
          <div>
            <label className="block font-bold text-white/80 mb-1">
              How does your agent introduce itself?
            </label>
            <select
              value={greetingStyle}
              onChange={(e) => setGreetingStyle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border-3 border-white/10 bg-[#0a1628] text-white focus:outline-none focus:ring-2 focus:ring-claw-green"
            >
              {GREETING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* STATS section */}
      <div className="w-full max-w-xl mb-6">
        <div className="flex justify-end mb-1">
          <span className="claw-panel px-4 py-1 font-bold text-white uppercase tracking-wide text-sm">
            Stats
          </span>
        </div>
        <div className="claw-panel">
          {/* Stat bars */}
          <div className="space-y-3">
            {/* Strength */}
            <div className="flex items-center gap-3">
              <span className="font-bold text-white/80 w-6 text-right">S:</span>
              <div className="flex-1 bg-white/10 rounded-full h-5 overflow-hidden border-2 border-white/10">
                <div
                  className="h-full bg-cyan-400 rounded-full transition-all duration-500"
                  style={{ width: `${(stats.strength / maxStat) * 100}%` }}
                />
              </div>
              <span className="font-bold text-white/60 w-8 text-sm">
                {stats.strength}
              </span>
            </div>

            {/* Defence */}
            <div className="flex items-center gap-3">
              <span className="font-bold text-white/80 w-6 text-right">D:</span>
              <div className="flex-1 bg-white/10 rounded-full h-5 overflow-hidden border-2 border-white/10">
                <div
                  className="h-full bg-cyan-400 rounded-full transition-all duration-500"
                  style={{ width: `${(stats.defence / maxStat) * 100}%` }}
                />
              </div>
              <span className="font-bold text-white/60 w-8 text-sm">
                {stats.defence}
              </span>
            </div>

            {/* Movement */}
            <div className="flex items-center gap-3">
              <span className="font-bold text-white/80 w-6 text-right">M:</span>
              <div className="flex-1 bg-white/10 rounded-full h-5 overflow-hidden border-2 border-white/10">
                <div
                  className="h-full bg-cyan-400 rounded-full transition-all duration-500"
                  style={{ width: `${(stats.movement / maxStat) * 100}%` }}
                />
              </div>
              <span className="font-bold text-white/60 w-8 text-sm">
                {stats.movement}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-red-300 font-bold text-sm mb-4 text-center">
          {error}
        </p>
      )}

      {/* Create button */}
      <button
        onClick={handleCreate}
        disabled={createAvatarMutation.isPending || isSaving || avatarLoading}
        className="w-full max-w-xl py-3 rounded-lg font-clawville text-sm uppercase tracking-wider bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] text-xl disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {customizeMode
          ? isSaving
            ? 'Saving...'
            : 'SAVE'
          : createAvatarMutation.isPending
            ? 'Creating...'
            : 'CREATE'}
      </button>
    </div>
  );
}
