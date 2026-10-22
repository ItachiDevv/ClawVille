'use client';

/**
 * Shared baccarat lobby (spec section 7.1): one card per house table (tier,
 * bet bounds, open seats, phase + countdown, last winner) and one card for the
 * private shoe (the solo room at `?mode=solo`). Polls `GET /tables` every 3 s
 * and pauses while the tab is hidden. Anyone can watch a table; only a real
 * (non-guest) account can sit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  COVE_BACCARAT_MAX_BET,
  COVE_BACCARAT_MIN_BET,
  type BaccaratLobbyRow,
  type BaccaratTablePhase,
  type BaccaratTableTier,
} from '@clawville/shared';
import { useIsMobile } from '@/hooks/use-is-mobile';
import {
  baccaratTableApi,
  describeBaccaratTableError,
  errorBodyField,
  isTableErrorCode,
} from '@/lib/cove/baccarat-table-api';
import styles from './BaccaratTableLobby.module.css';

const DEFAULT_POLL_MS = 3000;
const TIER_ORDER: Record<BaccaratTableTier, number> = { low: 0, mid: 1, high: 2 };
const TIER_LABEL: Record<BaccaratTableTier, string> = {
  low: 'Low table',
  mid: 'Mid table',
  high: 'High table',
};
const PHASE_LABEL: Record<BaccaratTablePhase, string> = {
  idle: 'Waiting for a player',
  betting: 'Betting open',
  dealing: 'Dealing',
  reveal: 'Showing the result',
};
const WINNER_LABEL = { player: 'Player', banker: 'Banker', tie: 'Tie' } as const;

export function tableRoomHref(tableId: string): string {
  return `/cove/baccarat?tableId=${encodeURIComponent(tableId)}`;
}

export interface BaccaratTableLobbyProps {
  /** Logged in with a real (non-guest) account. */
  isRealTier: boolean;
  isGuest: boolean;
  /** The account check is still running: no sign-in prompt yet. */
  authPending?: boolean;
  pollMs?: number;
}

export function BaccaratTableLobby({
  isRealTier,
  isGuest,
  authPending = false,
  pollMs = DEFAULT_POLL_MS,
}: BaccaratTableLobbyProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [tables, setTables] = useState<BaccaratLobbyRow[] | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [busyTableId, setBusyTableId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let paused = false;
    const clear = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const tick = async () => {
      clear();
      if (document.visibilityState === 'hidden') {
        paused = true;
        return;
      }
      try {
        const result = await baccaratTableApi.listTables(50);
        if (cancelled) return;
        setClockOffsetMs(result.serverNow - Date.now());
        setTables(
          [...result.tables].sort(
            (a, b) => (TIER_ORDER[a.tierKey] ?? 9) - (TIER_ORDER[b.tierKey] ?? 9),
          ),
        );
        setNotice(null);
      } catch (error) {
        if (!cancelled) setNotice(`${describeBaccaratTableError(error)} Retrying.`);
      } finally {
        if (!cancelled && !paused) timerRef.current = setTimeout(() => { void tick(); }, pollMs);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        paused = true;
        clear();
        return;
      }
      if (!paused) return;
      paused = false;
      void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollMs]);

  const anyBetting = Boolean(tables?.some((table) => table.phase === 'betting'));
  useEffect(() => {
    if (!anyBetting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [anyBetting]);

  const sitAndOpen = useCallback(async (table: BaccaratLobbyRow) => {
    if (!isRealTier) {
      router.push('/login');
      return;
    }
    setBusyTableId(table.tableId);
    setNotice(null);
    try {
      await baccaratTableApi.sit(table.tableId);
      router.push(tableRoomHref(table.tableId));
    } catch (error) {
      const elsewhere = isTableErrorCode(error, 409, 'already_seated_elsewhere')
        ? errorBodyField(error, 'tableId')
        : undefined;
      if (typeof elsewhere === 'string') {
        router.push(tableRoomHref(elsewhere));
        return;
      }
      setNotice(describeBaccaratTableError(error));
      setBusyTableId(null);
    }
  }, [isRealTier, router]);

  return (
    <section
      className={`${styles.overlay} ${isMobile ? styles.mobile : ''}`}
      aria-label="Baccarat table lobby"
    >
      <button type="button" className={styles.backButton} onClick={() => router.push('/cove')}>
        Back to Cove
      </button>
      <div className={styles.panel}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Cove · Baccarat</p>
          <h1 className={styles.title}>Pick a table</h1>
          <p className={styles.subtitle}>
            Shared tables deal one coup per round to every seat. Bet PLAYER, BANKER or TIE
            in a 12-second window. Your stake and payout settle together when the window closes.
          </p>
          {!isRealTier && !authPending && (
            <p className={styles.gateLine}>
              {isGuest
                ? 'Guest accounts can watch shared tables and play the private shoe with demo vCLAW.'
                : 'You can watch any table. Sign in to play.'}
            </p>
          )}
        </header>

        <div className={styles.grid}>
          {tables === null && !notice && (
            <p className={styles.loading} role="status">Loading tables...</p>
          )}
          {tables?.length === 0 && (
            <p className={styles.loading} role="status">No shared table is open right now.</p>
          )}
          {tables?.map((table) => {
            const msLeft = table.phase === 'betting' && table.bettingClosesAt != null
              ? Math.max(0, table.bettingClosesAt - (now + clockOffsetMs))
              : 0;
            const full = table.openSeats <= 0;
            const busy = busyTableId === table.tableId;
            return (
              <article key={table.tableId} className={styles.card} data-tier={table.tierKey}>
                <div className={styles.cardHead}>
                  <h2 className={styles.cardTitle}>{TIER_LABEL[table.tierKey] ?? table.tierKey}</h2>
                  <span className={styles.bounds}>{table.minBet}-{table.maxBet} vCLAW</span>
                </div>
                <dl className={styles.facts}>
                  <div>
                    <dt>Open seats</dt>
                    <dd>{Math.max(0, table.openSeats)} of {table.maxSeats}</dd>
                  </div>
                  <div>
                    <dt>Now</dt>
                    <dd>
                      {PHASE_LABEL[table.phase] ?? table.phase}
                      {table.phase === 'betting' && msLeft > 0 ? ` · ${Math.ceil(msLeft / 1000)} s` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Last coup</dt>
                    <dd>{table.lastWinner ? WINNER_LABEL[table.lastWinner] : 'None yet'}</dd>
                  </div>
                </dl>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => router.push(tableRoomHref(table.tableId))}
                  >
                    Watch
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busy || authPending || (isRealTier && full)}
                    onClick={() => { void sitAndOpen(table); }}
                  >
                    {authPending ? 'Checking...' : !isRealTier ? 'Sign in to play' : busy ? 'Sitting...' : full ? 'Table full' : 'Sit down'}
                  </button>
                </div>
              </article>
            );
          })}

          <article className={`${styles.card} ${styles.soloCard}`}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Private shoe</h2>
              <span className={styles.bounds}>{COVE_BACCARAT_MIN_BET}-{COVE_BACCARAT_MAX_BET} vCLAW</span>
            </div>
            <p className={styles.cardText}>
              Your own shoe, one coup at a time, at your own pace.
              {!isRealTier ? ' Guests play here with demo vCLAW.' : ''}
            </p>
            <div className={styles.cardActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => router.push('/cove/baccarat?mode=solo')}
              >
                Open private shoe
              </button>
            </div>
          </article>
        </div>

        {notice && <p className={styles.notice} role="status">{notice}</p>}
      </div>
    </section>
  );
}
