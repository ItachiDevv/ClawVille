'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LandTier } from '@clawville/shared';
import { RpgButton } from '@/components/rpg';
import { useGameStore } from '@/stores/game';
import { useLandStore } from '@/stores/land';
import { api, ApiError } from '@/lib/api';
import { requestLandStructuresRefresh } from '@/lib/land-query-keys';
import {
  getPaletteAppearanceOptions,
  getShellAppearanceOptions,
  type ShellAppearanceOption,
} from '@/lib/land-appearance-options';
import type { LandStructureDTO } from './types';

const SHELL_THUMBNAILS: Record<string, readonly [string, string]> = {
  'coastal-cottage': ['#67b7c7', '#f4e7ce'],
  'driftwood-cabin': ['#a97852', '#d6c0a3'],
  'fantasy-cottage': ['#8874b8', '#9ed3bd'],
  'premium-tower': ['#4b7ea8', '#e7cf82'],
  'premium-mall': ['#3f8e98', '#f0bb70'],
};

function apiErrorCode(error: unknown): { code?: string; status?: number } {
  if (!(error instanceof ApiError)) return {};
  return { code: error.code ?? error.message, status: error.status };
}

function appearanceErrorMessage(error: unknown): string {
  const { code, status } = apiErrorCode(error);
  switch (code) {
    case 'shell_not_allowed':
      return 'That shell is still locked for this structure.';
    case 'palette_not_allowed':
      return 'Those colors are still locked for this structure.';
    case 'not_structure_owner':
      return 'You do not own this structure.';
    case 'structure_archived':
      return 'That structure is no longer active.';
    case 'structure_not_found':
      return 'That structure no longer exists. Reopen the panel.';
    case 'invalid_body':
    case 'invalid_structure_id':
      return 'Could not apply that appearance. Reopen the panel and try again.';
    default:
      if (status === 401) return 'Log in to change this appearance.';
      return 'Could not update the appearance. Try again.';
  }
}

function shellLockCopy(option: ShellAppearanceOption): string[] {
  const copy: string[] = [];
  if (option.levelLocked) copy.push(`Unlocks at Lv ${option.entry.minLevel}`);
  if (option.tierLocked) copy.push('Founder tier');
  return copy;
}

export function StructureAppearancePicker({
  structure,
  parcelCode,
  parcelTier,
  isMobile,
  onStructureChange,
  onChanged,
}: {
  structure: LandStructureDTO;
  parcelCode: string;
  parcelTier: LandTier;
  isMobile: boolean;
  onStructureChange: (structure: LandStructureDTO) => void;
  onChanged: () => void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const updateStoreAppearance = useLandStore((state) => state.updateStructureAppearance);
  const [shellKey, setShellKey] = useState(structure.shellKey);
  const [paletteKey, setPaletteKey] = useState(structure.paletteKey);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    setShellKey(structure.shellKey);
    setPaletteKey(structure.paletteKey);
  }, [structure.id, structure.shellKey, structure.paletteKey]);

  const shellOptions = useMemo(
    () => getShellAppearanceOptions(structure.structureType, structure.level, parcelTier),
    [parcelTier, structure.level, structure.structureType],
  );
  const paletteOptions = useMemo(() => getPaletteAppearanceOptions(structure.level), [structure.level]);
  const selectedPalette = paletteOptions.find((option) => option.entry.key === paletteKey);
  const previewSwatches = selectedPalette?.entry.swatches ?? ['#67b7c7', '#f4e7ce', '#e9826b'];
  const hasChanges = shellKey !== structure.shellKey || paletteKey !== structure.paletteKey;

  const handleApply = async () => {
    if (!hasChanges || applying) return;

    const previousStructure = structure;
    const previousRendered = useLandStore.getState().structures.get(parcelCode);
    const optimisticStructure = { ...structure, shellKey, paletteKey };

    setApplying(true);
    onStructureChange(optimisticStructure);
    updateStoreAppearance(parcelCode, { shellKey, paletteKey });

    try {
      const response = await api.updateStructureAppearance(structure.id, {
        shellKey,
        paletteKey,
      });
      onStructureChange(response.structure);
      updateStoreAppearance(parcelCode, {
        shellKey: response.structure.shellKey,
        paletteKey: response.structure.paletteKey,
      });
      requestLandStructuresRefresh();
      onChanged();
      addToast('🎨', 'Appearance updated.');
    } catch (error) {
      onStructureChange(previousStructure);
      setShellKey(previousStructure.shellKey);
      setPaletteKey(previousStructure.paletteKey);
      if (previousRendered) {
        updateStoreAppearance(parcelCode, {
          shellKey: previousRendered.shellKey,
          paletteKey: previousRendered.paletteKey,
        });
      }
      addToast('⚠️', appearanceErrorMessage(error), 4500);
    } finally {
      setApplying(false);
    }
  };

  return (
    <section
      className="mt-4 rounded-xl border border-cyan-400/20 bg-[#08172a]/80 p-3"
      aria-labelledby="structure-appearance-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 id="structure-appearance-title" className="font-clawville text-sm text-cyan-50">
            Appearance
          </h4>
          <p className="mt-0.5 text-[11px] text-slate-300">Pick a shell and colors for your structure.</p>
        </div>
        <div className="flex overflow-hidden rounded-full border border-cyan-300/25" aria-hidden>
          {previewSwatches.map((color) => (
            <span key={color} className="h-6 w-7" style={{ backgroundColor: color }} />
          ))}
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <h5 className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200">Shell</h5>
          <span className="text-[10px] text-slate-400">Swipe to see every option</span>
        </div>
        <div className="flex snap-x gap-2 overflow-x-auto pb-2">
          {shellOptions.map((option) => {
            const current = option.entry.key === structure.shellKey;
            const selected = option.entry.key === shellKey;
            const lockCopy = shellLockCopy(option);
            const thumbnail = SHELL_THUMBNAILS[option.entry.key] ?? ['#4b7ea8', '#cbd5e1'];
            return (
              <button
                key={option.entry.key}
                type="button"
                disabled={option.locked || applying}
                aria-pressed={selected}
                aria-label={`${option.entry.label}${lockCopy.length ? `. ${lockCopy.join('. ')}` : ''}`}
                onClick={() => setShellKey(option.entry.key)}
                className="relative min-h-[92px] shrink-0 snap-start rounded-lg border p-2 text-left transition-colors disabled:cursor-not-allowed"
                style={{
                  width: isMobile ? 142 : 158,
                  borderColor: selected ? '#67e8f9' : 'rgba(103, 232, 249, 0.2)',
                  background: selected ? 'rgba(8, 145, 178, 0.18)' : 'rgba(14, 116, 144, 0.07)',
                  opacity: option.locked ? 0.68 : 1,
                }}
              >
                <span
                  className="mb-2 flex h-10 items-center justify-center rounded-md border border-white/10 text-xl"
                  style={{
                    background: `linear-gradient(135deg, ${thumbnail[0]}, ${thumbnail[1]})`,
                  }}
                  aria-hidden
                >
                  {structure.structureType === 'home' ? '🏠' : '🏪'}
                </span>
                <span className="block pr-1 text-[11px] font-semibold leading-tight text-cyan-50">
                  {option.entry.label}
                </span>
                {current && (
                  <span className="mt-1 block font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-emerald-200">
                    Current
                  </span>
                )}
                {option.locked && (
                  <span className="mt-1 block text-[9px] leading-tight text-amber-200">🔒 {lockCopy.join(' · ')}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2">
        <h5 className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200">Colors</h5>
        <div className="flex snap-x gap-2 overflow-x-auto pb-2">
          {paletteOptions.map((option) => {
            const current = option.entry.key === structure.paletteKey;
            const selected = option.entry.key === paletteKey;
            const lockCopy = `Unlocks at Lv ${option.entry.minLevel}`;
            return (
              <button
                key={option.entry.key}
                type="button"
                disabled={option.locked || applying}
                aria-pressed={selected}
                aria-label={`${option.entry.label}${option.locked ? `. ${lockCopy}` : ''}`}
                onClick={() => setPaletteKey(option.entry.key)}
                className="min-h-[72px] shrink-0 snap-start rounded-lg border p-2 text-left transition-colors disabled:cursor-not-allowed"
                style={{
                  width: isMobile ? 132 : 144,
                  borderColor: selected ? '#67e8f9' : 'rgba(103, 232, 249, 0.2)',
                  background: selected ? 'rgba(8, 145, 178, 0.18)' : 'rgba(14, 116, 144, 0.07)',
                  opacity: option.locked ? 0.68 : 1,
                }}
              >
                <span className="mb-2 flex overflow-hidden rounded-md border border-white/10" aria-hidden>
                  {option.entry.swatches.map((color) => (
                    <span key={color} className="h-5 flex-1" style={{ backgroundColor: color }} />
                  ))}
                </span>
                <span className="block text-[10px] font-semibold leading-tight text-cyan-50">{option.entry.label}</span>
                {current && (
                  <span className="mt-1 block font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-emerald-200">
                    Current
                  </span>
                )}
                {option.locked && (
                  <span className="mt-1 block text-[9px] leading-tight text-amber-200">🔒 {lockCopy}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex justify-end">
        <RpgButton
          size="sm"
          variant="primary"
          className="min-h-[44px]"
          disabled={!hasChanges}
          loading={applying}
          onClick={handleApply}
        >
          Apply appearance
        </RpgButton>
      </div>
    </section>
  );
}
