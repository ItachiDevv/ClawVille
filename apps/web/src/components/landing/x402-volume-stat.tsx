'use client';

import { useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const ANIMATION_DURATION_MS = 1_200;

const compactUsdFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const standardUsdFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  const formatted = value >= 10_000
    ? compactUsdFormatter.format(value)
    : standardUsdFormatter.format(value);

  return `$${formatted}`;
}

export function X402VolumeStat() {
  const [displayedTotal, setDisplayedTotal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let animationFrame: number | null = null;
    let active = true;

    const loadTotal = async () => {
      try {
        const response = await fetch(`${API_URL}/api/x402/stats`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('x402_stats_unavailable');

        const payload: unknown = await response.json();
        if (
          typeof payload !== 'object'
          || payload === null
          || !('totalUsd' in payload)
          || typeof payload.totalUsd !== 'number'
          || !Number.isFinite(payload.totalUsd)
          || payload.totalUsd < 0
        ) {
          throw new Error('x402_stats_invalid');
        }
        if (!active) return;

        const target = payload.totalUsd;
        const startedAt = performance.now();
        setDisplayedTotal(0);
        setLoaded(true);

        const animate = (now: number) => {
          if (!active) return;

          const progress = Math.min((now - startedAt) / ANIMATION_DURATION_MS, 1);
          const eased = 1 - (1 - progress) ** 3;
          setDisplayedTotal(target * eased);

          if (progress < 1) {
            animationFrame = requestAnimationFrame(animate);
          }
        };

        animationFrame = requestAnimationFrame(animate);
      } catch {
        if (!controller.signal.aborted) {
          setDisplayedTotal(null);
          setLoaded(false);
        }
      }
    };

    void loadTotal();

    return () => {
      active = false;
      controller.abort();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div className="group">
      <div className="font-clawville text-2xl md:text-3xl text-white drop-shadow-[0_0_20px_rgba(0,229,255,0.25)]">
        {loaded && displayedTotal !== null ? formatUsd(displayedTotal) : '—'}
      </div>
      <div className="text-[9px] font-mono uppercase tracking-[0.25em] text-cyan-400/60 mt-1">x402 Volume</div>
      <div className="text-[9px] font-mono text-white/30 mt-0.5">
        {loaded ? 'All-time · USDC settled' : 'USDC settled'}
      </div>
    </div>
  );
}
