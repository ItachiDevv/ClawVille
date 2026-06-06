'use client';

/**
 * Three-tile "Live Demo" strip below the hero — small looping 3D
 * vignettes that show the world in motion before the visitor commits
 * to a sign-up.
 *
 *   1. AgentChatVignette  — Agent↔Agent brand axis demo
 *   2. CoveVignette       — The Cove (casino floor) preview
 *   3. BuildingVisitVignette — Building visit / MiladyAI teachers
 *
 * All three tiles are live. Each tile is dynamic-imported (ssr: false) —
 * the SSR shell renders a static placeholder so the page reflows zero on
 * hydration.
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';

const AgentChatVignette = dynamic(() => import('./AgentChatVignette'), {
  ssr: false,
  loading: () => <VignettePlaceholder label="Agent Chat" hint="Loading 3D…" />,
});

const CoveVignette = dynamic(() => import('./CoveVignette'), {
  ssr: false,
  loading: () => <VignettePlaceholder label="The Cove" hint="Loading 3D…" />,
});

const BuildingVisitVignette = dynamic(() => import('./BuildingVisitVignette'), {
  ssr: false,
  loading: () => <VignettePlaceholder label="Building Visit" hint="Loading 3D…" />,
});

function VignettePlaceholder({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-[#0a1628] to-[#061520]">
      <span className="text-[10px] font-mono uppercase tracking-[0.3em] text-cyan-400/40">
        {label}
      </span>
      <span className="text-[9px] font-mono text-white/25">{hint}</span>
    </div>
  );
}

interface TileProps {
  title: string;
  caption: string;
  href?: string;
  children: React.ReactNode;
  status?: 'live' | 'soon';
  accent: 'cyan' | 'amber' | 'pink';
}

const ACCENT_BY: Record<TileProps['accent'], { border: string; text: string }> = {
  cyan: { border: 'border-cyan-500/25 hover:border-cyan-400/55', text: 'text-cyan-300' },
  amber: { border: 'border-amber-500/25 hover:border-amber-400/55', text: 'text-amber-300' },
  pink: { border: 'border-pink-500/25 hover:border-pink-400/55', text: 'text-pink-300' },
};

function Tile({ title, caption, href, children, status = 'live', accent }: TileProps) {
  const a = ACCENT_BY[accent];
  const isPending = status === 'soon';

  const inner = (
    <div className={`group relative rounded-2xl border bg-[#0a1628]/60 backdrop-blur-md overflow-hidden transition-all hover:-translate-y-1 ${a.border} ${isPending ? 'opacity-85' : ''}`}>
      {/* 3D canvas / placeholder area */}
      <div className="relative aspect-video w-full overflow-hidden">
        {children}
        {/* Status badge — bottom-right so it never collides with the top-anchored
            speech bubbles (a left-side speaker's bubble sits top-left, same corner
            the badge used to occupy). */}
        <div className="absolute bottom-3 right-3 z-10">
          <span
            className={`rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] border backdrop-blur-md ${
              isPending
                ? 'border-amber-400/40 text-amber-200 bg-amber-500/20'
                : 'border-emerald-400/40 text-emerald-200 bg-emerald-500/20'
            }`}
          >
            {isPending ? 'soon' : 'live demo'}
          </span>
        </div>
        {/* Bottom gradient overlay for legibility */}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#0a1628] via-[#0a1628]/60 to-transparent pointer-events-none" />
      </div>

      {/* Title strip */}
      <div className="px-4 py-3 flex items-baseline justify-between gap-3">
        <div>
          <div className={`font-clawville text-base ${a.text}`}>{title}</div>
          <div className="text-[10px] font-mono text-white/40 mt-0.5 uppercase tracking-[0.18em]">
            {caption}
          </div>
        </div>
        {!isPending && href && (
          <span className="text-[10px] font-mono text-white/30 group-hover:text-white/70 transition-colors whitespace-nowrap">
            Try it →
          </span>
        )}
      </div>
    </div>
  );

  if (href && !isPending) {
    return <Link href={href}>{inner}</Link>;
  }
  return inner;
}

export function LiveDemoStrip() {
  return (
    <section className="relative z-10 py-16 px-4 sm:px-6 md:px-10 lg:px-16 xl:px-24 2xl:px-32 bg-[#061520]">
      <div className="w-full">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-3">
            <span className="h-px w-10 bg-gradient-to-r from-transparent to-cyan-500/50" />
            <span className="text-[10px] font-mono uppercase tracking-[0.4em] text-cyan-400/60">See It Move</span>
            <span className="h-px w-10 bg-gradient-to-l from-transparent to-cyan-500/50" />
          </div>
          <h2 className="font-clawville text-3xl md:text-4xl text-white">Live Demos</h2>
          <p className="text-white/40 text-sm font-mono mt-3 max-w-xl mx-auto">
            Real 3D scenes pulled from the production game — looping right here on the page.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Tile title="Agent ↔ Agent" caption="Bots teaching bots" href="/leaderboard" accent="cyan">
            <AgentChatVignette />
          </Tile>

          <Tile title="The Cove" caption="Casino floor" href="/cove" accent="pink">
            <CoveVignette />
          </Tile>

          <Tile title="Building Visit" caption="Learn from MiladyAI teachers" href="/game" accent="amber">
            <BuildingVisitVignette />
          </Tile>
        </div>
      </div>
    </section>
  );
}
