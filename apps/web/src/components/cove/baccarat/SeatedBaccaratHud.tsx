'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  COVE_BACCARAT_MAX_BET,
  COVE_BACCARAT_MIN_BET,
  type BaccaratBet,
  type SerializedBaccaratCoup,
} from '@clawville/shared';
import type { BaccaratRoomState } from '@/lib/cove/baccarat-room-controller';
import styles from './SeatedBaccaratHud.module.css';

const BET_STEPS = [5, 25, 50, 100, 250, 500] as const;
const BET_LABELS: Record<BaccaratBet, string> = {
  player: 'Player · 1:1',
  banker: 'Banker · 0.95:1',
  tie: 'Tie · 8:1',
};

function cardLabel(coup: SerializedBaccaratCoup, side: 'player' | 'banker') {
  return coup[side].cards.map((card) => `${card.rank}${card.suit[0]!.toUpperCase()}`).join(' ');
}

export function SeatedBaccaratHud({
  controller,
}: {
  controller: BaccaratRoomState;
}) {
  const [fairnessOpen, setFairnessOpen] = useState(false);
  const coup = controller.settled?.outcome ?? controller.restored?.outcome ?? null;
  const settled = controller.phase === 'settled' || controller.phase === 'leaving';
  const dealLocked = controller.phase !== 'idle' || controller.inFlight;
  const choiceLocked = dealLocked || controller.pending !== null;
  const seedLabel = controller.shoe
    ? `${controller.shoe.serverSeedHash.slice(0, 10)}…${controller.shoe.serverSeedHash.slice(-8)}`
    : 'opens with the first deal';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'e' || event.repeat || fairnessOpen) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) return;
      event.preventDefault();
      void controller.handleWalkAway();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, fairnessOpen]);

  const naturalLabel = useMemo(() => {
    if (!coup) return '—';
    const naturalSides = [
      coup.player.isNatural ? 'Player' : null,
      coup.banker.isNatural ? 'Banker' : null,
    ].filter(Boolean);
    return naturalSides.length ? naturalSides.join(' + ') : 'None';
  }, [coup]);

  return (
    <div className={styles.hud}>
      <div className={styles.topBar}>
        <div className={`${styles.panel}`}>
          <div className={styles.eyebrow}>Baccarat · Punto Banco</div>
          <div className={styles.balance}>
            Current balance: {controller.walletBalance.toLocaleString()} vCLAW
            {controller.isDemo ? ' demo' : ''}
          </div>
          <div className={styles.seed}>Seed commitment: {seedLabel}</div>
        </div>
        <div className={styles.topActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => setFairnessOpen(true)}
          >
            Fairness
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.danger}`}
            onClick={() => { void controller.handleWalkAway(); }}
            disabled={controller.phase === 'leaving'}
          >
            {controller.phase === 'revealing'
              ? controller.walkAwayQueued ? 'Leaving after reveal' : 'Queue Walk Away'
              : controller.isDemo ? 'Close' : 'Walk Away'}
          </button>
        </div>
      </div>

      {settled && coup && (
        <section
          className={styles.outcome}
          data-testid="bac-outcome-banner"
          aria-live="polite"
        >
          <div className={styles.headline}>{controller.bannerText}</div>
          <div className={styles.outcomeGrid}>
            <div className={styles.metric}>
              Player · {cardLabel(coup, 'player')}
              <strong>{coup.player.total}{coup.player.isNatural ? ' · natural' : ''}</strong>
            </div>
            <div className={styles.metric}>
              Banker · {cardLabel(coup, 'banker')}
              <strong>{coup.banker.total}{coup.banker.isNatural ? ' · natural' : ''}</strong>
            </div>
            <div className={styles.metric}>
              Naturals
              <strong>{naturalLabel}</strong>
            </div>
            <div className={styles.metric}>
              Gross payout
              <strong>{coup.payout} vCLAW</strong>
            </div>
            <div className={styles.metric} data-testid="bac-banner-net">
              Net
              <strong>{Number(coup.net) > 0 ? '+' : ''}{coup.net} vCLAW</strong>
            </div>
            <div className={styles.metric}>
              Commission
              <strong>{coup.commission} vCLAW</strong>
            </div>
          </div>
        </section>
      )}

      <section className={styles.controls} aria-label="Baccarat controls">
        <div
          className={styles.row}
          role="radiogroup"
          aria-label="Baccarat bet"
          data-testid="bac-bet-zones"
        >
          <span className={styles.label}>Bet</span>
          {(['player', 'banker', 'tie'] as const).map((bet) => (
            <button
              key={bet}
              type="button"
              role="radio"
              aria-checked={controller.betType === bet}
              className={styles.betButton}
              disabled={choiceLocked}
              onClick={() => controller.setBetType(bet)}
            >
              {BET_LABELS[bet]}
            </button>
          ))}
        </div>
        <div className={styles.row}>
          <span className={styles.label}>
            Stake {COVE_BACCARAT_MIN_BET}–{COVE_BACCARAT_MAX_BET}
          </span>
          {BET_STEPS.map((stake) => (
            <button
              key={stake}
              type="button"
              aria-pressed={controller.stake === stake}
              className={styles.chipButton}
              disabled={choiceLocked}
              onClick={() => controller.setStake(stake)}
            >
              {stake}
            </button>
          ))}
        </div>
        <div className={`${styles.row} ${styles.actionRow}`}>
          <div className={styles.betPill} data-testid="bac-bet-pill">
            {BET_LABELS[coup?.bet ?? controller.betType]} · {coup?.stake ?? controller.stake} vCLAW
          </div>
          {settled ? (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={controller.phase === 'leaving'}
              onClick={controller.handleNextCoup}
            >
              Next Coup
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={dealLocked}
              onClick={() => { void controller.handleDeal(); }}
            >
              {controller.phase === 'requesting'
                ? 'Dealing…'
                : controller.phase === 'revealing'
                  ? 'Revealing…'
                  : `Deal ${controller.stake} vCLAW`}
            </button>
          )}
        </div>
      </section>

      {controller.toast && (
        <div className={styles.toast} role="status" aria-live="polite">
          {controller.toast.message}
        </div>
      )}

      {fairnessOpen && (
        <div className={styles.dialogBackdrop} role="presentation">
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={controller.isDemo ? 'Baccarat shoe commitment' : 'Provably fair shoe'}
          >
            <div className={styles.eyebrow}>
              {controller.isDemo ? 'Shoe commitment' : 'Provably fair shoe'}
            </div>
            <h2>
              {controller.isDemo
                ? 'Commitment visible · demo reveal unavailable'
                : 'Commit before deal, reveal when closed'}
            </h2>
            {controller.isDemo ? (
              <p>
                The landed demo endpoint exposes the pre-deal commitment, but
                does not yet expose the retired shoe seed for client
                verification. Demo reveal verification arrives with the
                server rotation surface; no verification is claimed here.
              </p>
            ) : (
              <p>
                The server commits this eight-deck shoe before the first coup.
                Walk Away closes the shoe and verifies the revealed seed
                against this commitment before leaving.
              </p>
            )}
            <p>Server-seed hash</p>
            <code>{controller.shoe?.serverSeedHash ?? 'No shoe open yet'}</code>
            <p>Client seed</p>
            <code>{controller.shoe?.clientSeed ?? 'No shoe open yet'}</code>
            {controller.revealedSeed && (
              <>
                <p>Revealed server seed</p>
                <code>{controller.revealedSeed}</code>
              </>
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
