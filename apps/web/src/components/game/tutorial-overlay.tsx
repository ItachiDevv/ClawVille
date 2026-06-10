'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, ArrowRight, CircleHelp, X } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-is-mobile';

const STORAGE_KEY = 'clawville-tutorial-seen';
const CONTROLS_STEP_INDEX = 2;

const CONTROL_ITEMS = [
  { key: 'WASD', label: 'Move', detail: 'Walk through The Depths', tone: 'cyan' },
  { key: 'Shift', label: 'Run', detail: 'Hold while moving', tone: 'amber' },
  { key: 'Space', label: 'Jump', detail: 'Tap, hold to charge, tap mid-air to sink', tone: 'coral' },
  { key: 'Joystick', label: 'Touch', detail: 'Outer ring runs; Jump button charges', tone: 'green' },
] as const;

function controlTone(tone: (typeof CONTROL_ITEMS)[number]['tone']) {
  switch (tone) {
    case 'amber':
      return {
        border: 'rgba(251, 191, 36, 0.46)',
        bg: 'linear-gradient(135deg, rgba(120, 72, 12, 0.64), rgba(41, 28, 10, 0.78))',
        key: '#fde68a',
        glow: 'rgba(251, 191, 36, 0.22)',
      };
    case 'coral':
      return {
        border: 'rgba(251, 113, 133, 0.48)',
        bg: 'linear-gradient(135deg, rgba(116, 28, 54, 0.64), rgba(39, 13, 26, 0.78))',
        key: '#fecdd3',
        glow: 'rgba(251, 113, 133, 0.22)',
      };
    case 'green':
      return {
        border: 'rgba(74, 222, 128, 0.44)',
        bg: 'linear-gradient(135deg, rgba(18, 100, 67, 0.58), rgba(9, 39, 35, 0.8))',
        key: '#bbf7d0',
        glow: 'rgba(74, 222, 128, 0.18)',
      };
    default:
      return {
        border: 'rgba(56, 189, 248, 0.5)',
        bg: 'linear-gradient(135deg, rgba(10, 82, 116, 0.64), rgba(8, 28, 54, 0.8))',
        key: '#bae6fd',
        glow: 'rgba(56, 189, 248, 0.24)',
      };
  }
}

const STEPS = [
  {
    title: 'Welcome to ClawVille!',
    icon: '🎉',
    content:
      'You just created an AI-powered agent — a real ElizaOS agent with its own personality, memories, and way of speaking. This isn\'t a chatbot with a skin. Your agent thinks for itself.',
    tip: null,
  },
  {
    title: 'Move Around',
    icon: '🗺️',
    content:
      'Use WASD to walk your agent through The Depths. On touch screens, use the left joystick to move and the right joystick to rotate the camera.',
    tip: 'WASD / joysticks',
  },
  {
    title: 'Run and Jump',
    icon: '⚡',
    content:
      'Hold Shift while moving to run. On touch screens, push the movement joystick to the outer ring for run speed. Press Space to jump, hold Space to charge higher, and press Space again mid-air to sink fast. Touch players can press and hold the Jump button.',
    tip: 'Shift = run · Space = jump / hold to charge',
  },
  {
    title: 'Enter Buildings',
    icon: '🏠',
    content:
      'Walk near any building and press E to go inside. Each building has its own AI agent you can talk to — a shopkeeper, a librarian, a fortune teller, and more.',
    tip: 'Press E near a building',
  },
  {
    title: 'Chat with Agents',
    icon: '💬',
    content:
      'Once inside, a chat panel opens. Type anything — the agent will respond in character. Press Escape or the X button to leave and keep exploring.',
    tip: 'Press ESC to leave',
  },
  {
    title: 'Customize Everything',
    icon: '⚙️',
    content:
      'Open the gear menu (top right) to manage your agent, configure location agents with custom personalities, or view all 10 buildings on the map.',
    tip: 'Gear icon = settings',
  },
  {
    title: 'You\'re Ready!',
    icon: '🚀',
    content:
      'Go explore! Every conversation is unique. Your agent and the shopkeepers all remember what you\'ve said. The world is alive — go see what they have to say.',
    tip: null,
  },
];

export default function TutorialOverlay() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [animating, setAnimating] = useState(false);
  const isMobile = useIsMobile();

  // Show on first visit
  useEffect(() => {
    const seen = localStorage.getItem(STORAGE_KEY);
    if (!seen) {
      setVisible(true);
    }
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  }, []);

  const nextStep = () => {
    if (step >= STEPS.length - 1) {
      close();
      return;
    }
    setAnimating(true);
    setTimeout(() => {
      setStep((s) => s + 1);
      setAnimating(false);
    }, 150);
  };

  const prevStep = () => {
    if (step <= 0) return;
    setAnimating(true);
    setTimeout(() => {
      setStep((s) => s - 1);
      setAnimating(false);
    }, 150);
  };

  const openControls = () => {
    setStep(CONTROLS_STEP_INDEX);
    setVisible(true);
  };

  // Keyboard nav
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight' || e.key === 'Enter') nextStep();
      if (e.key === 'ArrowLeft') prevStep();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  const current = STEPS[step];

  return (
    <>
      {/* Controls button — constant on /game. Uses useIsMobile instead of
          Tailwind breakpoints so iPad landscape is treated as touch UI. */}
      <button
        type="button"
        onClick={openControls}
        className="fixed z-50 flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-cyan-300/50 bg-[#05283a]/90 px-3 text-cyan-50 shadow-[0_0_24px_rgba(34,211,238,0.28)] backdrop-blur-md transition-all hover:border-cyan-200/80 hover:bg-[#07364e] active:translate-y-0.5"
        style={isMobile
          ? {
              top: 'calc(env(safe-area-inset-top, 0px) + 128px)',
              right: 'calc(env(safe-area-inset-right, 0px) + 12px)',
            }
          : {
              bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
              right: 260,
            }}
        aria-label="Open controls help"
        title="Controls"
      >
        <CircleHelp className="h-5 w-5" aria-hidden />
        <span className="hidden text-xs font-black uppercase tracking-[0.16em] sm:inline">
          Controls
        </span>
      </button>

      {/* Tutorial overlay */}
      {visible && (
        <div
          className={`fixed z-[44] ${isMobile ? 'inset-0 flex items-center justify-center p-4' : ''}`}
          style={!isMobile
            ? {
                top: 114,
                right: 260,
                width: 'min(390px, calc(100vw - 300px))',
              }
            : undefined}
        >
          {isMobile && (
            <div
              className="absolute inset-0 bg-[#021019]/70 backdrop-blur-sm"
              onClick={close}
            />
          )}

          <div
            className={`relative w-full transition-all duration-150 ${
              animating ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
            }`}
          >
            <div
              className="relative max-h-[calc(100svh-2rem)] overflow-hidden rounded-lg border p-0 shadow-[0_22px_80px_rgba(0,0,0,0.42),0_0_40px_rgba(45,212,191,0.22)]"
              style={{
                background:
                  'linear-gradient(180deg, rgba(6, 47, 70, 0.96) 0%, rgba(7, 28, 49, 0.98) 46%, rgba(8, 20, 35, 0.98) 100%)',
                borderColor: 'rgba(125, 211, 252, 0.34)',
              }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-1"
                style={{
                  background:
                    'linear-gradient(90deg, #22d3ee 0%, #fbbf24 38%, #fb7185 68%, #4ade80 100%)',
                }}
              />

              {/* Step indicator */}
              <div className="flex items-center justify-between px-5 pb-2 pt-5">
                <div className="flex gap-1.5">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={`h-2 rounded-full transition-all duration-300 ${
                        i === step
                          ? 'w-6 bg-claw-green'
                          : i < step
                          ? 'w-2 bg-claw-green/50'
                          : 'w-2 bg-white/15'
                      }`}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={close}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-cyan-200/20 bg-cyan-950/40 text-cyan-100/75 transition-colors hover:border-cyan-200/45 hover:text-white"
                  aria-label="Close controls help"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>

              {/* Icon + Title */}
              <div className="px-5 pt-1">
                <div className="mb-3 flex items-center gap-3">
                  <span
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-cyan-200/25 bg-cyan-200/10 text-3xl shadow-[inset_0_0_24px_rgba(125,211,252,0.12)]"
                    aria-hidden
                  >
                    {current.icon}
                  </span>
                  <div>
                    <div className="font-mono text-[10px] font-black uppercase tracking-[0.22em] text-cyan-200/70">
                      Field Manual
                    </div>
                    <h2 className="font-clawville text-2xl leading-tight text-white">
                      {current.title}
                    </h2>
                  </div>
                </div>
              </div>

              {/* Body */}
              <div className="space-y-4 px-5 pb-4">
                <p className="text-sm leading-relaxed text-cyan-50/82">
                  {current.content}
                </p>

                {step === CONTROLS_STEP_INDEX && (
                  <div className="grid grid-cols-1 gap-2">
                    {CONTROL_ITEMS.map((item) => {
                      const tone = controlTone(item.tone);
                      return (
                        <div
                          key={item.key}
                          className="rounded-md border px-3 py-2"
                          style={{
                            borderColor: tone.border,
                            background: tone.bg,
                            boxShadow: `inset 0 0 18px ${tone.glow}`,
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <span
                              className="min-w-[76px] rounded border px-2 py-1 text-center font-mono text-[11px] font-black uppercase tracking-[0.12em]"
                              style={{
                                borderColor: tone.border,
                                color: tone.key,
                                background: 'rgba(0, 0, 0, 0.22)',
                              }}
                            >
                              {item.key}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm font-black text-white">
                                {item.label}
                              </div>
                              <div className="text-xs leading-snug text-cyan-50/70">
                                {item.detail}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {current.tip && (
                  <div className="inline-flex rounded-md border border-cyan-200/24 bg-cyan-950/40 px-3 py-1.5 font-mono text-[11px] font-bold text-cyan-100/80">
                    {current.tip}
                  </div>
                )}
              </div>

              {/* Navigation */}
              <div className="flex items-center justify-between border-t border-cyan-200/12 bg-black/18 px-5 py-4">
                <button
                  type="button"
                  onClick={prevStep}
                  disabled={step === 0}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-cyan-200/20 text-cyan-100/70 transition-all hover:border-cyan-200/45 hover:text-white disabled:opacity-0 disabled:pointer-events-none"
                  aria-label="Previous tutorial step"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                </button>

                <div className="font-mono text-[11px] font-bold tracking-[0.16em] text-cyan-100/50">
                  {step + 1}/{STEPS.length}
                </div>

                <button
                  type="button"
                  onClick={nextStep}
                  className="flex h-10 items-center gap-2 rounded-full border border-emerald-200/35 bg-emerald-400/18 px-4 text-sm font-black text-emerald-50 shadow-[0_0_22px_rgba(74,222,128,0.16)] transition-all hover:bg-emerald-400/28"
                >
                  {step >= STEPS.length - 1 ? "Let's Go" : 'Next'}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>

            {/* Powered by badge */}
            <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-100/45">
              Each agent powered by ElizaOS
            </p>
          </div>
        </div>
      )}
    </>
  );
}
