'use client';

import { useEffect, useState } from 'react';

/**
 * Phase 6.7.5 — one-shot toast that surfaces the "claimed N guest plays"
 * message after a signup. The login page writes the message text into
 * `sessionStorage['cv-cove-claim-toast']`; this component reads + clears
 * it on first mount of any subsequent page, so the user sees the
 * confirmation regardless of where they land after signup.
 *
 * Implemented as a tiny self-contained pill (light text on dark inset)
 * to avoid pulling in a toast library. Auto-dismiss after 6s, manual
 * dismiss on click.
 */
const STORAGE_KEY = 'cv-cove-claim-toast';

export function CoveClaimToast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        setMessage(stored);
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // SSR / disabled storage — nothing to do
    }
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;

  return (
    <div
      onClick={() => setMessage(null)}
      style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: 'rgba(10,22,40,0.96)',
        border: '1px solid rgba(0,255,224,0.6)',
        color: '#e0fff8',
        padding: '12px 20px',
        borderRadius: 10,
        fontSize: 13,
        fontFamily: 'monospace',
        letterSpacing: '0.02em',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 0 24px rgba(0,229,255,0.25)',
        cursor: 'pointer',
        maxWidth: 'min(520px, 92vw)',
        lineHeight: 1.5,
      }}
      role="status"
      aria-live="polite"
    >
      <span style={{ color: 'rgba(0,255,224,0.85)', marginRight: 8 }}>✓</span>
      {message}
    </div>
  );
}
