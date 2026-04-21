'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCheckPetName } from '@/hooks/use-avatar';
import {
  MODEL_REGISTRY,
  PICKER_COLORS,
  HARNESS_OPTIONS,
  MODEL_KEY_TO_LEGACY_SPECIES,
  type AgentCategory,
  type PickerColorId,
  type HarnessId,
  type ModelKey,
  type LegacySpecies,
} from '@/lib/three/agent-model-registry';

// ── Enum validation sets (audit Fix D) ──────────────────────────────────────
const VALID_COLOR_IDS: ReadonlySet<string> = new Set(PICKER_COLORS.map((c) => c.id));
const VALID_HARNESS_IDS: ReadonlySet<string> = new Set(HARNESS_OPTIONS.map((h) => h.id));

// Lazy-load the Canvas
const SelectAgentCanvas = dynamic(
  () => import('@/components/three/SelectAgentCanvas'),
  { ssr: false }
);

// Shape of the sessionStorage payload that bridges step 1 → step 2 → POST /api/avatars.
interface CreatePetStep1 {
  species: LegacySpecies;
  modelKey: ModelKey;
  category: AgentCategory;
  color: PickerColorId;
  name: string;
  gender: 'male' | 'female';
  harness: HarnessId;
  thumb: string;
}

function readSessionStep1(): Partial<CreatePetStep1> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem('createPetStep1');
    if (!raw) return null;
    return JSON.parse(raw) as Partial<CreatePetStep1>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-GLB fallback sea-creature styling (no preview PNGs shipped for these).
// Rather than inventing fake thumbnails, each GLB card gets a colored glyph on
// a tinted backdrop so the grid feels curated instead of a generic text list.
// ---------------------------------------------------------------------------
const GLB_STYLE: Record<string, { glyph: string; tint: string; from: string; to: string }> = {
  lobster:       { glyph: '🦞', tint: '#ff8566', from: 'rgba(255,80,60,0.18)',  to: 'rgba(255,160,120,0.04)' },
  sweet_crab:    { glyph: '🦀', tint: '#ffb04a', from: 'rgba(255,140,50,0.18)', to: 'rgba(255,200,120,0.04)' },
  lobster_plush: { glyph: '🧸', tint: '#ff9eb1', from: 'rgba(255,120,160,0.18)',to: 'rgba(255,180,200,0.04)' },
  hermitcrab:    { glyph: '🐚', tint: '#d5c1a0', from: 'rgba(200,160,100,0.18)',to: 'rgba(240,220,180,0.04)' },
  jellyfish:     { glyph: '🪼', tint: '#b589ff', from: 'rgba(140,90,220,0.18)', to: 'rgba(200,170,255,0.04)' },
  octopus:       { glyph: '🐙', tint: '#ff6fae', from: 'rgba(255,100,170,0.18)',to: 'rgba(255,180,220,0.04)' },
  seahorse:      { glyph: '🐉', tint: '#6fd8ff', from: 'rgba(80,190,255,0.18)', to: 'rgba(160,220,255,0.04)' },
};

// Romanised pseudo-kana tag per model — a decorative wink, not translated text.
// Kept short so it fits the card corner. Milady gets stylized "m°N" badges.
const MODEL_TAG: Record<string, string> = {
  lobster:        '甲殻',
  sweet_crab:     '蟹',
  lobster_plush:  'ぬい',
  hermitcrab:     '宿借',
  jellyfish:      '水母',
  octopus:        '章魚',
  seahorse:       '海馬',
};

export default function CreateAgentPage() {
  const router = useRouter();
  const checkNameMutation = useCheckPetName();

  const [selectedModel, setSelectedModel] = useState<ModelKey>(() => {
    const s = readSessionStep1();
    if (s?.modelKey && s.modelKey in MODEL_REGISTRY) return s.modelKey as ModelKey;
    return 'lobster';
  });
  const [selectedColor, setSelectedColor] = useState<PickerColorId>(() => {
    const s = readSessionStep1();
    if (s?.color && VALID_COLOR_IDS.has(s.color)) return s.color as PickerColorId;
    return 'green';
  });
  const [selectedHarness, setSelectedHarness] = useState<HarnessId>(() => {
    const s = readSessionStep1();
    if (s?.harness && VALID_HARNESS_IDS.has(s.harness)) return s.harness as HarnessId;
    return 'milady';
  });

  const [agentName, setAgentName] = useState<string>(() => readSessionStep1()?.name ?? '');
  const [gender, setGender] = useState<'male' | 'female'>(() => {
    const s = readSessionStep1();
    return s?.gender === 'female' ? 'female' : 'male';
  });
  const [nameStatus, setNameStatus] = useState<{
    available: boolean;
    reason?: string;
  } | null>(null);

  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => () => { submittingRef.current = false; }, []);

  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const handleCanvasReady = useCallback((canvas: HTMLCanvasElement) => {
    canvasElRef.current = canvas;
  }, []);

  // Derived: current model + grouped registry
  const selectedCategory: AgentCategory =
    MODEL_REGISTRY[selectedModel]?.category ?? 'openclaw';
  const selectedEntry = MODEL_REGISTRY[selectedModel];
  const selectedIsVRM = selectedEntry?.avatar_type === 'vrm';

  const modelsByCategory = useMemo(() => {
    const all = Object.entries(MODEL_REGISTRY);
    return {
      openclaw: all.filter(([, e]) => e.category === 'openclaw'),
      other:    all.filter(([, e]) => e.category === 'other'),
      milady:   all.filter(([, e]) => e.category === 'milady'),
    };
  }, []);

  // Name availability debounce
  useEffect(() => {
    if (!agentName || agentName.length < 3) {
      setNameStatus(null);
      return;
    }
    let cancelled = false;
    const nameForRequest = agentName;
    const timer = setTimeout(() => {
      if (cancelled) return;
      checkNameMutation.mutate(nameForRequest, {
        onSuccess: (data) => { if (!cancelled) setNameStatus(data); },
        onError:   ()     => { if (!cancelled) setNameStatus(null); },
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  const captureThumbnail = (): Promise<string> => {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const tryCapture = (): string => {
        const canvasEl = canvasElRef.current;
        if (!canvasEl) return '';
        try {
          const data = canvasEl.toDataURL('image/jpeg', 0.8);
          if (data === 'data:,' || data.length < 200) return '';
          return data;
        } catch {
          return '';
        }
      };
      const poll = () => {
        const data = tryCapture();
        if (data) { resolve(data); return; }
        if (performance.now() - startedAt > 1000) { resolve(''); return; }
        requestAnimationFrame(poll);
      };
      poll();
    });
  };

  const handleNext = useCallback(async () => {
    if (submittingRef.current) return;
    if (!agentName || agentName.length < 3) return;
    if (nameStatus?.available !== true) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const thumb = await captureThumbnail();
      const legacySpecies = MODEL_KEY_TO_LEGACY_SPECIES[selectedModel];

      const payload: CreatePetStep1 = {
        species: legacySpecies,
        modelKey: selectedModel,
        category: selectedCategory,
        color: selectedColor,
        name: agentName,
        gender,
        harness: selectedHarness,
        thumb,
      };

      sessionStorage.setItem('createPetStep1', JSON.stringify(payload));
      router.push('/create-agent/personality');
    } finally {
      setIsSubmitting(false);
    }
  }, [agentName, nameStatus, selectedModel, selectedCategory, selectedColor, gender, selectedHarness, router]);

  // Card renderer — one branch for VRM (thumbnail), one for GLB (glyph)
  const renderCard = (key: string, entry: typeof MODEL_REGISTRY[ModelKey], index: number) => {
    const isSelected = selectedModel === key;
    const isVRM = entry.avatar_type === 'vrm';
    const glbStyle = GLB_STYLE[key];
    const tag = MODEL_TAG[key];
    const numLabel = `N°${String(index + 1).padStart(2, '0')}`;

    return (
      <button
        key={key}
        onClick={() => setSelectedModel(key as ModelKey)}
        className={`group relative aspect-[3/4] rounded-xl overflow-hidden border-2 transition-all duration-200 ${
          isSelected
            ? (isVRM
                ? 'border-pink-400/80 shadow-[0_0_18px_rgba(255,130,200,0.45),inset_0_0_30px_rgba(255,130,200,0.12)] scale-[1.02]'
                : 'border-cyan-400/80 shadow-[0_0_18px_rgba(0,229,255,0.45),inset_0_0_30px_rgba(0,229,255,0.12)] scale-[1.02]')
            : 'border-white/8 hover:border-white/30 hover:scale-[1.01]'
        }`}
      >
        {/* Card background */}
        {isVRM ? (
          <>
            {/* VRM preview PNG */}
            <img
              src={entry.preview}
              alt={entry.label}
              className="absolute inset-0 w-full h-full object-cover object-top"
              loading="lazy"
            />
            {/* Pink halftone overlay */}
            <div
              className="absolute inset-0 mix-blend-overlay opacity-60 pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(circle at 30% 20%, rgba(255,130,200,0.35), transparent 60%), radial-gradient(circle at 80% 80%, rgba(0,229,255,0.22), transparent 55%)`,
              }}
            />
            {/* Scanline hairlines */}
            <div
              className="absolute inset-0 opacity-25 pointer-events-none mix-blend-soft-light"
              style={{ backgroundImage: `repeating-linear-gradient(0deg, rgba(255,255,255,0.22) 0px, rgba(255,255,255,0.22) 1px, transparent 1px, transparent 4px)` }}
            />
          </>
        ) : (
          <>
            {/* GLB glyph backdrop */}
            <div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(circle at 50% 38%, ${glbStyle?.from ?? 'rgba(0,229,255,0.14)'}, ${glbStyle?.to ?? 'rgba(0,0,0,0.8)'} 65%, #051220 95%)`,
              }}
            />
            {/* Large glyph */}
            <div className="absolute inset-0 flex items-center justify-center text-[58px] leading-none select-none grayscale-[0.25] group-hover:grayscale-0 transition-all">
              <span style={{ filter: `drop-shadow(0 0 18px ${glbStyle?.tint ?? '#00e5ff'})` }}>
                {glbStyle?.glyph ?? '◈'}
              </span>
            </div>
            {/* Grid overlay */}
            <div
              className="absolute inset-0 opacity-30 pointer-events-none"
              style={{
                backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)`,
                backgroundSize: `16px 16px`,
              }}
            />
          </>
        )}

        {/* Corner bracket decorations — always visible, brighten on select */}
        <div className={`pointer-events-none absolute top-1 left-1 w-2.5 h-2.5 border-t border-l ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />
        <div className={`pointer-events-none absolute top-1 right-1 w-2.5 h-2.5 border-t border-r ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />
        <div className={`pointer-events-none absolute bottom-1 left-1 w-2.5 h-2.5 border-b border-l ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />
        <div className={`pointer-events-none absolute bottom-1 right-1 w-2.5 h-2.5 border-b border-r ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />

        {/* Top-right numeric label */}
        <div className="absolute top-1.5 right-2 font-mono text-[9px] tracking-wider text-white/45">
          {numLabel}
        </div>

        {/* Top-left kana/tag — only for GLBs that have one; VRMs get category pill */}
        {tag && (
          <div className="absolute top-1.5 left-2 font-mono text-[9px] tracking-wider text-white/55" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
            {tag}
          </div>
        )}
        {isVRM && (
          <div className="absolute top-1.5 left-2 font-mono text-[8px] tracking-[0.15em] text-pink-200/90 uppercase bg-pink-500/20 backdrop-blur-sm px-1.5 py-0.5 rounded-full border border-pink-300/30">
            Milady
          </div>
        )}

        {/* Bottom label band */}
        <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/85 via-black/70 to-transparent">
          <div className={`font-clawville text-[10px] leading-tight uppercase tracking-wide text-center ${
            isSelected ? (isVRM ? 'text-pink-200' : 'text-cyan-200') : 'text-white/85'
          }`}>
            {entry.label}
          </div>
        </div>

        {/* Chromatic aberration ghost on selected VRM */}
        {isSelected && isVRM && (
          <div
            className="pointer-events-none absolute inset-0 mix-blend-screen opacity-30"
            style={{
              background: 'linear-gradient(45deg, rgba(255,120,200,0.25) 0%, transparent 40%, transparent 60%, rgba(120,220,255,0.22) 100%)',
            }}
          />
        )}
      </button>
    );
  };

  // Model index tracker for stable N° numbering across all categories
  let globalIdx = 0;

  return (
    <div className="relative min-h-screen px-4 py-8 bg-[#050d17] overflow-x-hidden">
      {/* Ambient page-level atmosphere — consistent cyan, matches the in-game
          underwater world. Previously shifted hue with avatar_type; removed
          because it misrepresented the actual gameplay backdrop. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 20% 80%, rgba(0,220,255,0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(0,140,220,0.06) 0%, transparent 55%)',
        }}
      />

      {/* Subtle noise/grain overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      <div className="relative max-w-6xl mx-auto">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center mb-8">
          <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-white/35 mb-2">
            ClawVille <span className="text-white/15">//</span> Agent Forge
          </div>
          <h1 className="font-clawville text-3xl md:text-4xl text-white drop-shadow-[0_0_20px_rgba(0,229,255,0.25)] tracking-widest">
            CAST YOUR AGENT
          </h1>
          <div className="mt-3 flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-white/40">
            <span className={selectedCategory === 'openclaw' ? 'text-cyan-300' : ''}>
              OpenClaw · {modelsByCategory.openclaw.length}
            </span>
            <span className="text-white/15">//</span>
            <span className={selectedCategory === 'other' ? 'text-cyan-300' : ''}>
              Other · {modelsByCategory.other.length}
            </span>
            <span className="text-white/15">//</span>
            <span className={selectedCategory === 'milady' ? 'text-pink-300' : ''}>
              Milady · {modelsByCategory.milady.length}
            </span>
          </div>
        </div>

        {/* ── Two-pane: picker (left) + shrine (right) ──────────────────── */}
        <div className="grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-6 mb-6">

          {/* ─── Left pane: picker grid ─── */}
          <div className="space-y-5">
            {/* OpenClaw */}
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300/80">⟐ OpenClaw</div>
                <div className="font-mono text-[9px] text-white/30">crustacean caste</div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {modelsByCategory.openclaw.map(([key, entry]) => renderCard(key, entry, globalIdx++))}
              </div>
            </div>

            {/* Other sea creatures */}
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-300/80">⟐ Other</div>
                <div className="font-mono text-[9px] text-white/30">reef dwellers</div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {modelsByCategory.other.map(([key, entry]) => renderCard(key, entry, globalIdx++))}
              </div>
            </div>

            {/* Milady VRMs — visually lifted with pink accent heading */}
            <div className="relative">
              <div className="flex items-baseline justify-between mb-2">
                <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-pink-300/90">♡ Milady</div>
                <div className="font-mono text-[9px] text-pink-200/40">neo-chibi VRM</div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {modelsByCategory.milady.map(([key, entry]) => renderCard(key, entry, globalIdx++))}
              </div>
            </div>
          </div>

          {/* ─── Right pane: shrine preview ─── */}
          {/* One unified shrine background for all avatars — the picker shows
              what the player will see in-game (underwater cyan), not a
              category-specific theme. Milady branding lives on the picker
              cards + the selected-state outline, NOT in the world backdrop. */}
          <div className="flex flex-col min-w-0">
            <div className="relative flex-1 min-h-[420px] lg:min-h-[560px] rounded-2xl overflow-hidden border border-white/8">
              {/* Deep-sea cyan shrine backdrop — matches in-game atmosphere */}
              <div
                className="absolute inset-0"
                style={{
                  background: 'radial-gradient(ellipse at 50% 70%, rgba(0,200,255,0.18) 0%, rgba(5,25,45,0.70) 40%, #030d1a 80%)',
                }}
              />

              {/* Canvas mounted on top of shrine background */}
              <div className="absolute inset-0">
                <SelectAgentCanvas
                  modelKey={selectedModel}
                  color={selectedColor}
                  onCanvasReady={handleCanvasReady}
                />
              </div>

              {/* Shrine corner brackets — cyan base, pink tint only when VRM
                  selected (signals the Milady caste is active, not the world). */}
              <div className={`pointer-events-none absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />
              <div className={`pointer-events-none absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />
              <div className={`pointer-events-none absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />
              <div className={`pointer-events-none absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />

              {/* Top-left diagnostic strip */}
              <div className="pointer-events-none absolute top-4 left-12 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                <div>REC · LIVE</div>
                <div className="text-white/25">{selectedIsVRM ? 'MTOON//VRM' : 'PBR//GLB'}</div>
              </div>

              {/* Bottom-center model name + subtext */}
              <div className="pointer-events-none absolute bottom-6 left-0 right-0 text-center px-6">
                <div className={`font-mono text-[9px] uppercase tracking-[0.35em] mb-1 ${selectedIsVRM ? 'text-pink-300/70' : 'text-cyan-300/70'}`}>
                  {selectedIsVRM ? '— Milady Avatar —' : '— Sea Creature Avatar —'}
                </div>
                <div className={`font-clawville text-xl md:text-2xl tracking-[0.2em] text-cyan-100`} style={{ textShadow: '0 0 12px rgba(0,229,255,0.4)' }}>
                  {selectedEntry?.label ?? selectedModel}
                </div>
              </div>
            </div>

            {/* Color picker bar — transforms when VRM is selected */}
            <div className="mt-3">
              {selectedIsVRM ? (
                <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/30 border border-pink-400/20">
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-pink-200/70">⟡ tint_mode</div>
                    <div className="font-mono text-[10px] text-pink-100/80">MToon · preserved</div>
                  </div>
                  <div className="font-mono text-[9px] text-white/30 uppercase tracking-wider hidden sm:block">
                    vrm-native shading
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-black/30 border border-cyan-400/20">
                  <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-200/70 shrink-0">
                    ⟡ tint
                  </div>
                  <div className="flex gap-2 flex-1">
                    {PICKER_COLORS.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setSelectedColor(c.id)}
                        className={`group relative flex-1 h-8 rounded-md font-mono text-[10px] font-bold uppercase tracking-wider transition-all border ${
                          selectedColor === c.id
                            ? 'border-white/80 shadow-[0_0_10px_rgba(255,255,255,0.25)] scale-[1.03]'
                            : 'border-transparent opacity-70 hover:opacity-100'
                        }`}
                        style={{
                          backgroundColor: c.bg,
                          color: '#0a0a10',
                        }}
                        aria-label={`Tint ${c.label}`}
                      >
                        {selectedColor === c.id ? c.label : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Identity config card ──────────────────────────────────────── */}
        <div className="relative w-full max-w-3xl mx-auto bg-[#08111d]/95 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-[0_0_40px_rgba(0,0,0,0.4)] space-y-5">
          {/* Decorative header strip */}
          <div className="flex items-center justify-between pb-3 border-b border-white/8">
            <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
              § identity
            </div>
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-cyan-300/70">ready</div>
            </div>
          </div>

          {/* Name + Gender row */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <label className="block text-white/45 text-[10px] font-mono uppercase tracking-[0.25em] mb-1.5">
                ⟐ agent_name
              </label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                maxLength={20}
                className="w-full px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-400/60 focus:shadow-[0_0_14px_rgba(0,229,255,0.12)] transition-all font-mono text-sm"
                placeholder="name your agent…"
              />
              {agentName.length >= 3 && nameStatus && (
                <p className={`text-[10px] mt-1.5 font-mono uppercase tracking-wider ${nameStatus.available ? 'text-emerald-400' : 'text-red-400'}`}>
                  {nameStatus.available
                    ? `✓ ${agentName} is available`
                    : `✗ ${nameStatus.reason || 'name taken'}`}
                </p>
              )}
              {agentName.length > 0 && agentName.length < 3 && (
                <p className="text-[10px] mt-1.5 text-white/30 font-mono uppercase tracking-wider">
                  min 3 characters
                </p>
              )}
            </div>

            <div className="sm:w-44">
              <label className="block text-white/45 text-[10px] font-mono uppercase tracking-[0.25em] mb-1.5">
                ⟐ gender
              </label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as 'male' | 'female')}
                className="w-full px-4 py-2.5 rounded-lg bg-white/[0.04] border border-white/10 text-white focus:outline-none focus:border-cyan-400/60 transition-all font-mono text-sm uppercase tracking-wider"
              >
                <option value="male" className="bg-[#0a1628]">MALE</option>
                <option value="female" className="bg-[#0a1628]">FEMALE</option>
              </select>
            </div>
          </div>

          {/* Harness */}
          <div>
            <label className="block text-white/45 text-[10px] font-mono uppercase tracking-[0.25em] mb-2">
              ⟐ harness
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {HARNESS_OPTIONS.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelectedHarness(h.id)}
                  className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
                    selectedHarness === h.id
                      ? (h.id === 'milady'
                          ? 'border-pink-400/60 bg-pink-500/10 shadow-[0_0_10px_rgba(255,130,200,0.15)]'
                          : 'border-cyan-400/60 bg-cyan-500/10 shadow-[0_0_10px_rgba(0,229,255,0.12)]')
                      : 'border-white/8 bg-white/[0.02] hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full border-2 shrink-0 ${
                      selectedHarness === h.id
                        ? (h.id === 'milady' ? 'border-pink-300 bg-pink-300' : 'border-cyan-300 bg-cyan-300')
                        : 'border-white/25 bg-transparent'
                    }`} />
                    <span className={`text-[11px] font-bold tracking-wide uppercase ${
                      selectedHarness === h.id
                        ? (h.id === 'milady' ? 'text-pink-200' : 'text-cyan-200')
                        : 'text-white/65'
                    }`}>
                      {h.label}
                      {h.id === 'milady' && (
                        <span className="ml-1 text-[9px] text-pink-300/80 font-mono">(rec)</span>
                      )}
                    </span>
                  </div>
                  <p className="text-[10px] text-white/35 mt-0.5 ml-5 font-mono">{h.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* CTA — consistent cyan across all avatar types. The button is the
              ClawVille primary action; its color is theme, not brand-selector. */}
          <button
            onClick={handleNext}
            disabled={
              isSubmitting ||
              !agentName ||
              agentName.length < 3 ||
              nameStatus?.available !== true
            }
            className="w-full py-3.5 rounded-lg font-clawville text-sm uppercase tracking-[0.25em] transition-all disabled:opacity-25 disabled:cursor-not-allowed text-white bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
          >
            <span className="inline-flex items-center gap-2">
              <span className="opacity-60">→</span>
              <span>Choose Personality</span>
              <span className="opacity-60">→</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
