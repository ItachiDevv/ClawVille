'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCheckPetName } from '@/hooks/use-pet';
import {
  MODEL_REGISTRY,
  CATEGORY_META,
  CATEGORY_ORDER,
  CATEGORY_DEFAULT_MODEL,
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
// Module-scope so they're computed once, not on every readSessionStep1 call.
// Used to reject stale sessionStorage payloads whose color/harness came from a
// previous version of the enums (e.g. 'cyan' from the 9-color era, 'ironclaw'
// from an early harness draft). Without this validation, an invalid value
// would set state to a string that no button highlights and that COLOR_TINTS
// doesn't recognise, leaving the picker UI visually broken.
const VALID_COLOR_IDS: ReadonlySet<string> = new Set(PICKER_COLORS.map((c) => c.id));
const VALID_HARNESS_IDS: ReadonlySet<string> = new Set(HARNESS_OPTIONS.map((h) => h.id));

// Lazy-load the Canvas — keeps the 3D pipeline out of the synchronous bundle
// so first-paint is not blocked. ssr: false required (Canvas needs window).
const SelectAgentCanvas = dynamic(
  () => import('@/components/three/SelectAgentCanvas'),
  { ssr: false }
);

// Shape of the sessionStorage payload that bridges step 1 → step 2 → POST /api/pets.
// `species` is a LEGACY field (one of the Phase 0 fantasy enum) required by
// pets.ts:24 Zod schema; modelKey carries the real Phase 1 value for 3D rendering.
// When Phase 2 lands, `species` drops out of the payload.
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

// ── sessionStorage hydration helper (audit Fix E) ──────────────────────────
// Read + parse the step-1 draft. SSR-safe — returns null when window is
// unavailable so the lazy initializers below fall back to defaults during
// server render. Catches JSON.parse errors from a malformed payload so a
// stale cookie-era artifact can't blank the page.
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

export default function CreateAgentPage() {
  const router = useRouter();
  const checkNameMutation = useCheckPetName();

  // ── Model picker state (audit Fix E — lazy initializers) ──────────────────
  // Hydrating from sessionStorage in a useEffect caused a visible one-frame
  // flash of the default lobster model before the hydrated value rendered
  // on the next tick, which also triggered a spurious <Suspense> fallback
  // + dispose cycle on the GLB. Moving the hydration into lazy init
  // functions means the first render already has the correct state.
  // Each initializer validates against the current enum set (audit Fix D)
  // so stale payloads (e.g. color 'cyan' from the 9-color era) fall back
  // to defaults instead of putting the picker in an invalid state.
  const [selectedModel, setSelectedModel] = useState<ModelKey>(() => {
    const s = readSessionStep1();
    if (s?.modelKey && s.modelKey in MODEL_REGISTRY) return s.modelKey as ModelKey;
    return 'lobster';
  });
  const [selectedCategory, setSelectedCategory] = useState<AgentCategory>(() => {
    const s = readSessionStep1();
    if (s?.modelKey && s.modelKey in MODEL_REGISTRY) {
      return MODEL_REGISTRY[s.modelKey as ModelKey].category;
    }
    return 'openclaw';
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

  // ── Agent identity state ──────────────────────────────────────────────────
  const [agentName, setAgentName] = useState<string>(() => readSessionStep1()?.name ?? '');
  const [gender, setGender] = useState<'male' | 'female'>(() => {
    const s = readSessionStep1();
    return s?.gender === 'female' ? 'female' : 'male';
  });
  const [nameStatus, setNameStatus] = useState<{
    available: boolean;
    reason?: string;
  } | null>(null);

  // ── Submission lock (audit Fix A) ─────────────────────────────────────────
  // Prevents a double-click on Next from firing two concurrent handleNext
  // invocations — each would await captureThumbnail, write sessionStorage,
  // and router.push, racing in the route transition. The ref is the
  // load-bearing piece (synchronous re-entry guard); the state drives the
  // disabled prop so the user sees the button freeze during submission.
  const submittingRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Release the ref on unmount so back-navigation to this page after a
  // successful submit lets the user resubmit from the restored draft.
  useEffect(() => () => { submittingRef.current = false; }, []);

  // ── Canvas ref — populated by SelectAgentCanvas.onCanvasReady ─────────────
  // Replaces the fragile document.getElementById('select-agent-canvas') lookup.
  // Guaranteed to be populated by the time R3F finishes creating the renderer.
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const handleCanvasReady = useCallback((canvas: HTMLCanvasElement) => {
    canvasElRef.current = canvas;
  }, []);

  // ── Derived model list for current category ───────────────────────────────
  const modelsInCategory = Object.entries(MODEL_REGISTRY).filter(
    ([, entry]) => entry.category === selectedCategory
  );

  // ── Name availability debounce with request cancellation ─────────────────
  // Fixes audit §2 (stale mutation response race) + §7 (unmount leak):
  // drop all updates if the effect has been torn down. The previous
  // `nameForRequest === agentName` comparison was redundant — both values
  // come from the same closure, so they're always equal by construction.
  // `cancelled` alone is sufficient to drop stale responses (fix G).
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
    // checkNameMutation ref is stable across renders (TanStack v5); excluding
    // it is deliberate — including it would re-run the debounce on every
    // render and invalidate the cancellation flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName]);

  // Switch category — also switch to that category's default model.
  // Both setters are batched under React 18's automatic batching for event
  // handlers. Do NOT make this async — an `await` between the two setters
  // breaks batching and would cause one render with the new category + stale
  // model, sending a mismatched modelKey to SelectAgentCanvas.
  // CATEGORY_DEFAULT_MODEL is Partial<Record<AgentCategory, ModelKey>> since
  // 2026-04-16 (hermes/milady tabs removed) — fall back to 'lobster' for any
  // category that is no longer in the picker so the state can never be
  // undefined even if stale sessionStorage pushes a retired category in.
  const handleCategoryChange = useCallback((cat: AgentCategory) => {
    setSelectedCategory(cat);
    setSelectedModel(CATEGORY_DEFAULT_MODEL[cat] ?? 'lobster');
  }, []);

  // ── Thumbnail capture with bounded rAF poll (audit Fix F) ────────────────
  // preserveDrawingBuffer is set on the Canvas so toDataURL returns the last
  // rendered frame. If the user clicks Next before the first frame paints
  // (or before SelectAgentCanvas's dynamic import has even finished
  // populating canvasElRef on a cold load), toDataURL returns 'data:,' and
  // the previous two-frame retry wasn't enough. Poll once per rAF until
  // either a real frame is available or 1000ms have elapsed — then resolve
  // with '' so the caller's router.push isn't blocked forever.
  const captureThumbnail = (): Promise<string> => {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const tryCapture = (): string => {
        const canvasEl = canvasElRef.current;
        if (!canvasEl) return '';
        try {
          const data = canvasEl.toDataURL('image/jpeg', 0.8);
          // Detect empty frame: 'data:,' or suspiciously short data URL.
          if (data === 'data:,' || data.length < 200) return '';
          return data;
        } catch {
          return '';
        }
      };
      const poll = () => {
        const data = tryCapture();
        if (data) {
          resolve(data);
          return;
        }
        if (performance.now() - startedAt > 1000) {
          resolve('');
          return;
        }
        requestAnimationFrame(poll);
      };
      poll();
    });
  };

  const handleNext = useCallback(async () => {
    // Fix A — in-flight lock. Double-click races were firing two concurrent
    // handlers, each awaiting captureThumbnail, each writing sessionStorage
    // and pushing the route. The ref is the synchronous guard; the state
    // drives the button's disabled prop so the freeze is visible.
    if (submittingRef.current) return;
    if (!agentName || agentName.length < 3) return;
    // Fix B — require explicit name availability before advancing. The old
    // `nameStatus !== null && !nameStatus.available` was false when
    // nameStatus was null (debounce pending or mutation in flight), so the
    // button was enabled during that window and a fast click would ship an
    // unverified name — the user wouldn't discover the collision until
    // final CREATE after filling archetype + stats.
    if (nameStatus?.available !== true) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const thumb = await captureThumbnail();

      // CRITICAL (audit #1): project modelKey down to the legacy species enum
      // that POST /api/pets still validates against. Without this the server
      // 400s on every Phase 1 model key.
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
      // Keep submittingRef true during the route transition so a rapid
      // Back+Next can't re-fire mid-push. The unmount effect clears the
      // ref when the component tears down, which happens on successful
      // navigation. setIsSubmitting(false) is safe — if the component is
      // unmounted the setter is a no-op (React 18 silently drops it).
      setIsSubmitting(false);
    }
  }, [agentName, nameStatus, selectedModel, selectedCategory, selectedColor, gender, selectedHarness, router]);

  return (
    <div className="relative min-h-screen flex flex-col items-center px-4 py-8 bg-[#061520] overflow-x-hidden">
      {/* 3D scene — full-page background, replacing LandingScene.
          Canvas is fixed inset-0 z-0 (set inside SelectAgentCanvas).
          UI overlay is z-10. Never run alongside LandingScene on Iris Xe.
          onCanvasReady gives us the <canvas> element ref so handleNext can
          call toDataURL without resorting to document.getElementById. */}
      <SelectAgentCanvas
        modelKey={selectedModel}
        color={selectedColor}
        onCanvasReady={handleCanvasReady}
      />

      <div className="relative z-10 w-full flex flex-col items-center">

        {/* Title */}
        <h1 className="font-clawville text-3xl text-white drop-shadow-[0_0_16px_rgba(0,229,255,0.3)] mb-1">
          Create Your Agent
        </h1>
        <p className="text-white/40 text-xs font-mono uppercase tracking-widest mb-5">
          Choose model, color, and identity
        </p>

        {/* ── Category tabs ─────────────────────────────────────────────── */}
        {/* CATEGORY_META is now Partial<Record<...>> — `cat` here is always
            drawn from CATEGORY_ORDER which is guaranteed to have a matching
            meta entry, but TS doesn't know that so we fall back on `cat`
            itself as the label text. */}
        <div className="flex gap-1 bg-black/40 backdrop-blur-sm rounded-xl p-1 mb-4 border border-white/10">
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                selectedCategory === cat
                  ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/40'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/5'
              }`}
            >
              {CATEGORY_META[cat]?.label ?? cat}
            </button>
          ))}
        </div>

        {/* ── Model picker grid ─────────────────────────────────────────── */}
        <div className="w-full max-w-xl mb-4">
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {modelsInCategory.map(([key, entry]) => (
              <button
                key={key}
                // `key` comes from Object.entries() which widens to string; MODEL_REGISTRY
                // is `satisfies Record<string, ModelRegistryEntry>` so every key IS a ModelKey.
                onClick={() => setSelectedModel(key as ModelKey)}
                className={`flex flex-col items-center py-2 px-1 rounded-xl border transition-all ${
                  selectedModel === key
                    ? 'bg-cyan-500/20 border-cyan-500/60 shadow-[0_0_10px_rgba(0,229,255,0.2)]'
                    : 'bg-black/30 border-white/10 hover:bg-white/5 hover:border-white/20'
                }`}
              >
                <span className={`text-xs font-bold text-center leading-tight mt-1 ${
                  selectedModel === key ? 'text-cyan-300' : 'text-white/60'
                }`}>
                  {entry.label}
                </span>
              </button>
            ))}
          </div>
          <p className="text-white/30 text-[10px] text-center mt-1.5 font-mono">
            {CATEGORY_META[selectedCategory]?.description ?? ''}
          </p>
        </div>

        {/* ── Color picker ──────────────────────────────────────────────── */}
        <div className="flex gap-2 mb-5">
          {PICKER_COLORS.map((color) => (
            <button
              key={color.id}
              onClick={() => setSelectedColor(color.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border-2 ${
                selectedColor === color.id
                  ? 'border-white/60 shadow-[0_0_8px_rgba(255,255,255,0.3)] scale-105'
                  : 'border-transparent opacity-70 hover:opacity-90'
              }`}
              style={{ backgroundColor: color.bg, color: '#000' }}
            >
              {color.label}
            </button>
          ))}
        </div>

        {/* ── Config panel ──────────────────────────────────────────────── */}
        <div className="w-full max-w-xl bg-[#0a1628]/90 border border-cyan-500/20 rounded-2xl p-6 backdrop-blur-xl shadow-[0_0_30px_rgba(0,229,255,0.06)] space-y-4">

          {/* Selected model label */}
          <p className="text-center">
            <span className="text-white/40 text-xs font-mono uppercase tracking-wider">
              Model:{' '}
            </span>
            <span className="font-clawville text-xl text-cyan-300">
              {MODEL_REGISTRY[selectedModel]?.label ?? selectedModel}
            </span>
          </p>

          {/* Name + Gender row */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">
                Agent Name
              </label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                maxLength={20}
                className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white placeholder:text-white/20 focus:outline-none focus:border-cyan-500/50 focus:shadow-[0_0_12px_rgba(0,229,255,0.1)] transition-all"
                placeholder="Enter a name..."
              />
              {agentName.length >= 3 && nameStatus && (
                <p className={`text-xs mt-1.5 font-bold ${nameStatus.available ? 'text-emerald-400' : 'text-red-400'}`}>
                  {nameStatus.available
                    ? `${agentName} is available!`
                    : nameStatus.reason || 'That name is taken'}
                </p>
              )}
              {agentName.length > 0 && agentName.length < 3 && (
                <p className="text-xs mt-1.5 text-white/30 font-mono">
                  Name must be at least 3 characters
                </p>
              )}
            </div>

            <div className="sm:w-40">
              <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-1.5">
                Gender
              </label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as 'male' | 'female')}
                className="w-full px-4 py-2.5 rounded-lg bg-white/[0.05] border border-white/10 text-white focus:outline-none focus:border-cyan-500/50 transition-all"
              >
                <option value="male" className="bg-[#0a1628]">MALE</option>
                <option value="female" className="bg-[#0a1628]">FEMALE</option>
              </select>
            </div>
          </div>

          {/* ── Agent harness ───────────────────────────────────────────── */}
          <div>
            <label className="block text-white/50 text-xs font-mono uppercase tracking-wider mb-2">
              Agent Harness
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {HARNESS_OPTIONS.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelectedHarness(h.id)}
                  className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
                    selectedHarness === h.id
                      ? 'border-cyan-500/60 bg-cyan-500/10 shadow-[0_0_8px_rgba(0,229,255,0.1)]'
                      : 'border-white/10 bg-white/5 hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full border-2 shrink-0 ${
                      selectedHarness === h.id
                        ? 'border-cyan-400 bg-cyan-400'
                        : 'border-white/30 bg-transparent'
                    }`} />
                    <span className={`text-xs font-bold ${selectedHarness === h.id ? 'text-cyan-300' : 'text-white/70'}`}>
                      {h.label}
                      {h.id === 'milady' && (
                        <span className="ml-1 text-[9px] text-cyan-400/70 font-mono">(recommended)</span>
                      )}
                    </span>
                  </div>
                  <p className="text-[10px] text-white/30 mt-0.5 ml-5">{h.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Next button — disabled unless name is verified-available AND
              no submission is in flight (Fix A + B). Requiring
              nameStatus.available === true means the user must wait for
              the debounced check to return "available" before the button
              lights up, which is the correct UX: tell them the name is
              good BEFORE they spend 2 minutes on step 2. */}
          <button
            onClick={handleNext}
            disabled={
              isSubmitting ||
              !agentName ||
              agentName.length < 3 ||
              nameStatus?.available !== true
            }
            className="w-full py-3 rounded-lg font-clawville text-sm uppercase tracking-wider transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:shadow-[0_0_28px_rgba(0,229,255,0.35)]"
          >
            Choose Personality
          </button>
        </div>

      </div>
    </div>
  );
}
