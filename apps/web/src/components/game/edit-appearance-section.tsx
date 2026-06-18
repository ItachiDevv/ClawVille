'use client';

/**
 * EditAppearanceSection — in-game Layer 1 edit panel for avatar-settings-modal.
 *
 * Lets the user swap avatar (modelKey), re-tint color (GLB only — VRM
 * MToon materials preserve their native colorway), and switch gender.
 * Calls `PATCH /api/avatars/me/appearance` via `useEditAvatarAppearance`.
 *
 * Harness is NOT editable here — swapping Milady↔non-Milady would cross
 * the hosting contract. The avatar grid is pre-filtered to the current
 * harness's pool so the user can't even pick a cross-pool avatar.
 */

import { useMemo, useState, useCallback, useEffect } from 'react';
import { DEFAULT_AGENT_MODEL_KEY } from '@clawville/shared';
import {
  MODEL_REGISTRY,
  PICKER_COLORS,
  type ModelKey,
  type PickerColorId,
} from '@/lib/three/agent-model-registry';
import { useEditAvatarAppearance } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';

interface EditAppearanceSectionProps {
  avatar: {
    id: string;
    modelKey: string | null | undefined;
    color: string | null | undefined;
    gender: string | null | undefined;
    harness: string | null | undefined;
  };
}

export function EditAppearanceSection({ avatar }: EditAppearanceSectionProps) {
  const editMutation = useEditAvatarAppearance();
  const addToast = useGameStore((s) => s.addToast);

  const currentModelKey = (avatar.modelKey ?? DEFAULT_AGENT_MODEL_KEY) as ModelKey;
  const currentColor = (avatar.color ?? 'green') as PickerColorId;
  const currentGender = (avatar.gender ?? 'male') as 'male' | 'female';

  // Audit fix — `avatar.harness` is the server's source of truth for the
  // pool, but a legacy row with a NULL harness or one that contradicts
  // its modelKey (edge case before Phase 4d locked them together) would
  // leave the user staring at an empty or wrong grid. Fall back to the
  // current modelKey's category when harness is missing, so the pool
  // always contains the user's current avatar.
  const currentModelCategory = MODEL_REGISTRY[currentModelKey]?.category;
  const currentIsMilady = avatar.harness
    ? avatar.harness === 'milady'
    : currentModelCategory === 'milady';

  // Draft state (only diffs vs. current avatar get sent).
  const [draftModelKey, setDraftModelKey] = useState<ModelKey>(currentModelKey);
  const [draftColor, setDraftColor] = useState<PickerColorId>(currentColor);
  const [draftGender, setDraftGender] = useState<'male' | 'female'>(currentGender);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audit fix — sync drafts when the avatar prop changes (after a successful
  // save invalidates the react-query cache, or after a cross-tab edit).
  // Without this the `dirty` check below would stay true against stale
  // "current*" values and re-saving could POST outdated fields.
  useEffect(() => {
    setDraftModelKey(currentModelKey);
    setDraftColor(currentColor);
    setDraftGender(currentGender);
  }, [currentModelKey, currentColor, currentGender]);

  // Filter the avatar pool by harness. Milady → only VRMs; non-Milady →
  // only GLBs. Mirrors the server-side guard in PATCH /me/appearance.
  const pool = useMemo(() => {
    const all = Object.entries(MODEL_REGISTRY) as [ModelKey, typeof MODEL_REGISTRY[ModelKey]][];
    return all.filter(([, e]) =>
      // pickerHidden models (Hatcher-reserved avatars) are server-assigned only —
      // never human-selectable. Mirrors the server guards in POST / and
      // PATCH /me/appearance (avatars.ts). Without this, hatcher-category VRMs
      // leaked into the non-Milady appearance grid.
      !e.pickerHidden &&
      (currentIsMilady ? e.category === 'milady' : e.category !== 'milady'),
    );
  }, [currentIsMilady]);

  const draftEntry = MODEL_REGISTRY[draftModelKey];
  const draftIsVRM = draftEntry?.avatar_type === 'vrm';

  const dirty =
    draftModelKey !== currentModelKey ||
    draftColor !== currentColor ||
    draftGender !== currentGender;

  const handleSave = useCallback(async () => {
    setError(null);
    // Only send fields the user actually changed. Color isn't sent if the
    // new pick is a VRM (server ignores it but saves a pointless write).
    const patch: { modelKey?: string; color?: PickerColorId; gender?: 'male' | 'female' } = {};
    if (draftModelKey !== currentModelKey) patch.modelKey = draftModelKey;
    if (!draftIsVRM && draftColor !== currentColor) patch.color = draftColor;
    if (draftGender !== currentGender) patch.gender = draftGender;

    if (Object.keys(patch).length === 0) return;

    try {
      await editMutation.mutateAsync(patch);
      addToast('✨', 'Appearance updated', 2500);
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  }, [
    draftModelKey,
    currentModelKey,
    draftIsVRM,
    draftColor,
    currentColor,
    draftGender,
    currentGender,
    editMutation,
    addToast,
  ]);

  const handleReset = useCallback(() => {
    setDraftModelKey(currentModelKey);
    setDraftColor(currentColor);
    setDraftGender(currentGender);
    setError(null);
  }, [currentModelKey, currentColor, currentGender]);

  // Collapsed chevron tab.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg bg-cyan-500/10 border border-cyan-400/25 hover:bg-cyan-500/20 hover:border-cyan-300/50 transition-all text-left group"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/70">
            § edit
          </span>
          <span className="text-sm font-bold text-cyan-100">Appearance</span>
        </div>
        <span className="font-mono text-[11px] text-cyan-300/70 group-hover:text-cyan-200">
          avatar · color · gender  ▸
        </span>
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-400/40 bg-cyan-500/5 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-clawville text-sm uppercase tracking-[0.2em] text-cyan-100">
          Edit Appearance
        </h3>
        <button
          type="button"
          onClick={() => { handleReset(); setExpanded(false); }}
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40 hover:text-white/80"
        >
          ✕ close
        </button>
      </div>

      {/* Avatar grid */}
      <div className="space-y-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/55">
          Avatar{' '}
          <span className="text-white/30">
            ({currentIsMilady ? 'Milady pool' : 'Self-hosted pool'} · {pool.length})
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {pool.map(([key, entry]) => {
            const selected = draftModelKey === key;
            const isCurrent = currentModelKey === key;
            const isVRM = entry.avatar_type === 'vrm';
            return (
              <button
                key={key}
                type="button"
                onClick={() => setDraftModelKey(key)}
                title={entry.label}
                className={`relative aspect-square rounded-md border transition-all overflow-hidden ${
                  selected
                    ? (isVRM
                        ? 'border-pink-400/80 shadow-[0_0_10px_rgba(255,130,200,0.4)] scale-[1.03]'
                        : 'border-cyan-400/80 shadow-[0_0_10px_rgba(0,229,255,0.4)] scale-[1.03]')
                    : 'border-white/10 hover:border-white/40'
                }`}
              >
                {isVRM && entry.preview ? (
                  <img
                    src={entry.preview}
                    alt={entry.label}
                    className="absolute inset-0 w-full h-full object-cover object-top"
                    loading="lazy"
                  />
                ) : (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-2xl">
                    {({
                      lobster: '🦞',
                      sweet_crab: '🦀',
                      lobster_plush: '🧸',
                      hermitcrab: '🐚',
                      jellyfish: '🪼',
                      octopus: '🐙',
                      seahorse: '🐉',
                    } as Record<string, string>)[key] ?? '◈'}
                  </div>
                )}
                {isCurrent && (
                  <div className="absolute top-0.5 left-0.5 bg-emerald-500/80 text-white font-mono text-[7px] uppercase tracking-wider px-1 rounded">
                    live
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-white/40 font-mono">
          {currentIsMilady ? 'Only Milady avatars shown — hosting contract' : 'Pick any sea creature'}
        </p>
      </div>

      {/* Color palette */}
      <div className="space-y-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/55">
          Color Tint{' '}
          {draftIsVRM && (
            <span className="text-pink-300/60">— MToon preserves native tint (no-op for VRM)</span>
          )}
        </div>
        <div className={`flex gap-1.5 ${draftIsVRM ? 'opacity-40 pointer-events-none' : ''}`}>
          {PICKER_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setDraftColor(c.id)}
              disabled={draftIsVRM}
              className={`flex-1 h-7 rounded font-mono text-[9px] font-bold uppercase tracking-wider transition-all border ${
                draftColor === c.id
                  ? 'border-white/80 shadow-[0_0_6px_rgba(255,255,255,0.3)] scale-[1.05]'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}
              style={{ backgroundColor: c.bg, color: '#0a0a10' }}
            >
              {draftColor === c.id ? c.label : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Gender */}
      <div className="space-y-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/55">
          Gender
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {(['male', 'female'] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setDraftGender(g)}
              className={`py-2 rounded-md font-mono text-[11px] uppercase tracking-wider border transition-all ${
                draftGender === g
                  ? 'border-cyan-400/70 bg-cyan-500/15 text-cyan-100'
                  : 'border-white/10 bg-white/[0.02] text-white/60 hover:border-white/30'
              }`}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </p>
      )}

      {/* Save / reset */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || editMutation.isPending}
          className="flex-1 py-2 rounded-md font-mono text-[10px] uppercase tracking-wider bg-white/[0.03] border border-white/10 text-white/50 hover:text-white/80 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || editMutation.isPending}
          className="flex-[2] py-2 rounded-md font-clawville text-xs uppercase tracking-[0.2em] text-white bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 shadow-[0_0_12px_rgba(0,229,255,0.2)] disabled:from-white/10 disabled:to-white/10 disabled:text-white/25 disabled:cursor-not-allowed disabled:shadow-none transition-all"
        >
          {editMutation.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
