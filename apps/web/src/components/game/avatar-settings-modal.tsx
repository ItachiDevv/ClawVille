'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import { api } from '@/lib/api';
import { AUTH_ME_QUERY_KEY, fetchAuthMe } from '@/hooks/use-auth-me';
import { AVATAR_SPECIES, AVATAR_COLORS, AVATAR_ARCHETYPES } from '@clawville/shared';
import { SetupInstructions } from '@/components/create-agent/setup-instructions';
import { EditAppearanceSection } from '@/components/game/edit-appearance-section';
import { WalletPanel } from '@/components/game/wallet/wallet-panel';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

export default function AvatarSettingsModal() {
  const { settingsModalOpen, setSettingsModalOpen } = useGameStore();
  const { data: avatar } = useAvatar();

  if (!avatar) return null;

  const species = AVATAR_SPECIES.find((s) => s.id === avatar.species);
  const color = AVATAR_COLORS.find((c) => c.id === avatar.color);
  const archetype = AVATAR_ARCHETYPES.find((a) => a.id === avatar.archetype);

  return (
    <Dialog open={settingsModalOpen} onOpenChange={setSettingsModalOpen}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl flex items-center gap-2">
                {species?.emoji} {avatar.name}
              </DialogTitle>
              <DialogDescription className="mt-1">
                Your agent profile
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-black/40 text-white flex items-center justify-center font-bold transition-colors"
                aria-label="Close"
              >
                X
              </button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 p-6 space-y-5">
          {/* Avatar sprite placeholder */}
          <div className="flex justify-center">
            <div
              className="w-24 h-24 rounded-full border-4 border-white/50 shadow-lg flex items-center justify-center text-4xl"
              style={{ backgroundColor: color?.hex || '#ccc' }}
            >
              {species?.emoji}
            </div>
          </div>

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-3">
            <InfoCard label="Species" value={species?.name || avatar.species} />
            <InfoCard label="Color" value={color?.name || avatar.color} />
            <InfoCard
              label="Gender"
              value={avatar.gender === 'male' ? 'Male' : 'Female'}
            />
            <InfoCard
              label="Archetype"
              value={archetype?.label || avatar.archetype}
            />
          </div>

          {/* Archetype details */}
          {archetype && (
            <div className="bg-white/30 rounded-lg p-3 space-y-2">
              <h3 className="font-bold text-sm text-white">
                {archetype.label}
              </h3>
              <p className="text-xs text-white/70">{archetype.description}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {archetype.adjectives.map((adj) => (
                  <span
                    key={adj}
                    className="text-xs bg-cyan-500/20 text-cyan-200 border border-cyan-400/25 rounded-full px-2 py-0.5 font-medium"
                  >
                    {adj}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="space-y-2">
            <h3 className="font-bold text-sm text-white">Stats</h3>
            <div className="space-y-1.5">
              <StatBar label="Strength" value={avatar.stats?.strength ?? 10} />
              <StatBar label="Defence" value={avatar.stats?.defence ?? 10} />
              <StatBar label="Movement" value={avatar.stats?.movement ?? 10} />
            </div>
          </div>

          {/* Personality */}
          {avatar.personality && (
            <div className="space-y-2">
              <h3 className="font-bold text-sm text-white">Personality</h3>
              <div className="grid grid-cols-3 gap-2">
                <PersonalityItem
                  label="Habitat"
                  value={formatPersonalityValue(avatar.personality.habitat)}
                />
                <PersonalityItem
                  label="Hobby"
                  value={formatPersonalityValue(avatar.personality.hobby)}
                />
                <PersonalityItem
                  label="Greeting"
                  value={formatPersonalityValue(avatar.personality.greeting)}
                />
              </div>
            </div>
          )}

          {/* Username editor (2026-05-19) — separate from avatar.name so a
              user can change their public handle without renaming their
              in-world character. */}
          <UsernameSection />

          {/* Wallet (Tokenomics Phase A) — in-game custodial deposit address +
              linked self-custody wallet. Shared component with the standalone
              HUD wallet modal so the two never drift. Public keys only. */}
          <WalletPanel variant="section" />

          {/* Phase 4c Layer 1 — in-game appearance edits */}
          <EditAppearanceSection
            avatar={{
              id: avatar.id,
              modelKey: (avatar as { modelKey?: string | null }).modelKey,
              color: avatar.color,
              gender: avatar.gender,
              harness: (avatar as { harness?: string | null }).harness,
            }}
          />

          {/* Phase 5.1 — Cross-world accounts (plan §15) */}
          <CrossWorldAccountsSection
            linkedScapePrincipalId={
              (avatar as { linkedScapePrincipalId?: string | null }).linkedScapePrincipalId ?? null
            }
            linkedScapeDisplayName={
              (avatar as { linkedScapeDisplayName?: string | null }).linkedScapeDisplayName ?? null
            }
          />

          {/* Phase 4a — Take agent home */}
          <TakeAgentHomeSection
            avatarId={avatar.id}
            harness={(avatar as { harness?: string | null }).harness ?? 'milady'}
          />
        </div>

        {/* Powered by ElizaOS — brand attribution. Every avatar runs on the
            ElizaOS runtime via @clawville/agent-runtime, regardless of
            which export harness the user picked at /create-agent. */}
        <div className="border-t border-white/10 px-6 py-3 flex items-center justify-center gap-2 text-[10px] font-mono uppercase tracking-[0.2em] text-white/40">
          <span>Powered by</span>
          <a
            href="https://elizaos.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-300/80 hover:text-cyan-200 transition-colors font-bold"
          >
            ElizaOS
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * UsernameSection — change the public handle.
 *
 * Lives next to appearance edits in the Avatar Settings modal. Username
 * is initialized from avatar.name at avatar-create time (see
 * apps/api/src/routes/avatars.ts) and editable here after the fact —
 * 5 changes per minute per IP per the API rate limit.
 *
 * Debounce: 400ms after the last keystroke before /check-username fires.
 * The Save button stays disabled until the entered value is both valid
 * (regex) and confirmed-available (200 with available:true) AND
 * different from the current username.
 */
function UsernameSection() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available' }
    | { kind: 'taken'; reason: string }
    | { kind: 'invalid'; reason: string }
  >({ kind: 'idle' });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const meQuery = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: fetchAuthMe,
    staleTime: 30_000,
    retry: false,
  });
  const currentUsername = meQuery.data?.user?.username ?? '';

  const mutation = useMutation({
    mutationFn: (username: string) => api.updateUsername(username),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AUTH_ME_QUERY_KEY });
      setEditing(false);
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });

  useEffect(() => {
    if (!editing) return;
    if (!draft) {
      setStatus({ kind: 'idle' });
      return;
    }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(draft)) {
      setStatus({
        kind: 'invalid',
        reason: '3-20 letters, numbers, or underscore',
      });
      return;
    }
    if (draft.toLowerCase() === currentUsername.toLowerCase()) {
      setStatus({ kind: 'idle' });
      return;
    }
    setStatus({ kind: 'checking' });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.checkUsername(draft);
        if (res.available) {
          setStatus({ kind: 'available' });
        } else {
          setStatus({ kind: 'taken', reason: res.reason ?? 'Already taken' });
        }
      } catch (e) {
        setStatus({ kind: 'invalid', reason: 'Could not check availability' });
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft, editing, currentUsername]);

  const startEdit = () => {
    setDraft(currentUsername);
    setStatus({ kind: 'idle' });
    setError('');
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft('');
    setStatus({ kind: 'idle' });
    setError('');
  };
  const canSave = status.kind === 'available' && !mutation.isPending;

  if (!editing) {
    return (
      <div className="bg-white/5 rounded-lg p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-mono text-white/40">
              Username
            </div>
            <div className="text-sm font-bold text-white mt-0.5">
              {currentUsername || (
                <span className="text-yellow-400/80 italic">
                  not set — click change to pick one
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={startEdit}
            className="px-3 py-1.5 rounded-md bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-200 text-xs font-bold transition-colors"
          >
            Change
          </button>
        </div>
        <p className="text-[10px] text-white/40 leading-relaxed">
          Your public handle on chat, leaderboards, and shared links.
          Independent from your avatar&apos;s in-world name.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white/5 rounded-lg p-3 space-y-2">
      <div className="text-[10px] uppercase tracking-[0.2em] font-mono text-white/40">
        Change username
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, 20))}
        maxLength={20}
        autoFocus
        placeholder="pick a handle"
        className="w-full px-3 py-2 rounded-md bg-black/40 border border-white/15 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-cyan-400/60"
      />
      <div className="text-[11px] font-mono min-h-[1rem]">
        {status.kind === 'checking' && (
          <span className="text-white/40">Checking…</span>
        )}
        {status.kind === 'available' && (
          <span className="text-green-400">Available</span>
        )}
        {status.kind === 'taken' && (
          <span className="text-red-400">{status.reason}</span>
        )}
        {status.kind === 'invalid' && (
          <span className="text-yellow-400/80">{status.reason}</span>
        )}
      </div>
      {error && (
        <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => mutation.mutate(draft)}
          disabled={!canSave}
          className="flex-1 px-3 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-white text-xs font-bold disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={cancelEdit}
          className="px-3 py-2 rounded-md bg-white/10 hover:bg-white/20 text-white/70 text-xs font-bold transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/30 rounded-lg px-3 py-2">
      <p className="text-xs text-white/60 font-medium">{label}</p>
      <p className="text-sm text-white font-bold">{value}</p>
    </div>
  );
}

function StatBar({ label, value }: { label: string; value: number }) {
  const maxStat = 20;
  const percentage = Math.min((value / maxStat) * 100, 100);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/70 font-medium w-16">{label}</span>
      <div className="flex-1 h-3 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 rounded-full transition-all shadow-[0_0_8px_rgba(0,229,255,0.45)]"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs text-white/70 font-bold w-6 text-right">
        {value}
      </span>
    </div>
  );
}

function PersonalityItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/30 rounded-lg px-2 py-1.5 text-center">
      <p className="text-[10px] text-white/60 font-medium">{label}</p>
      <p className="text-xs text-white font-bold truncate">{value}</p>
    </div>
  );
}

function formatPersonalityValue(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Phase 5.1 — Cross-world accounts section (plan §15)
// ---------------------------------------------------------------------------
//
// Two branches driven by `linkedScapePrincipalId`:
//
//   Unlinked: "Generate link code" → POST /api/portal/scape-link-code →
//             monospace copy field + poll /api/avatars/me every 3s for up
//             to 10 min. When the backend writes linkedScapePrincipalId
//             (via POST /api/portal/accept-scape-link on the scape side),
//             the polled avatar response flips, we invalidate the react-query
//             cache and the modal re-renders to the linked branch.
//
//   Linked:   static confirmation card, no action surface for v1 (unlink
//             is deferred to the support-chat phase per plan §15.6).
//
// Polling is aggressively cancelled on unmount, code expiry, or parent
// modal close to prevent the interval from leaking beyond its usefulness.

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // mirrors the backend (plan §15.2)

interface CrossWorldAccountsSectionProps {
  linkedScapePrincipalId: string | null;
  linkedScapeDisplayName: string | null;
}

function CrossWorldAccountsSection({
  linkedScapePrincipalId,
  linkedScapeDisplayName,
}: CrossWorldAccountsSectionProps) {
  if (linkedScapePrincipalId) {
    return (
      <LinkedScapeCard
        displayName={linkedScapeDisplayName ?? 'your scape account'}
      />
    );
  }
  return <UnlinkedScapeCard />;
}

function LinkedScapeCard({ displayName }: { displayName: string }) {
  return (
    <div className="space-y-2">
      <h3 className="font-bold text-sm text-white">Cross-world accounts</h3>
      <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block w-2 h-2 rounded-full bg-teal-300 shadow-[0_0_6px_rgba(45,212,191,0.6)]"
          />
          <p className="text-sm font-bold text-white">&apos;scape account linked</p>
        </div>
        <p className="text-xs text-white/70">
          Linked to <span className="font-bold text-cyan-200">{displayName}</span>{' '}
          on &apos;scape. Future portal crossings use this account.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 4a — Take agent home to Milady
// ---------------------------------------------------------------------------
//
// Emits a copy-pasteable curl one-liner the user runs on the machine where
// their local runtime is reachable. We deliberately DO NOT attempt to POST
// from the browser: local ports are unknowable, and guessing produces a
// 404 UX that looks like a ClawVille bug rather than a user-side port
// mismatch.
//
// Below the install command we render setup instructions branched by the
// avatar's harness — Milady avatars see "run Milady AI locally", everyone else
// sees the raw Eliza + Postgres setup (character JSON + DATABASE_URL + how
// to keep the Eliza process alive after the browser closes).
function TakeAgentHomeSection({
  avatarId,
  harness,
}: {
  avatarId: string;
  harness: string;
}) {
  const isMilady = harness === 'milady';
  const addToast = useGameStore((s) => s.addToast);

  const [miladyUrl, setMiladyUrl] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    skillsCount: number;
    knowledgeCount: number;
    harness: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloadingManifest, setDownloadingManifest] = useState(false);
  const [manifestError, setManifestError] = useState<string | null>(null);

  // Download the signed, portable ClawVille Avatar Manifest (CAM v1) as a .json
  // file — body URI + sha256, equipped cosmetics, owner/identity pubkeys,
  // character + skillPack, and a service-issuer ed25519 signature. Harness-
  // agnostic (works for every avatar, not just Milady exports).
  const handleDownloadManifest = useCallback(async () => {
    setManifestError(null);
    setDownloadingManifest(true);
    try {
      const manifest = await api.exportManifest(avatarId);
      const blob = new Blob([JSON.stringify(manifest, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (manifest.name || 'avatar').replace(/[^a-zA-Z0-9_-]+/g, '-');
      a.download = `${safeName}-clawville-manifest.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast('📦', 'Portable manifest downloaded', 2500);
    } catch (err) {
      setManifestError(
        err instanceof Error && err.message ? err.message : 'Could not build manifest',
      );
    } finally {
      setDownloadingManifest(false);
    }
  }, [avatarId, addToast]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    setCopied(false);
    setGenerating(true);
    try {
      const trimmed = miladyUrl.trim();
      const res = await api.exportCharacter({
        avatarId,
        ...(trimmed ? { miladyBaseUrl: trimmed } : {}),
      });
      setInstallCommand(res.installCommand);
      setSummary({
        skillsCount: res.summary.skillsCount,
        knowledgeCount: res.summary.knowledgeCount,
        harness: res.summary.harness,
      });
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : 'Could not build install command';
      setError(msg);
    } finally {
      setGenerating(false);
    }
  }, [miladyUrl, avatarId]);

  const handleCopy = useCallback(async () => {
    if (!installCommand) return;
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      addToast('📋', 'Install command copied', 2500);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (iOS sandbox, etc.) — user can select-all
      // the code block manually.
    }
  }, [installCommand, addToast]);

  return (
    <div className="space-y-2">
      <h3 className="font-bold text-sm text-white">Take agent home to Milady</h3>
      <div className="bg-pink-500/10 border border-pink-400/25 rounded-lg p-3 space-y-2">
        <p className="text-xs text-white/70">
          Export this agent as a Milady-installable bundle. Paste the command
          into any terminal that can reach your local Milady.
        </p>

        <div className="space-y-1">
          <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider">
            Milady URL <span className="text-white/30">(optional)</span>
          </label>
          <input
            type="text"
            value={miladyUrl}
            onChange={(e) => setMiladyUrl(e.target.value)}
            placeholder="http://localhost:2138"
            spellCheck={false}
            className="w-full px-3 py-1.5 rounded-md bg-black/30 border border-white/10 text-sm text-white placeholder:text-white/25 font-mono focus:outline-none focus:border-pink-400/50"
          />
          <p className="text-[10px] text-white/40">
            Leave blank if your Milady runs on its default port. Override if
            you run Milady on a custom host or port.
          </p>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="w-full px-3 py-2 rounded-lg bg-gradient-to-r from-pink-500 to-fuchsia-500 hover:from-pink-400 hover:to-fuchsia-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-progress"
        >
          {generating
            ? 'Building bundle…'
            : installCommand
              ? 'Regenerate install command'
              : 'Generate install command'}
        </button>

        {error && (
          <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {installCommand && (
          <div className="space-y-2 pt-1">
            {summary && (
              <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-pink-200/70">
                <span>harness: {summary.harness}</span>
                <span className="text-white/20">//</span>
                <span>{summary.skillsCount} skills</span>
                <span className="text-white/20">//</span>
                <span>{summary.knowledgeCount} chunks</span>
              </div>
            )}
            <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider">
              Install command
            </label>
            <div className="bg-black/40 border border-pink-400/30 rounded-lg p-2 max-h-32 overflow-y-auto">
              <pre className="text-[11px] text-pink-100 font-mono whitespace-pre-wrap break-all select-all">
                {installCommand}
              </pre>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="w-full px-3 py-1.5 rounded-md bg-pink-500/20 hover:bg-pink-500/30 text-pink-100 text-xs font-bold transition-colors"
            >
              {copied ? 'Copied!' : 'Copy install command'}
            </button>
          </div>
        )}
      </div>

      {/* Portable manifest (CAM v1) — harness-agnostic, signed, content-addressed.
          The single artifact a user/agent walks away with: 3D body URI+sha256,
          equipped cosmetics, owner + identity pubkeys, character + skillPack, and
          a ClawVille service-issuer ed25519 signature. */}
      <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-2">
        <h3 className="font-bold text-sm text-white">Take your agent anywhere</h3>
        <p className="text-xs text-white/70">
          Download a signed, portable <span className="font-mono text-cyan-200">manifest.json</span>{' '}
          — your agent&apos;s 3D body, cosmetics, learned skills, and identity in
          one verifiable file you can re-import or render elsewhere.
        </p>
        <button
          type="button"
          onClick={handleDownloadManifest}
          disabled={downloadingManifest}
          className="w-full px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-progress"
        >
          {downloadingManifest ? 'Building manifest…' : 'Download portable manifest (.json)'}
        </button>
        {manifestError && (
          <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            {manifestError}
          </p>
        )}
      </div>

      {/* Harness-branched setup instructions — Milady avatars see the "install
          Milady AI locally" doc (Milady bundles Eliza), everyone else sees
          the raw postgres + Eliza bootstrap doc + how-to-keep-Eliza-running. */}
      <SetupInstructions
        docKey={isMilady ? 'milady-export' : 'custom-export'}
        accent={isMilady ? 'pink' : 'cyan'}
      />
    </div>
  );
}

function UnlinkedScapeCard() {
  const queryClient = useQueryClient();
  const addToast = useGameStore((s) => s.addToast);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopAllTimers = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (clockRef.current) {
      clearInterval(clockRef.current);
      clockRef.current = null;
    }
    if (expiryRef.current) {
      clearTimeout(expiryRef.current);
      expiryRef.current = null;
    }
  }, []);

  // Stop every timer on unmount so the interval can't outlive the modal.
  useEffect(() => stopAllTimers, [stopAllTimers]);

  const handleGenerate = useCallback(async () => {
    setError(null);
    setCopied(false);
    setGenerating(true);
    try {
      const res = await api.generateScapeLinkCode();
      const expiresAtMs = Date.parse(res.expiresAt);
      const resolvedExpiresAt =
        Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
          ? expiresAtMs
          : Date.now() + LINK_CODE_TTL_MS;

      setCode(res.code);
      setExpiresAt(resolvedExpiresAt);
      setNow(Date.now());

      // Tick the countdown display every second.
      if (clockRef.current) clearInterval(clockRef.current);
      clockRef.current = setInterval(() => setNow(Date.now()), 1000);

      // Poll /api/avatars/me every 3s — when the linked columns populate we
      // swap into the linked branch via react-query invalidation.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const { avatar } = await api.getMyAvatar();
          if (avatar && avatar.linkedScapePrincipalId) {
            stopAllTimers();
            setCode(null);
            setExpiresAt(null);
            // Refresh the cached avatar so the settings modal (and anything
            // else consuming useAvatar()) flips to the linked branch.
            queryClient.setQueryData(['avatar'], { avatar });
            queryClient.invalidateQueries({ queryKey: ['avatar'] });
            const name = avatar.linkedScapeDisplayName ?? 'your scape account';
            addToast('🔗', `Linked to ${name}!`, 4500);
          }
        } catch {
          // Network blips are fine — we'll retry in 3s. A consistent
          // 401/403 surfaces when the Lucia cookie expires; letting the
          // interval keep running is harmless (next request will also
          // fail) and cleaner than a second auth-watch loop here.
        }
      }, 3000);

      // Absolute stop when the code expires — the server has already
      // invalidated it, so polling afterward is wasted work.
      if (expiryRef.current) clearTimeout(expiryRef.current);
      expiryRef.current = setTimeout(() => {
        stopAllTimers();
        setCode(null);
        setExpiresAt(null);
        setError('Link code expired — generate a new one.');
      }, resolvedExpiresAt - Date.now());
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Could not mint a link code';
      setError(msg);
    } finally {
      setGenerating(false);
    }
  }, [addToast, queryClient, stopAllTimers]);

  const handleCopy = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (some iOS / sandboxed contexts). Leave the
      // code visible — user can select-and-copy manually.
    }
  }, [code]);

  const handleCancel = useCallback(() => {
    stopAllTimers();
    setCode(null);
    setExpiresAt(null);
    setError(null);
    setCopied(false);
  }, [stopAllTimers]);

  const timeRemainingLabel = useMemo(() => {
    if (!expiresAt) return null;
    const msLeft = Math.max(0, expiresAt - now);
    const secs = Math.floor(msLeft / 1000);
    const mm = Math.floor(secs / 60);
    const ss = secs % 60;
    return `${mm}:${ss.toString().padStart(2, '0')}`;
  }, [expiresAt, now]);

  return (
    <div className="space-y-2">
      <h3 className="font-bold text-sm text-white">Cross-world accounts</h3>
      <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-2">
        <p className="text-sm font-bold text-white">
          Have an existing &apos;scape account?
        </p>
        <p className="text-xs text-white/70">
          Link it so portal crossings land on your original character instead
          of a new one.
        </p>

        {!code ? (
          <>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="w-full px-3 py-2 rounded-lg bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-400 hover:to-cyan-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-progress"
            >
              {generating ? 'Generating…' : 'Generate link code'}
            </button>
            {error && (
              <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <label className="block text-white/50 text-[10px] font-mono uppercase tracking-wider">
              Your link code
            </label>
            <div className="flex gap-1">
              <div className="flex-1 bg-black/30 border border-teal-400/30 rounded-lg px-3 py-2 text-sm text-teal-200 font-mono break-all select-all">
                {code}
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-2 rounded-lg bg-teal-500/20 hover:bg-teal-500/30 text-teal-200 text-xs font-bold shrink-0"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-white/60 leading-relaxed">
              In &apos;scape: Settings → Link External Account → paste this code.
              Expires in{' '}
              <span className="font-mono text-teal-200">{timeRemainingLabel ?? '10:00'}</span>.
            </p>
            <div className="flex items-center gap-2 px-3 py-2 bg-teal-500/10 border border-teal-400/25 rounded-lg">
              <span
                aria-hidden
                className="w-2 h-2 rounded-full bg-teal-300 animate-pulse"
              />
              <span className="text-teal-200 text-xs font-bold">
                Waiting for &apos;scape…
              </span>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              className="w-full text-white/40 text-[11px] hover:text-white/70 underline"
            >
              Cancel and discard code
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
