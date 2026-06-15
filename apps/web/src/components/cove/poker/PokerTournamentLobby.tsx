'use client';

/**
 * PokerTournamentLobby — registration + seating gate for a single MTT.
 *
 * Flow (human path; the agent path hits the SAME endpoints with the
 * `X-Clawville-Agent-Session` header from its own runtime — parity by
 * construction, see cove-poker-mtt.ts Rule E5 note):
 *
 *   1. GET  /api/cove/poker/mtt/:id            — status + standings (polled).
 *   2. POST /api/cove/poker/mtt/:id/register   — buy in (real CT debit).
 *   3. GET  /api/cove/poker/mtt/:id/connection — POLL until 200 (409 = not
 *      seated yet). On 200 → `{ roomId, shortCode, seatIndex, activityId }`.
 *   4. onSeated(conn) → parent mounts <PokerTable> on the live WS.
 *
 * The lobby owns the pre-seat lifecycle ONLY. Once seated it hands the
 * connection ticket up and unmounts.
 *
 * Iris Xe safe: pure DOM/CSS. Dark-panel text uses LIGHT tokens.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RuneFrame, RpgButton } from '@/components/rpg';
import ActivityTutorialCard, {
  shouldShowActivityTutorial,
} from '@/components/game/activity/ActivityTutorialCard';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

// ─── Server shapes (mirror cove-poker-mtt.ts responses) ──────────────────────

interface TournamentStatus {
  tournament: {
    id: string;
    name: string;
    status: string; // 'registering' | 'seating' | 'running' | 'settled' | 'cancelled' | ...
    buyInCt: string;
    rakeBps: number;
    minEntrants: number;
    maxEntrants: number;
    seatsPerTable: number;
    startingStack: number;
    prizePoolCt: string;
    rakeTakenCt: string | null;
    registrationClosesAt: string | null;
    startedAt: string | null;
    settledAt: string | null;
  };
  entrants: Array<{
    avatarId: string;
    agentId: string | null;
    subjectType: string;
    status: string;
    chipStack: number;
    seatIndex: number | null;
    placement: number | null;
  }>;
  results: Array<{ avatarId: string; placement: number; prizeCt: string }>;
}

export interface PokerConnectionTicket {
  roomId: string;
  shortCode: string;
  seatIndex: number;
  activityId: string;
}

export interface PokerTournamentLobbyProps {
  tournamentId: string;
  /** Our avatar id — used to detect "already registered" in the standings. */
  selfAvatarId: string | null;
  /** Fired once with the connection ticket the moment seating completes. */
  onSeated: (conn: PokerConnectionTicket) => void;
  /** Back-to-cove. */
  onLeave: () => void;
}

const STATUS_POLL_MS = 4000;
const CONNECTION_POLL_MS = 2000;

type Phase = 'loading' | 'idle' | 'registering' | 'waiting' | 'seating' | 'error';

export default function PokerTournamentLobby({
  tournamentId,
  selfAvatarId,
  onSeated,
  onLeave,
}: PokerTournamentLobbyProps) {
  const [status, setStatus] = useState<TournamentStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);
  const seatedRef = useRef(false);

  // ── Tutorial gate (first entry only) ────────────────────────────────────
  useEffect(() => {
    setShowTutorial(shouldShowActivityTutorial('texas-holdem-mtt'));
  }, []);

  // ── Status poll ─────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async (): Promise<TournamentStatus | null> => {
    try {
      const res = await fetch(`${API_BASE}/api/cove/poker/mtt/${tournamentId}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setErrorMsg(res.status === 404 ? 'Tournament not found' : `HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as TournamentStatus;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load tournament');
      return null;
    }
  }, [tournamentId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const data = await fetchStatus();
      if (cancelled) return;
      if (data) {
        setStatus(data);
        setErrorMsg(null);
        // Derive phase from registration vs our membership (unless we're
        // mid-register / waiting for seating, which the action handlers own).
        setPhase((prev) => {
          if (prev === 'registering' || prev === 'seating') return prev;
          const mine = selfAvatarId
            ? data.entrants.find((e) => e.avatarId === selfAvatarId)
            : undefined;
          if (mine) return 'waiting';
          return 'idle';
        });
      } else if (phase === 'loading') {
        setPhase('error');
      }
      if (!cancelled) timer = setTimeout(tick, STATUS_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStatus, selfAvatarId]);

  // ── Connection poll — starts once we're a registered entrant ────────────
  const pollConnection = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(
        `${API_BASE}/api/cove/poker/mtt/${tournamentId}/connection`,
        { credentials: 'include' },
      );
      if (res.status === 409) return false; // not seated yet — keep polling
      if (!res.ok) return false;
      const conn = (await res.json()) as { ok: boolean } & PokerConnectionTicket;
      if (conn.roomId && conn.shortCode && typeof conn.seatIndex === 'number') {
        if (!seatedRef.current) {
          seatedRef.current = true;
          onSeated({
            roomId: conn.roomId,
            shortCode: conn.shortCode,
            seatIndex: conn.seatIndex,
            activityId: conn.activityId || 'texas-holdem-mtt',
          });
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [tournamentId, onSeated]);

  const isRegistered = !!(
    selfAvatarId &&
    status?.entrants.some((e) => e.avatarId === selfAvatarId)
  );

  useEffect(() => {
    if (!isRegistered) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const seated = await pollConnection();
      if (cancelled || seated) return;
      timer = setTimeout(tick, CONNECTION_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isRegistered, pollConnection]);

  // ── Register action ──────────────────────────────────────────────────────
  const handleRegister = useCallback(async () => {
    setPhase('registering');
    setErrorMsg(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/cove/poker/mtt/${tournamentId}/register`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        const code = err.error || err.message || `HTTP ${res.status}`;
        if (res.status === 402) setErrorMsg('Not enough ClawTokens for the buy-in.');
        else if (res.status === 401) setErrorMsg('Sign in to enter the tournament.');
        else if (res.status === 403) setErrorMsg('Create an avatar before entering.');
        else setErrorMsg(code);
        setPhase('idle');
        return;
      }
      // Registered — refresh status + flip to waiting (connection poll fires
      // off the `isRegistered` effect once standings include us).
      const fresh = await fetchStatus();
      if (fresh) setStatus(fresh);
      setPhase('waiting');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Registration failed');
      setPhase('idle');
    }
  }, [tournamentId, fetchStatus]);

  // ── Derived display ──────────────────────────────────────────────────────
  const t = status?.tournament;
  const registeredCount = status?.entrants.length ?? 0;
  const buyIn = t ? Number(t.buyInCt) : 0;
  const prizePool = t ? Number(t.prizePoolCt) : 0;
  const startsAtLabel = t?.registrationClosesAt
    ? new Date(t.registrationClosesAt).toLocaleString()
    : null;
  const tournamentClosed =
    t?.status === 'running' ||
    t?.status === 'settled' ||
    t?.status === 'cancelled' ||
    t?.status === 'seating';
  const cancelled = t?.status === 'cancelled';

  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background:
          'radial-gradient(ellipse 80% 70% at 50% 30%, #0a3325 0%, #06140f 60%, #03090a 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflowY: 'auto',
      }}
    >
      <div style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Title */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              color: '#7cffcb',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 12,
              letterSpacing: '0.24em',
              textTransform: 'uppercase',
              marginBottom: 4,
            }}
          >
            Poker Tournament
          </div>
          <h1
            style={{
              color: '#f0fdf4',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 22,
              fontWeight: 800,
              margin: 0,
              textShadow: '0 0 18px rgba(124,255,203,0.4)',
            }}
          >
            {t?.name ?? 'Sit-N-Go'}
          </h1>
        </div>

        {/* Tutorial card (first entry) */}
        {showTutorial && (
          <ActivityTutorialCard
            activityId="texas-holdem-mtt"
            onDismiss={() => setShowTutorial(false)}
          />
        )}

        {/* Stats card */}
        <RuneFrame tier="epic" glow="subtle" style={{ padding: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Stat label="Buy-in" value={`${buyIn.toLocaleString()} CT`} accent="#fbbf24" />
            <Stat label="Prize pool" value={`${prizePool.toLocaleString()} CT`} accent="#7cffcb" />
            <Stat
              label="Registered"
              value={`${registeredCount}${t ? ` / ${t.maxEntrants}` : ''}`}
              accent="#f0fdf4"
            />
            <Stat
              label="Min to start"
              value={t ? String(t.minEntrants) : '—'}
              accent="#f0fdf4"
            />
            <Stat
              label="Starting stack"
              value={t ? `${t.startingStack.toLocaleString()} chips` : '—'}
              accent="#cbd5e1"
            />
            <Stat
              label="Status"
              value={t ? humanStatus(t.status) : 'Loading…'}
              accent={cancelled ? '#f87171' : '#7cffcb'}
            />
          </div>
          {startsAtLabel && (
            <div
              style={{
                marginTop: 12,
                fontSize: 11,
                color: 'rgba(203,213,225,0.8)',
                fontFamily: 'ui-monospace, monospace',
                textAlign: 'center',
              }}
            >
              Registration closes {startsAtLabel}
            </div>
          )}
        </RuneFrame>

        {/* Standings preview (registered entrants) */}
        {registeredCount > 0 && (
          <RuneFrame tier="rare" glow={false} style={{ padding: 14 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'rgba(124,255,203,0.7)',
                marginBottom: 8,
              }}
            >
              Entrants
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
              {status!.entrants.slice(0, 9).map((e, i) => (
                <div
                  key={e.avatarId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    fontFamily: 'ui-monospace, monospace',
                    color:
                      e.avatarId === selfAvatarId ? '#7cffcb' : 'rgba(226,232,240,0.85)',
                    padding: '2px 0',
                  }}
                >
                  <span>
                    {i + 1}. {e.avatarId === selfAvatarId ? 'You' : shortId(e.avatarId)}
                    {e.subjectType === 'agent' && (
                      <span style={{ color: '#a78bfa', marginLeft: 6 }}>· agent</span>
                    )}
                  </span>
                  <span style={{ color: 'rgba(148,184,170,0.8)' }}>
                    {e.placement != null
                      ? `#${e.placement}`
                      : e.chipStack > 0
                        ? `${e.chipStack.toLocaleString()} chips`
                        : 'registered'}
                  </span>
                </div>
              ))}
            </div>
          </RuneFrame>
        )}

        {/* Error */}
        {errorMsg && (
          <div
            style={{
              color: '#fca5a5',
              fontSize: 12,
              textAlign: 'center',
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          {cancelled ? (
            <div style={{ color: '#fca5a5', fontSize: 13, textAlign: 'center' }}>
              Tournament cancelled — every buy-in was refunded in full.
            </div>
          ) : isRegistered ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: '#7cffcb',
                fontSize: 13,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              <span className="cv-poker-spin" aria-hidden style={spinnerStyle} />
              {phase === 'seating'
                ? 'Seating you…'
                : 'Registered — waiting for the table to fill…'}
            </div>
          ) : (
            <RpgButton
              variant="primary"
              size="lg"
              loading={phase === 'registering'}
              disabled={phase === 'loading' || tournamentClosed || !t}
              onClick={handleRegister}
              style={{ minWidth: 220 }}
            >
              {tournamentClosed
                ? 'Registration closed'
                : `Register · ${buyIn.toLocaleString()} CT`}
            </RpgButton>
          )}

          <button
            type="button"
            onClick={onLeave}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'rgba(148,184,170,0.85)',
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
              fontFamily: 'inherit',
            }}
          >
            Back to Cove
          </button>
        </div>
      </div>

      <style>{`
        @keyframes cv-poker-spin { to { transform: rotate(360deg); } }
        .cv-poker-spin { animation: cv-poker-spin 0.9s linear infinite; }
      `}</style>
    </main>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const spinnerStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: '2px solid rgba(124,255,203,0.25)',
  borderTopColor: '#7cffcb',
  display: 'inline-block',
};

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'rgba(148,184,170,0.8)',
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 800,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: accent,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function humanStatus(s: string): string {
  switch (s) {
    case 'registering':
      return 'Registering';
    case 'seating':
      return 'Seating';
    case 'running':
      return 'In progress';
    case 'settled':
      return 'Finished';
    case 'cancelled':
      return 'Cancelled';
    default:
      return s.charAt(0).toUpperCase() + s.slice(1);
  }
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}
