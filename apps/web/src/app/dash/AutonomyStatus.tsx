'use client';

import { useCallback, useEffect, useState } from 'react';

export interface AutonomyStandbyState {
  mode: 'active' | 'standby';
  armedUntil: number | null;
  defaultMode: 'active' | 'standby';
}

export interface AutonomyDashboardState extends AutonomyStandbyState {
  counts: {
    house: number;
    user: number;
    total: number;
  };
}

interface AutonomyStatusProps {
  initialState: AutonomyDashboardState | null;
  initialError: string | null;
}

function hasStandbyState(value: unknown): value is AutonomyStandbyState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.mode === 'active' || candidate.mode === 'standby') &&
    (candidate.defaultMode === 'active' || candidate.defaultMode === 'standby') &&
    (candidate.armedUntil === null || typeof candidate.armedUntil === 'number')
  );
}

function hasCounts(value: unknown): value is AutonomyDashboardState['counts'] {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.house === 'number' &&
    typeof candidate.user === 'number' &&
    typeof candidate.total === 'number'
  );
}

function formatArmedUntil(armedUntil: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(armedUntil));
}

export function AutonomyStatus({ initialState, initialError }: AutonomyStatusProps) {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState<'arm' | 'standby' | null>(null);
  const [error, setError] = useState(initialError);

  const applyPayload = useCallback((payload: unknown) => {
    const record = payload as Record<string, unknown>;
    if (!hasStandbyState(record)) {
      throw new Error('The autonomy endpoint returned an invalid response.');
    }
    setState((previous) => {
      const counts = hasCounts(record.counts)
        ? record.counts
        : previous?.counts ?? { house: 0, user: 0, total: 0 };
      return {
        mode: record.mode,
        armedUntil: record.armedUntil,
        defaultMode: record.defaultMode,
        counts,
      };
    });
  }, []);

  const refresh = useCallback(async () => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
    if (!apiBase) {
      setError('NEXT_PUBLIC_API_URL is not configured.');
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/dashboard/autonomy`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Autonomy status returned ${response.status}.`);
      }
      applyPayload(await response.json());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [applyPayload]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (state?.mode !== 'active' || state.armedUntil === null) return;
    const delay = Math.max(0, state.armedUntil - Date.now() + 250);
    const timeout = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timeout);
  }, [refresh, state?.armedUntil, state?.mode]);

  async function changeMode(action: 'arm' | 'standby') {
    if (pending) return;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? '';
    if (!apiBase) {
      setError('NEXT_PUBLIC_API_URL is not configured.');
      return;
    }
    setPending(action);
    setError(null);
    try {
      const response = await fetch(
        `${apiBase}/api/dashboard/autonomy/${action}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: action === 'arm' ? { 'Content-Type': 'application/json' } : undefined,
          body: action === 'arm' ? JSON.stringify({ minutes: 120 }) : undefined,
        },
      );
      if (!response.ok) {
        throw new Error(`Autonomy ${action} returned ${response.status}.`);
      }
      applyPayload(await response.json());
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(null);
    }
  }

  const active = state?.mode === 'active';
  const modeLabel = state ? (active ? 'ACTIVE' : 'STANDBY') : 'UNAVAILABLE';

  return (
    <section
      aria-labelledby="autonomy-status-heading"
      className="mb-6 rounded-lg border border-slate-800 bg-slate-900 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="autonomy-status-heading" className="sr-only">
            Agent autonomy controls
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span
              role="status"
              aria-live="polite"
              className={`rounded-full border px-2.5 py-1 font-mono text-xs font-semibold ${
                state === null
                  ? 'border-slate-600 bg-slate-800 text-slate-200'
                  : active
                  ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
                  : 'border-amber-400/30 bg-amber-400/10 text-amber-200'
              }`}
            >
              Autonomy: {modeLabel}
              {active && state?.armedUntil !== null && state?.armedUntil !== undefined ? (
                <>
                  {' '}
                  (armed until{' '}
                  <time dateTime={new Date(state.armedUntil).toISOString()} suppressHydrationWarning>
                    {formatArmedUntil(state.armedUntil)}
                  </time>
                  )
                </>
              ) : null}
            </span>
            {state ? (
              <span className="font-mono text-[11px] text-slate-400">
                Driven: {state.counts.total} ({state.counts.house} house · {state.counts.user} hosted)
                {' · '}restart default: {state.defaultMode.toUpperCase()}
              </span>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="mt-2 font-mono text-[11px] text-red-300">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            disabled={pending !== null || state === null}
            onClick={() => void changeMode('arm')}
            className="rounded border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 font-mono text-xs text-cyan-100 transition-colors hover:bg-cyan-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === 'arm' ? 'Arming…' : 'Arm 2h'}
          </button>
          <button
            type="button"
            disabled={pending !== null || state === null}
            onClick={() => void changeMode('standby')}
            className="rounded border border-slate-600 bg-slate-800 px-3 py-1.5 font-mono text-xs text-slate-100 transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === 'standby' ? 'Stopping…' : 'Standby now'}
          </button>
        </div>
      </div>
    </section>
  );
}
