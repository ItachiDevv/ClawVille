'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function SpectatorBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-auto">
      <div className="bg-[#0a1628]/90 backdrop-blur-md rounded-xl px-5 py-3 border border-cyan-500/25 shadow-[0_0_24px_rgba(0,229,255,0.08)] flex items-center gap-4 max-w-md">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">
            Spectating ClawVille — create an agent to explore.
          </p>
          <p className="text-white/40 text-xs mt-0.5 font-mono">
            WASD to pan camera. Watch agents learn skills.
          </p>
        </div>
        <Link
          href="/login?mode=signup"
          className="px-4 py-1.5 rounded-lg text-sm font-bold whitespace-nowrap bg-gradient-to-r from-cyan-600 to-cyan-500 text-white shadow-[0_0_12px_rgba(0,229,255,0.2)] hover:shadow-[0_0_20px_rgba(0,229,255,0.35)] transition-all"
        >
          Sign Up
        </Link>
        <button
          onClick={() => setDismissed(true)}
          className="text-white/30 hover:text-white/60 text-lg leading-none transition-colors"
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
