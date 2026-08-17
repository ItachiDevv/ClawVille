'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCoveStore } from '@/stores/cove';
import { useAvatar } from '@/hooks/use-avatar';
import '@/styles/cove-tokens.css';
import {
  computeAllIn,
  computeRaiseOpen,
  useHoldemController,
} from '@/lib/cove/holdem-controller';
import { computeRaisePresets } from '@/lib/cove/holdem-bet-math';
import {
  holdemSeatName,
  settlementNarration,
} from '@/lib/cove/holdem-settlement-narration';
import PokerCard from './PokerCard';
import CommunityCardRow from './CommunityCardRow';
import styles from './SeatedHoldemHud.module.css';
import {
  registerHoldemSeatBadge,
  publishHoldemSettledReveal,
  requestHoldemTableRecenter,
} from '@/lib/cove/holdem-table-view';
import {
  deriveHoldemPublicSeats,
  type CashSettledHandSnapshot,
  type HoldemStreet,
  type SerializedHoldemLogEntry,
} from '@clawville/shared';
import { ParityMirror } from '@/components/cove/CardParityMirror';
import {
  buildHoldemTrayParity,
  publishFeltParity,
} from '@/lib/cove/card-parity-mirror';
import type {
  CashAction,
  CashActionKind,
  CashAgentView,
  CashPublicSeat,
  PublicTableStateResponse,
} from '@/lib/cove/cash-poker';

const EMPTY_LOG: readonly SerializedHoldemLogEntry[] = [];
/** Display-only decision duration. A future enforcement round may reuse this
 * constant; this HUD never auto-acts, folds, or calls when it reaches zero. */
export const HOLDEM_DECISION_SECONDS = 10;
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

const CASH_ROOM_BADGE_REFS: readonly ((element: HTMLDivElement | null) => void)[] =
  Array.from({ length: 5 }, (_, physicalIndex) => (
    (element: HTMLDivElement | null) => registerHoldemSeatBadge(physicalIndex, element)
  ));

function secondsUntil(deadlineMs: number | null): number | null {
  return deadlineMs == null ? null : Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1_000));
}

interface CashTableRoomHudProps {
  instanceId: string;
  state: PublicTableStateResponse | null;
  selfView: CashAgentView | null;
  settled: CashSettledHandSnapshot | null;
  povSeatIndex: number;
  amSeated: boolean;
  sitting: boolean;
  leaving: boolean;
  leaveQueued: boolean;
  actionBusy: boolean;
  pollNotice?: string | null;
  actionNotice?: string | null;
  cashedOutCt?: number | null;
  onSit: () => void;
  onLeave: () => void;
  onAction: (action: CashAction) => void;
}

interface CashSeatBadgeView {
  avatarId: string;
  name: string;
  chipStack: number;
  status: CashPublicSeat['status'] | 'roster';
  isButton: boolean;
  isSB: boolean;
  isBB: boolean;
  isActing: boolean;
}

/** Live cash-table overlay. Public badges/board come only from the public
 * snapshot; the private fan/actions come only from the own-seat poll after a
 * hand-number freshness check. Physical badge slot N maps to server seat
 * `(pov + N + 1) % 6`, matching the 3D chair rotation. */
export function CashTableRoomHud({
  instanceId,
  state,
  selfView,
  settled,
  povSeatIndex,
  amSeated,
  sitting,
  leaving,
  leaveQueued,
  actionBusy,
  pollNotice,
  actionNotice,
  cashedOutCt,
  onSit,
  onLeave,
  onAction,
}: CashTableRoomHudProps) {
  const live = state?.live ?? null;
  const freshSelf = live && selfView?.handNumber === live.handNumber ? selfView : null;
  const ownDeadline = freshSelf?.isYourTurn ? freshSelf.deadlineMs : null;
  const [countdown, setCountdown] = useState<number | null>(
    secondsUntil(ownDeadline ?? live?.toActDeadlineMs ?? null),
  );
  const countdownBudgetRef = useRef<number | null>(
    secondsUntil(ownDeadline ?? live?.toActDeadlineMs ?? null),
  );
  const [confirmingSit, setConfirmingSit] = useState(false);
  const [raiseTo, setRaiseTo] = useState(0);
  const seatNameByAvatarRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const deadline = ownDeadline ?? live?.toActDeadlineMs ?? null;
    const initial = secondsUntil(deadline);
    countdownBudgetRef.current = initial;
    setCountdown(initial);
    if (deadline == null) return;
    const timer = window.setInterval(() => setCountdown(secondsUntil(deadline)), 250);
    return () => window.clearInterval(timer);
  }, [live?.handNumber, live?.toActDeadlineMs, ownDeadline]);

  useEffect(() => {
    if (!freshSelf) return;
    setRaiseTo(freshSelf.minRaiseTo);
    if (freshSelf.isYourTurn) requestHoldemTableRecenter();
  }, [freshSelf?.deadlineMs, freshSelf?.handNumber, freshSelf?.isYourTurn, freshSelf?.minRaiseTo]);

  useEffect(() => {
    if (amSeated) setConfirmingSit(false);
  }, [amSeated]);

  useEffect(() => {
    if (!live) return;
    for (const seat of live.seats) {
      seatNameByAvatarRef.current.set(seat.avatarId, seat.name);
    }
  }, [live]);

  const physicalSeats = useMemo<Array<CashSeatBadgeView | null>>(() => Array.from({ length: 5 }, (_, index) => {
    const serverSeatIndex = (povSeatIndex + index + 1) % 6;
    const liveSeat = live?.seats.find((seat) => seat.seatIndex === serverSeatIndex);
    if (liveSeat) return liveSeat;
    if (live) return null;
    const rosterSeat = state?.seats.find(
      (seat) => seat.status !== 'left' && seat.seatIndex === serverSeatIndex,
    );
    if (!rosterSeat) return null;
    return {
      avatarId: rosterSeat.avatarId,
      name: seatNameByAvatarRef.current.get(rosterSeat.avatarId) ?? 'Seated',
      chipStack: Number(rosterSeat.stackCt),
      status: 'roster',
      isButton: false,
      isSB: false,
      isBB: false,
      isActing: false,
    };
  }), [live, povSeatIndex, state?.seats]);
  const povSeat = live?.seats.find((seat) => seat.seatIndex === povSeatIndex) ?? null;
  const legal: readonly CashActionKind[] = freshSelf?.legalActions ?? [];
  const canFold = legal.includes('fold');
  const canCheck = legal.includes('check');
  const canCall = legal.includes('call');
  const canBet = legal.includes('bet');
  const canRaise = legal.includes('raise');
  const canSize = canBet || canRaise;
  const actionExpired = countdown === 0;
  const actionsDisabled = actionBusy || actionExpired || !freshSelf?.isYourTurn;
  const clampedRaiseTo = freshSelf
    ? Math.min(Math.max(raiseTo, freshSelf.minRaiseTo), freshSelf.maxRaiseTo)
    : 0;
  const raisePresets = useMemo(() => {
    if (!freshSelf || !live || !canSize) return [];
    const min = freshSelf.minRaiseTo;
    const max = freshSelf.maxRaiseTo;
    const clamp = (value: number) => Math.min(Math.max(Math.round(value), min), max);
    return [
      { label: 'Min', value: min },
      { label: '½ Pot', value: clamp(freshSelf.toCall + live.pot * 0.5) },
      { label: 'Pot', value: clamp(freshSelf.toCall + live.pot) },
      { label: 'All In', value: max },
    ].filter((preset, index, all) => all.findIndex((item) => item.value === preset.value) === index);
  }, [canSize, freshSelf, live]);
  const hasOpenSeat = Boolean(state && state.seats.length < state.table.maxSeats);
  const settledSelf = settled?.seats.find((seat) => seat.seatIndex === povSeatIndex) ?? null;
  const settledPot = settled?.pots
    .reduce((total, item) => total + BigInt(item.amount), 0n)
    .toString() ?? null;
  const settlementHeadline = settled
    ? settled.endedAt === 'showdown' ? 'Showdown' : 'Hand won without showdown'
    : null;

  useEffect(() => {
    if (settled) {
      publishFeltParity(instanceId, buildHoldemTrayParity({
        kind: 'cash',
        hole: settledSelf?.shown ?? [],
        board: settled.board,
        settled,
        correlation: {
          hand: `${settled.tableId}:${settled.handNumber}`,
          handNumber: settled.handNumber,
        },
        dealStep: 'showdown',
        phase: 'settled',
        transition: 'idle',
        ownSeatIndex: povSeatIndex,
        ...(settlementHeadline ? { bannerText: settlementHeadline } : {}),
        ...(settledPot === null ? {} : { pot: settledPot }),
      }));
      return;
    }

    const handNumber = live?.handNumber ?? null;
    const dealStep = live?.street === 'preflop' ? 'hole' : live?.street ?? 'hole';
    publishFeltParity(instanceId, buildHoldemTrayParity({
      kind: 'cash',
      hole: freshSelf?.holeCards ?? [],
      board: live?.board ?? [],
      settled: null,
      correlation: {
        hand: handNumber == null ? `${state?.table.id ?? 'cash'}:idle` : `${state?.table.id ?? 'cash'}:${handNumber}`,
        handNumber,
      },
      dealStep,
      phase: live?.street ?? 'idle',
      transition: 'idle',
      ownSeatIndex: povSeatIndex,
      ...(live ? { pot: String(live.pot) } : {}),
    }));
  }, [
    freshSelf,
    instanceId,
    live,
    povSeatIndex,
    settled,
    settlementHeadline,
    settledPot,
    settledSelf,
    state?.table.id,
  ]);

  return (
    <div className={styles.surface} data-testid="cash-table-room-hud">
      <ParityMirror surface="holdem-tray-3d" instanceId={instanceId} />
      {physicalSeats.map((seat, physicalIndex) => seat ? (
        <div
          key={seat.avatarId}
          ref={CASH_ROOM_BADGE_REFS[physicalIndex]}
          className={styles.seatBadge
            + (seat.status === 'folded' ? ' ' + styles.seatBadgeFolded : '')
            + (seat.isActing ? ' ' + styles.seatBadgeThinking : '')}
          style={{
            left: TABLE_ROOM_SEAT_ANCHORS[physicalIndex + 1]!.left + '%',
            top: TABLE_ROOM_SEAT_ANCHORS[physicalIndex + 1]!.top + '%',
          }}
        >
          <div className={styles.seatNameRow + ' ' + styles.smallCaps}>
            <span>{seat.name}</span>
            {seat.isButton && <span className={styles.positionChip + ' ' + styles.dealerChip}>D</span>}
            {seat.isSB && <span className={styles.positionChip}>SB</span>}
            {seat.isBB && <span className={styles.positionChip}>BB</span>}
          </div>
          <div className={styles.seatAction}>
            {seat.chipStack.toLocaleString()} vCLAW
            {' · '}
            {seat.status === 'roster' ? 'Seated' : seat.status === 'allin' ? 'All in' : seat.status === 'folded' ? 'Folded' : seat.isActing ? `${countdown ?? 0}s` : 'In hand'}
          </div>
        </div>
      ) : null)}

      {!live && cashedOutCt == null && (
        <div className={styles.settlement} data-testid="cash-table-waiting">
          <div className={styles.settlementHeadline}>
            {amSeated && physicalSeats.some(Boolean) ? 'Next hand' : 'Waiting for players'}
          </div>
          <div className={styles.settlementDetail}>
            {amSeated
              ? physicalSeats.some(Boolean)
                ? 'The next hand is starting…'
                : 'You are seated — the game starts when another player joins.'
              : 'Sit down to start the game.'}
          </div>
        </div>
      )}

      {cashedOutCt != null && (
        <div className={styles.settlement} data-testid="cash-table-cashed-out">
          <div className={styles.settlementHeadline}>Cashed out</div>
          <div className={styles.settlementDetail}>{cashedOutCt.toLocaleString()} vCLAW returned to your avatar.</div>
        </div>
      )}

      {settled && settlementHeadline && (
        <div className={styles.settlement} data-testid="holdem-settlement-narration">
          <div className={styles.settlementHeadline}>{settlementHeadline}</div>
          <div className={styles.settlementDetail}>
            Hand {settled.handNumber}
            {settledPot != null && (
              <> · <span data-testid="holdem-pot-amount">Pot {Number(settledPot).toLocaleString()} vCLAW</span></>
            )}
            {settledSelf && (
              <>
                {' · '}
                <span data-testid="holdem-self-stack">
                  Stack {Number(settledSelf.endStack).toLocaleString()} vCLAW
                </span>
                {` · ${Number(settledSelf.net) >= 0 ? '+' : ''}${settledSelf.net} vCLAW net`}
              </>
            )}
          </div>
        </div>
      )}

      <div className={styles.hud}>
        {freshSelf && (
          <div className={styles.cardTray} data-testid="cash-private-card-tray">
            <div className={styles.privateCards}>
              <div className={styles.trayLabel + ' ' + styles.smallCaps}>Your hand</div>
              <div aria-label="Your private hole cards" className={styles.cardPair}>
                {freshSelf.holeCards.map((card, index) => (
                  <PokerCard key={`${card.suit}-${card.rank}-${index}`} card={card} compact />
                ))}
              </div>
            </div>
            <div className={styles.trayDivider} aria-hidden />
            <div className={styles.boardCards}>
              <div className={styles.trayLabel + ' ' + styles.smallCaps}>Table</div>
              <CommunityCardRow cards={live?.board ?? []} />
            </div>
          </div>
        )}
        <div className={styles.panel + ' ' + styles.actionPanel}>
          <div className={styles.statusRow}>
            {live && (
              <span
                className={styles.metric}
                data-testid={settled ? undefined : 'holdem-pot-amount'}
              >
                Pot <strong>{live.pot.toLocaleString()}</strong> vCLAW
              </span>
            )}
            <span className={styles.blindPill}>
              Blinds {state?.table.smallBlindCt ?? '—'}/{state?.table.bigBlindCt ?? '—'} vCLAW
            </span>
            {live && <span className={styles.metric}>{live.street.toUpperCase()} · Hand {live.handNumber}</span>}
            {live?.toActSeatIndex != null && (
              <span className={styles.metric}>
                Acting <strong>{live.seats.find((seat) => seat.seatIndex === live.toActSeatIndex)?.name ?? `Seat ${live.toActSeatIndex + 1}`}</strong>
                {countdown != null ? ` · ${countdown}s` : ''}
              </span>
            )}
            {povSeat && (
              <span
                className={styles.metric}
                data-testid={settled ? undefined : 'holdem-self-stack'}
              >
                {povSeat.name} · <strong>{povSeat.chipStack.toLocaleString()}</strong> vCLAW
              </span>
            )}
          </div>
          {pollNotice && <div className={styles.toast + ' ' + styles.toastWarn}>{pollNotice}</div>}
          {actionNotice && <div className={styles.toast + ' ' + styles.toastError}>{actionNotice}</div>}
          {leaveQueued && <div className={styles.toast + ' ' + styles.toastWarn}>Cashing out after this hand…</div>}

          {freshSelf?.isYourTurn && (
            <div
              className={styles.decisionTimer + (actionExpired ? ' ' + styles.timerZero : '')}
              role="timer"
              aria-label={`${countdown ?? 0} seconds left to act`}
              data-testid="cash-server-deadline"
            >
              <span className={styles.smallCaps}>{actionExpired ? 'Server resolving turn' : 'Your turn'}</span>
              <div className={styles.timerTrack} aria-hidden>
                <div
                  className={styles.timerFill}
                  style={{
                    width: `${countdownBudgetRef.current && countdown != null
                      ? Math.min(100, Math.max(0, (countdown / countdownBudgetRef.current) * 100))
                      : 0}%`,
                  }}
                />
              </div>
              <span className={styles.timerNumber}>{countdown ?? 0}s</span>
            </div>
          )}

          {canSize && freshSelf && (
            <div className={styles.inlineBetPanel}>
              <div className={styles.inlinePresetRow} aria-label="One-tap raise-to sizes">
                {raisePresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setRaiseTo(preset.value)}
                    disabled={actionsDisabled}
                    className={styles.actionButton + ' ' + styles.presetButton}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className={styles.inlineAmountRow}>
                <label className={styles.amountLabel} htmlFor="cash-raise-to">{canRaise ? 'Raise to' : 'Bet to'}</label>
                <input
                  type="range"
                  min={freshSelf.minRaiseTo}
                  max={freshSelf.maxRaiseTo}
                  step={1}
                  value={clampedRaiseTo}
                  onChange={(event) => setRaiseTo(Number(event.target.value))}
                  disabled={actionsDisabled}
                  className={styles.inlineRange}
                  aria-label="Total raise-to amount"
                />
                <input
                  id="cash-raise-to"
                  type="number"
                  inputMode="numeric"
                  min={freshSelf.minRaiseTo}
                  max={freshSelf.maxRaiseTo}
                  value={clampedRaiseTo}
                  onChange={(event) => setRaiseTo(Number(event.target.value))}
                  disabled={actionsDisabled}
                  className={styles.amountInput}
                  aria-label="Total raise-to amount in vCLAW"
                />
              </div>
              <div className={styles.raiseLimits}>
                <span>Min {freshSelf.minRaiseTo}</span>
                <span>Max {freshSelf.maxRaiseTo}</span>
              </div>
            </div>
          )}

          <div className={styles.actionRow}>
            {!amSeated && cashedOutCt == null && !confirmingSit && (
              <button
                type="button"
                onClick={() => setConfirmingSit(true)}
                disabled={!state || !hasOpenSeat}
                className={styles.actionButton + ' ' + styles.primaryButton}
              >
                {hasOpenSeat ? 'Sit down' : 'Table full'}
              </button>
            )}
            {!amSeated && confirmingSit && state && (
              <>
                <span className={styles.metric}>Buy in for <strong>{Number(state.table.buyInCt).toLocaleString()}</strong> vCLAW?</span>
                <button
                  type="button"
                  onClick={onSit}
                  disabled={sitting}
                  className={styles.actionButton + ' ' + styles.primaryButton}
                >
                  {sitting ? 'Taking seat…' : 'Confirm buy-in'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingSit(false)}
                  disabled={sitting}
                  className={styles.actionButton}
                >
                  Cancel
                </button>
              </>
            )}
            {amSeated && freshSelf?.isYourTurn && (
              <div className={styles.turnControls} data-testid="cash-inline-betting">
                <div className={styles.coreActionRow}>
                  {canFold && <button type="button" onClick={() => onAction({ kind: 'fold' })} disabled={actionsDisabled} className={styles.actionButton + ' ' + styles.foldButton}>Fold</button>}
                  {canCheck && <button type="button" onClick={() => onAction({ kind: 'check' })} disabled={actionsDisabled} className={styles.actionButton + ' ' + styles.primaryButton}>Check</button>}
                  {canCall && <button type="button" onClick={() => onAction({ kind: 'call' })} disabled={actionsDisabled} className={styles.actionButton + ' ' + styles.primaryButton}>Call {freshSelf.toCall} vCLAW</button>}
                  {canSize && (
                    <button
                      type="button"
                      onClick={() => onAction(canRaise ? { kind: 'raise', amount: clampedRaiseTo } : { kind: 'bet', amount: clampedRaiseTo })}
                      disabled={actionsDisabled}
                      className={styles.actionButton + ' ' + styles.betSubmitButton}
                    >
                      {canRaise ? 'Raise to' : 'Bet to'} {clampedRaiseTo}
                    </button>
                  )}
                </div>
              </div>
            )}
            {amSeated && (
              <button
                type="button"
                onClick={onLeave}
                disabled={leaving || leaveQueued}
                className={styles.actionButton + ' ' + styles.walkButton}
              >
                {leaveQueued ? 'Cashing out…' : leaving ? 'Standing…' : 'Walk Away'}
              </button>
            )}
          </div>
          <div className={styles.legendRow}>
            <span><span className={styles.positionChip + ' ' + styles.dealerChip}>D</span> Dealer</span>
            <span><span className={styles.positionChip}>SB</span> Small blind</span>
            <span><span className={styles.positionChip}>BB</span> Big blind</span>
            <span className={styles.controlHint}>←/→ Look around · Home center</span>
          </div>
        </div>
      </div>
    </div>
  );
}

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

function actionLabel(entry: SerializedHoldemLogEntry): string {
  if (entry.type === 'post-sb') return `POST SB ${entry.amount}`;
  if (entry.type === 'post-bb') return `POST BB ${entry.amount}`;
  if (entry.type === 'check' || entry.type === 'fold') return entry.type.toUpperCase();
  return `${entry.type.toUpperCase()} ${entry.amount}`;
}

/** P3 — seated in-world action HUD (2026-07-15). While the player is seated
 * at T1 the 2D modal is suppressed (founder contract: the entire session
 * renders on the felt), so this DOM overlay is the ONLY action surface. It is
 * a pure consumer of the shared Hold'em controller — the SAME handleDeal /
 * runAction / handleWalkAway mutation path the modal uses; it never issues
 * its own requests. It owns the private hole-card/public-board DOM overlay;
 * TableCards3D renders only public board cards and opponent pairs on felt. */
export function SeatedHoldemHud({ instanceId }: { instanceId?: string }) {
  const seatedTable = useCoveStore((state) => state.seatedTable);
  const holdemModalOpen = useCoveStore((state) => state.holdemModalOpen);
  const { data: avatar } = useAvatar();

  const {
    table, live, settled, toast, phase, agentMode, inFlight,
    walkAwayLocked, pot, publicPot, toCallNum, facingBet, canCheck, humanStack,
    humanCommitted,
    playerHoleCards, communityCards,
    resetHand, handleDeal, runAction, handleWalkAway,
  } = useHoldemController();

  const [betAmount, setBetAmount] = useState(0);
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

  const liveHandId = live?.handId ?? null;
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
  const raiseOpen = useMemo(
    () => live && phase === 'player-turn' ? computeRaiseOpen(live) : null,
    [live, phase],
  );
  const raisePresets = useMemo(
    () => raiseOpen?.kind === 'slider'
      ? computeRaisePresets(
          raiseOpen,
          publicPot,
          live?.bigBlind ?? table?.bigBlind ?? '2',
          humanCommitted,
        )
      : [],
    [humanCommitted, live?.bigBlind, publicPot, raiseOpen, table?.bigBlind],
  );

  useEffect(() => {
    if (raiseOpen?.kind === 'slider') setBetAmount(raiseOpen.min);
  }, [decisionKey, liveHandId, raiseOpen]);

  useEffect(() => {
    publishHoldemSettledReveal(settled && !playoutPending ? settled.handId : null);
    return () => publishHoldemSettledReveal(null);
  }, [playoutPending, settled]);

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

  const handleSubmitRaise = useCallback((requestedAmount?: number) => {
    if (!live || phase !== 'player-turn' || actionsDisabled) return;
    // Re-derive against CURRENT live state at submit time — the hand can have
    // advanced (resync) since the slider opened. Clamp into today's legal
    // window; if raising is no longer possible, drop the click (the action
    // row re-renders with the legal options).
    const open = computeRaiseOpen(live);
    if (open.kind !== 'slider') return;
    const value = Math.min(Math.max(requestedAmount ?? betAmount, open.min), open.max);
    setBetAmount(value);
    void runAction(open.verb, value);
  }, [actionsDisabled, betAmount, live, phase, runAction]);

  const handleAllIn = useCallback(() => {
    if (!live || phase !== 'player-turn' || actionsDisabled) return;
    const shove = computeAllIn(live);
    if (shove.action === 'call') void runAction('call');
    else void runAction(shove.action, shove.amount);
  }, [actionsDisabled, live, phase, runAction]);

  const handleNextHand = useCallback(() => {
    if (playoutPending) return;
    resetHand();
  }, [playoutPending, resetHand]);

  // Demo/practice follows the same live cadence as the cash room: the server
  // practice hand starts without a player-owned Deal button, then the next
  // hand begins about three seconds after settlement playback catches up.
  useEffect(() => {
    if (!seatedActive || inFlight || playoutPending) return;
    if (phase !== 'idle' && phase !== 'settled') return;
    const timer = window.setTimeout(() => {
      if (phase === 'settled') handleNextHand();
      void handleDeal();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [handleDeal, handleNextHand, inFlight, phase, playoutPending, seatedActive]);

  const narration = useMemo(
    () => settled ? settlementNarration(settled) : null,
    [settled],
  );
  const publicSeats = useMemo(() => deriveHoldemPublicSeats(renderedLog), [renderedLog]);
  const narratedCards = useMemo(
    () => communityCards.map((card, index) => index < revealedBoardCount ? card : null),
    [communityCards, revealedBoardCount],
  );
  const parityDealStep = settled && !playoutPending
    ? 'showdown'
    : revealedBoardCount >= 5 ? 'river'
      : revealedBoardCount >= 4 ? 'turn'
        : revealedBoardCount >= 3 ? 'flop' : 'hole';
  const paritySettled = settled && !playoutPending ? settled : null;
  useEffect(() => {
    if (!instanceId) return;
    publishFeltParity(instanceId, buildHoldemTrayParity({
      kind: 'practice',
      hole: phase === 'idle' ? [] : playerHoleCards,
      narratedBoard: phase === 'idle' ? [] : narratedCards,
      publicSeats: Array.from({ length: 6 }, (_, seat) => ({
        folded: publicSeats[seat]?.folded ?? false,
      })),
      settled: paritySettled,
      correlation: {
        hand: handKey ?? 'practice:idle',
        handNumber: live?.handIndex ?? settled?.handIndex ?? table?.handsPlayed ?? null,
      },
      dealStep: parityDealStep,
      phase,
      transition: playoutPending ? 'revealing' : 'idle',
      ...(paritySettled && narration ? { bannerText: narration.headline } : {}),
      ...(phase === 'idle' ? {} : { pot: String(pot) }),
    }));
  }, [
    handKey,
    instanceId,
    live?.handIndex,
    narratedCards,
    narration,
    parityDealStep,
    paritySettled,
    phase,
    playerHoleCards,
    playoutPending,
    pot,
    publicSeats,
    settled?.handIndex,
    table?.handsPlayed,
  ]);
  const livePositions = live ?? settled?.outcome ?? null;
  const visibleStreet = revealedBoardCount >= 5 ? 'river'
    : revealedBoardCount >= 4 ? 'turn'
      : revealedBoardCount >= 3 ? 'flop' : 'preflop';
  const renderedStreet = renderedLog.at(-1)?.street ?? 'preflop';
  const decisionSeconds = Math.ceil(decisionRemainingMs / 1_000);
  const timerTone = decisionRemainingMs < 4_000
    ? styles.timerDanger
    : decisionRemainingMs < 8_000
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
      {instanceId && (
        <ParityMirror surface="holdem-tray-practice" instanceId={instanceId} />
      )}
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
              <span>{holdemSeatName(seat)}</span>
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
              <span className={styles.metric} data-testid="holdem-pot-amount">
                Pot <strong>{pot}</strong>
              </span>
            )}
            <span className={styles.blindPill}>
              Blinds {live?.smallBlind ?? table?.smallBlind ?? '1'}/
              {live?.bigBlind ?? table?.bigBlind ?? '2'} vCLAW
            </span>
            {table && (
              <span className={styles.metric} data-testid="holdem-self-stack">
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

          <div className={styles.actionRow}>
            {phase === 'idle' && (
              table ? (
                <button
                  type="button"
                  onClick={() => { void handleWalkAway(); }}
                  disabled={walkAwayLocked || playoutPending}
                  className={styles.actionButton + ' ' + styles.walkButton}
                >
                  {isAuthed ? 'Walk Away' : 'Close'}
                </button>
              ) : <span className={styles.playout}>Next practice hand starts automatically…</span>
            )}

            {phase === 'player-turn' && (
              <div className={styles.turnControls} data-testid="holdem-inline-betting">
                <div className={styles.coreActionRow}>
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
                </div>

                {raiseOpen?.kind === 'slider' && (
                  <div className={styles.inlineBetPanel}>
                    <div className={styles.inlinePresetRow} aria-label="One-tap bet sizes">
                      {raisePresets.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => handleSubmitRaise(preset.value)}
                          disabled={actionsDisabled}
                          className={styles.actionButton + ' ' + styles.presetButton}
                        >
                          {preset.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={handleAllIn}
                        disabled={actionsDisabled}
                        className={styles.actionButton + ' ' + styles.allInButton + ' ' + styles.presetButton}
                      >
                        All In
                      </button>
                    </div>

                    <div className={styles.inlineAmountRow}>
                      <label className={styles.amountLabel} htmlFor="holdem-bet-amount">
                        Amount
                      </label>
                      <input
                        type="range"
                        min={raiseOpen.min}
                        max={raiseOpen.max}
                        step={1}
                        value={betAmount}
                        onChange={(event) => setBetAmount(Number(event.target.value))}
                        className={styles.inlineRange}
                        aria-label={`${raiseOpen.verb} amount`}
                      />
                      <input
                        id="holdem-bet-amount"
                        type="number"
                        inputMode="numeric"
                        min={raiseOpen.min}
                        max={raiseOpen.max}
                        step={1}
                        value={betAmount}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setBetAmount(Math.min(Math.max(Number.isFinite(next) ? next : raiseOpen.min, raiseOpen.min), raiseOpen.max));
                        }}
                        className={styles.amountInput}
                        aria-label={`${raiseOpen.verb} amount in vCLAW`}
                      />
                      <button
                        type="button"
                        onClick={() => handleSubmitRaise()}
                        disabled={actionsDisabled}
                        className={styles.actionButton + ' ' + styles.betSubmitButton}
                      >
                        {raiseOpen.verb === 'bet' ? 'Bet' : 'Raise'} {betAmount}
                      </button>
                    </div>
                    <div className={styles.raiseLimits}>
                      <span>Min {raiseOpen.min}</span>
                      <span>Max {raiseOpen.max}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {phase === 'settled' && (
              <>
                <span className={styles.playout}>Next hand starts automatically…</span>
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
