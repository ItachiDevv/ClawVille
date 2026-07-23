'use client';

import { useEffect, useState } from 'react';
import { checkForStaleClient } from '@/lib/stale-client-version';

const AUTO_RELOAD_SECONDS = 5;
const CHECK_TIMEOUT_MS = 2500;
const MESSAGE = 'A new version is live — refresh before your next race';

export function useStaleClientVersionCheck(checkKey: string | null): {
  stale: boolean;
  checked: boolean;
} {
  const [staleKey, setStaleKey] = useState<string | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);

  useEffect(() => {
    setStaleKey(null);
    if (!checkKey) {
      setCheckedKey(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(
      () => controller.abort(),
      CHECK_TIMEOUT_MS,
    );
    void checkForStaleClient(controller.signal)
      .then((mismatch) => {
        if (active) setStaleKey(mismatch ? checkKey : null);
      })
      .catch(() => {
        // Operational guard only: health/network failures must not block play.
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setCheckedKey(checkKey);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [checkKey]);

  return {
    stale: checkKey !== null && staleKey === checkKey,
    checked: checkKey !== null && checkedKey === checkKey,
  };
}

export default function StaleClientVersionBanner({
  stale,
  autoReload = false,
}: {
  stale: boolean;
  autoReload?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_RELOAD_SECONDS);

  useEffect(() => {
    setDismissed(false);
    setCountdown(AUTO_RELOAD_SECONDS);
  }, [stale]);

  useEffect(() => {
    if (!stale || !autoReload || dismissed) return;

    let seconds = AUTO_RELOAD_SECONDS;
    const timer = window.setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        window.clearInterval(timer);
        window.location.reload();
        return;
      }
      setCountdown(seconds);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoReload, dismissed, stale]);

  if (!stale || dismissed) return null;

  return (
    <div
      role="status"
      data-testid="stale-client-version-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginBottom: 12,
        padding: '8px 10px',
        background: 'rgba(251, 191, 36, 0.12)',
        border: '1px solid rgba(251, 191, 36, 0.48)',
        borderRadius: 6,
        color: '#fde68a',
        fontSize: 11,
        lineHeight: 1.35,
      }}
    >
      <span style={{ flex: '1 1 230px' }}>{MESSAGE}</span>
      {autoReload && (
        <span aria-live="polite" style={{ color: '#fef3c7' }}>
          Refreshing in {countdown}s
        </span>
      )}
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={buttonStyle}
      >
        Refresh
      </button>
      <button
        type="button"
        aria-label="Dismiss new version notice"
        onClick={() => setDismissed(true)}
        style={{ ...buttonStyle, borderColor: 'transparent' }}
      >
        Dismiss
      </button>
    </div>
  );
}

const buttonStyle = {
  padding: '4px 8px',
  background: 'rgba(15, 23, 42, 0.55)',
  border: '1px solid rgba(253, 230, 138, 0.7)',
  borderRadius: 4,
  color: '#fef3c7',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 10,
  fontWeight: 700,
} as const;
