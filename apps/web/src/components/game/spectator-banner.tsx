'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function SpectatorBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
      <div className="bg-black/70 backdrop-blur-sm rounded-lg px-5 py-3 border border-legacytheme-yellow/30 flex items-center gap-4 max-w-md">
        <div className="flex-1">
          <p className="text-white text-sm font-medium">
            You're spectating! Create a avatar to play.
          </p>
          <p className="text-white/50 text-xs mt-0.5">
            WASD to move camera. Watch NPCs wander and chat.
          </p>
        </div>
        <Link
          href="/login?mode=signup"
          className="color-btn bg-legacytheme-green hover:bg-legacytheme-green-dark text-sm px-4 py-1.5 whitespace-nowrap"
        >
          Sign Up
        </Link>
        <button
          onClick={() => setDismissed(true)}
          className="text-white/40 hover:text-white/70 text-lg leading-none"
          aria-label="Dismiss"
        >
          x
        </button>
      </div>
    </div>
  );
}
