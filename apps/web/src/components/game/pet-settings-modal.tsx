'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useGameStore } from '@/stores/game';
import { usePet } from '@/hooks/use-pet';
import { api } from '@/lib/api';
import { PET_SPECIES, PET_COLORS, PET_ARCHETYPES } from '@clawville/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@/components/ui/dialog';

export default function PetSettingsModal() {
  const { settingsModalOpen, setSettingsModalOpen } = useGameStore();
  const { data: pet } = usePet();

  if (!pet) return null;

  const species = PET_SPECIES.find((s) => s.id === pet.species);
  const color = PET_COLORS.find((c) => c.id === pet.color);
  const archetype = PET_ARCHETYPES.find((a) => a.id === pet.archetype);

  return (
    <Dialog open={settingsModalOpen} onOpenChange={setSettingsModalOpen}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl flex items-center gap-2">
                {species?.emoji} {pet.name}
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
          {/* Pet sprite placeholder */}
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
            <InfoCard label="Species" value={species?.name || pet.species} />
            <InfoCard label="Color" value={color?.name || pet.color} />
            <InfoCard
              label="Gender"
              value={pet.gender === 'male' ? 'Male' : 'Female'}
            />
            <InfoCard
              label="Archetype"
              value={archetype?.label || pet.archetype}
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
              <StatBar label="Strength" value={pet.stats?.strength ?? 10} />
              <StatBar label="Defence" value={pet.stats?.defence ?? 10} />
              <StatBar label="Movement" value={pet.stats?.movement ?? 10} />
            </div>
          </div>

          {/* Personality */}
          {pet.personality && (
            <div className="space-y-2">
              <h3 className="font-bold text-sm text-white">Personality</h3>
              <div className="grid grid-cols-3 gap-2">
                <PersonalityItem
                  label="Habitat"
                  value={formatPersonalityValue(pet.personality.habitat)}
                />
                <PersonalityItem
                  label="Hobby"
                  value={formatPersonalityValue(pet.personality.hobby)}
                />
                <PersonalityItem
                  label="Greeting"
                  value={formatPersonalityValue(pet.personality.greeting)}
                />
              </div>
            </div>
          )}

          {/* Phase 5.1 — Cross-world accounts (plan §15) */}
          <CrossWorldAccountsSection
            linkedScapePrincipalId={
              (pet as { linkedScapePrincipalId?: string | null }).linkedScapePrincipalId ?? null
            }
            linkedScapeDisplayName={
              (pet as { linkedScapeDisplayName?: string | null }).linkedScapeDisplayName ?? null
            }
          />
        </div>
      </DialogContent>
    </Dialog>
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
//             monospace copy field + poll /api/pets/me every 3s for up
//             to 10 min. When the backend writes linkedScapePrincipalId
//             (via POST /api/portal/accept-scape-link on the scape side),
//             the polled pet response flips, we invalidate the react-query
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

      // Poll /api/pets/me every 3s — when the linked columns populate we
      // swap into the linked branch via react-query invalidation.
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const { pet } = await api.getMyPet();
          if (pet && pet.linkedScapePrincipalId) {
            stopAllTimers();
            setCode(null);
            setExpiresAt(null);
            // Refresh the cached pet so the settings modal (and anything
            // else consuming usePet()) flips to the linked branch.
            queryClient.setQueryData(['pet'], { pet });
            queryClient.invalidateQueries({ queryKey: ['pet'] });
            const name = pet.linkedScapeDisplayName ?? 'your scape account';
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
