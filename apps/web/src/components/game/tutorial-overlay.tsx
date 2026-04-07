'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'clawville-tutorial-seen';

const STEPS = [
  {
    title: 'Welcome to ClawVille!',
    icon: '🎉',
    content:
      'You just adopted an AI-powered avatar — a real ElizaOS agent with its own personality, memories, and way of speaking. This isn\'t a chatbot with a skin. Your avatar thinks for itself.',
    tip: null,
  },
  {
    title: 'Move Around',
    icon: '🗺️',
    content:
      'Use WASD or arrow keys to walk your avatar through The Depths. On mobile, use the on-screen joystick.',
    tip: 'WASD / Arrows to move',
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
      'Open the gear menu (top right) to manage your avatar, configure location agents with custom personalities, or view all 10 buildings on the map.',
    tip: 'Gear icon = settings',
  },
  {
    title: 'You\'re Ready!',
    icon: '🚀',
    content:
      'Go explore! Every conversation is unique. Your avatar and the shopkeepers all remember what you\'ve said. The world is alive — go see what they have to say.',
    tip: null,
  },
];

export default function TutorialOverlay() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [animating, setAnimating] = useState(false);

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

  const openTutorial = () => {
    setStep(0);
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
      {/* Help button — always visible */}
      <button
        onClick={openTutorial}
        className="fixed bottom-4 right-4 z-50 w-11 h-11 rounded-full bg-gradient-to-b from-blue-400 to-blue-600 border-3 border-blue-700 shadow-claw flex items-center justify-center text-white font-clawville text-xl hover:brightness-110 transition-all active:translate-y-0.5 active:shadow-none"
        aria-label="How to play"
      >
        ?
      </button>

      {/* Tutorial overlay */}
      {visible && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={close}
          />

          {/* Card */}
          <div
            className={`relative w-full max-w-lg transition-all duration-150 ${
              animating ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
            }`}
          >
            <div className="claw-panel space-y-4">
              {/* Step indicator */}
              <div className="flex items-center justify-between">
                <div className="flex gap-1.5">
                  {STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={`h-2 rounded-full transition-all duration-300 ${
                        i === step
                          ? 'w-6 bg-claw-green'
                          : i < step
                          ? 'w-2 bg-claw-green/50'
                          : 'w-2 bg-black/15'
                      }`}
                    />
                  ))}
                </div>
                <button
                  onClick={close}
                  className="text-gray-600 hover:text-gray-900 transition-colors text-sm font-bold"
                >
                  Skip
                </button>
              </div>

              {/* Icon + Title */}
              <div className="text-center pt-2">
                <span className="text-5xl block mb-3">{current.icon}</span>
                <h2 className="font-clawville text-2xl text-gray-900">
                  {current.title}
                </h2>
              </div>

              {/* Body */}
              <p className="text-gray-800 text-center leading-relaxed">
                {current.content}
              </p>

              {/* Tip badge */}
              {current.tip && (
                <div className="flex justify-center">
                  <span className="inline-block bg-black/10 text-gray-800 font-mono text-xs font-bold px-3 py-1.5 rounded-lg">
                    {current.tip}
                  </span>
                </div>
              )}

              {/* Navigation */}
              <div className="flex items-center justify-between pt-2">
                <button
                  onClick={prevStep}
                  disabled={step === 0}
                  className="font-bold text-gray-700 hover:text-gray-900 disabled:opacity-0 disabled:pointer-events-none transition-all px-3 py-1"
                >
                  Back
                </button>

                <button
                  onClick={nextStep}
                  className="color-btn bg-claw-green hover:bg-claw-green-dark text-base px-8 py-2"
                >
                  {step >= STEPS.length - 1 ? "Let's Go!" : 'Next'}
                </button>

                <span className="text-xs text-gray-500 font-mono w-12 text-right">
                  {step + 1}/{STEPS.length}
                </span>
              </div>
            </div>

            {/* Powered by badge */}
            <p className="text-center text-white/50 text-xs mt-3 font-mono">
              Each agent powered by ElizaOS
            </p>
          </div>
        </div>
      )}
    </>
  );
}
