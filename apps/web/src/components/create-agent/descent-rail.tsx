'use client';

/**
 * DescentRail — the depth gauge that ties the sign-up flow together.
 *
 * The flow IS a descent: enter the water (/login), forge a body
 * (/create-agent), give it a soul (/create-agent/personality). The rail is a
 * thin instrument gauge fixed to the left edge on desktop, with the current
 * stage lit by a pulsing amber lure. On small screens it collapses into a
 * compact horizontal step strip rendered in flow at the top of the page.
 *
 * Purely presentational — stages are labels, not links (the flow has its own
 * navigation and step 2 → 1 back-nav goes through sessionStorage hydration).
 */

export type DescentStage = 1 | 2 | 3;

const STAGES: { depth: string; name: string }[] = [
  { depth: '0m', name: 'Surface' },
  { depth: '-120m', name: 'The Forge' },
  { depth: '-400m', name: 'The Soul' },
];

export function DescentRail({ stage }: { stage: DescentStage }) {
  return (
    <>
      {/* Desktop: fixed vertical gauge on the left edge. Shown only from
          1400px up — below that the forge's max-w-6xl content reaches the
          edges and the gauge labels would collide with it. */}
      <div
        className="pointer-events-none fixed left-5 top-1/2 z-20 hidden -translate-y-1/2 min-[1400px]:flex flex-col items-center"
        aria-hidden
      >
        <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/25 [writing-mode:vertical-rl] rotate-180 mb-3">
          descent
        </div>
        <div className="relative flex flex-col items-center">
          {/* Gauge line */}
          <div className="absolute inset-y-2 w-px bg-gradient-to-b from-cyan-300/30 via-white/10 to-transparent" />
          {STAGES.map((s, i) => {
            const n = (i + 1) as DescentStage;
            const isCurrent = n === stage;
            const isPast = n < stage;
            return (
              <div key={s.name} className="relative flex flex-col items-center py-6">
                <div className="relative flex items-center">
                  <div
                    className={
                      isCurrent
                        ? 'descent-lure h-2.5 w-2.5 rounded-full bg-[#ffb45e]'
                        : isPast
                          ? 'h-2 w-2 rounded-full bg-cyan-300/80 shadow-[0_0_8px_rgba(53,224,255,0.5)]'
                          : 'h-2 w-2 rounded-full border border-white/25 bg-transparent'
                    }
                  />
                  <div className="absolute left-5 whitespace-nowrap">
                    <div
                      className={`font-mono text-[9px] uppercase tracking-[0.25em] leading-tight ${
                        isCurrent ? 'text-[#ffcf94]' : isPast ? 'text-cyan-200/60' : 'text-white/25'
                      }`}
                    >
                      {s.depth}
                    </div>
                    <div
                      className={`font-mono text-[10px] uppercase tracking-[0.2em] leading-tight ${
                        isCurrent ? 'text-white/90' : isPast ? 'text-white/50' : 'text-white/25'
                      }`}
                    >
                      {s.name}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile / tablet / narrow desktop: compact step strip in flow */}
      <div className="mx-auto mb-5 flex w-fit items-center gap-3 min-[1400px]:hidden" aria-hidden>
        {STAGES.map((s, i) => {
          const n = (i + 1) as DescentStage;
          const isCurrent = n === stage;
          const isPast = n < stage;
          return (
            <div key={s.name} className="flex items-center gap-3">
              {i > 0 && <div className="h-px w-6 bg-white/15" />}
              <div className="flex items-center gap-1.5">
                <div
                  className={
                    isCurrent
                      ? 'descent-lure h-2 w-2 rounded-full bg-[#ffb45e]'
                      : isPast
                        ? 'h-1.5 w-1.5 rounded-full bg-cyan-300/80'
                        : 'h-1.5 w-1.5 rounded-full border border-white/25'
                  }
                />
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.2em] ${
                    isCurrent ? 'text-white/90' : isPast ? 'text-white/50' : 'text-white/30'
                  }`}
                >
                  {s.name}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
