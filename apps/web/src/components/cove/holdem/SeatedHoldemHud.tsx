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
import styles from './SeatedHoldemHud.module.css';
import {
  registerHoldemSeatBadge,
  requestHoldemTableRecenter,
} from '@/lib/cove/holdem-table-view';
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

/** Display-only decision duration. A future enforcement round may reuse this
 * constant; this HUD never auto-acts, folds, or calls when it reaches zero. */
export const HOLDEM_DECISION_SECONDS = 12;
const HOLDEM_DECISION_MS = HOLDEM_DECISION_SECONDS * 1_000;

/**
 * Initial no-JS/fresh-mount positions. The room camera replaces seats 1-5
 * with live world projections whenever yaw or viewport geometry changes.
 * Side badges start farther outside the avatar silhouettes than the prior
 * anchors, so the default player view never masks a face.
 */
const TABLE_ROOM_SEAT_ANCHORS: ReadonlyArray<Readonly<{ left: number; top: number }>> = [
  { left: 50, top: 76 },
  { left: 95, top: 70 },
  { left: 95, top: 54 },
  { left: 94, top: 37 },
  { left: 5, top: 54 },
  { left: 6, top: 37 },
];
const TABLE_ROOM_SEAT_REFS: readonly ((element: HTMLDivElement | null) => void)[] =
  TABLE_ROOM_SEAT_ANCHORS.map((_, seat) => (
    (element: HTMLDivElement | null) => registerHoldemSeatBadge(seat, element)
  ));

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
  const [decisionRemainingMs, setDecisionRemainingMs] = useState(HOLDEM_DECISION_MS);
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
  const decisionActive = phase === 'player-turn' && !actionsDisabled;
  const decisionKey = `${live?.handId ?? ''}:${live?.publicActionLog.length ?? 0}:${toCallNum}`;

  useEffect(() => {
    if (!decisionActive) {
      setDecisionRemainingMs(HOLDEM_DECISION_MS);
      return;
    }

    requestHoldemTableRecenter();
    const startedAt = performance.now();
    setDecisionRemainingMs(HOLDEM_DECISION_MS);
    const timer = window.setInterval(() => {
      const next = Math.max(0, HOLDEM_DECISION_MS - (performance.now() - startedAt));
      setDecisionRemainingMs(next);
      if (next === 0) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [decisionActive, decisionKey]);

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
  const decisionSeconds = Math.ceil(decisionRemainingMs / 1_000);
  const timerTone = decisionRemainingMs < 3_000
    ? styles.timerDanger
    : decisionRemainingMs < 5_000
      ? styles.timerWarn
      : '';
  const timerZero = decisionRemainingMs === 0 ? styles.timerZero : '';
  const timerProgress = `${(decisionRemainingMs / HOLDEM_DECISION_MS) * 100}%`;

  // Seated-only surface: T1 with the modal closed (the hotspot suppresses the
  // modal while seated, but a hand resumed IN the modal then carried to the
  // seat keeps this gate correct in both orders).
  if (seatedTable?.tableId !== 'T1' || holdemModalOpen) return null;

  return (
    <div className={styles.surface}>
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
            key={'holdem-public-seat-' + seat}
            ref={TABLE_ROOM_SEAT_REFS[seat]}
            className={styles.seatBadge
              + (folded ? ' ' + styles.seatBadgeFolded : '')
              + (isFlashing ? ' ' + styles.seatBadgeThinking : '')}
            style={{ left: anchor.left + '%', top: anchor.top + '%' }}
            data-testid={'holdem-seat-badge-' + seat}
          >
            <div className={styles.seatNameRow + ' ' + styles.smallCaps}>
              <span>{seatName(seat)}</span>
              {livePositions.buttonSeat === seat && (
                <span className={styles.positionChip + ' ' + styles.dealerChip} title="Dealer button">D</span>
              )}
              {livePositions.smallBlindSeat === seat && (
                <span className={styles.positionChip} title="Small blind">SB</span>
              )}
              {livePositions.bigBlindSeat === seat && (
                <span className={styles.positionChip} title="Big blind">BB</span>
              )}
            </div>
            <div className={styles.seatAction}>
              {folded
                ? 'Folded'
                : isFlashing
                  ? actionFlash.text
                  : BigInt(streetBet) > 0n
                    ? 'Bet ' + streetBet
                    : '—'}
            </div>
          </div>
        );
      })}

      {streetToast && <div className={styles.streetToast}>{streetToast}</div>}

      {settled && narration && !playoutPending && (
        <div className={styles.settlement} data-testid="holdem-settlement-narration">
          <div className={styles.settlementHeadline}>{narration.headline}</div>
          <div className={styles.settlementDetail}>{narration.detail}</div>
        </div>
      )}

      <div className={styles.hud} data-testid="seated-holdem-hud">
        {phase !== 'idle' && (
          <div className={styles.cardTray} data-testid="holdem-card-tray">
            <div className={styles.privateCards}>
              {livePositions && (
                <div
                  ref={TABLE_ROOM_SEAT_REFS[0]}
                  className={styles.trayLabel + ' ' + styles.smallCaps}
                  data-testid="holdem-seat-badge-0"
                >
                  <span>You</span>
                  {livePositions.buttonSeat === 0 && (
                    <span className={styles.positionChip + ' ' + styles.dealerChip} title="Dealer button">D</span>
                  )}
                  {livePositions.smallBlindSeat === 0 && (
                    <span className={styles.positionChip} title="Small blind">SB</span>
                  )}
                  {livePositions.bigBlindSeat === 0 && (
                    <span className={styles.positionChip} title="Big blind">BB</span>
                  )}
                  <span className={styles.seatAction}>
                    {publicSeats[0]?.folded
                      ? 'Folded'
                      : actionFlash?.seat === 0
                        ? actionFlash.text
                        : renderedStreet === visibleStreet
                            && BigInt(publicSeats[0]?.streetCommitted ?? '0') > 0n
                          ? 'Bet ' + publicSeats[0]!.streetCommitted
                          : '—'}
                  </span>
                </div>
              )}
              <div aria-label="Your private hole cards" className={styles.cardPair}>
                {playerHoleCards.map((card, cardIndex) => (
                  <PokerCard
                    key={[card.suit, card.rank, cardIndex].join('-')}
                    card={card}
                    compact
                  />
                ))}
              </div>
            </div>
            <div className={styles.trayDivider} aria-hidden />
            <div className={styles.boardCards}>
              <div className={styles.trayLabel + ' ' + styles.smallCaps}>Table</div>
              <CommunityCardRow cards={narratedCards} />
            </div>
          </div>
        )}

        {toast && (
          <div
            className={styles.toast
              + (toast.tone === 'error' ? ' ' + styles.toastError : '')
              + (toast.tone === 'warn' ? ' ' + styles.toastWarn : '')}
          >
            {toast.message}
          </div>
        )}

        <div className={styles.panel + ' ' + styles.actionPanel}>
          <div className={styles.statusRow}>
            {phase !== 'idle' && (
              <span className={styles.metric}>Pot <strong>{pot}</strong></span>
            )}
            <span className={styles.blindPill}>
              Blinds {live?.smallBlind ?? table?.smallBlind ?? '1'}/
              {live?.bigBlind ?? table?.bigBlind ?? '2'} vCLAW
            </span>
            {table && (
              <span className={styles.metric}>
                Stack <strong>{Number(humanStack).toLocaleString()}</strong>
              </span>
            )}
            {phase === 'player-turn' && facingBet && toCallNum > 0 && (
              <span className={styles.metric}>To call <strong>{toCallNum}</strong></span>
            )}
            {playoutPending && <span className={styles.playout}>Playing actions…</span>}
          </div>

          {decisionActive && (
            <div
              className={styles.decisionTimer
                + (timerTone ? ' ' + timerTone : '')
                + (timerZero ? ' ' + timerZero : '')}
              role="timer"
              aria-label={decisionSeconds + ' seconds left to act; visual timer only'}
              data-testid="holdem-decision-timer"
            >
              <span className={styles.smallCaps}>Your decision</span>
              <div className={styles.timerTrack} aria-hidden>
                <div className={styles.timerFill} style={{ width: timerProgress }} />
              </div>
              <span className={styles.timerNumber}>{decisionSeconds}s</span>
            </div>
          )}

          {showRaise && phase === 'player-turn' && (
            <RaiseSlider
              config={raiseConfig}
              pot={publicPot}
              bigBlind={live?.bigBlind ?? table?.bigBlind ?? '2'}
              humanCommitted={humanCommitted}
              onChange={(value) => setRaiseConfig((current) => ({ ...current, value }))}
              onConfirm={handleConfirmRaise}
              onCancel={() => setShowRaise(false)}
            />
          )}

          <div className={styles.actionRow}>
            {phase === 'idle' && (
              <>
                <button
                  type="button"
                  onClick={() => { void handleDeal(); }}
                  disabled={actionsDisabled}
                  className={styles.actionButton + ' ' + styles.primaryButton}
                >
                  {inFlight ? 'Dealing…' : 'Deal'}
                </button>
                {table && (
                  <button
                    type="button"
                    onClick={() => { void handleWalkAway(); }}
                    disabled={walkAwayLocked || playoutPending}
                    className={styles.actionButton + ' ' + styles.walkButton}
                  >
                    {isAuthed ? 'Walk Away' : 'Close'}
                  </button>
                )}
              </>
            )}

            {phase === 'player-turn' && !showRaise && (
              <>
                <button
                  type="button"
                  onClick={() => { void runAction('fold'); }}
                  disabled={actionsDisabled}
                  className={styles.actionButton + ' ' + styles.foldButton}
                >
                  Fold
                </button>
                {canCheck ? (
                  <button
                    type="button"
                    onClick={() => { void runAction('check'); }}
                    disabled={actionsDisabled}
                    className={styles.actionButton + ' ' + styles.primaryButton}
                  >
                    Check
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { void runAction('call'); }}
                    disabled={actionsDisabled}
                    className={styles.actionButton + ' ' + styles.primaryButton}
                  >
                    {'Call' + (toCallNum > 0 ? ' ' + toCallNum + ' vCLAW' : '')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleOpenRaise}
                  disabled={actionsDisabled}
                  className={styles.actionButton}
                >
                  {facingBet ? 'Raise' : 'Bet'}
                </button>
                <button
                  type="button"
                  onClick={handleAllIn}
                  disabled={actionsDisabled}
                  className={styles.actionButton + ' ' + styles.allInButton}
                >
                  All In
                </button>
              </>
            )}

            {phase === 'settled' && (
              <>
                <button
                  type="button"
                  onClick={handleNextHand}
                  disabled={inFlight || Boolean(revealedSeed) || playoutPending}
                  className={styles.actionButton + ' ' + styles.primaryButton}
                >
                  Next Hand
                </button>
                <button
                  type="button"
                  onClick={() => { void handleWalkAway(); }}
                  disabled={walkAwayLocked || playoutPending}
                  className={styles.actionButton + ' ' + styles.walkButton}
                >
                  {isAuthed ? 'Walk Away' : 'Close'}
                </button>
              </>
            )}
          </div>

          <div className={styles.legendRow}>
            <span>
              <span className={styles.positionChip + ' ' + styles.dealerChip}>D</span> Dealer
            </span>
            <span><span className={styles.positionChip}>SB</span> Small blind</span>
            <span><span className={styles.positionChip}>BB</span> Big blind</span>
            <span className={styles.controlHint}>
              ←/→ Look around · Home center · E stand
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
