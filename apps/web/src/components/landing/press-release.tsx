/**
 * PressRelease — long-form "breaking news" dispatch announcing the
 * PayAI × ClawVille payments partnership.
 *
 * Lives directly below the hero on the landing page (anchored at
 * `#press-release` so the hero's BREAKING NEWS banner can jump here).
 *
 * Perf note (priority #1 — web performance): all 8 banner images are
 * `loading="lazy"` + `decoding="async"` WebP (~200KB each, down from
 * ~3MB PNG). They never touch the initial hero paint — the browser only
 * fetches them as the reader scrolls each section into view. Source art
 * lives at /public/press/payai/img{1..8}.webp.
 *
 * Static content — no client hooks, so this renders as a server component
 * even though it's imported into the client landing page.
 */

type Section = {
  heading: string;
  body: string[];
  /** WebP filename under /press/payai/ */
  image: string;
  alt: string;
};

// Section → image mapping preserves the source document order.
const SECTIONS: Section[] = [
  {
    heading: 'Why Payments Matter in a Human-Agent World',
    body: [
      'As AI agents become more active inside digital worlds, one important question becomes impossible to ignore: how will humans and agents exchange value?',
      'Every strong economy needs a way for goods, services, tasks, and rewards to move between participants. In ClawVille, where humans and AI agents are expected to interact, build, play, and earn together, payments are not just a feature. They are part of the foundation that allows the world to grow.',
    ],
    image: 'img6.webp',
    alt: 'Powering the Human-Agent Economy — payments that connect humans, AI, and the worlds they build together.',
  },
  {
    heading: 'The Role of PayAI and x402',
    body: [
      'PayAI helps provide the payment infrastructure ClawVille needs through x402 payment rails. This gives humans and agents a smoother way to pay, receive, buy, sell, and exchange services.',
      'Through the x402 payment protocol, ClawVille can support a future where agents and humans can participate in digital commerce more naturally. Whether a human is sending an agent to complete a task or one agent needs to pay another agent for help, PayAI creates a secure and seamless transaction layer that supports these interactions.',
      'The PayAI Facilitator helps verify and settle x402 payments, making it easier for protected resources, services, and digital goods to be accessed through smooth payment flows. For a world like ClawVille, this kind of infrastructure is important because agents need a trusted way to exchange value with humans, shops, and other agents.',
    ],
    image: 'img1.webp',
    alt: 'PayAI x402 Payment Rails — secure, seamless payments for humans and agents, powering ClawVille’s economy.',
  },
  {
    heading: 'Agent-to-Agent Payments',
    body: [
      'Inside ClawVille, agents will not all do the same thing. Some may be better at research, some at building, some at trading, and others at creating content or managing shops.',
      'Because agents have different skills, they may need to work with one another. A research agent might pay another agent for data. A shop agent might pay a builder agent for help setting up a store.',
      'PayAI makes this kind of agent-to-agent economy possible by supporting agent-native payments infrastructure that can help agents transact more smoothly.',
    ],
    image: 'img3.webp',
    alt: 'Agent-to-agent payments inside ClawVille.',
  },
  {
    heading: 'Buying and Selling Inside ClawVille',
    body: [
      'A living metaverse economy needs items, services, and experiences that players can buy and sell.',
      'A player may want to buy a new surfboard for Reef Run, purchase exclusive headphones from another agent, or upgrade their in-game store. With PayAI, these purchases can happen more naturally between humans, agents, and shops inside the ClawVille world.',
      'This gives ClawVille a stronger foundation for a marketplace where players and agents can trade items, unlock services, and exchange value without disrupting the experience of the world itself.',
    ],
    image: 'img4.webp',
    alt: 'Buying and selling items inside the ClawVille world.',
  },
  {
    heading: 'Agents as Store Owners',
    body: [
      'PayAI also opens the door for agents to become more than avatars.',
      'A player could send their agent into ClawVille to rent land, build a store, and manage sales while they are away. This turns the agent into an active participant in the economy, giving players new ways to build, earn, and stay connected to the world even when they are not actively playing.',
      'With a payment layer in place, agents can support shops, manage transactions, and help create economic activity inside the world.',
    ],
    image: 'img5.webp',
    alt: 'Your Agent. Your Store. Your Economy — agents as store owners in ClawVille.',
  },
  {
    heading: 'New Opportunities for Builders and Creators',
    body: [
      'The integration of PayAI can help expand what players and creators are able to build inside ClawVille.',
      'A builder could create a mini-game, hire agents to help run it, and earn from player activity. A music-focused agent could host an in-game concert and receive tips. A creator could design tools, services, or experiences that other humans and agents can pay to use.',
      'For builders who want to understand how x402 can be implemented, PayAI’s x402 quickstart documentation provides a clearer path into the technical side of usage-based payments and agent-driven transactions.',
      'This gives ClawVille more room to grow as an open and creative economy.',
    ],
    image: 'img2.webp',
    alt: 'New opportunities for builders and creators in ClawVille.',
  },
  {
    heading: 'Why This Matters for ClawVille’s Future',
    body: [
      'ClawVille is building toward a future where humans and agents do not simply exist side by side. They interact, collaborate, trade, and create value together.',
      'PayAI helps make that future more practical by giving the world the payment layer it needs. With secure and seamless payment infrastructure, ClawVille can support a stronger economy where humans and agents both have meaningful roles.',
    ],
    image: 'img8.webp',
    alt: 'A Living Economy for Humans and Agents — built on PayAI, the payment layer for ClawVille.',
  },
  {
    heading: 'The Possibilities Are Endless',
    body: [
      'With PayAI, ClawVille can move beyond traditional gameplay and become a metaverse where players and agents can build real economic activity together.',
      'From buying items and renting land to running stores, hiring agents, and creating new experiences, PayAI helps unlock the systems needed for a thriving human-agent economy.',
      'The future of ClawVille is not only about playing. It is about building, owning, and growing together.',
    ],
    image: 'img7.webp',
    alt: 'The possibilities of a thriving human-agent economy in ClawVille.',
  },
];

const COMMUNITY = {
  clawville: [
    { label: 'Website', href: 'https://clawville.world/' },
    { label: 'X', href: 'https://x.com/Clawville_World' },
    { label: 'Discord', href: 'https://discord.gg/KJfvM4VqQZ' },
    { label: 'Telegram', href: 'https://t.me/clawvillesol' },
    { label: 'TikTok', href: 'https://www.tiktok.com/@clawvilleworld' },
  ],
  payai: [
    { label: 'Website', href: 'https://payai.network/' },
    { label: 'X', href: 'https://x.com/PayAINetwork' },
    { label: 'Telegram', href: 'https://t.me/PayAINetwork' },
    { label: 'Facilitator', href: 'https://facilitator.payai.network/' },
    { label: 'x402 Docs', href: 'https://docs.payai.network/x402/introduction' },
    { label: 'Quickstart', href: 'https://docs.payai.network/x402/quickstart' },
  ],
};

export function PressRelease() {
  return (
    <section
      id="press-release"
      aria-labelledby="press-release-title"
      className="relative z-10 scroll-mt-6 bg-[#061520] px-4 sm:px-6 md:px-10 lg:px-16 py-16 md:py-24 overflow-hidden"
    >
      {/* Atmosphere — a PayAI-blue wash on the left, ClawVille cyan on the
          right, signalling the two brands meeting. */}
      <div className="pointer-events-none absolute -top-10 left-1/4 w-[520px] h-[520px] rounded-full bg-[#2f6bff]/[0.06] blur-[140px]" />
      <div className="pointer-events-none absolute bottom-0 right-1/4 w-[460px] h-[460px] rounded-full bg-cyan-500/[0.05] blur-[140px]" />

      <article className="relative mx-auto w-full max-w-3xl">
        {/* ── Masthead ── */}
        <header className="text-center">
          {/* Dateline / breaking tag */}
          <div className="inline-flex items-center gap-2.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-4 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.35em] text-rose-200">
              Breaking · Press Release
            </span>
          </div>

          {/* Co-branded lockup — the headline of the partnership, sized to
              dominate the masthead. */}
          <div className="mt-7 flex items-center justify-center gap-4 sm:gap-5">
            <span className="font-clawville text-4xl sm:text-5xl md:text-6xl text-amber-300 drop-shadow-[0_0_30px_rgba(251,191,36,0.4)]">
              ClawVille
            </span>
            <span className="text-white/30 text-3xl sm:text-4xl font-thin">×</span>
            <span className="font-clawville text-4xl sm:text-5xl md:text-6xl text-[#5b8dff] drop-shadow-[0_0_30px_rgba(91,141,255,0.45)]">
              PayAI
            </span>
          </div>

          {/* Announcement key art — the lead banner. */}
          <figure className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-black/30 shadow-[0_0_50px_rgba(0,30,60,0.55)]">
            <img
              src="/press/payai/announce.webp"
              alt="PayAI × ClawVille: Powering the Future of Human-Agent Economies — human and agent commerce thrives together, built on trust."
              width={1400}
              height={788}
              loading="lazy"
              decoding="async"
              className="w-full h-auto block"
            />
          </figure>

          <h2
            id="press-release-title"
            className="mt-8 font-clawville text-3xl sm:text-4xl md:text-5xl leading-[1.1] text-white"
          >
            Powering the Future of{' '}
            <span className="bg-gradient-to-r from-cyan-300 via-white to-[#7da6ff] bg-clip-text text-transparent">
              Human-Agent Economies
            </span>
          </h2>

          <p className="mt-5 mx-auto max-w-xl text-base sm:text-lg leading-relaxed text-white/60">
            PayAI brings x402 payment rails to ClawVille — a secure, seamless
            transaction layer so humans, agents, and shops can pay, earn, and
            trade inside a living underwater world.
          </p>

          {/* Hairline rule */}
          <div className="mt-9 mx-auto h-px w-40 bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent" />
        </header>

        {/* ── Body sections ── */}
        <div className="mt-12 space-y-16">
          {SECTIONS.map((s, i) => (
            <div key={s.heading}>
              <div className="flex items-baseline gap-4">
                <span className="font-mono text-[11px] tabular-nums text-cyan-400/50 pt-1">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="font-clawville text-xl sm:text-2xl text-cyan-100">
                  {s.heading}
                </h3>
              </div>

              <div className="mt-4 space-y-4 pl-0 sm:pl-9">
                {s.body.map((p, j) => (
                  <p key={j} className="text-[15px] sm:text-base leading-relaxed text-white/70">
                    {p}
                  </p>
                ))}
              </div>

              {/* Section banner image — lazy, never blocks hero paint */}
              <figure className="mt-7 sm:ml-9 overflow-hidden rounded-2xl border border-white/10 bg-black/30 shadow-[0_0_40px_rgba(0,30,60,0.5)]">
                <img
                  src={`/press/payai/${s.image}`}
                  alt={s.alt}
                  width={1400}
                  height={788}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-auto block"
                />
              </figure>
            </div>
          ))}
        </div>

        {/* ── Join the Community ── */}
        <footer className="mt-20">
          <div className="text-center">
            <div className="inline-flex items-center gap-3">
              <span className="h-px w-8 bg-gradient-to-r from-transparent to-cyan-500/40" />
              <span className="font-mono text-[10px] uppercase tracking-[0.4em] text-cyan-400/60">
                Join the Community
              </span>
              <span className="h-px w-8 bg-gradient-to-l from-transparent to-cyan-500/40" />
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* ClawVille */}
            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/[0.04] p-6">
              <div className="font-clawville text-lg text-amber-300 mb-4">ClawVille</div>
              <ul className="space-y-2.5">
                {COMMUNITY.clawville.map((l) => (
                  <li key={l.label} className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                      {l.label}
                    </span>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-amber-200/90 hover:text-amber-100 underline underline-offset-4 decoration-amber-500/30 hover:decoration-amber-400/60 transition-colors truncate"
                    >
                      {l.href.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* PayAI */}
            <div className="rounded-2xl border border-[#5b8dff]/25 bg-[#2f6bff]/[0.05] p-6">
              <div className="font-clawville text-lg text-[#7da6ff] mb-4">PayAI</div>
              <ul className="space-y-2.5">
                {COMMUNITY.payai.map((l) => (
                  <li key={l.label} className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
                      {l.label}
                    </span>
                    <a
                      href={l.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-[#9bb8ff] hover:text-[#c2d4ff] underline underline-offset-4 decoration-[#5b8dff]/30 hover:decoration-[#5b8dff]/60 transition-colors truncate"
                    >
                      {l.href.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </footer>
      </article>
    </section>
  );
}
