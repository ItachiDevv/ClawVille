'use client';

/**
 * Shared-table baccarat HUD (spec section 7.3). Every number here is a server
 * value from `GET /api/cove/baccarat/tables/:id` (balance, bets, payout, net).
 * The HUD does no money math.
 *
 * Layout: the touch decision comes from `useIsMobile()`. The viewport size
 * then picks phone portrait, phone landscape, or the desktop layout (tablets
 * keep the desktop layout with larger tap targets). The table-surface chat bar
 * sits top-left at 70 px, so the left edge below the top bar stays clear.
 */

import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type {
  BaccaratTableBetSide,
  BaccaratTablePublicState,
  BaccaratTableTier,
} from '@clawville/shared';
import BaccaratCard from '@/components/cove/baccarat/BaccaratCard';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { maskOutcomeToStep } from '@/lib/cove/baccarat-room-controller';
import {
  bettingMsLeft,
  nextWindowMsLeft,
  useBaccaratTableController,
} from '@/lib/cove/baccarat-table-controller';
import styles from './SharedBaccaratHud.module.css';

const SIDES: readonly BaccaratTableBetSide[] = ['player', 'banker', 'tie'];
const SIDE_LABEL: Record<BaccaratTableBetSide, string> = {
  player: 'PLAYER',
  banker: 'BANKER',
  tie: 'TIE',
};
const SIDE_PAYOUT: Record<BaccaratTableBetSide, string> = {
  player: 'pays 1:1',
  banker: 'pays 0.95:1',
  tie: 'pays 8:1',
};
const TIER_LABEL: Record<BaccaratTableTier, string> = {
  low: 'Low table',
  mid: 'Mid table',
  high: 'High table',
};
const TIER_CHIPS: Record<BaccaratTableTier, readonly number[]> = {
  low: [5, 10, 25, 50],
  mid: [20, 50, 100, 200],
  high: [50, 100, 250, 500],
};
/** Visual denominator for the ring only (spec default window, 12 s). */
const RING_WINDOW_MS = 12_000;
const TOAST_MS = 4500;
const VOID_REASON_TEXT: Record<string, string> = {
  insufficient_at_settle: 'your balance was too low when the window closed',
  daily_cap: 'the daily autonomous play cap was reached',
  settle_failed: 'the deal failed on the server',
  no_owner: 'the seat had no owner account',
  orphaned: 'the round was closed without a deal',
};

type HudLayout = 'desktop' | 'tablet' | 'phonePortrait' | 'phoneLandscape';

// Layout effect in the browser (no desktop-layout first paint on a phone),
// plain effect on the server. Same pattern as use-is-mobile.ts.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Below this width the seat rail moves from a right column to a strip above the controls. */
const RAIL_COLUMN_MIN_WIDTH = 1000;

function useHudLayout(): { layout: HudLayout; railStrip: boolean } {
  const isMobile = useIsMobile();
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useIsomorphicLayoutEffect(() => {
    const read = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener('resize', read);
    window.addEventListener('orientationchange', read);
    return () => {
      window.removeEventListener('resize', read);
      window.removeEventListener('orientationchange', read);
    };
  }, []);
  const width = size?.w ?? RAIL_COLUMN_MIN_WIDTH;
  let layout: HudLayout = 'desktop';
  if (isMobile && size) {
    // Phones: the short side is under 600 px. Tablets keep the desktop layout
    // with larger tap targets.
    if (Math.min(size.w, size.h) >= 600) layout = 'tablet';
    else layout = size.w > size.h ? 'phoneLandscape' : 'phonePortrait';
  }
  const railStrip = layout === 'phonePortrait'
    || ((layout === 'desktop' || layout === 'tablet') && width < RAIL_COLUMN_MIN_WIDTH);
  return { layout, railStrip };
}

/** Re-render on an interval while a countdown runs. */
function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}...${hash.slice(-8)}` : hash;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function chipsFor(table: Pick<BaccaratTablePublicState, 'tierKey' | 'minBet' | 'maxBet'>): number[] {
  const tierChips = TIER_CHIPS[table.tierKey] ?? [];
  const inBounds = tierChips.filter((chip) => chip >= table.minBet && chip <= table.maxBet);
  return inBounds.length ? inBounds : [table.minBet, table.maxBet];
}

export interface SharedBaccaratHudProps {
  /** Logged in with a real (non-guest) account. */
  isRealTier: boolean;
  /** Logged in as a guest account. */
  isGuest: boolean;
  /** The account check is still running (no sign-in prompt yet). */
  authPending: boolean;
  onBackToLobby(): void;
  onSignIn(): void;
  onOpenTable(tableId: string): void;
}

export function SharedBaccaratHud({
  isRealTier,
  isGuest,
  authPending,
  onBackToLobby,
  onSignIn,
  onOpenTable,
}: SharedBaccaratHudProps) {
  const { layout, railStrip } = useHudLayout();
  const phone = layout === 'phonePortrait' || layout === 'phoneLandscape';
  const table = useBaccaratTableController((s) => s.table);
  const clockOffsetMs = useBaccaratTableController((s) => s.clockOffsetMs);
  const pollNotice = useBaccaratTableController((s) => s.pollNotice);
  const notFound = useBaccaratTableController((s) => s.notFound);
  const selectedBet = useBaccaratTableController((s) => s.selectedBet);
  const selectedStake = useBaccaratTableController((s) => s.selectedStake);
  const inFlight = useBaccaratTableController((s) => s.inFlight);
  const toast = useBaccaratTableController((s) => s.toast);
  const elsewhereTableId = useBaccaratTableController((s) => s.elsewhereTableId);
  const revealCoup = useBaccaratTableController((s) => s.revealCoup);
  const revealedStep = useBaccaratTableController((s) => s.revealedStep);
  const revealDone = useBaccaratTableController((s) => s.revealDone);
  const revealedRoundSeq = useBaccaratTableController((s) => s.revealedRoundSeq);
  const setSelectedBet = useBaccaratTableController((s) => s.setSelectedBet);
  const setSelectedStake = useBaccaratTableController((s) => s.setSelectedStake);
  const clearToast = useBaccaratTableController((s) => s.clearToast);
  const sit = useBaccaratTableController((s) => s.sit);
  const placeBet = useBaccaratTableController((s) => s.bet);
  const cancelBet = useBaccaratTableController((s) => s.cancelBet);
  const leave = useBaccaratTableController((s) => s.leave);
  const [fairnessOpen, setFairnessOpen] = useState(false);

  const phase = table?.phase ?? null;
  const now = useNow(phase === 'betting' || phase === 'reveal');
  const msLeft = bettingMsLeft(table, clockOffsetMs, now);
  const nextMs = nextWindowMsLeft(table, clockOffsetMs, now);
  const windowOpen = phase === 'betting' && msLeft > 0;
  const me = table?.me ?? null;
  const seated = Boolean(me?.seated);
  const myBet = me?.currentBet ?? null;
  const busy = inFlight !== null;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => clearToast(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [clearToast, toast]);

  useEffect(() => {
    if (!fairnessOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFairnessOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fairnessOpen]);

  const masked = useMemo(
    () => (revealCoup ? maskOutcomeToStep(revealCoup, revealedStep) : null),
    [revealCoup, revealedStep],
  );
  const shownRound = revealCoup && table?.lastRound?.roundSeq === revealedRoundSeq
    ? table.lastRound
    : null;
  // `me.lastResult` is the server's row for me in `lastRound` (or null).
  const myResult = shownRound ? me?.lastResult ?? null : null;
  const resultBySeat = useMemo(() => {
    const map = new Map<number, number>();
    if (shownRound && revealDone) {
      for (const row of shownRound.seatResults) map.set(row.seatIndex, row.net);
    }
    return map;
  }, [revealDone, shownRound]);

  const realSeats = table?.seats.filter((seat) => !seat.isSeeded).length ?? 0;
  const tableFull = table ? realSeats >= table.maxSeats : false;
  const voided = me?.voidedLastRound && table && me.voidedLastRound.roundSeq === table.roundSeq - 1
    ? me.voidedLastRound
    : null;

  if (notFound) {
    return (
      <div className={styles.hud}>
        <div className={styles.centerCard} role="alert">
          <p className={styles.eyebrow}>Shared baccarat</p>
          <h2 className={styles.centerTitle}>This table is not open.</h2>
          <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onBackToLobby}>
            Back to the lobby
          </button>
        </div>
      </div>
    );
  }

  const ringFraction = windowOpen ? Math.min(1, msLeft / RING_WINDOW_MS) : 0;
  const ringLabel = !table
    ? '...'
    : phase === 'betting'
      ? windowOpen ? String(Math.ceil(msLeft / 1000)) : '0'
      : phase === 'dealing'
        ? 'Deal'
        : phase === 'reveal'
          ? revealDone && revealCoup ? SIDE_LABEL[revealCoup.winner] : 'Cards'
          : 'Wait';
  const ringCaption = !table
    ? 'Loading the table'
    : phase === 'betting'
      ? windowOpen ? 'Bets close in' : 'Bets closed'
      : phase === 'dealing'
        ? 'Dealing...'
        : phase === 'reveal'
          ? nextMs > 0 ? `Next round in ${Math.ceil(nextMs / 1000)} s` : 'Result'
          : 'Waiting for a player to sit';
  const RING_R = 26;
  const RING_C = 2 * Math.PI * RING_R;

  const stakeChoice = selectedStake ?? table?.minBet ?? 0;
  const sameAsPlaced = myBet && myBet.bet === selectedBet && myBet.stake === stakeChoice;

  const seatRail = table && table.seats.length > 0 ? (
    <aside className={styles.seatRail} aria-label="Seats at this table">
      {table.seats.map((seat) => {
        const isMe = me?.seatIndex === seat.seatIndex && seated;
        const net = resultBySeat.get(seat.seatIndex);
        const tag = isMe ? 'You' : seat.isSeeded ? 'Bot' : seat.subjectType === 'agent' ? 'Agent' : 'Player';
        return (
          <div key={seat.seatIndex} className={`${styles.seatChip} ${isMe ? styles.seatMine : ''}`}>
            <span className={styles.seatName}>{seat.name || `Seat ${seat.seatIndex + 1}`}</span>
            <span className={styles.seatTag}>{tag}</span>
            <span className={styles.seatBet}>
              {net !== undefined
                ? net === 0 ? 'push' : `${signed(net)} vCLAW`
                : seat.currentBet
                  ? `${SIDE_LABEL[seat.currentBet.bet]} ${seat.currentBet.stake}`
                  : seat.isSeeded ? 'watching' : 'no bet'}
            </span>
          </div>
        );
      })}
    </aside>
  ) : null;

  const controls = (
    <section className={styles.controls} aria-label="Shared baccarat controls">
      {!isRealTier && authPending ? (
        <p className={styles.gateText} role="status">Checking your account...</p>
      ) : !isRealTier ? (
        <div className={styles.gate}>
          <p className={styles.gateText}>
            {isGuest
              ? 'Shared tables use real vCLAW. Guest accounts can play the private shoe.'
              : 'You are watching this table.'}
          </p>
          <div className={styles.actionRow}>
            <button type="button" className={`${styles.button} ${styles.primary}`} onClick={onSignIn}>
              Sign in to play
            </button>
            <Link className={styles.button} href="/cove/baccarat?mode=solo">
              {isGuest ? 'Private shoe (demo)' : 'Private shoe'}
            </Link>
          </div>
        </div>
      ) : !seated ? (
        <div className={styles.gate}>
          <p className={styles.gateText}>
            {tableFull ? 'Every seat is taken. Watch, or try another table.' : 'Take a seat to bet on the next coup.'}
          </p>
          <div className={styles.actionRow}>
            {elsewhereTableId && elsewhereTableId !== table?.tableId && (
              <button type="button" className={styles.button} onClick={() => onOpenTable(elsewhereTableId)}>
                Go to my table
              </button>
            )}
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={!table || tableFull || busy}
              onClick={() => { void sit(); }}
            >
              {inFlight === 'sit' ? 'Sitting...' : 'Sit down'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.betSpots} role="radiogroup" aria-label="Bet side">
            {SIDES.map((side) => (
              <button
                key={side}
                type="button"
                role="radio"
                aria-checked={selectedBet === side}
                className={`${styles.betSpot} ${myBet?.bet === side ? styles.betPlaced : ''}`}
                disabled={!windowOpen || busy}
                onClick={() => setSelectedBet(side)}
              >
                <span className={styles.betSide}>{SIDE_LABEL[side]}</span>
                <span className={styles.betPayout}>{SIDE_PAYOUT[side]}</span>
                {myBet?.bet === side && (
                  <span className={styles.betPlacedTag}>{myBet.stake} vCLAW placed</span>
                )}
              </button>
            ))}
          </div>
          <div className={styles.chipRow} aria-label="Stake">
            {table && chipsFor(table).map((chip) => (
              <button
                key={chip}
                type="button"
                aria-pressed={stakeChoice === chip}
                className={styles.chip}
                disabled={!windowOpen || busy}
                onClick={() => setSelectedStake(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
          <div className={styles.actionRow}>
            {voided ? (
              <span className={styles.notice}>
                Your last bet did not play: {VOID_REASON_TEXT[voided.reason] ?? 'the server voided it'}. No vCLAW moved.
              </span>
            ) : me?.nextRoundBet ? (
              <span className={styles.notice}>
                Next round: {me.nextRoundBet.stake} vCLAW on {SIDE_LABEL[me.nextRoundBet.bet]}.
              </span>
            ) : (
              <span className={styles.notice}>
                {windowOpen
                  ? myBet ? 'Your bet plays when the window closes.' : 'Pick a side and a stake.'
                  : phase === 'betting' || phase === 'dealing' ? 'Bets are locked for this coup.' : 'Bets open with the next round.'}
              </span>
            )}
            {myBet && (
              <button
                type="button"
                className={styles.button}
                disabled={!windowOpen || busy}
                onClick={() => { void cancelBet(); }}
              >
                {inFlight === 'cancel' ? 'Cancelling...' : 'Cancel'}
              </button>
            )}
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={!windowOpen || busy || Boolean(sameAsPlaced)}
              onClick={() => { void placeBet(selectedBet, stakeChoice); }}
            >
              {inFlight === 'bet'
                ? 'Placing...'
                : myBet
                  ? `Change to ${stakeChoice} on ${SIDE_LABEL[selectedBet]}`
                  : `Bet ${stakeChoice} on ${SIDE_LABEL[selectedBet]}`}
            </button>
          </div>
        </>
      )}
      {pollNotice && <p className={styles.pollNotice} role="status">{pollNotice}</p>}
    </section>
  );

  return (
    <div className={`${styles.hud} ${styles[layout] ?? ''}`} data-layout={layout}>
      <div className={styles.topBar}>
        <div className={styles.topLeft}>
          {seated ? (
            <button
              type="button"
              className={`${styles.button} ${styles.danger}`}
              onClick={() => { void leave(); }}
              disabled={busy}
            >
              {inFlight === 'leave' ? 'Leaving...' : 'Leave seat'}
            </button>
          ) : (
            <button type="button" className={styles.button} onClick={onBackToLobby}>
              Lobby
            </button>
          )}
        </div>
        {phone ? (
          <div className={styles.infoPanel}>
            <div className={styles.infoLine}>
              {table ? `${table.minBet}-${table.maxBet}` : 'Baccarat'}
              {me ? ` · ${me.balance.toLocaleString()} vCLAW` : table ? ' vCLAW' : ''}
              {myBet ? ` · ${myBet.stake} on felt` : ''}
            </div>
          </div>
        ) : (
          <div className={styles.infoPanel}>
            <div className={styles.eyebrow}>
              Shared baccarat{table ? ` · ${TIER_LABEL[table.tierKey] ?? table.tierKey}` : ''}
            </div>
            {table && (
              <div className={styles.infoLine}>
                {table.minBet}-{table.maxBet} vCLAW
                {me ? ` · Balance ${me.balance.toLocaleString()} vCLAW` : ''}
              </div>
            )}
            {myBet && (
              <div className={styles.infoLine}>
                On the felt: {myBet.stake} vCLAW on {SIDE_LABEL[myBet.bet]}
              </div>
            )}
            <div className={styles.seed}>
              Seed commitment: {table?.shoe ? shortHash(table.shoe.serverSeedHash) : 'opens with the first deal'}
            </div>
          </div>
        )}
        <button type="button" className={styles.button} onClick={() => setFairnessOpen(true)}>
          Fairness
        </button>
      </div>

      <div
        className={styles.ring}
        role="timer"
        aria-live="off"
        aria-label={`${ringCaption} ${ringLabel}`}
        data-testid="bac-shared-countdown"
      >
        <svg viewBox="0 0 64 64" className={styles.ringSvg} aria-hidden="true">
          <circle cx="32" cy="32" r={RING_R} className={styles.ringTrack} />
          <circle
            cx="32"
            cy="32"
            r={RING_R}
            className={styles.ringArc}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - ringFraction)}
          />
        </svg>
        <span className={styles.ringValue}>{ringLabel}</span>
        <span className={styles.ringCaption}>{ringCaption}</span>
      </div>

      {masked && (
        <section className={styles.hands} aria-live="polite" data-testid="bac-shared-hands">
          {(['player', 'banker'] as const).map((side) => (
            <div key={side} className={styles.hand}>
              <div className={styles.handLabel}>
                {SIDE_LABEL[side]}
                {revealDone && revealCoup ? ` · ${revealCoup[side].total}` : ''}
                {revealDone && revealCoup?.[side].isNatural ? ' · natural' : ''}
              </div>
              <div className={styles.handCards}>
                {masked[side].cards.map((card, index) => (
                  <BaccaratCard key={`${side}-${index}`} card={card} />
                ))}
              </div>
            </div>
          ))}
          {revealDone && revealCoup && (
            <div className={styles.banner} data-testid="bac-shared-result">
              <strong>
                {revealCoup.winner === 'tie' ? 'TIE' : `${SIDE_LABEL[revealCoup.winner]} WINS`}
              </strong>
              <span>
                {myResult
                  ? `Your ${SIDE_LABEL[myResult.bet]} bet of ${myResult.stake} vCLAW: ${myResult.net === 0 ? 'push' : `${signed(myResult.net)} vCLAW`}`
                  : seated ? 'You had no bet this round.' : 'Spectating.'}
              </span>
            </div>
          )}
        </section>
      )}

      {!railStrip && seatRail}

      <div className={styles.bottomStack}>
        {toast && (
          <div className={`${styles.toast} ${styles[`toast_${toast.tone}`] ?? ''}`} role="status" aria-live="polite">
            {toast.message}
          </div>
        )}
        {railStrip && seatRail}
        {controls}
      </div>

      {fairnessOpen && (
        <div className={styles.dialogBackdrop} role="presentation" onClick={() => setFairnessOpen(false)}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Provably fair shoe"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.eyebrow}>Provably fair shoe</div>
            <h2 className={styles.dialogTitle}>Commit before the deal, reveal when the shoe closes</h2>
            <p>
              The server commits this table&apos;s eight-deck shoe before the first coup. Every seat
              bets on the same cards. When the shoe closes, its seed is published here, and each
              settled bet can be checked from your history.
            </p>
            <p className={styles.dialogLabel}>Current shoe: server-seed hash</p>
            <code>{table?.shoe?.serverSeedHash ?? 'No shoe open yet'}</code>
            <p className={styles.dialogLabel}>Current shoe: client seed</p>
            <code>{table?.shoe?.clientSeed ?? 'No shoe open yet'}</code>
            {table?.previousShoe ? (
              <>
                <p className={styles.dialogLabel}>Previous shoe: revealed server seed</p>
                <code>{table.previousShoe.serverSeed}</code>
                <p className={styles.dialogLabel}>Previous shoe: server-seed hash</p>
                <code>{table.previousShoe.serverSeedHash}</code>
                <p className={styles.dialogLabel}>Previous shoe: client seed</p>
                <code>{table.previousShoe.clientSeed}</code>
              </>
            ) : (
              <p className={styles.dialogLabel}>No previous shoe has closed at this table yet.</p>
            )}
            <div className={styles.dialogActions}>
              <Link className={styles.button} href="/cove/history">
                Open history
              </Link>
              <button type="button" className={styles.button} onClick={() => setFairnessOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
