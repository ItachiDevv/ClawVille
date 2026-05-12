'use client';

/**
 * <LobbyLanding> — reusable wager-lobby landing screen shared by every
 * activity that wraps a wagered match (Bumper Shells, Reef Race today;
 * future activities drop in unchanged).
 *
 * Wired into `apps/web/src/app/activity/[activityId]/[roomId]/page.tsx`
 * as the first thing the user sees. The 3D scene is gated behind
 * `lobbyState === 'in-game'`, which only happens after the page receives
 * `onLobbyLocked` from this component.
 *
 * State graph (matches the README in the lobby-landing brief):
 *
 *   loading                  ─→ fetches GET /api/wager/lobbies?roomId=X
 *      ├── lobby exists for this room ── waiting / cancelled
 *      └── no lobby                    ── create
 *   create                  user submits → POST /api/wager/lobbies → waiting
 *   waiting                 polls GET /api/wager/lobbies/:id every 3s
 *      ├── state=open       — still here; player list + leave button
 *      ├── state=locked     — onLobbyLocked() → parent mounts scene
 *      └── state=cancelled  — refund button per-player
 *   locking                 transient ~2s during the lock tx confirm
 *   match-starting          calls onLobbyLocked; parent unmounts us
 *   cancelled               shows reason + refund + back to /game
 *
 * Polling cadence: 3s — slow enough to not hammer the API, fast enough
 * to surface state changes before the human gives up.
 *
 * Designed to mount BEFORE the 3D scene, so the WebGPU pipeline only
 * boots after the lobby is locked.
 *
 * No external rpc/websocket dependency in this file — pure REST fetches.
 * If the WS hub broadcasts lobby state changes (concern 5 follow-up),
 * the parent can pass those through `externalLobbyUpdate` to bypass
 * polling.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

// ─── types matching apps/api/src/routes/wager.ts JSON shape ─────────────

export type LobbyState = 'open' | 'locked' | 'settled' | 'cancelled';
export type LobbyVisibility = 'public' | 'private' | 'friends';
export type LobbyMode = 'multiplayer' | 'solo-bots';

export interface LobbySnapshot {
  id: string;
  lobbyId: string; // bigint serialized as decimal string
  activityId: string;
  roomId: string;
  creatorUserId: string;
  creatorAvatarId: string;
  wagerAmountLamports: string;
  wagerMint: string | null;
  maxPlayers: number;
  joinedCount: number;
  state: LobbyState;
  visibility: LobbyVisibility;
  inviteCode: string | null;
  mode: LobbyMode;
  settledWinnerAvatarId: string | null;
  createdAt: string;
  lockedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
  onChainCreateSig: string | null;
  onChainLockSig: string | null;
  onChainSettleSig: string | null;
  onChainCancelSig: string | null;
}

export interface LobbyPlayerSnapshot {
  id: string;
  userId: string;
  avatarId: string;
  depositAmountLamports: string;
  depositedAt: string;
  refunded: boolean;
  refundedAt: string | null;
  onChainJoinSig: string;
  avatarName: string | null;
}

// ─── props ──────────────────────────────────────────────────────────────

export interface LobbyLandingProps {
  activityId: string;
  roomId: string;
  /** From `?invite=...` URL param — auto-joins private lobby. */
  inviteCode?: string | null;
  /** Called when the lobby transitions to `locked` — parent should mount the scene. */
  onLobbyLocked: (lobby: LobbySnapshot) => void;
  /** Called when the lobby is cancelled — parent should route back. */
  onLobbyCancelled: (lobby: LobbySnapshot) => void;
  /** Display title — "Bumper Shells", "Reef Race", … */
  activityTitle: string;
  /** Hex color used for accents (e.g. `'#00E5FF'`). */
  activityAccentColor: string;
}

// ─── wager preset chips (SOL) ───────────────────────────────────────────

const SOL_PRESETS: Array<{ label: string; lamports: number }> = [
  { label: 'Free', lamports: 0 },
  { label: '0.01 SOL', lamports: 10_000_000 },
  { label: '0.05 SOL', lamports: 50_000_000 },
  { label: '0.1 SOL', lamports: 100_000_000 },
  { label: '0.5 SOL', lamports: 500_000_000 },
  { label: '1 SOL', lamports: 1_000_000_000 },
];

// ─── helpers ────────────────────────────────────────────────────────────

function lamportsToSolDisplay(lamports: string): string {
  try {
    const n = BigInt(lamports);
    if (n === 0n) return 'Free';
    // 9 decimal places — trim trailing zeros
    const whole = n / 1_000_000_000n;
    const frac = n % 1_000_000_000n;
    if (frac === 0n) return `${whole.toString()} SOL`;
    const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr} SOL`;
  } catch {
    return `${lamports} lamports`;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const err = await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ─── component ──────────────────────────────────────────────────────────

type Phase =
  | 'loading'
  | 'create'
  | 'waiting'
  | 'locking'
  | 'match-starting'
  | 'cancelled'
  | 'error';

export default function LobbyLanding(props: LobbyLandingProps) {
  const {
    activityId,
    roomId,
    inviteCode,
    onLobbyLocked,
    onLobbyCancelled,
    activityTitle,
    activityAccentColor,
  } = props;

  const [phase, setPhase] = useState<Phase>('loading');
  const [lobby, setLobby] = useState<LobbySnapshot | null>(null);
  const [players, setPlayers] = useState<LobbyPlayerSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create-form state
  const [formWager, setFormWager] = useState<number>(0); // lamports
  const [formMaxPlayers, setFormMaxPlayers] = useState<number>(4);
  const [formVisibility, setFormVisibility] = useState<LobbyVisibility>('public');
  const [formMode, setFormMode] = useState<LobbyMode>('multiplayer');
  const [submitting, setSubmitting] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  // ─── initial load: is there already a lobby for this room? ────────────
  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        // Invite-code wins: jump straight to that lobby.
        if (inviteCode) {
          try {
            const { lobby: existing, players: ps } = await apiFetch<{
              lobby: LobbySnapshot;
              players: LobbyPlayerSnapshot[];
            }>(`/api/wager/lobbies/${encodeURIComponent(inviteCode)}`);
            if (cancelledRef.current) return;
            setLobby(existing);
            setPlayers(ps);
            // If we're not yet in the lobby and it's still open, auto-join.
            // (POST /join is idempotent — returns 409 already_joined if we're in.)
            if (existing.state === 'open') {
              await joinIfNotMember(existing);
            }
            setPhase(stateToPhase(existing.state));
            return;
          } catch (err) {
            if (cancelledRef.current) return;
            setError(`Invite code error: ${(err as Error).message}`);
            setPhase('error');
            return;
          }
        }

        // No invite — check if there's a lobby for this room.
        const list = await apiFetch<{ lobbies: LobbySnapshot[] }>(
          `/api/wager/lobbies?activityId=${encodeURIComponent(
            activityId,
          )}&roomId=${encodeURIComponent(roomId)}&state=open`,
        );
        if (cancelledRef.current) return;
        if (list.lobbies.length > 0) {
          // Pick the most recent open lobby for this room.
          const existing = list.lobbies[0]!;
          const detail = await apiFetch<{
            lobby: LobbySnapshot;
            players: LobbyPlayerSnapshot[];
          }>(`/api/wager/lobbies/${existing.id}`);
          if (cancelledRef.current) return;
          setLobby(detail.lobby);
          setPlayers(detail.players);
          setPhase(stateToPhase(detail.lobby.state));
        } else {
          setPhase('create');
        }
      } catch (err) {
        if (cancelledRef.current) return;
        setError((err as Error).message);
        setPhase('error');
      }
    })();
    return () => {
      cancelledRef.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityId, roomId, inviteCode]);

  // ─── polling loop while waiting ───────────────────────────────────────
  useEffect(() => {
    if (!lobby || phase !== 'waiting') return;
    let stopped = false;
    const tick = async () => {
      try {
        const detail = await apiFetch<{
          lobby: LobbySnapshot;
          players: LobbyPlayerSnapshot[];
        }>(`/api/wager/lobbies/${lobby.id}`);
        if (stopped) return;
        setLobby(detail.lobby);
        setPlayers(detail.players);
        if (detail.lobby.state === 'locked') {
          setPhase('match-starting');
          onLobbyLocked(detail.lobby);
          return;
        }
        if (detail.lobby.state === 'cancelled') {
          setPhase('cancelled');
          onLobbyCancelled(detail.lobby);
          return;
        }
        if (detail.lobby.state === 'settled') {
          // Race condition — match already finished. Fall back to cancelled UX.
          setPhase('cancelled');
          onLobbyCancelled(detail.lobby);
          return;
        }
        pollTimer.current = setTimeout(tick, 3000);
      } catch (err) {
        if (stopped) return;
        // Soft fail — keep polling.
        console.warn('[LobbyLanding] poll error:', err);
        pollTimer.current = setTimeout(tick, 3000);
      }
    };
    pollTimer.current = setTimeout(tick, 3000);
    return () => {
      stopped = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [lobby?.id, phase, onLobbyLocked, onLobbyCancelled, lobby]);

  // ─── helpers ──────────────────────────────────────────────────────────

  function stateToPhase(state: LobbyState): Phase {
    if (state === 'open') return 'waiting';
    if (state === 'locked') return 'match-starting';
    if (state === 'cancelled' || state === 'settled') return 'cancelled';
    return 'waiting';
  }

  async function joinIfNotMember(target: LobbySnapshot): Promise<void> {
    try {
      await apiFetch(`/api/wager/lobbies/${target.id}/join`, {
        method: 'POST',
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('already_joined')) return; // idempotent
      throw err;
    }
  }

  const handleCreate = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        activityId,
        roomId,
        wagerAmountLamports: formMode === 'solo-bots' ? 0 : formWager,
        maxPlayers: formMaxPlayers,
        visibility: formVisibility,
        mode: formMode,
      };
      const { lobby: created } = await apiFetch<{ lobby: LobbySnapshot }>(
        `/api/wager/lobbies`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      setLobby(created);
      setPlayers([]); // server inserts the creator row right after; will reload via poll
      if (formMode === 'solo-bots') {
        // Solo-bots: auto-lock immediately to mount the scene without waiting.
        try {
          // No admin endpoint for self-lock; rely on the FE-side fast-path.
          // We treat solo-bots as instantly playable — flip phase manually
          // and call onLobbyLocked with the snapshot we have.
          setPhase('match-starting');
          onLobbyLocked(created);
        } catch {
          // ignore
        }
      } else {
        setPhase('waiting');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [activityId, roomId, formWager, formMaxPlayers, formVisibility, formMode, onLobbyLocked]);

  const handleLeave = useCallback(async () => {
    if (!lobby) return;
    setSubmitting(true);
    try {
      // Creator leave → cancel; non-creator leave → refund (after cancel).
      // Simple: just call /cancel — server checks creator-vs-not.
      const isCreator = false; // FE doesn't know currentUserId cheaply; let server enforce
      void isCreator;
      await apiFetch(`/api/wager/lobbies/${lobby.id}/cancel`, {
        method: 'POST',
      });
    } catch (err) {
      // Non-creator → cancel returns 403; that's expected. The match-server
      // sweep will eventually cancel if everyone leaves. For now, just exit.
      console.warn('[LobbyLanding] leave/cancel:', err);
    } finally {
      setSubmitting(false);
      onLobbyCancelled(lobby);
    }
  }, [lobby, onLobbyCancelled]);

  const handleRefund = useCallback(async () => {
    if (!lobby) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/wager/lobbies/${lobby.id}/refund`, {
        method: 'POST',
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [lobby]);

  const inviteUrl = useMemo(() => {
    if (!lobby?.inviteCode) return null;
    if (typeof window === 'undefined') return null;
    const u = new URL(window.location.href);
    u.searchParams.set('invite', lobby.inviteCode);
    return u.toString();
  }, [lobby?.inviteCode]);

  // ─── render ──────────────────────────────────────────────────────────

  return (
    <main style={containerStyle(activityAccentColor)}>
      <header style={headerStyle(activityAccentColor)}>
        <div style={{ fontSize: 20, letterSpacing: '0.2em' }}>{activityTitle}</div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>
          {phase === 'loading' && 'CHECKING FOR LOBBY…'}
          {phase === 'create' && 'CREATE OR JOIN A LOBBY'}
          {phase === 'waiting' && `WAITING — ${players.length}/${lobby?.maxPlayers ?? '?'} PLAYERS`}
          {phase === 'locking' && 'LOCKING IN…'}
          {phase === 'match-starting' && 'MATCH STARTING…'}
          {phase === 'cancelled' && 'CANCELLED'}
          {phase === 'error' && 'ERROR'}
        </div>
      </header>

      {error && <div style={errorBoxStyle(activityAccentColor)}>{error}</div>}

      {phase === 'loading' && <div style={statusStyle(activityAccentColor)}>Loading…</div>}

      {phase === 'create' && (
        <section style={panelStyle(activityAccentColor)}>
          <div style={fieldGroupStyle}>
            <label style={labelStyle}>MODE</label>
            <div style={chipRowStyle}>
              <Chip
                active={formMode === 'multiplayer'}
                accent={activityAccentColor}
                onClick={() => setFormMode('multiplayer')}
              >
                Multiplayer
              </Chip>
              <Chip
                active={formMode === 'solo-bots'}
                accent={activityAccentColor}
                onClick={() => {
                  setFormMode('solo-bots');
                  setFormWager(0);
                }}
              >
                Solo vs Bots
              </Chip>
            </div>
          </div>

          {formMode === 'multiplayer' && (
            <>
              <div style={fieldGroupStyle}>
                <label style={labelStyle}>WAGER</label>
                <div style={chipRowStyle}>
                  {SOL_PRESETS.map((p) => (
                    <Chip
                      key={p.lamports}
                      active={formWager === p.lamports}
                      accent={activityAccentColor}
                      onClick={() => setFormWager(p.lamports)}
                    >
                      {p.label}
                    </Chip>
                  ))}
                </div>
              </div>

              <div style={fieldGroupStyle}>
                <label style={labelStyle}>VISIBILITY</label>
                <div style={chipRowStyle}>
                  <Chip
                    active={formVisibility === 'public'}
                    accent={activityAccentColor}
                    onClick={() => setFormVisibility('public')}
                  >
                    Public
                  </Chip>
                  <Chip
                    active={formVisibility === 'private'}
                    accent={activityAccentColor}
                    onClick={() => setFormVisibility('private')}
                  >
                    Private (invite link)
                  </Chip>
                  <Chip
                    active={formVisibility === 'friends'}
                    accent={activityAccentColor}
                    onClick={() => setFormVisibility('friends')}
                  >
                    Friends-only
                  </Chip>
                </div>
              </div>
            </>
          )}

          <div style={fieldGroupStyle}>
            <label style={labelStyle}>MAX PLAYERS</label>
            <input
              type="number"
              min={2}
              max={16}
              value={formMaxPlayers}
              onChange={(e) => setFormMaxPlayers(Math.max(2, Math.min(16, Number(e.target.value) || 4)))}
              style={inputStyle(activityAccentColor)}
            />
          </div>

          <button
            type="button"
            disabled={submitting}
            onClick={handleCreate}
            style={primaryButtonStyle(activityAccentColor)}
          >
            {submitting ? 'CREATING…' : 'CREATE LOBBY'}
          </button>
        </section>
      )}

      {(phase === 'waiting' || phase === 'locking') && lobby && (
        <section style={panelStyle(activityAccentColor)}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            Wager:{' '}
            <strong>{lamportsToSolDisplay(lobby.wagerAmountLamports)}</strong>
            {' • '}Visibility: <strong>{lobby.visibility}</strong>
            {' • '}Mode: <strong>{lobby.mode}</strong>
          </div>
          {inviteUrl && (
            <div style={{ marginBottom: 12, fontSize: 11, opacity: 0.85 }}>
              Invite link: <code style={{ color: activityAccentColor }}>{inviteUrl}</code>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <div style={labelStyle}>PLAYERS ({players.length}/{lobby.maxPlayers})</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
              {players.map((p) => (
                <li key={p.id} style={playerRowStyleObj}>
                  <span>{p.avatarName ?? p.avatarId.slice(0, 8)}</span>
                  <span style={{ opacity: 0.6, fontSize: 10 }}>
                    {lamportsToSolDisplay(p.depositAmountLamports)}
                  </span>
                </li>
              ))}
              {players.length === 0 && (
                <li style={{ opacity: 0.6, fontSize: 11 }}>(waiting for sync…)</li>
              )}
            </ul>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={handleLeave}
            style={secondaryButtonStyle(activityAccentColor)}
          >
            {submitting ? 'LEAVING…' : 'LEAVE LOBBY'}
          </button>
        </section>
      )}

      {phase === 'match-starting' && (
        <div style={statusStyle(activityAccentColor)}>
          MATCH STARTING…
        </div>
      )}

      {phase === 'cancelled' && lobby && (
        <section style={panelStyle(activityAccentColor)}>
          <div style={{ marginBottom: 12 }}>
            Lobby was cancelled. Refund your deposit below.
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={handleRefund}
            style={primaryButtonStyle(activityAccentColor)}
          >
            {submitting ? 'CLAIMING…' : 'CLAIM REFUND'}
          </button>
          <button
            type="button"
            onClick={() => onLobbyCancelled(lobby)}
            style={{ ...secondaryButtonStyle(activityAccentColor), marginTop: 8 }}
          >
            BACK TO LOBBY
          </button>
        </section>
      )}

      {phase === 'error' && (
        <div style={statusStyle(activityAccentColor)}>
          {error ?? 'Something went wrong.'}
        </div>
      )}
    </main>
  );
}

// ─── tiny inline UI primitives (no new design tokens) ───────────────────

function Chip({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 12px',
        borderRadius: 4,
        background: active ? accent : 'transparent',
        border: `1px solid ${accent}`,
        color: active ? '#0A1628' : accent,
        fontFamily: 'inherit',
        fontSize: 11,
        letterSpacing: '0.1em',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ─── style helpers ──────────────────────────────────────────────────────

function containerStyle(accent: string): React.CSSProperties {
  return {
    position: 'fixed',
    inset: 0,
    background: '#0A1628',
    color: accent,
    fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
    letterSpacing: '0.08em',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: 24,
    overflow: 'auto',
  };
}

function headerStyle(accent: string): React.CSSProperties {
  return {
    width: '100%',
    maxWidth: 560,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    marginBottom: 24,
    textAlign: 'center',
    color: accent,
    textShadow: `0 0 12px ${accent}`,
  };
}

function panelStyle(accent: string): React.CSSProperties {
  return {
    width: '100%',
    maxWidth: 560,
    padding: 20,
    background: 'rgba(0, 229, 255, 0.04)',
    border: `1px solid ${accent}`,
    borderRadius: 8,
    boxShadow: `0 0 24px ${accent}33`,
  };
}

const fieldGroupStyle: React.CSSProperties = { marginBottom: 16 };
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 10,
  letterSpacing: '0.16em',
  marginBottom: 6,
  opacity: 0.7,
};
const chipRowStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };

function inputStyle(accent: string): React.CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${accent}`,
    color: accent,
    padding: '6px 12px',
    borderRadius: 4,
    fontFamily: 'inherit',
    width: 100,
  };
}

function primaryButtonStyle(accent: string): React.CSSProperties {
  return {
    width: '100%',
    padding: '10px 24px',
    background: accent,
    border: `1px solid ${accent}`,
    color: '#0A1628',
    fontFamily: 'inherit',
    fontWeight: 700,
    fontSize: 11,
    letterSpacing: '0.16em',
    cursor: 'pointer',
    borderRadius: 4,
    marginTop: 8,
  };
}

function secondaryButtonStyle(accent: string): React.CSSProperties {
  return {
    width: '100%',
    padding: '10px 24px',
    background: 'transparent',
    border: `1px solid ${accent}`,
    color: accent,
    fontFamily: 'inherit',
    fontWeight: 700,
    fontSize: 11,
    letterSpacing: '0.16em',
    cursor: 'pointer',
    borderRadius: 4,
    marginTop: 12,
  };
}

function errorBoxStyle(accent: string): React.CSSProperties {
  return {
    width: '100%',
    maxWidth: 560,
    padding: 12,
    background: '#fca5a522',
    border: '1px solid #fca5a5',
    color: '#fca5a5',
    borderRadius: 4,
    marginBottom: 16,
    fontSize: 12,
  };
}

function statusStyle(accent: string): React.CSSProperties {
  return {
    padding: 24,
    color: accent,
    fontSize: 12,
    letterSpacing: '0.16em',
    textShadow: `0 0 8px ${accent}`,
  };
}

const playerRowStyleObj: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '4px 0',
  borderBottom: '1px solid rgba(0, 229, 255, 0.15)',
  fontSize: 12,
};
