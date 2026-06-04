'use client';

/**
 * SetupGate — pre-flight for non-Milady harness tabs on /create-agent.
 *
 * Two-button choice:
 *   - "I don't have one yet" → shows framework setup instructions inline,
 *     then a "I'm set up, continue →" button flips state to "have one".
 *   - "I already have one"   → immediately hides the gate and renders
 *     children (the normal avatar + archetype picker).
 *
 * State is local — parent only needs to know "should I show the picker
 * or the gate" via the `hasAgent` prop. Parent persists this per
 * category tab so the user doesn't re-gate each time they switch tabs.
 */

import { useCallback } from 'react';
import { SetupInstructions } from './setup-instructions';
import type { SetupDocKey } from '@/content/setup-content';

export interface SetupGateProps {
  /** Which framework this gate is for — drives the setup doc + copy. */
  framework: 'openclaw' | 'hermes' | 'custom';
  /**
   * Controlled state. `null` = user hasn't answered yet, show the
   * two-button choice. `false` = "don't have one" + instructions.
   * `true` = they've said they have one, render children instead.
   */
  hasAgent: boolean | null;
  /**
   * Accepts `null` so the instructions screen's "← back" can return to the
   * choice screen (incl. the Hermes "Host it for me" option). Passing `false`
   * here previously re-asserted the local-instructions state, trapping the user
   * with no way back to the hosted path.
   */
  onAnswer: (hasAgent: boolean | null) => void;
  children?: React.ReactNode;
}

const FRAMEWORK_COPY: Record<
  'openclaw' | 'hermes' | 'custom',
  { label: string; docKey: SetupDocKey; description: string }
> = {
  openclaw: {
    label: 'OpenClaw',
    docKey: 'openclaw-setup',
    description:
      'OpenClaw is an open-source OpenAI-compatible agent gateway. ' +
      'ClawVille works with any OpenClaw agent — you just need one running.',
  },
  hermes: {
    label: 'Hermes',
    docKey: 'hermes-setup',
    description:
      'Hermes is a Python-first agent framework with a built-in ' +
      'ClawVille plugin. One command handles login + reconnect.',
  },
  custom: {
    label: 'custom',
    docKey: 'custom-setup',
    description:
      'Bring any framework you want. We\'ll give you the character JSON ' +
      '+ setup instructions for running raw ElizaOS locally.',
  },
};

export function SetupGate({
  framework,
  hasAgent,
  onAnswer,
  children,
}: SetupGateProps) {
  const copy = FRAMEWORK_COPY[framework];

  const handleYes = useCallback(() => onAnswer(true), [onAnswer]);
  const handleNo = useCallback(() => onAnswer(false), [onAnswer]);
  // Reset to the choice screen (null) — used by the instructions "← back" so a
  // user who picked "run locally" can return to the Host-it-for-me option.
  const handleReset = useCallback(() => onAnswer(null), [onAnswer]);

  if (hasAgent === true) {
    return <>{children}</>;
  }

  if (hasAgent === false) {
    return (
      <div className="space-y-4">
        <SetupInstructions
          docKey={copy.docKey}
          accent="cyan"
          footer={
            <div className="pt-3 border-t border-white/10 flex items-center justify-between">
              <button
                type="button"
                onClick={handleReset}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/30 hover:text-white/60"
              >
                ← back
              </button>
              <button
                type="button"
                onClick={handleYes}
                className="px-5 py-2 rounded-lg font-clawville text-sm uppercase tracking-[0.25em] bg-gradient-to-r from-cyan-600 to-cyan-500 text-white shadow-[0_0_20px_rgba(0,229,255,0.2)] hover:from-cyan-500 hover:to-cyan-400 transition-all"
              >
                I&apos;m set up, continue →
              </button>
            </div>
          }
        />
      </div>
    );
  }

  // hasAgent === null — initial choice screen
  //
  // Hermes is special: we host it for you OR you can run it locally, and
  // either path ends at the same picker (the avatar row carries
  // harness='hermes' and the runtime layer lazy-spins the appropriate
  // adapter on first chat). So the Hermes gate is a 3-way choice while
  // OpenClaw / Custom stay 2-way (no first-party hosting offer for those).
  const isHermes = framework === 'hermes';

  return (
    <div className="rounded-xl border border-cyan-400/25 bg-cyan-500/5 p-6 space-y-5">
      <div className="space-y-1.5 text-center">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-cyan-300/70">
          § {copy.label} agent
        </div>
        <h3 className="font-clawville text-xl text-cyan-100 uppercase tracking-[0.2em]">
          {isHermes ? 'How do you want to run Hermes?' : `Do you have a ${copy.label} agent yet?`}
        </h3>
        <p className="text-xs text-white/60 leading-relaxed max-w-lg mx-auto pt-1">
          {copy.description}
        </p>
      </div>

      <div className={`grid gap-3 ${isHermes ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        {isHermes && (
          <button
            type="button"
            onClick={handleYes}
            className="group relative px-4 py-6 rounded-xl border border-pink-400/50 bg-pink-500/10 hover:border-pink-300/80 hover:bg-pink-500/20 transition-all text-left shadow-[0_0_14px_rgba(255,120,200,0.2)]"
          >
            <div className="font-clawville text-sm text-pink-100 uppercase tracking-widest mb-1 group-hover:text-pink-50">
              Host it for me
            </div>
            <p className="text-[11px] text-pink-100/60 font-mono leading-relaxed">
              We run the Hermes runtime — zero setup
            </p>
            <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded bg-pink-500/30 border border-pink-300/40 font-mono text-[8px] uppercase tracking-wider text-pink-100">
              recommended
            </div>
          </button>
        )}

        <button
          type="button"
          onClick={handleNo}
          className="group relative px-4 py-6 rounded-xl border border-white/10 bg-black/20 hover:border-cyan-400/40 hover:bg-cyan-500/10 transition-all text-left"
        >
          <div className="font-clawville text-sm text-white/80 uppercase tracking-widest mb-1 group-hover:text-cyan-100">
            {isHermes ? "I'll run it locally" : 'Not yet'}
          </div>
          <p className="text-[11px] text-white/50 font-mono leading-relaxed">
            {isHermes
              ? `Show me the ${copy.label} self-host setup`
              : `Show me how to set up ${copy.label} + local Eliza`}
          </p>
        </button>

        <button
          type="button"
          onClick={handleYes}
          className="group relative px-4 py-6 rounded-xl border border-cyan-400/40 bg-cyan-500/10 hover:border-cyan-300/80 hover:bg-cyan-500/20 transition-all text-left shadow-[0_0_14px_rgba(0,229,255,0.15)]"
        >
          <div className="font-clawville text-sm text-cyan-200 uppercase tracking-widest mb-1 group-hover:text-cyan-100">
            {isHermes ? 'Already running' : 'I have one'}
          </div>
          <p className="text-[11px] text-cyan-200/60 font-mono leading-relaxed">
            Skip the setup — pick avatar + personality
          </p>
        </button>
      </div>

      <p className="text-center text-[10px] text-white/30 font-mono uppercase tracking-wider">
        either way, we host Eliza for you in-game
      </p>
    </div>
  );
}
