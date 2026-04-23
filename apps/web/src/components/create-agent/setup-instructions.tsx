'use client';

/**
 * SetupInstructions — renders a SETUP_DOCS entry as a styled panel.
 *
 * Used inline on /create-agent (pre-flight gate "I don't have one yet"
 * state) AND inside the Take-Agent-Home section of pet-settings-modal
 * (harness-specific export instructions).
 *
 * Single-source-of-truth content lives in
 * `apps/web/src/content/setup-content.ts`.
 */

import { useCallback, useState } from 'react';
import type { SetupDoc, SetupDocKey, SetupSection } from '@/content/setup-content';
import { SETUP_DOCS } from '@/content/setup-content';

export interface SetupInstructionsProps {
  docKey: SetupDocKey;
  /** Visual accent — pink for Milady, cyan for everyone else. */
  accent?: 'pink' | 'cyan';
  /** Optional trailing content (e.g. "I'm set up, continue →" button). */
  footer?: React.ReactNode;
}

export function SetupInstructions({
  docKey,
  accent = 'cyan',
  footer,
}: SetupInstructionsProps) {
  const doc: SetupDoc = SETUP_DOCS[docKey];

  const accentClasses =
    accent === 'pink'
      ? {
          border: 'border-pink-400/25',
          bg: 'bg-pink-500/5',
          heading: 'text-pink-200',
          subheading: 'text-pink-300/80',
          link: 'text-pink-300 hover:text-pink-200',
          codeBorder: 'border-pink-400/25',
        }
      : {
          border: 'border-cyan-400/25',
          bg: 'bg-cyan-500/5',
          heading: 'text-cyan-100',
          subheading: 'text-cyan-300/80',
          link: 'text-cyan-300 hover:text-cyan-200',
          codeBorder: 'border-cyan-400/25',
        };

  return (
    <div
      className={`rounded-xl border ${accentClasses.border} ${accentClasses.bg} p-5 space-y-5`}
    >
      <header className="space-y-1">
        <h3
          className={`font-clawville text-lg tracking-widest uppercase ${accentClasses.heading}`}
        >
          {doc.title}
        </h3>
        <p className={`font-mono text-[11px] uppercase tracking-[0.2em] ${accentClasses.subheading}`}>
          {doc.subtitle}
        </p>
      </header>

      {doc.preamble && (
        <p className="text-sm text-white/70 leading-relaxed">{doc.preamble}</p>
      )}

      <div className="space-y-4">
        {doc.sections.map((section, i) => (
          <SetupSectionBlock
            key={i}
            section={section}
            accent={accent}
            accentClasses={accentClasses}
          />
        ))}
      </div>

      {footer}
    </div>
  );
}

function SetupSectionBlock({
  section,
  accentClasses,
}: {
  section: SetupSection;
  accent: 'pink' | 'cyan';
  accentClasses: {
    border: string;
    bg: string;
    heading: string;
    subheading: string;
    link: string;
    codeBorder: string;
  };
}) {
  return (
    <div className="space-y-2">
      <h4 className={`font-bold text-sm ${accentClasses.heading}`}>
        {section.heading}
      </h4>
      <p className="text-[13px] text-white/70 leading-relaxed">{section.body}</p>
      {section.link && (
        <a
          href={section.link.href}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-block font-mono text-[11px] uppercase tracking-wider ${accentClasses.link} hover:underline`}
        >
          {section.link.label}
        </a>
      )}
      {section.code && <CodeBlock code={section.code} accentClasses={accentClasses} />}
    </div>
  );
}

function CodeBlock({
  code,
  accentClasses,
}: {
  code: { language: string; value: string };
  accentClasses: { codeBorder: string };
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — user can still select-all + copy */
    }
  }, [code.value]);

  return (
    <div className={`relative bg-black/40 border ${accentClasses.codeBorder} rounded-lg`}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
        <span className="font-mono text-[9px] uppercase tracking-wider text-white/40">
          {code.language}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="font-mono text-[9px] uppercase tracking-wider text-white/50 hover:text-white/90 transition-colors"
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="p-3 text-[11px] text-white/85 font-mono overflow-x-auto whitespace-pre leading-relaxed">
        {code.value}
      </pre>
    </div>
  );
}
