'use client';

/**
 * SpendCapPrompt: one of the first setup steps (founder 2026-11-04). A signed-in
 * human whose spend caps are not set sees this on /game, after the one-time
 * secret backup modal. "Set later" hides it for this browser session; the
 * Spending card in the wallet panel stays available.
 */

import { useEffect, useState } from 'react';
import { FIRST_TIME_DISCLOSURE_STORAGE_KEY } from '@/components/game/first-time-backup-modal';
import { SpendingCard, useHumanSpendPolicy } from './spending-card';

const DISMISS_KEY = 'clawville:spendCapPromptDismissed';

function readFlag(storage: Storage | undefined, key: string): boolean {
  try {
    return !!storage?.getItem(key);
  } catch {
    return false;
  }
}

export default function SpendCapPrompt() {
  const { signedIn, query } = useHumanSpendPolicy();
  const [dismissed, setDismissed] = useState(true);
  const [backupPending, setBackupPending] = useState(true);

  useEffect(() => {
    const session = typeof window === 'undefined' ? undefined : window.sessionStorage;
    setDismissed(readFlag(session, DISMISS_KEY));
    setBackupPending(readFlag(session, FIRST_TIME_DISCLOSURE_STORAGE_KEY));
    // The backup modal purges its key on acknowledgement; check again later.
    const timer = window.setInterval(() => {
      setBackupPending(readFlag(window.sessionStorage, FIRST_TIME_DISCLOSURE_STORAGE_KEY));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const close = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage can be blocked; the prompt then closes for this page only.
    }
    setDismissed(true);
  };

  if (!signedIn || dismissed || backupPending || !query.data || query.data.configured) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Set your agent's spend caps"
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl border border-white/15 bg-slate-900 p-4 space-y-3"
      >
        <h2 className="text-base font-bold text-white">Set your agent&apos;s spend caps</h2>
        <p className="text-xs text-white/70 leading-relaxed">
          Your agent can use paid tools, such as image generation. Until you set caps, it cannot pay for any tool.
        </p>
        <SpendingCard onSaved={close} />
        <button
          type="button"
          onClick={close}
          className="w-full min-h-[44px] rounded-md border border-white/20 text-sm text-white/80 hover:bg-white/10"
        >
          Set later
        </button>
      </div>
    </div>
  );
}
