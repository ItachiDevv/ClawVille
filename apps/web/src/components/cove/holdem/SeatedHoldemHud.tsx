'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import '@/styles/cove-tokens.css';
import type { RaiseConfig } from '@/lib/cove/holdem-types';
import {
  computeAllIn,
  computeRaiseOpen,
  useHoldemController,
} from '@/lib/cove/holdem-controller';
import { RaiseSlider } from './RaiseSlider';
import PokerCard from './PokerCard';
import CommunityCardRow from './CommunityCardRow';
import {
  deriveHoldemPublicSeats,
  type HoldemStreet,
  type HoldemSettledResponse,
  type SerializedHoldemHand,
  type SerializedHoldemLogEntry,
} from '@clawville/shared';

const EMPTY_LOG: readonly SerializedHoldemLogEntry[] = [];
const BOT_NAMES: Record<number, string> = {
  1: 'Tess',
  2: 'Vex',
  3: 'Pip',
  4: 'Cal',
  5: 'Nita',
};

/**
 * Static DOM anchors derived once from `holdem-table-room.tsx`'s CAM_EYE,
 * CAM_LOOK, FOV=62 and BOT_SEATS by projecting a y=105 torso point at 16:9.
 * The raw near-side points land beyond the frustum; x/y are clamped into an
 * 8â€“92% / 18â€“72% safe frame while preserving their projected order. No
 * per-frame Three.js projection or allocation is needed.
 */
const TABLE_ROOM_SEAT_ANCHORS: ReadonlyArray<Readonly<{ left: number; top: number }>> = [
  { left: 50, top: 76 },
  { left: 92, top: 72 },
  { left: 92, top: 57 },
  { left: 90, top: 42 },
  { left: 8, top: 57 },
  { left: 10, top: 42 },
];

type PlaybackEvent =
  | { kind: 'action'; entry: SerializedHoldemLogEntry }
  | { kind: 'street'; street: Exclude<HoldemStreet, 'preflop'>; boardCount: 3 | 4 | 5 };

function boardCountForStreet(street: HoldemStreet): 0 | 3 | 4 | 5 {
  if (street === 'flop') return 3;
  if (street === 'turn') return 4;
  if (street === 'river') return 5;
  return 0;
}

function nextStreetEvent(boardCount: number): PlaybackEvent & { kind: 'street' } {
  if (boardCount < 3) return { kind: 'street', street: 'flop', boardCount: 3 };
  if (boardCount < 4) return { kind: 'street', street: 'turn', boardCount: 4 };
  return { kind: 'street', street: 'river', boardCount: 5 };
}

function sameLogEntry(a: SerializedHoldemLogEntry, b: SerializedHoldemLogEntry): boolean {
  return a.seat === b.seat && a.street === b.street && a.type === b.type
    && a.amount === b.amount && a.isHuman === b.isHuman;
}

function seatName(seat: number): string {
  return seat === 0 ? 'YOU' : (BOT_NAMES[seat] ?? `BOT ${seat}`);
}

function actionLabel(entry: SerializedHoldemLogEntry): string {
  if (entry.type === 'post-sb') return `POST SB ${entry.amount}`;
  if (entry.type === 'post-bb') return `POST BB ${entry.amount}`;
  if (entry.type === 'check' || entry.type === 'fold') return entry.type.toUpperCase();
  return `${entry.type.toUpperCase()} ${entry.amount}`;
}

function settlementNarration(
  settled: HoldemSettledResponse,
): { headline: string; detail: string } {
  const outcome: SerializedHoldemHand = settled.outcome;
  const winners = outcome.seats.filter((seat) => seat.isWinner);
  const humanWinner = winners.find((seat) => seat.isHuman);
  const oneSurvivor = outcome.seats.filter((seat) => seat.status !== 'folded').length === 1;
  const net = BigInt(settled.net);
  const netText = `${net >= 0n ? '+' : ''}${net.toString()} vCLAW`;

  if (oneSurvivor && humanWinner) {
    return {
      headline: `Everyone folded — you take the pot: +${settled.payout} vCLAW`,
      detail: `Your net: ${netText}`,
    };
  }
  if (oneSurvivor && winners[0]) {
    return {
      headline: `Everyone else folded — ${seatName(winners[0].seat)} takes ${winners[0].won} vCLAW`,
      detail: `Your net: ${netText}`,
    };
  }

  const winnerText = winners.map((winner) => {
    const category = winner.handCategoryName ? ` with ${winner.handCategoryName}` : '';
    return `${seatName(winner.seat)} wins ${winner.won} vCLAW${category}`;
  }).join(' · ');
  const splitDetail = outcome.pots.length > 1 || outcome.pots.some((pot) => pot.winners.length > 1)
    ? outcome.pots.map((pot, index) => {
        const names = pot.winners.map(seatName).join(' + ');
        return `${outcome.pots.length > 1 ? `Pot ${index + 1}` : 'Split pot'}: ${names} (${pot.amount} vCLAW)`;
      }).join(' · ')
    : '';
  return {
    headline: `Showdown — ${winnerText || 'pot awarded'}`,
    detail: [splitDetail, `Your net: ${netText}`].filter(Boolean).join(' · '),
  };
}

/** P3 — seated in-world action HUD (2026-07-15). While the player is seated
 * at T1 the 2D modal is suppressed (founder contract: the entire session
 * renders on the felt), so this DOM overlay is the ONLY action surface. It is
 * a pure consumer of the shared Hold'em controller — the SAME handleDeal /
 * runAction / handleWalkAway mutation path the modal uses; it never issues
 * its own requests. It owns the private hole-card/public-board DOM overlay;
 * TableCards3D renders only public board cards and opponent pairs on felt. */
export function SeatedHoldemHud() {
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const holdemModalOpen = useCoveStore((state) => state.holdemModalOpen);
  const { data: avatar } = useAvatar();

  const {
    table, live, settled, revealedSeed, toast, phase, agentMode, inFlight,
    walkAwayLocked, pot, publicPot, toCallNum, facingBet, canCheck, humanStack,
    humanCommitted,
    playerHoleCards, communityCards,
    resetHand, handleDeal, runAction, handleWalkAway,
  } = useHoldemController();

  const [showRaise, setShowRaise] = useState(false);
  const [raiseConfig, setRaiseConfig] = useState<RaiseConfig>({ min: 0, max: 0, value: 0, verb: 'bet' });
  const [renderedLog, setRenderedLog] = useState<SerializedHoldemLogEntry[]>([]);
  const [revealedBoardCount, setRevealedBoardCount] = useState(0);
  const [replayBusy, setReplayBusy] = useState(false);
  const [actionFlash, setActionFlash] = useState<{ seat: number; text: string } | null>(null);
  const [streetToast, setStreetToast] = useState<string | null>(null);
  const playbackHandRef = useRef<string | null>(null);
  const renderedLogRef = useRef<SerializedHoldemLogEntry[]>([]);
  const revealedBoardCountRef = useRef(0);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const seatedActive = seatedTable?.tableId === 'T1' && !holdemModalOpen;
  const handKey = live?.handId ?? settled?.handId ?? null;
  const targetLog = settled?.outcome.actionLog ?? live?.publicActionLog ?? EMPTY_LOG;
  const targetBoardCount = settled?.outcome.board.length ?? live?.board.length ?? 0;

  useEffect(() => {
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    if (!seatedActive || !handKey) {
      if (streetTimerRef.current) clearTimeout(streetTimerRef.current);
      playbackHandRef.current = null;
      renderedLogRef.current = [];
      revealedBoardCountRef.current = 0;
      setRenderedLog([]);
      setRevealedBoardCount(0);
      setReplayBusy(false);
      setActionFlash(null);
      setStreetToast(null);
      return;
    }

    if (playbackHandRef.current !== handKey) {
      playbackHandRef.current = handKey;
      renderedLogRef.current = [];
      revealedBoardCountRef.current = 0;
      setRenderedLog([]);
      setRevealedBoardCount(0);
    }

    const prefixMatches = renderedLogRef.current.length <= targetLog.length
      && renderedLogRef.current.every((entry, index) => sameLogEntry(entry, targetLog[index]!));
    if (!prefixMatches) {
      renderedLogRef.current = [];
      revealedBoardCountRef.current = 0;
      setRenderedLog([]);
      setRevealedBoardCount(0);
    }

    const queue: PlaybackEvent[] = [];
    let queuedBoardCount = revealedBoardCountRef.current;
    for (let index = renderedLogRef.current.length; index < targetLog.length; index += 1) {
      const entry = targetLog[index]!;
      const streetBoardCount = boardCountForStreet(entry.street);
      while (queuedBoardCount < streetBoardCount) {
        const streetEvent = nextStreetEvent(queuedBoardCount);
        queue.push(streetEvent);
        queuedBoardCount = streetEvent.boardCount;
      }
      queue.push({ kind: 'action', entry });
    }
    while (queuedBoardCount < targetBoardCount) {
      const streetEvent = nextStreetEvent(queuedBoardCount);
      queue.push(streetEvent);
      queuedBoardCount = streetEvent.boardCount;
    }

    if (queue.length === 0) {
      setReplayBusy(false);
      setActionFlash(null);
      return;
    }

    let cancelled = false;
    let cursor = 0;
    setReplayBusy(true);
    const playNext = () => {
      if (cancelled) return;
      const event = queue[cursor];
      if (!event) {
        setReplayBusy(false);
        setActionFlash(null);
        return;
      }
      if (event.kind === 'street') {
        revealedBoardCountRef.current = event.boardCount;
        setRevealedBoardCount(event.boardCount);
        setStreetToast(event.street.toUpperCase());
        if (streetTimerRef.current) clearTimeout(streetTimerRef.current);
        streetTimerRef.current = setTimeout(() => setStreetToast(null), 520);
      } else {
        const nextLog = [...renderedLogRef.current, event.entry];
        renderedLogRef.current = nextLog;
        setRenderedLog(nextLog);
        setActionFlash({ seat: event.entry.seat, text: actionLabel(event.entry) });
      }
      cursor += 1;
      playbackTimerRef.current = setTimeout(playNext, 600);
    };
    playbackTimerRef.current = setTimeout(playNext, 80);

    return () => {
      cancelled = true;
      if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    };
  }, [handKey, seatedActive, targetBoardCount, targetLog]);

  useEffect(() => () => {
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    if (streetTimerRef.current) clearTimeout(streetTimerRef.current);
  }, []);

  // The HUD renders null while unseated but stays MOUNTED, so slider state
  // would otherwise survive standing, modal play, and hand changes (P3.1,
  // Codex finding: a stale-but-legal raise could submit into a later hand).
  // Close it on any hand identity or phase transition.
  const liveHandId = live?.handId ?? null;
  useEffect(() => {
    setShowRaise(false);
  }, [liveHandId, phase, replayBusy]);

  const isAuthed = Boolean(avatar);
  const playoutPending = Boolean(handKey) && (
    playbackHandRef.current !== handKey
    || replayBusy
    || renderedLog.length !== targetLog.length
    || revealedBoardCount < targetBoardCount
  );
  const actionsDisabled = inFlight || agentMode === 'autonomous' || playoutPending;

  const handleOpenRaise = useCallback(() => {
    if (!live || phase !== 'player-turn' || actionsDisabled) return;
    const open = computeRaiseOpen(live);
    if (open.kind === 'call') {
      void runAction('call');
      return;
    }
    setRaiseConfig({ min: open.min, max: open.max, value: open.min, verb: open.verb });
    setShowRaise(true);
  }, [actionsDisabled, live, phase, runAction]);

  const handleConfirmRaise = useCallback(() => {
    setShowRaise(false);
    if (!live || phase !== 'player-turn' || actionsDisabled) return;
    // Re-derive against CURRENT live state at submit time — the hand can have
    // advanced (resync) since the slider opened. Clamp into today's legal
    // window; if raising is no longer possible, drop the click (the action
    // row re-renders with the legal options).
    const open = computeRaiseOpen(live);
    if (open.kind !== 'slider') return;
    const value = Math.min(Math.max(raiseConfig.value, open.min), open.max);
    void runAction(open.verb, value);
  }, [actionsDisabled, live, phase, raiseConfig, runAction]);

  const handleAllIn = useCallback(() => {
    if (!live || phase !== 'player-turn' || actionsDisabled) return;
    const shove = computeAllIn(live);
    setShowRaise(false);
    if (shove.action === 'call') void runAction('call');
    else void runAction(shove.action, shove.amount);
  }, [actionsDisabled, live, phase, runAction]);

  const handleNextHand = useCallback(() => {
    if (playoutPending) return;
    setShowRaise(false);
    resetHand();
  }, [playoutPending, resetHand]);

  const narration = useMemo(
    () => settled ? settlementNarration(settled) : null,
    [settled],
  );
  const publicSeats = useMemo(() => deriveHoldemPublicSeats(renderedLog), [renderedLog]);
  const narratedCards = useMemo(
    () => communityCards.map((card, index) => index < revealedBoardCount ? card : null),
    [communityCards, revealedBoardCount],
  );
  const livePositions = live ?? settled?.outcome ?? null;
  const visibleStreet = revealedBoardCount >= 5 ? 'river'
    : revealedBoardCount >= 4 ? 'turn'
      : revealedBoardCount >= 3 ? 'flop' : 'preflop';
  const renderedStreet = renderedLog.at(-1)?.street ?? 'preflop';

  // Seated-only surface: T1 with the modal closed (the hotspot suppresses the
  // modal while seated, but a hand resumed IN the modal then carried to the
  // seat keeps this gate correct in both orders).
  if (seatedTable?.tableId !== 'T1' || holdemModalOpen) return null;

  return (
    <>
      {livePositions && TABLE_ROOM_SEAT_ANCHORS.map((anchor, seat) => {
        if (seat === 0) return null;
        const publicSeat = publicSeats[seat];
        const folded = publicSeat?.folded ?? false;
        const streetBet = renderedStreet === visibleStreet
          ? (publicSeat?.streetCommitted ?? '0')
          : '0';
        const isFlashing = actionFlash?.seat === seat;
        return (
          <div
            key={`holdem-public-seat-${seat}`}
            style={{
              position: 'fixed', left: `clamp(52px, ${anchor.left}%, calc(100% - 52px))`, top: `${anchor.top}%`,
              transform: 'translate(-50%, -50%)', zIndex: 36,
              minWidth: seat === 0 ? 112 : 96, maxWidth: 150,
              padding: '6px 8px', borderRadius: 8, pointerEvents: 'none',
              background: folded ? 'rgba(45,50,54,0.86)' : 'rgba(8,14,18,0.88)',
              border: `1px solid ${isFlashing ? '#ffd27a' : folded ? 'rgba(150,160,165,0.35)' : 'rgba(60,180,120,0.38)'}`,
              boxShadow: isFlashing ? '0 0 22px rgba(255,194,92,0.72)' : '0 4px 16px rgba(0,0,0,0.38)',
              opacity: folded ? 0.62 : 1,
              color: '#e8f3ea', fontFamily: 'var(--pt-data)', textAlign: 'center',
              transition: 'border-color 140ms ease, box-shadow 140ms ease, opacity 180ms ease',
            }}
            data-testid={`holdem-seat-badge-${seat}`}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <b style={{ fontSize: 10, letterSpacing: '0.08em' }}>{seatName(seat)}</b>
              {livePositions.buttonSeat === seat && <span style={{ color: '#ffd27a' }}>D</span>}
              {livePositions.smallBlindSeat === seat && <span style={{ color: '#7dd3fc' }}>SB</span>}
              {livePositions.bigBlindSeat === seat && <span style={{ color: '#c4b5fd' }}>BB</span>}
            </div>
            <div style={{ marginTop: 3, color: folded ? '#b6bec2' : '#ffd27a', fontSize: 10, fontWeight: 700 }}>
              {folded ? 'FOLDED' : isFlashing ? actionFlash.text : BigInt(streetBet) > 0n ? `BET ${streetBet}` : '—'}
            </div>
          </div>
        );
      })}

      {streetToast && (
        <div style={{
          position: 'fixed', left: '50%', top: '34%', transform: 'translate(-50%, -50%)',
          zIndex: 48, pointerEvents: 'none', padding: '10px 24px', borderRadius: 999,
          background: 'rgba(8,14,18,0.92)', border: '1px solid rgba(255,205,120,0.7)',
          color: '#ffd27a', fontFamily: 'var(--pt-display)', fontWeight: 800,
          letterSpacing: '0.22em', boxShadow: '0 0 26px rgba(255,194,92,0.3)',
        }}>
          {streetToast}
        </div>
      )}

      {settled && narration && !playoutPending && (
        <div style={{
          position: 'fixed', left: '50%', top: '58%', transform: 'translate(-50%, -50%)',
          zIndex: 47, width: 'min(620px, calc(100vw - 24px))', pointerEvents: 'none',
          padding: '14px 18px', borderRadius: 12, textAlign: 'center',
          background: 'rgba(25,12,27,0.94)', border: '2px solid rgba(255,205,120,0.75)',
          boxShadow: '0 0 34px rgba(255,194,92,0.28)', color: '#fff4dc',
        }} data-testid="holdem-settlement-narration">
          <div style={{ fontFamily: 'var(--pt-display)', fontSize: 18, fontWeight: 800 }}>
            {narration.headline}
          </div>
          <div style={{ marginTop: 5, fontFamily: 'var(--pt-data)', fontSize: 11, color: '#d6c8b2' }}>
            {narration.detail}
          </div>
        </div>
      )}

    <div
      style={{
        position: 'fixed', left: '50%', bottom: 'max(16px, env(safe-area-inset-bottom))',
        transform: 'translateX(-50%)', zIndex: 40,
        display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
        width: 'min(560px, calc(100vw - 24px))', pointerEvents: 'auto',
      }}
      data-testid="seated-holdem-hud"
    >
      {phase !== 'idle' && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
          padding: '8px 12px', borderRadius: 10,
          background: 'rgba(8,14,18,0.82)', border: '1px solid rgba(60,180,100,0.2)',
          backdropFilter: 'blur(6px)', maxWidth: '100%',
        }}>
          {livePositions && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              color: publicSeats[0]?.folded ? '#aeb7bb' : '#e8f3ea',
              fontFamily: 'var(--pt-data)', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.08em',
            }} data-testid="holdem-seat-badge-0">
              <span>YOU</span>
              {livePositions.buttonSeat === 0 && <span style={{ color: '#ffd27a' }}>D</span>}
              {livePositions.smallBlindSeat === 0 && <span style={{ color: '#7dd3fc' }}>SB</span>}
              {livePositions.bigBlindSeat === 0 && <span style={{ color: '#c4b5fd' }}>BB</span>}
              <span style={{ color: publicSeats[0]?.folded ? '#aeb7bb' : '#ffd27a' }}>
                {publicSeats[0]?.folded
                  ? 'FOLDED'
                  : actionFlash?.seat === 0
                    ? actionFlash.text
                    : renderedStreet === visibleStreet && BigInt(publicSeats[0]?.streetCommitted ?? '0') > 0n
                      ? `BET ${publicSeats[0]!.streetCommitted}`
                      : '—'}
              </span>
            </div>
          )}
          <div aria-label="Your private hole cards" style={{ display: 'flex', gap: 6 }}>
            {playerHoleCards.map((card, index) => (
              <PokerCard key={`${card.suit}-${card.rank}-${index}`} card={card} compact />
            ))}
          </div>
          <CommunityCardRow cards={narratedCards} />
        </div>
      )}

      {toast && (
        <div style={{
          fontSize: 12, fontFamily: 'var(--pt-data)', padding: '6px 12px', borderRadius: 6,
          background: 'rgba(8,14,18,0.92)', border: '1px solid rgba(60,180,100,0.25)',
          color: toast.tone === 'error' ? '#f87171' : toast.tone === 'warn' ? '#f59e0b' : '#d8e8dc',
        }}>
          {toast.message}
        </div>
      )}

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8, width: '100%',
        background: 'rgba(8,14,18,0.88)', border: '1px solid rgba(60,180,100,0.22)',
        borderRadius: 10, padding: '10px 14px', backdropFilter: 'blur(6px)',
      }}>
        <div style={{
          display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap',
          fontSize: 11, fontFamily: 'var(--pt-data)', color: '#a8c0ae', letterSpacing: '0.08em',
        }}>
          {/* The live wire carries no pot total (only settled outcomes do),
              so POT shows at settle only — never a misleading live zero.
              STACK uses the controller's humanStack (live mid-hand,
              table.playerStack otherwise). P3.1 Codex finding. */}
          {phase !== 'idle' && <span>POT <b style={{ color: 'var(--pt-amber)' }}>{pot}</b></span>}
          <span style={{
            padding: '2px 7px', borderRadius: 999,
            border: '1px solid rgba(125,211,252,0.34)', color: '#bfe8ff',
          }}>
            BLINDS {live?.smallBlind ?? table?.smallBlind ?? '1'}/{live?.bigBlind ?? table?.bigBlind ?? '2'} vCLAW
          </span>
          {table && <span>STACK <b style={{ color: '#d8e8dc' }}>{Number(humanStack).toLocaleString()}</b></span>}
          {phase === 'player-turn' && facingBet && toCallNum > 0 && (
            <span>TO CALL <b style={{ color: 'var(--pt-amber)' }}>{toCallNum}</b></span>
          )}
          {playoutPending && <span style={{ color: '#ffd27a', fontWeight: 700 }}>PLAYING ACTIONS…</span>}
        </div>

        {showRaise && phase === 'player-turn' && (
          <RaiseSlider
            config={raiseConfig}
            pot={publicPot}
            bigBlind={live?.bigBlind ?? table?.bigBlind ?? '2'}
            humanCommitted={humanCommitted}
            onChange={(v) => setRaiseConfig((c) => ({ ...c, value: v }))}
            onConfirm={handleConfirmRaise}
            onCancel={() => setShowRaise(false)}
          />
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {phase === 'idle' && (
            <>
              <button
                type="button"
                onClick={() => { void handleDeal(); }}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-primary"
                style={{ height: 44, fontSize: 13, fontWeight: 700, minWidth: 120 }}
              >
                {inFlight ? 'Dealing…' : 'Deal'}
              </button>
              {/* Escape hatch at idle too (the modal's X equivalent): a
                  resumed table can be un-dealable (stack < big blind) and
                  the server copy says to close + re-buy — so the close must
                  be reachable HERE, not only at settled. */}
              {table && (
                <button
                  type="button" onClick={() => { void handleWalkAway(); }}
                  disabled={walkAwayLocked || playoutPending}
                  style={{
                    height: 44, fontSize: 12, fontWeight: 600,
                    fontFamily: 'var(--pt-data)', letterSpacing: '0.06em',
                    paddingLeft: 16, paddingRight: 16, borderRadius: 6,
                    border: 'none', background: '#dc2626', color: '#ffffff',
                    cursor: walkAwayLocked || playoutPending ? 'not-allowed' : 'pointer',
                    opacity: walkAwayLocked || playoutPending ? 0.6 : 1,
                  }}
                >
                  {isAuthed ? 'Walk Away' : 'Close'}
                </button>
              )}
            </>
          )}

          {phase === 'player-turn' && !showRaise && (
            <>
              <button
                type="button" onClick={() => { void runAction('fold'); }}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-ghost"
                style={{ height: 44, fontSize: 12, minWidth: 64 }}
              >
                Fold
              </button>
              {canCheck ? (
                <button
                  type="button" onClick={() => { void runAction('check'); }}
                  disabled={actionsDisabled}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 44, fontSize: 13, fontWeight: 700, minWidth: 76 }}
                >
                  Check
                </button>
              ) : (
                <button
                  type="button" onClick={() => { void runAction('call'); }}
                  disabled={actionsDisabled}
                  className="pt-btn pt-btn-primary"
                  style={{ height: 44, fontSize: 13, fontWeight: 700, minWidth: 96 }}
                >
                  Call {toCallNum > 0 ? `${toCallNum} vCLAW` : ''}
                </button>
              )}
              <button
                type="button" onClick={handleOpenRaise}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-ghost"
                style={{ height: 44, fontSize: 12, minWidth: 76 }}
              >
                {facingBet ? 'Raise' : 'Bet'}
              </button>
              <button
                type="button" onClick={handleAllIn}
                disabled={actionsDisabled}
                className="pt-btn pt-btn-ghost"
                style={{ height: 44, fontSize: 12, minWidth: 76, color: '#f59e0b' }}
              >
                All In
              </button>
            </>
          )}

          {phase === 'settled' && (
            <>
              {/* revealedSeed gate mirrors the modal: after Walk Away cashes
                  out, Next Hand inside the auto-close window would orphan a
                  fresh buy-in. */}
              <button
                type="button" onClick={handleNextHand}
                disabled={inFlight || Boolean(revealedSeed) || playoutPending}
                className="pt-btn pt-btn-primary"
                style={{ height: 44, fontSize: 13, minWidth: 110 }}
              >
                Next Hand
              </button>
              {/* Same button for BOTH tiers, exactly like the modal ("Close"
                  for guests): without it, a guest whose demo stack hits 0 has
                  a dead Deal button and no way to reset the table from the
                  seat (P4 live-run find). */}
              <button
                type="button" onClick={() => { void handleWalkAway(); }}
                  disabled={walkAwayLocked || playoutPending}
                style={{
                  height: 44, fontSize: 12, fontWeight: 600,
                  fontFamily: 'var(--pt-data)', letterSpacing: '0.06em',
                  paddingLeft: 16, paddingRight: 16, borderRadius: 6,
                  border: 'none', background: '#dc2626', color: '#ffffff',
                  cursor: walkAwayLocked || playoutPending ? 'not-allowed' : 'pointer',
                  opacity: walkAwayLocked || playoutPending ? 0.6 : 1,
                }}
              >
                {isAuthed ? 'Walk Away' : 'Close'}
              </button>
            </>
          )}
        </div>

        <div style={{
          textAlign: 'center', fontSize: 10, fontFamily: 'var(--pt-data)',
          color: '#6f8a76', letterSpacing: '0.1em',
        }}>
          PRESS E TO STAND
        </div>
      </div>
    </div>
    </>
  );
}
