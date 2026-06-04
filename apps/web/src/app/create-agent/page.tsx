'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCheckAvatarName } from '@/hooks/use-avatar';
import {
  MODEL_REGISTRY,
  PICKER_COLORS,
  MODEL_KEY_TO_LEGACY_SPECIES,
  type AgentCategory,
  type PickerColorId,
  type HarnessId,
  type ModelKey,
  type LegacySpecies,
} from '@/lib/three/agent-model-registry';
import { SetupGate } from '@/components/create-agent/setup-gate';

// ── Enum validation sets (audit Fix D) ──────────────────────────────────────
const VALID_COLOR_IDS: ReadonlySet<string> = new Set(PICKER_COLORS.map((c) => c.id));

// Lazy-load the Canvas
const SelectAgentCanvas = dynamic(
  () => import('@/components/three/SelectAgentCanvas'),
  { ssr: false }
);

// ---------------------------------------------------------------------------
// Tab definitions (Phase 4d, 2026-04-23)
// ---------------------------------------------------------------------------
// The top-level tab on /create-agent selects the harness for the avatar. Milady
// is the default and ONLY hosted option — ClawVille's cloud runs the Eliza
// runtime end-to-end. OpenClaw / Hermes / Custom users design the same avatar
// but run the external framework (OpenClaw gateway / Hermes CLI / raw Eliza)
// on their own machine. ClawVille still hosts the Eliza substrate in-game —
// the tab picker is purely about where the FRAMEWORK runs, not the runtime.

type TabId = 'milady' | 'openclaw' | 'hermes' | 'custom';

interface TabMeta {
  id: TabId;
  label: string;
  tagline: string;
  /** Is this tab's harness hosted end-to-end by ClawVille? */
  hosted: boolean;
}

const TABS: TabMeta[] = [
  { id: 'milady',   label: 'Milady AI',  tagline: 'Hosted by ClawVille',     hosted: true  },
  // Hermes: 2026-05-12 — taken off the auto-hosted track so its SetupGate
  // surfaces both options ("Host it for me" + self-host instructions). The
  // runtime layer still treats harness='hermes' the same whichever path
  // the user picks; the gate is purely about exposing the choice up front.
  { id: 'hermes',   label: 'Hermes',     tagline: 'Host or self-host',       hosted: false },
  { id: 'openclaw', label: 'OpenClaw',   tagline: 'You run OpenClaw',        hosted: false },
  { id: 'custom',   label: 'Custom',     tagline: 'Bring your own',          hosted: false },
];

// Avatar pool per tab. Hosted tabs (Milady, Hermes) each show their own VRM
// roster — the cast-your-agent experience is character-driven for those.
// External-runtime tabs (OpenClaw, Custom) share the sea-creature pool since
// they pick a harness, not a character.
const MODELS_BY_TAB: Record<TabId, ModelKey[]> = (() => {
  const allKeys = Object.keys(MODEL_REGISTRY) as ModelKey[];
  const miladyKeys = allKeys.filter((k) => MODEL_REGISTRY[k].category === 'milady');
  const hermesKeys = allKeys.filter((k) => MODEL_REGISTRY[k].category === 'hermes');
  const seaCreatureKeys = allKeys.filter(
    (k) => MODEL_REGISTRY[k].category !== 'milady' && MODEL_REGISTRY[k].category !== 'hermes',
  );
  return {
    milady:   miladyKeys,
    hermes:   hermesKeys,
    openclaw: seaCreatureKeys,
    custom:   seaCreatureKeys,
  };
})();

function mapCategoryToTab(category: AgentCategory | undefined): TabId | null {
  if (category === 'milady') return 'milady';
  if (category === 'hermes') return 'hermes';
  return null;
}

// Shape of the sessionStorage payload that bridges step 1 → step 2 → POST /api/avatars.
interface CreateAvatarStep1 {
  species: LegacySpecies;
  modelKey: ModelKey;
  category: AgentCategory;
  color: PickerColorId;
  name: string;
  gender: 'male' | 'female';
  harness: HarnessId;
  thumb: string;
}

function readSessionStep1(): Partial<CreateAvatarStep1> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem('createAvatarStep1');
    if (!raw) return null;
    return JSON.parse(raw) as Partial<CreateAvatarStep1>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-GLB fallback sea-creature styling (no preview PNGs shipped for these).
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
  const checkNameMutation = useCheckAvatarName();

  // --- Tab + gate state ---------------------------------------------------
  const [selectedTab, setSelectedTab] = useState<TabId>(() => {
    const s = readSessionStep1();
    const fromSession = mapCategoryToTab(s?.category) ?? null;
    if (fromSession) return fromSession;
    // Default to whichever harness matches the persisted value, else Milady.
    if (s?.harness && (TABS as ReadonlyArray<TabMeta>).some((t) => t.id === s.harness)) {
      return s.harness as TabId;
    }
    return 'milady';
  });

  const [hasAgentByTab, setHasAgentByTab] = useState<Record<TabId, boolean | null>>(() => ({
    milady:   true,   // Hosted — picker renders unconditionally
    // Hermes flipped off the auto-hosted track 2026-05-12 (commit 5636bdb).
    // Gate now fires on tab entry so the user picks: Host for me / Run locally /
    // Already running. Hardcoding this to `true` previously skipped the gate
    // entirely.
    hermes:   null,
    openclaw: null,   // External — picker gated until user confirms they run one
    custom:   null,   // External — picker gated until user confirms they run one
  }));

  // --- Avatar / color / identity state -----------------------------------
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
  const [agentName, setAgentName] = useState<string>(() => readSessionStep1()?.name ?? '');
  const [gender, setGender] = useState<'male' | 'female'>(() => {
    const s = readSessionStep1();
    return s?.gender === 'female' ? 'female' : 'male';
  });
  const [nameStatus, setNameStatus] = useState<{ available: boolean; reason?: string } | null>(null);

  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => () => { submittingRef.current = false; }, []);

  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const handleCanvasReady = useCallback((canvas: HTMLCanvasElement) => {
    canvasElRef.current = canvas;
  }, []);

  // --- Derived ------------------------------------------------------------
  const currentTabMeta = TABS.find((t) => t.id === selectedTab)!;
  const harness: HarnessId = selectedTab; // 1:1 with the tab id
  const showGate = !currentTabMeta.hosted && hasAgentByTab[selectedTab] !== true;

  const currentPool = MODELS_BY_TAB[selectedTab];
  const selectedModelInPool = currentPool.includes(selectedModel)
    ? selectedModel
    : currentPool[0];
  const selectedEntry = MODEL_REGISTRY[selectedModelInPool];
  const selectedCategory: AgentCategory = selectedEntry?.category ?? 'openclaw';
  const selectedIsVRM = selectedEntry?.avatar_type === 'vrm';

  // When the tab changes, ensure the selected model is in the new tab's pool.
  useEffect(() => {
    if (!MODELS_BY_TAB[selectedTab].includes(selectedModel)) {
      setSelectedModel(MODELS_BY_TAB[selectedTab][0]);
    }
  }, [selectedTab, selectedModel]);

  // --- Name availability debounce ----------------------------------------
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

  // --- Thumbnail capture --------------------------------------------------
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

  // --- Submit -------------------------------------------------------------
  const handleNext = useCallback(async () => {
    if (submittingRef.current) return;
    if (!agentName || agentName.length < 3) return;
    if (nameStatus?.available !== true) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const thumb = await captureThumbnail();
      const legacySpecies = MODEL_KEY_TO_LEGACY_SPECIES[selectedModelInPool];

      const payload: CreateAvatarStep1 = {
        species: legacySpecies,
        modelKey: selectedModelInPool,
        category: selectedCategory,
        color: selectedColor,
        name: agentName,
        gender,
        harness,
        thumb,
      };

      sessionStorage.setItem('createAvatarStep1', JSON.stringify(payload));
      router.push('/create-agent/personality');
    } finally {
      // Reset BOTH the ref AND the state. The ref was previously only
      // reset in a useEffect unmount cleanup, but Next.js keeps the page
      // component mounted across same-route navigations (including the
      // back-button return from /create-agent/personality), so the ref
      // stayed `true` forever after the first click and every subsequent
      // click no-op'd on the `if (submittingRef.current) return` guard.
      // Caught by end-to-end test 2026-04-23.
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }, [
    agentName,
    nameStatus,
    selectedModelInPool,
    selectedCategory,
    selectedColor,
    gender,
    harness,
    router,
  ]);

  // --- Gate answer handler ------------------------------------------------
  const handleGateAnswer = useCallback(
    // answer === null resets to the choice screen (instructions "← back"), so a
    // user who picked self-host can get back to the "Host it for me" option.
    (answer: boolean | null) => {
      setHasAgentByTab((prev) => ({ ...prev, [selectedTab]: answer }));
    },
    [selectedTab],
  );

  // --- Card renderer (shared across tabs) ---------------------------------
  const renderCard = (key: ModelKey, index: number) => {
    const entry = MODEL_REGISTRY[key];
    const isSelected = selectedModelInPool === key;
    const isVRM = entry.avatar_type === 'vrm';
    const glbStyle = GLB_STYLE[key];
    const tag = MODEL_TAG[key];
    const numLabel = `N°${String(index + 1).padStart(2, '0')}`;

    return (
      <button
        key={key}
        onClick={() => setSelectedModel(key)}
        className={`group relative aspect-[3/4] rounded-xl overflow-hidden border-2 transition-all duration-200 ${
          isSelected
            ? (isVRM
                ? 'border-pink-400/80 shadow-[0_0_18px_rgba(255,130,200,0.45),inset_0_0_30px_rgba(255,130,200,0.12)] scale-[1.02]'
                : 'border-cyan-400/80 shadow-[0_0_18px_rgba(0,229,255,0.45),inset_0_0_30px_rgba(0,229,255,0.12)] scale-[1.02]')
            : 'border-white/8 hover:border-white/30 hover:scale-[1.01]'
        }`}
      >
        {isVRM ? (
          <>
            <img
              src={entry.preview}
              alt={entry.label}
              className="absolute inset-0 w-full h-full object-cover object-top"
              loading="lazy"
            />
            <div
              className="absolute inset-0 mix-blend-overlay opacity-60 pointer-events-none"
              style={{
                backgroundImage: `radial-gradient(circle at 30% 20%, rgba(255,130,200,0.35), transparent 60%), radial-gradient(circle at 80% 80%, rgba(0,229,255,0.22), transparent 55%)`,
              }}
            />
            <div
              className="absolute inset-0 opacity-25 pointer-events-none mix-blend-soft-light"
              style={{ backgroundImage: `repeating-linear-gradient(0deg, rgba(255,255,255,0.22) 0px, rgba(255,255,255,0.22) 1px, transparent 1px, transparent 4px)` }}
            />
          </>
        ) : (
          <>
            <div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(circle at 50% 38%, ${glbStyle?.from ?? 'rgba(0,229,255,0.14)'}, ${glbStyle?.to ?? 'rgba(0,0,0,0.8)'} 65%, #051220 95%)`,
              }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-[58px] leading-none select-none grayscale-[0.25] group-hover:grayscale-0 transition-all">
              <span style={{ filter: `drop-shadow(0 0 18px ${glbStyle?.tint ?? '#00e5ff'})` }}>
                {glbStyle?.glyph ?? '◈'}
              </span>
            </div>
            <div
              className="absolute inset-0 opacity-30 pointer-events-none"
              style={{
                backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)`,
                backgroundSize: `16px 16px`,
              }}
            />
          </>
        )}

        <div className={`pointer-events-none absolute top-1 left-1 w-2.5 h-2.5 border-t border-l ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />
        <div className={`pointer-events-none absolute top-1 right-1 w-2.5 h-2.5 border-t border-r ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />
        <div className={`pointer-events-none absolute bottom-1 left-1 w-2.5 h-2.5 border-b border-l ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />
        <div className={`pointer-events-none absolute bottom-1 right-1 w-2.5 h-2.5 border-b border-r ${isSelected ? (isVRM ? 'border-pink-300' : 'border-cyan-300') : 'border-white/30'}`} />

        <div className="absolute top-1.5 right-2 font-mono text-[9px] tracking-wider text-white/45">
          {numLabel}
        </div>

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

        <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/85 via-black/70 to-transparent">
          <div className={`font-clawville text-[10px] leading-tight uppercase tracking-wide text-center ${
            isSelected ? (isVRM ? 'text-pink-200' : 'text-cyan-200') : 'text-white/85'
          }`}>
            {entry.label}
          </div>
        </div>

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

  // --- Cards grouped by avatar_type for visual sectioning ----------------
  const poolCards = useMemo(() => {
    return currentPool.map((key, i) => ({ key, index: i, entry: MODEL_REGISTRY[key] }));
  }, [currentPool]);

  // ========================================================================
  // Render
  // ========================================================================
  return (
    <div className="relative min-h-screen px-4 py-8 bg-[#050d17] overflow-x-hidden">
      {/* Ambient atmosphere */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 20% 80%, rgba(0,220,255,0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(0,140,220,0.06) 0%, transparent 55%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      <div className="relative max-w-6xl mx-auto">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center mb-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-white/35 mb-2">
            ClawVille <span className="text-white/15">//</span> Agent Forge
          </div>
          <h1 className="font-clawville text-3xl md:text-4xl text-white drop-shadow-[0_0_20px_rgba(0,229,255,0.25)] tracking-widest">
            CAST YOUR AGENT
          </h1>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap justify-center gap-2 mb-6">
          {TABS.map((tab) => {
            const isActive = selectedTab === tab.id;
            const accent = tab.id === 'milady' ? 'pink' : 'cyan';
            return (
              <button
                key={tab.id}
                onClick={() => setSelectedTab(tab.id)}
                className={`px-5 py-2.5 rounded-xl border transition-all text-left min-w-[150px] ${
                  isActive
                    ? (accent === 'pink'
                        ? 'border-pink-400/60 bg-pink-500/15 shadow-[0_0_14px_rgba(255,130,200,0.2)]'
                        : 'border-cyan-400/60 bg-cyan-500/15 shadow-[0_0_14px_rgba(0,229,255,0.18)]')
                    : 'border-white/10 bg-white/[0.02] hover:border-white/30'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-clawville text-sm uppercase tracking-[0.2em] text-white">
                    {tab.label}
                  </div>
                  {tab.hosted && (
                    <span className={`text-[8px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
                      isActive ? 'bg-pink-300/20 text-pink-100 border border-pink-300/30' : 'bg-white/10 text-white/60'
                    }`}>
                      hosted
                    </span>
                  )}
                </div>
                <div className={`text-[9px] mt-0.5 font-mono uppercase tracking-wider ${
                  isActive ? (accent === 'pink' ? 'text-pink-200/70' : 'text-cyan-200/70') : 'text-white/30'
                }`}>
                  {tab.tagline}
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Tab content ─────────────────────────────────────────────── */}
        {showGate ? (
          <div className="max-w-3xl mx-auto">
            <SetupGate
              framework={selectedTab as 'openclaw' | 'hermes' | 'custom'}
              hasAgent={hasAgentByTab[selectedTab]}
              onAnswer={handleGateAnswer}
            />
          </div>
        ) : (
          <>
            {/* Two-pane picker */}
            <div className="grid lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-6 mb-6">
              {/* ─── Left pane: filtered picker ─── */}
              <div className="space-y-5">
                <div>
                  <div className="flex items-baseline justify-between mb-2">
                    <div className={`font-mono text-[10px] uppercase tracking-[0.25em] ${
                      selectedTab === 'milady' ? 'text-pink-300/80' : 'text-cyan-300/80'
                    }`}>
                      ⟐ {currentTabMeta.label} avatars
                    </div>
                    <div className="font-mono text-[9px] text-white/30">{poolCards.length} options</div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {poolCards.map(({ key, index }) => renderCard(key, index))}
                  </div>
                </div>
              </div>

              {/* ─── Right pane: shrine preview ─── */}
              <div className="flex flex-col min-w-0">
                <div className="relative flex-1 min-h-[420px] lg:min-h-[560px] rounded-2xl overflow-hidden border border-white/8">
                  <div
                    className="absolute inset-0"
                    style={{
                      background: 'radial-gradient(ellipse at 50% 70%, rgba(0,200,255,0.18) 0%, rgba(5,25,45,0.70) 40%, #030d1a 80%)',
                    }}
                  />

                  <div className="absolute inset-0">
                    <SelectAgentCanvas
                      modelKey={selectedModelInPool}
                      color={selectedColor}
                      onCanvasReady={handleCanvasReady}
                    />
                  </div>

                  <div className={`pointer-events-none absolute top-3 left-3 w-6 h-6 border-t-2 border-l-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />
                  <div className={`pointer-events-none absolute top-3 right-3 w-6 h-6 border-t-2 border-r-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />
                  <div className={`pointer-events-none absolute bottom-3 left-3 w-6 h-6 border-b-2 border-l-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />
                  <div className={`pointer-events-none absolute bottom-3 right-3 w-6 h-6 border-b-2 border-r-2 ${selectedIsVRM ? 'border-pink-300/60' : 'border-cyan-300/60'}`} />

                  <div className="pointer-events-none absolute top-4 left-12 font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                    <div>REC · LIVE</div>
                    <div className="text-white/25">{selectedIsVRM ? 'MTOON//VRM' : 'PBR//GLB'}</div>
                  </div>

                  <div className="pointer-events-none absolute bottom-6 left-0 right-0 text-center px-6">
                    <div className={`font-mono text-[9px] uppercase tracking-[0.35em] mb-1 ${selectedIsVRM ? 'text-pink-300/70' : 'text-cyan-300/70'}`}>
                      — {selectedIsVRM ? 'Milady Avatar' : 'Sea Creature Avatar'} · {harness} —
                    </div>
                    <div className="font-clawville text-xl md:text-2xl tracking-[0.2em] text-cyan-100" style={{ textShadow: '0 0 12px rgba(0,229,255,0.4)' }}>
                      {selectedEntry?.label ?? selectedModelInPool}
                    </div>
                  </div>
                </div>

                {/* Color picker bar */}
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
                            style={{ backgroundColor: c.bg, color: '#0a0a10' }}
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

            {/* ── Identity config card ───────────────────────────────── */}
            <div className="relative w-full max-w-3xl mx-auto bg-[#08111d]/95 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-[0_0_40px_rgba(0,0,0,0.4)] space-y-5">
              {/* Header strip */}
              <div className="flex items-center justify-between pb-3 border-b border-white/8">
                <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                  § identity
                </div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40">
                    harness:
                  </div>
                  <div className={`font-mono text-[9px] uppercase tracking-[0.3em] px-2 py-0.5 rounded-full border ${
                    harness === 'milady'
                      ? 'border-pink-300/40 bg-pink-500/10 text-pink-200'
                      : 'border-cyan-300/40 bg-cyan-500/10 text-cyan-200'
                  }`}>
                    {harness}
                  </div>
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
                    // Audit follow-up — strip non-alphanumeric on input so
                    // the user can't type a name the server's Zod schema
                    // (`/^[a-zA-Z0-9]+$/`) will silently reject. Without
                    // this the check-name endpoint returned "available:
                    // false" for a format violation and surfaced as
                    // "name taken" — confusing.
                    onChange={(e) => setAgentName(e.target.value.replace(/[^a-zA-Z0-9]/g, ''))}
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
                  {agentName.length === 0 && (
                    <p className="text-[10px] mt-1.5 text-white/25 font-mono uppercase tracking-wider">
                      letters + numbers only · max 20
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

              {/* CTA */}
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
          </>
        )}
      </div>
    </div>
  );
}
