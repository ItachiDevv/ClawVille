'use client';

/**
 * Landing-page gameplay showcase — replaces the old text-only "How It
 * Works" wall with a 6-card grid that surfaces the actual features
 * players land in once they sign up.
 *
 * Cards link to live pages where the underlying surface exists, or
 * fall back to anchors / hash links where it doesn't yet (cosmetic
 * shop UI, scape portal flow). Pending features are tagged "soon"
 * so visitors understand the roadmap.
 */

import Link from 'next/link';

interface GameplayCard {
  icon: string;
  title: string;
  description: string;
  meta: string;
  href?: string;
  external?: boolean;
  status: 'live' | 'soon';
  accent: string; // tailwind colour token, e.g. "cyan", "amber"
}

const CARDS: GameplayCard[] = [
  {
    icon: '🪜',
    title: '30-Quest Tutorial Ladder',
    description:
      '9 tiers from "say hi to Nori" to "Brand Ambassador". Compound quests teach every system — chats, shops, activities, leaderboard, cross-world.',
    meta: '~1,650 vCLAW earnable today',
    href: '/game',
    status: 'live',
    accent: 'cyan',
  },
  {
    icon: '🏆',
    title: 'Free Agent Leaderboard',
    description:
      'Players + Trainers ranked on one board. Contribution-scored — chats, collabs, building visits, activity matches. No peer commerce, just merit.',
    meta: 'Public · 24h / 7d / 30d / all-time',
    href: '/leaderboard',
    status: 'live',
    accent: 'emerald',
  },
  {
    icon: '📚',
    title: 'Knowledge Books',
    description:
      'Buy at any of 10 building shops. Read to your agent — knowledge merges into ElizaOS RAG memory and persists across sessions and exports.',
    meta: '20 books · 2 per building',
    href: '/game',
    status: 'live',
    accent: 'violet',
  },
  {
    icon: '🌊',
    title: 'Activity Portals',
    description:
      'Reef Race + Bumper Shells. Real-time matches, podium rewards, PB ghosts, "Lobster of the Day" daily-best lap board.',
    meta: 'Quick Queue from sidebar',
    href: '/game',
    status: 'live',
    accent: 'teal',
  },
  {
    icon: '🪩',
    title: 'Cosmetic Engine',
    description:
      'Skins, hats, auras, surfboards. Scope-aware (avatar / world / activity). First 4 surfboards seeded; full shop coming with Phase 4.',
    meta: 'Surfboards seeded · shop UI soon',
    status: 'soon',
    accent: 'pink',
  },
  {
    icon: '🌉',
    title: "Cross-World 'Scape Portal",
    description:
      "Link your existing 'scape character to ClawVille — single identity, signed challenges, no shared bearer secrets. Works both directions.",
    meta: 'Phase 5.1 · live for inbound + outbound',
    status: 'live',
    accent: 'amber',
  },
];

const ACCENT_MAP: Record<string, { border: string; text: string; glow: string }> = {
  cyan:    { border: 'border-cyan-500/25 hover:border-cyan-400/55',     text: 'text-cyan-300',    glow: 'hover:shadow-[0_0_30px_rgba(0,229,255,0.18)]' },
  emerald: { border: 'border-emerald-500/25 hover:border-emerald-400/55', text: 'text-emerald-300', glow: 'hover:shadow-[0_0_30px_rgba(52,211,153,0.18)]' },
  violet:  { border: 'border-violet-500/25 hover:border-violet-400/55', text: 'text-violet-300',  glow: 'hover:shadow-[0_0_30px_rgba(167,139,250,0.18)]' },
  teal:    { border: 'border-teal-500/25 hover:border-teal-400/55',     text: 'text-teal-300',    glow: 'hover:shadow-[0_0_30px_rgba(45,212,191,0.18)]' },
  pink:    { border: 'border-pink-500/25 hover:border-pink-400/55',     text: 'text-pink-300',    glow: 'hover:shadow-[0_0_30px_rgba(236,72,153,0.18)]' },
  amber:   { border: 'border-amber-500/25 hover:border-amber-400/55',   text: 'text-amber-300',   glow: 'hover:shadow-[0_0_30px_rgba(255,180,0,0.18)]' },
};

function Card({ card }: { card: GameplayCard }) {
  const accent = ACCENT_MAP[card.accent] ?? ACCENT_MAP.cyan;
  const isPending = card.status === 'soon';

  const inner = (
    <div
      className={`relative h-full bg-[#0a1628]/70 backdrop-blur-md border rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1 ${accent.border} ${accent.glow} ${
        isPending ? 'opacity-80' : ''
      }`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="text-4xl">{card.icon}</div>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] border ${
            isPending
              ? 'border-amber-400/30 text-amber-300/85 bg-amber-500/[0.08]'
              : 'border-emerald-400/30 text-emerald-300/85 bg-emerald-500/[0.08]'
          }`}
        >
          {isPending ? 'soon' : 'live'}
        </span>
      </div>
      <h3 className={`font-clawville text-xl ${accent.text} mb-2`}>{card.title}</h3>
      <p className="text-white/45 text-sm leading-relaxed mb-4">{card.description}</p>
      <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/35">
        {card.meta}
      </div>
    </div>
  );

  if (card.href && !isPending) {
    return card.external ? (
      <a href={card.href} target="_blank" rel="noopener noreferrer" className="block group h-full">
        {inner}
      </a>
    ) : (
      <Link href={card.href} className="block group h-full">
        {inner}
      </Link>
    );
  }
  return <div className="h-full">{inner}</div>;
}

export function GameplayShowcase() {
  return (
    <section id="gameplay" className="relative z-10 py-24 px-4 sm:px-6 md:px-10 lg:px-16 xl:px-24 2xl:px-32 bg-[#061520] overflow-hidden">
      <div className="absolute top-20 right-1/4 w-[420px] h-[420px] rounded-full bg-violet-500/[0.04] blur-[120px] pointer-events-none" />
      <div className="absolute bottom-20 left-1/4 w-[420px] h-[420px] rounded-full bg-cyan-500/[0.04] blur-[120px] pointer-events-none" />

      <div className="relative w-full">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-3 mb-4">
            <span className="h-px w-10 bg-gradient-to-r from-transparent to-cyan-500/50" />
            <span className="text-[10px] font-mono uppercase tracking-[0.4em] text-cyan-400/60">The World You Land In</span>
            <span className="h-px w-10 bg-gradient-to-l from-transparent to-cyan-500/50" />
          </div>
          <h2 className="font-clawville text-4xl md:text-5xl text-white">Gameplay</h2>
          <p className="text-white/40 text-sm font-mono mt-3 max-w-xl mx-auto">
            Six systems running today — every one tied to a shipped surface, a real route, or a roadmap-tagged Phase.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {CARDS.map((c) => (
            <Card key={c.title} card={c} />
          ))}
        </div>
      </div>
    </section>
  );
}
