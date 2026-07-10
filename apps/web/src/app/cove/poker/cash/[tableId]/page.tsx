'use client';

/**
 * Poker CASH GAME (ring-table) felt PAGE — `/cove/poker/cash/[tableId]`.
 *
 * Why a dedicated ROUTE (not a cove modal): a ring table is a long-lived,
 * poll-driven surface (sit → many hands → leave) that needs a clean full-screen
 * felt + a deterministic unmount when the player walks away. Same isolation
 * reasoning the MTT route (`/cove/poker/[tournamentId]`) uses — but the cash
 * route is REST/poll (no WebSocket), so this page owns its own polling loop
 * instead of mounting `useActivityWs`.
 *
 * Data flow (two polls):
 *   - GET /tables/:id              (~3s)   → public table state (config + seats +
 *                                            live snapshot, NO hole cards).
 *   - GET /tables/:id/state-for-agent (~1.5s) → OWN view: hole cards, isYourTurn,
 *                                            legalActions, toCall, raise bounds,
 *                                            handNumber. 409 when not seated / no
 *                                            live hand (we just keep the public view).
 *
 * Controls:
 *   - Sit (when not seated)  → POST /tables/:id/sit { buyInCt } (fixed buy-in).
 *   - Action bar (your turn) → POST /tables/:id/action { handNumber, actionSeq,
 *                              action }. `actionSeq` is a monotonic per-seat ref
 *                              so a double-tap dedupes server-side.
 *   - Leave                  → POST /tables/:id/leave. Handles BOTH 200 (left now)
 *                              and 202 (mid-hand stand-up queued → "leaving after
 *                              this hand").
 *
 * Reuses the holdem felt primitives (SeatPosition, CommunityCardRow, PotDisplay)
 * + TurnClock. The PokerTable/PokerActionBar MTT components are store/WS-coupled
 * (usePokerStore + ClientFrame `send`), so this page renders a THIN poll-driven
 * felt from the same primitives instead of forking those components.
 *
 * Iris Xe safe: pure DOM/CSS. No Three.js / WebGPU on this route.
 */

import { useCallback, useEffect, useMemo, useRef, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import SeatPosition from '@/components/cove/holdem/SeatPosition';
import CommunityCardRow from '@/components/cove/holdem/CommunityCardRow';
import PotDisplay from '@/components/cove/holdem/PotDisplay';
import { TurnClock } from '@/components/cove/poker/TurnClock';
import type { SeatState, HoldemCard } from '@/lib/cove/holdem-types';
import {
  cashPokerApi,
  describeCashPokerError,
  CoveApiError,
  type CashAgentView,
  type CashPublicSeat,
  type CashAction,
  type CashActionKind,
  type PublicTableStateResponse,
} from '@/lib/cove/cash-poker';

const PUBLIC_POLL_MS = 3000;
const SELF_POLL_MS = 1500;

interface RouteParams {
  tableId: string;
}

export default function CashPokerTablePage({ params }: { params: Promise<RouteParams> }) {
  const { tableId } = use(params);
  const router = useRouter();
  const isMobile = useIsMobile();

  const { data: avatar, isLoading: avatarLoading } = useAvatar();
  const avatarId: string | null = avatar?.id ?? null;

  const [pub, setPub] = useState<PublicTableStateResponse | null>(null);
  const [selfView, setSelfView] = useState<CashAgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [sitting, setSitting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveQueued, setLeaveQueued] = useState(false);

  // Monotonic per-seat action counter (server idempotency key = hand:seq:avatar).
  const actionSeqRef = useRef(0);
  const [actionBusy, setActionBusy] = useState(false);

  // ── Public table poll ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await cashPokerApi.publicTableState(tableId);
        if (!cancelled) {
          setPub(res);
          setNotFound(false);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof CoveApiError && err.status === 404) setNotFound(true);
          else setError(describeCashPokerError(err));
        }
      }
      if (!cancelled) timer = setTimeout(tick, PUBLIC_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tableId]);

  // ── Self view poll (own hole cards + turn). 409 = not seated / no live hand. ─
  const amSeated = useMemo(
    () => !!avatarId && !!pub?.seats.some((s) => s.avatarId === avatarId && s.status !== 'left'),
    [avatarId, pub],
  );

  useEffect(() => {
    if (!amSeated) {
      setSelfView(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await cashPokerApi.stateForAgent(tableId);
        if (!cancelled) setSelfView(res.view);
      } catch (err) {
        // 409 = seated but no live hand yet (between hands) — clear the private
        // view and keep polling; any other error surfaces.
        if (!cancelled) {
          if (err instanceof CoveApiError && err.status === 409) setSelfView(null);
          else if (err instanceof CoveApiError && (err.status === 401 || err.status === 403)) {
            setSelfView(null);
          } else setError(describeCashPokerError(err));
        }
      }
      if (!cancelled) timer = setTimeout(tick, SELF_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tableId, amSeated]);

  // ── Sit ──────────────────────────────────────────────────────────────────
  const handleSit = useCallback(async () => {
    if (!pub) return;
    setSitting(true);
    setError(null);
    try {
      await cashPokerApi.sit(tableId, Number(pub.table.buyInCt));
      // The next public poll will reflect us as seated; nudge it immediately.
      const fresh = await cashPokerApi.publicTableState(tableId);
      setPub(fresh);
    } catch (err) {
      setError(describeCashPokerError(err));
    } finally {
      setSitting(false);
    }
  }, [tableId, pub]);

  // ── Leave (handles 200 immediate + 202 queued) ─────────────────────────────
  const handleLeave = useCallback(async () => {
    setLeaving(true);
    setError(null);
    try {
      const res = await cashPokerApi.leave(tableId);
      if (res.queued || res.httpStatus === 202) {
        // Mid-hand stand-up: cashed out at the next hand boundary.
        setLeaveQueued(true);
        setLeaving(false);
      } else {
        // Cashed out now — back to the cove.
        router.push('/cove');
      }
    } catch (err) {
      setError(describeCashPokerError(err));
      setLeaving(false);
    }
  }, [tableId, router]);

  // ── Submit an action ───────────────────────────────────────────────────────
  const submitAction = useCallback(
    async (action: CashAction) => {
      if (!selfView || !selfView.isYourTurn || actionBusy) return;
      setActionBusy(true);
      setError(null);
      const seq = actionSeqRef.current++;
      try {
        await cashPokerApi.submitAction(tableId, {
          handNumber: selfView.handNumber,
          actionSeq: seq,
          action,
        });
        // Optimistically clear our turn so the bar disables until the next poll.
        setSelfView((prev) => (prev ? { ...prev, isYourTurn: false, legalActions: [] } : prev));
      } catch (err) {
        setError(describeCashPokerError(err));
      } finally {
        setActionBusy(false);
      }
    },
    [tableId, selfView, actionBusy],
  );

  const goBack = useCallback(() => router.push('/cove'), [router]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (avatarLoading) return <FullScreen message="LOADING AVATAR…" />;
  if (!avatar) {
    return (
      <FullScreen
        message="No avatar found — create one to play cash poker."
        action={{ label: 'BACK TO COVE', onClick: goBack }}
      />
    );
  }
  if (notFound) {
    return (
      <FullScreen
        message="This table is closed or doesn't exist."
        action={{ label: 'BACK TO COVE', onClick: goBack }}
      />
    );
  }
  if (!pub) return <FullScreen message="LOADING TABLE…" />;

  const live = pub.live;
  const buyInCt = Number(pub.table.buyInCt);
  const myStackCt = avatarId
    ? Number(pub.seats.find((s) => s.avatarId === avatarId)?.stackCt ?? 0)
    : 0;

  return (
    <main style={{ position: 'fixed', inset: 0, background: '#03090a', overflow: 'hidden' }}>
      <Felt live={live} selfView={selfView} selfAvatarId={avatarId} />

      {/* Top bar — stakes, my stack, leave. CLEAR of bottom joystick zones. */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(12px + env(safe-area-inset-top, 0px))',
          left: 12,
          right: 12,
          zIndex: 30,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div
          style={{
            padding: '7px 12px',
            background: 'rgba(6,24,18,0.85)',
            border: '1px solid rgba(124,255,203,0.25)',
            borderRadius: 8,
            color: '#d1fae5',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {Number(pub.table.smallBlindCt)}/{Number(pub.table.bigBlindCt)} ·{' '}
          {amSeated ? (
            <span style={{ color: '#7cffcb' }}>Your stack {myStackCt.toLocaleString()} vCLAW</span>
          ) : (
            <span style={{ color: 'rgba(148,184,170,0.85)' }}>
              Buy-in {buyInCt.toLocaleString()} vCLAW
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleLeave}
          disabled={leaving || leaveQueued}
          style={{
            padding: '7px 16px',
            minHeight: 44,
            background: 'rgba(6,24,18,0.85)',
            border: '1px solid rgba(124,255,203,0.3)',
            borderRadius: 8,
            color: leaveQueued ? 'rgba(148,184,170,0.8)' : '#7cffcb',
            fontSize: 12,
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
            cursor: leaving || leaveQueued ? 'default' : 'pointer',
            opacity: leaving ? 0.6 : 1,
          }}
        >
          {leaveQueued ? 'Leaving after this hand…' : amSeated ? 'Leave' : 'Back to Cove'}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: 'calc(58px + env(safe-area-inset-top, 0px))',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 35,
            padding: '8px 16px',
            background: 'rgba(127,29,29,0.9)',
            border: '1px solid #f87171',
            borderRadius: 10,
            color: '#fecaca',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            maxWidth: '90vw',
            textAlign: 'center',
          }}
        >
          {error}
        </div>
      )}

      {/* Sit prompt (not seated) — centered, clear of joysticks. */}
      {!amSeated && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 25,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            padding: '20px 28px',
            background: 'rgba(6,24,18,0.92)',
            border: '1px solid rgba(124,255,203,0.4)',
            borderRadius: 14,
            backdropFilter: 'blur(6px)',
          }}
        >
          <div
            style={{
              color: '#f0fdf4',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontSize: 16,
              fontWeight: 800,
              textAlign: 'center',
            }}
          >
            Take a seat
          </div>
          <div style={{ color: 'rgba(203,213,225,0.85)', fontSize: 13, textAlign: 'center' }}>
            Buy in for {buyInCt.toLocaleString()} vCLAW. Your stack cashes back to vCLAW when you leave.
          </div>
          <button
            type="button"
            onClick={handleSit}
            disabled={sitting}
            style={{
              padding: '12px 28px',
              background: 'linear-gradient(180deg,#0c5a3a,#0a4730)',
              border: '1px solid #7cffcb',
              borderRadius: 10,
              color: '#f0fdf4',
              fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
              fontWeight: 800,
              letterSpacing: '0.08em',
              cursor: sitting ? 'default' : 'pointer',
              opacity: sitting ? 0.6 : 1,
              fontSize: 13,
            }}
          >
            {sitting ? 'SITTING…' : `SIT · ${buyInCt.toLocaleString()} vCLAW`}
          </button>
        </div>
      )}

      {/* Action bar (seated + your turn). */}
      {amSeated && (
        <CashActionBar
          selfView={selfView}
          pot={live?.pot ?? 0}
          isMobile={isMobile}
          busy={actionBusy}
          onAction={submitAction}
        />
      )}
    </main>
  );
}

// ─── Felt (poll-driven, built from holdem primitives) ───────────────────────────

function Felt({
  live,
  selfView,
  selfAvatarId,
}: {
  live: PublicTableStateResponse['live'];
  selfView: CashAgentView | null;
  selfAvatarId: string | null;
}) {
  // Resolve self seat index (rotate the ring so we sit bottom-center).
  const selfSeatIndex = useMemo(() => {
    if (!live || !selfAvatarId) return null;
    const me = live.seats.find((s) => s.avatarId === selfAvatarId);
    return me ? me.seatIndex : null;
  }, [live, selfAvatarId]);

  // Our own hole cards are valid only for the CURRENT hand the snapshot describes.
  const selfHole = useMemo(() => {
    if (!live || !selfView) return null;
    if (selfView.handNumber !== live.handNumber) return null;
    return selfView.holeCards;
  }, [live, selfView]);

  const orderedSeats = useMemo(() => {
    if (!live) return [] as Array<{ seat: CashPublicSeat; ringPos: number }>;
    const seats = [...live.seats].sort((a, b) => a.seatIndex - b.seatIndex);
    if (selfSeatIndex == null) return seats.map((seat, i) => ({ seat, ringPos: i }));
    const selfIdx = seats.findIndex((s) => s.seatIndex === selfSeatIndex);
    const n = seats.length;
    return seats.map((seat) => {
      const rawPos = seats.indexOf(seat);
      const ringPos = (rawPos - selfIdx + n) % n;
      return { seat, ringPos };
    });
  }, [live, selfSeatIndex]);

  const communityCards: (HoldemCard | null)[] = useMemo(() => {
    const out: (HoldemCard | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const c = live?.board[i];
      out.push(c ? { ...c } : null);
    }
    return out;
  }, [live]);

  if (!live) {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(124,255,203,0.8)',
          fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
          letterSpacing: '0.18em',
          fontSize: 12,
        }}
      >
        WAITING FOR THE NEXT HAND…
      </div>
    );
  }

  const handLive = live.street !== 'showdown';
  const seatCount = live.seats.length;

  return (
    <div
      role="group"
      aria-label="Cash poker table"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background:
          'radial-gradient(ellipse 70% 60% at 50% 44%, #0c5a3a 0%, #0a4730 45%, #06281c 100%)',
      }}
    >
      {/* Felt rail */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: '8%',
          left: '6%',
          width: '88%',
          height: '76%',
          borderRadius: '50%',
          border: '3px solid rgba(0,0,0,0.45)',
          boxShadow: 'inset 0 0 60px rgba(0,0,0,0.55), 0 0 0 8px rgba(8,40,28,0.6)',
          pointerEvents: 'none',
        }}
      />

      {/* Center: community + pot + blinds */}
      <div
        style={{
          position: 'absolute',
          top: '42%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          zIndex: 3,
        }}
      >
        <CommunityCardRow cards={communityCards} />
        <PotDisplay pot={live.pot} />
        <div
          style={{
            fontSize: 10,
            fontFamily: 'ui-monospace, monospace',
            color: 'rgba(124,255,203,0.6)',
            letterSpacing: '0.1em',
          }}
        >
          BLINDS {live.blinds.sb}/{live.blinds.bb}
        </div>
      </div>

      {/* Seats */}
      {orderedSeats.map(({ seat, ringPos }) => {
        const isSelf = selfSeatIndex != null && seat.seatIndex === selfSeatIndex;
        const slot = ovalSlot(ringPos, seatCount);
        const seatState = toSeatState(seat, {
          isSelf,
          selfHole: isSelf ? selfHole : null,
          handLive,
        });
        return (
          <div
            key={seat.seatIndex}
            style={{
              position: 'absolute',
              top: slot.top,
              left: slot.left,
              transform: slot.transform,
              zIndex: isSelf ? 5 : 2,
            }}
          >
            <SeatPosition seat={seatState} isPlayer={isSelf} revealCards={isSelf} />
            {seat.isActing && live.toActDeadlineMs != null && (
              <div style={{ marginTop: 4, display: 'flex', justifyContent: 'center' }}>
                <TurnClock deadlineMs={live.toActDeadlineMs} compact />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Oval geometry (mirror of PokerTable's ring placement) ──────────────────────

interface SeatSlot {
  top: string;
  left: string;
  transform: string;
}

function ovalSlot(ringPos: number, total: number): SeatSlot {
  if (ringPos === 0) {
    return { top: '100%', left: '50%', transform: 'translate(-50%, -100%)' };
  }
  const CX = 50;
  const CY = 46;
  const RX = 44;
  const RY = 38;
  const startDeg = 90;
  const stepDeg = 360 / total;
  const deg = startDeg + ringPos * stepDeg;
  const rad = (deg * Math.PI) / 180;
  const x = CX + RX * Math.cos(rad);
  const y = CY + RY * Math.sin(rad);
  return { top: `${y}%`, left: `${x}%`, transform: 'translate(-50%, -50%)' };
}

// ─── Wire → SeatState adapter (own cards face-up; others face-down mid-hand) ─────

function toSeatState(
  seat: CashPublicSeat,
  opts: {
    isSelf: boolean;
    selfHole: [HoldemCard, HoldemCard] | null;
    handLive: boolean;
  },
): SeatState {
  const { isSelf, selfHole, handLive } = opts;

  let holeCards: [HoldemCard, HoldemCard] | null = null;
  if (isSelf && selfHole) {
    holeCards = [
      { ...selfHole[0], hidden: false },
      { ...selfHole[1], hidden: false },
    ];
  } else if (
    !isSelf &&
    handLive &&
    (seat.status === 'active' || seat.status === 'allin' || seat.status === 'folded')
  ) {
    // Another live seat — face-DOWN backs (the public snapshot carries no cards).
    holeCards = [
      { suit: 'spades', rank: 'A', hidden: true },
      { suit: 'spades', rank: 'A', hidden: true },
    ];
  }

  const status: SeatState['status'] =
    seat.status === 'busted' || seat.status === 'sitting_out'
      ? 'out'
      : seat.status === 'allin'
        ? 'allin'
        : seat.status === 'folded'
          ? 'folded'
          : 'active';

  return {
    seatIndex: seat.seatIndex,
    name: isSelf ? 'You' : seat.name,
    stack: seat.chipStack,
    streetBet: seat.streetBet,
    holeCards,
    status,
    isSmallBlind: seat.isSB,
    isBigBlind: seat.isBB,
    isDealer: seat.isButton,
    isActing: seat.isActing,
  };
}

// ─── Action bar (poll-driven; mirrors PokerActionBar UX without the WS store) ────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function CashActionBar({
  selfView,
  pot,
  isMobile,
  busy,
  onAction,
}: {
  selfView: CashAgentView | null;
  pot: number;
  isMobile: boolean;
  busy: boolean;
  onAction: (action: CashAction) => void;
}) {
  const isOurTurn = !!selfView && selfView.isYourTurn;
  const legal: CashActionKind[] = selfView?.legalActions ?? [];
  const canFold = legal.includes('fold');
  const canCheck = legal.includes('check');
  const canCall = legal.includes('call');
  const canBet = legal.includes('bet');
  const canRaise = legal.includes('raise');
  const showSizing = canBet || canRaise;
  const sizingVerb: 'bet' | 'raise' = canRaise ? 'raise' : 'bet';

  const [raiseTo, setRaiseTo] = useState(0);
  // Re-seed the sizing band whenever a fresh prompt arrives.
  const promptKey = isOurTurn ? `${selfView?.handNumber}:${selfView?.deadlineMs}` : null;
  useEffect(() => {
    if (selfView) setRaiseTo(selfView.minRaiseTo);
  }, [promptKey, selfView?.minRaiseTo]);

  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
  }, [promptKey]);

  const disabled = !isOurTurn || expired || busy;

  const presets = useMemo(() => {
    if (!selfView) return [] as Array<{ label: string; to: number }>;
    const { minRaiseTo, maxRaiseTo, toCall } = selfView;
    const potNow = pot + toCall;
    return [
      { label: '½ Pot', to: Math.round(toCall + potNow * 0.5) },
      { label: '¾ Pot', to: Math.round(toCall + potNow * 0.75) },
      { label: 'Pot', to: Math.round(toCall + potNow) },
      { label: 'All-in', to: maxRaiseTo },
    ]
      .map((c) => ({ ...c, to: clamp(c.to, minRaiseTo, maxRaiseTo) }))
      .filter((c, i, arr) => arr.findIndex((x) => x.to === c.to) === i);
  }, [selfView, pot]);

  const barBg = 'rgba(6,24,18,0.94)';
  const btnBase: React.CSSProperties = {
    flex: 1,
    minWidth: isMobile ? 0 : 88,
    minHeight: isMobile ? 52 : 44,
    borderRadius: 10,
    fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
    fontWeight: 800,
    fontSize: isMobile ? 14 : 13,
    letterSpacing: '0.06em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: '1px solid transparent',
    color: '#f0fdf4',
  };

  function btnStyle(kind: 'fold' | 'check' | 'call' | 'raise', enabled: boolean): React.CSSProperties {
    const palettes = {
      fold: { bg: 'linear-gradient(180deg,#7f1d1d,#5b1414)', border: '#b91c1c' },
      check: { bg: 'linear-gradient(180deg,#1e3a5f,#13263f)', border: '#3b82f6' },
      call: { bg: 'linear-gradient(180deg,#1e3a5f,#13263f)', border: '#3b82f6' },
      raise: { bg: 'linear-gradient(180deg,#b45309,#7c3a06)', border: '#f59e0b' },
    } as const;
    const p = palettes[kind];
    return {
      ...btnBase,
      background: p.bg,
      borderColor: p.border,
      opacity: !enabled || disabled ? 0.35 : 1,
      pointerEvents: !enabled || disabled ? 'none' : 'auto',
    };
  }

  return (
    <div
      role="toolbar"
      aria-label="Cash poker actions"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        padding: isMobile
          ? 'calc(10px + env(safe-area-inset-bottom, 0px)) 12px 12px'
          : '12px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
        background: barBg,
        borderTop: '1px solid rgba(124,255,203,0.18)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div
          style={{
            fontSize: 11,
            fontFamily: 'ui-monospace, monospace',
            letterSpacing: '0.08em',
            color: isOurTurn ? '#7cffcb' : 'rgba(148,184,170,0.75)',
          }}
        >
          {isOurTurn ? (expired ? 'TIME UP — auto-acted' : 'YOUR TURN') : 'Waiting for your turn…'}
        </div>
        {isOurTurn && selfView?.deadlineMs != null && !expired && (
          <TurnClock deadlineMs={selfView.deadlineMs} onExpire={() => setExpired(true)} />
        )}
      </div>

      {/* Sizing */}
      {showSizing && selfView && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            opacity: disabled ? 0.4 : 1,
            pointerEvents: disabled ? 'none' : 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 12,
                fontFamily: 'ui-monospace, monospace',
                color: '#fbbf24',
                fontWeight: 700,
                minWidth: 64,
              }}
            >
              {sizingVerb === 'raise' ? 'Raise to' : 'Bet to'}
            </span>
            <input
              type="range"
              min={selfView.minRaiseTo}
              max={selfView.maxRaiseTo}
              step={1}
              value={clamp(raiseTo, selfView.minRaiseTo, selfView.maxRaiseTo)}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
              disabled={disabled}
              aria-label="Bet size"
              style={{ flex: 1, accentColor: '#f59e0b', minWidth: 0 }}
            />
            <input
              type="number"
              inputMode="numeric"
              min={selfView.minRaiseTo}
              max={selfView.maxRaiseTo}
              value={clamp(raiseTo, selfView.minRaiseTo, selfView.maxRaiseTo)}
              onChange={(e) =>
                setRaiseTo(
                  clamp(
                    Math.floor(Number(e.target.value) || selfView.minRaiseTo),
                    selfView.minRaiseTo,
                    selfView.maxRaiseTo,
                  ),
                )
              }
              disabled={disabled}
              aria-label="Bet size (chips)"
              style={{
                width: 78,
                background: 'rgba(0,0,0,0.4)',
                border: '1px solid rgba(245,158,11,0.4)',
                borderRadius: 6,
                color: '#fde68a',
                fontFamily: 'ui-monospace, monospace',
                fontSize: 13,
                fontWeight: 700,
                padding: '5px 6px',
                textAlign: 'right',
              }}
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={disabled}
                onClick={() => setRaiseTo(p.to)}
                style={{
                  flex: isMobile ? '1 1 0' : '0 0 auto',
                  padding: '5px 12px',
                  borderRadius: 6,
                  background: raiseTo === p.to ? 'rgba(245,158,11,0.25)' : 'rgba(0,0,0,0.35)',
                  border: `1px solid ${raiseTo === p.to ? '#f59e0b' : 'rgba(245,158,11,0.3)'}`,
                  color: '#fde68a',
                  fontSize: 11,
                  fontFamily: 'ui-monospace, monospace',
                  fontWeight: 700,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        {canFold && (
          <button type="button" style={btnStyle('fold', canFold)} disabled={disabled} onClick={() => onAction({ kind: 'fold' })}>
            Fold
          </button>
        )}
        {canCheck && (
          <button type="button" style={btnStyle('check', canCheck)} disabled={disabled} onClick={() => onAction({ kind: 'check' })}>
            Check
          </button>
        )}
        {canCall && selfView && (
          <button type="button" style={btnStyle('call', canCall)} disabled={disabled} onClick={() => onAction({ kind: 'call' })}>
            Call {selfView.toCall > 0 ? selfView.toCall : ''}
          </button>
        )}
        {showSizing && selfView && (
          <button
            type="button"
            style={btnStyle('raise', showSizing)}
            disabled={disabled}
            onClick={() =>
              onAction(
                sizingVerb === 'raise'
                  ? { kind: 'raise', amount: clamp(raiseTo, selfView.minRaiseTo, selfView.maxRaiseTo) }
                  : { kind: 'bet', amount: clamp(raiseTo, selfView.minRaiseTo, selfView.maxRaiseTo) },
              )
            }
          >
            {sizingVerb === 'raise' ? 'Raise' : 'Bet'} {clamp(raiseTo, selfView.minRaiseTo, selfView.maxRaiseTo)}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── FullScreen helper ──────────────────────────────────────────────────────────

function FullScreen({
  message,
  action,
}: {
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#03090a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        color: '#7cffcb',
        fontFamily: 'var(--font-orbitron, ui-sans-serif), sans-serif',
        letterSpacing: '0.16em',
        fontSize: 14,
        textShadow: '0 0 12px rgba(124,255,203,0.4)',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 360 }}>{message}</div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            padding: '10px 24px',
            background: 'transparent',
            border: '1px solid #7cffcb',
            borderRadius: 6,
            color: '#7cffcb',
            fontFamily: 'inherit',
            fontWeight: 700,
            letterSpacing: '0.12em',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          {action.label}
        </button>
      )}
    </main>
  );
}
