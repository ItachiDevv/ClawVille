'use client';

import Link from 'next/link';
import type { BlackjackCard } from '@/lib/cove/blackjack-types';
import type {
  BlackjackRoomHandlers,
  BlackjackRoomState,
  SubHandView,
} from '@/lib/cove/use-blackjack-room-controller';
import styles from '@/components/cove/holdem/SeatedHoldemHud.module.css';
import '@/styles/cove-tokens.css';

const BET_CHIPS = [5, 25, 50, 100, 250, 500] as const;

type Controller = BlackjackRoomState & { handlers: BlackjackRoomHandlers };

function cardLabel(card: BlackjackCard): string {
  if (card.hidden) return 'Face down';
  const suit = {
    clubs: '♣',
    diamonds: '♦',
    hearts: '♥',
    spades: '♠',
  }[card.suit];
  return `${card.rank}${suit}`;
}

function signedVclaw(value: string): string {
  try {
    const amount = BigInt(value);
    if (amount > 0n) return `+${amount.toString()}`;
    return amount.toString();
  } catch {
    return value.startsWith('-') || value.startsWith('+') ? value : `+${value}`;
  }
}

function HandSummary({
  hand,
  slot,
  activeSlot,
  canSelect,
  onSelect,
}: {
  hand: SubHandView;
  slot: 0 | 1;
  activeSlot: 0 | 1;
  canSelect: boolean;
  onSelect: () => void;
}) {
  const active = activeSlot === slot;
  return (
    <button
      type="button"
      data-testid={`bj-subhand-${slot}`}
      data-active={active ? 'true' : 'false'}
      onClick={onSelect}
      disabled={!canSelect}
      className={styles.actionButton}
      style={{
        minWidth: 150,
        height: 'auto',
        minHeight: 44,
        padding: '7px 11px',
        borderColor: active ? 'var(--hm-gold-bright)' : undefined,
        background: active ? 'rgba(212, 175, 55, 0.16)' : undefined,
        textAlign: 'left',
      }}
    >
      <span style={{ display: 'block', color: 'var(--hm-cream-muted)', fontSize: 9 }}>
        {`Hand ${slot + 1}`}
      </span>
      <span style={{ display: 'block', marginTop: 3 }}>
        {hand.total}{hand.isSoft ? ' soft' : ''}{hand.isBust ? ' · BUST' : ''}
      </span>
      <span style={{
        display: 'block',
        marginTop: 3,
        color: 'var(--hm-cream-muted)',
        fontSize: 9,
        letterSpacing: '0.04em',
        textTransform: 'none',
      }}>
        {hand.cards.map(cardLabel).join(' · ')}
      </span>
    </button>
  );
}

function AgentModeBar({ controller }: { controller: Controller }) {
  const {
    agentMode,
    agentConnected,
    agentDriverUnavailable,
    agentPendingAction,
    advisorMessages,
    handlers,
  } = controller;
  const autonomousEnabled = agentConnected && !agentDriverUnavailable;

  return (
    <div style={{
      display: 'grid',
      gap: 6,
      padding: '7px 9px',
      border: '1px solid rgba(111, 230, 255, 0.22)',
      borderRadius: 8,
      background: 'rgba(10, 22, 40, 0.56)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span className={styles.smallCaps} style={{ color: 'var(--hm-cream-muted)' }}>Mode</span>
        <button
          type="button"
          role="radio"
          aria-checked={agentMode === 'control'}
          onClick={() => handlers.setAgentMode('control')}
          className={styles.actionButton}
          style={{ minWidth: 92 }}
        >
          Control
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={agentMode === 'autonomous'}
          onClick={() => handlers.setAgentMode('autonomous')}
          disabled={!autonomousEnabled}
          className={styles.actionButton}
          style={{ minWidth: 118 }}
          title={autonomousEnabled
            ? 'Your connected agent decides while you keep the takeover window.'
            : 'Connect a compatible agent to use supervised Autonomous mode.'}
        >
          Autonomous
        </button>
        <span style={{ marginLeft: 'auto', color: 'var(--hm-cream-muted)', fontSize: 9 }}>
          {agentMode === 'control' ? 'You decide · agent advises' : 'Agent decides · you can take over'}
        </span>
      </div>

      <div
        aria-live="polite"
        style={{
          maxHeight: 54,
          overflowY: 'auto',
          color: 'var(--hm-cream-muted)',
          fontSize: 10,
          lineHeight: 1.35,
        }}
      >
        {agentPendingAction && agentMode === 'autonomous' && (
          <div style={{ color: 'var(--hm-gold-bright)', fontWeight: 800 }}>
            Agent plans to {agentPendingAction}. The 8–15 second veto countdown is active; tap any action to take over.
          </div>
        )}
        {advisorMessages.length === 0 ? (
          <div>
            {agentConnected
              ? 'Advisor is read-only. Your action buttons remain the authority in Control mode.'
              : 'Connect an agent to receive read-only table advice.'}
          </div>
        ) : advisorMessages.slice(-3).map((message) => (
          <div key={message.id}>
            <span style={{ color: '#6fe6ff' }}>Advisor:</span> {message.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SeatedBlackjackHud({ controller }: { controller: Controller }) {
  const {
    phase,
    dealerCards,
    dealerTotalLabel,
    playerHands,
    activeSlot,
    didSplit,
    tookInsurance,
    bannerVisible,
    bannerText,
    balance,
    isRealTier,
    bet,
    shoe,
    revealedSeed,
    settled,
    toast,
    inFlight,
    canDouble,
    canSplit,
    canSurrender,
    activeResolved,
    handlers,
  } = controller;
  const actionDisabled = phase !== 'player-turn' || inFlight || activeResolved;
  const outcome = settled?.outcome;
  const net = outcome?.rakedNet ?? settled?.net ?? '0';
  const rake = outcome?.rake ?? '0';

  return (
    <div className={styles.surface}>
      {bannerVisible && settled && (
        <div
          className={styles.settlement}
          data-testid="bj-outcome-banner"
          data-banner-text={bannerText ?? ''}
        >
          <div className={styles.settlementHeadline}>{bannerText}</div>
          <div className={styles.settlementDetail}>
            Net <span data-testid="bj-banner-net">{signedVclaw(net)}</span> vCLAW · Rake {rake} vCLAW
          </div>
        </div>
      )}

      <div className={styles.hud} data-testid="seated-blackjack-hud">
        {toast && (
          <div
            className={[
              styles.toast,
              toast.tone === 'error' ? styles.toastError : '',
              toast.tone === 'warn' ? styles.toastWarn : '',
            ].filter(Boolean).join(' ')}
          >
            {toast.message}
          </div>
        )}

        <div
          className={`${styles.panel} ${styles.actionPanel}`}
          style={{ maxHeight: 'min(62vh, 520px)', overflowY: 'auto' }}
        >
          <div className={styles.statusRow}>
            <span>BLACKJACK · 6-DECK · S17 · 3:2</span>
            <span className={styles.metric}>
              Balance <strong>{balance.toLocaleString()} vCLAW</strong>
              {!isRealTier ? ' · DEMO' : ''}
            </span>
            <span className={styles.metric}>Bet <strong>{bet} vCLAW</strong></span>
            {dealerTotalLabel && (
              <span className={styles.metric}>
                Dealer <strong>{dealerTotalLabel}</strong>
              </span>
            )}
            {tookInsurance && <span className={styles.blindPill}>Insurance taken</span>}
          </div>

          {dealerCards.length > 0 && (
            <div className={styles.legendRow} aria-label="Dealer cards">
              <span>Dealer</span>
              <span>{dealerCards.map(cardLabel).join(' · ')}</span>
            </div>
          )}

          {playerHands.length > 0 && (
            <div className={styles.actionRow} aria-label="Player hands">
              {playerHands.map((hand, index) => {
                const slot = index === 1 ? 1 : 0;
                return (
                  <HandSummary
                    key={`blackjack-hand-${slot}`}
                    hand={hand}
                    slot={slot}
                    activeSlot={activeSlot}
                    canSelect={didSplit && phase === 'player-turn' && !inFlight && !hand.isResolved}
                    onSelect={() => handlers.setActiveSlot(slot)}
                  />
                );
              })}
            </div>
          )}

          {phase === 'idle' && (
            <>
              <div className={styles.actionRow} aria-label="Choose bet">
                {BET_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => handlers.setBet(chip)}
                    disabled={inFlight || (shoe !== null && chip > balance)}
                    aria-pressed={bet === chip}
                    className={`${styles.actionButton}${bet === chip ? ` ${styles.primaryButton}` : ''}`}
                  >
                    {chip} vCLAW
                  </button>
                ))}
              </div>
              <div className={styles.actionRow}>
                <button
                  type="button"
                  onClick={() => { void handlers.handleDeal(); }}
                  disabled={inFlight || (shoe !== null && bet > balance)}
                  className={`${styles.actionButton} ${styles.primaryButton}`}
                >
                  {inFlight ? 'Dealing…' : 'Deal'}
                </button>
              </div>
            </>
          )}

          {phase === 'player-turn' && (
            <div className={styles.actionRow}>
              <button
                type="button"
                onClick={() => { void handlers.runAction('hit'); }}
                disabled={actionDisabled}
                className={styles.actionButton}
              >
                Hit
              </button>
              <button
                type="button"
                onClick={() => { void handlers.runAction('stand'); }}
                disabled={actionDisabled}
                className={`${styles.actionButton} ${styles.primaryButton}`}
              >
                Stand
              </button>
              <button
                type="button"
                onClick={() => { void handlers.runAction('double'); }}
                disabled={actionDisabled || !canDouble}
                className={styles.actionButton}
              >
                Double
              </button>
              <button
                type="button"
                onClick={() => { void handlers.runAction('split'); }}
                disabled={actionDisabled || !canSplit}
                className={styles.actionButton}
              >
                Split
              </button>
              <button
                type="button"
                onClick={() => { void handlers.runAction('surrender'); }}
                disabled={actionDisabled || !canSurrender}
                className={`${styles.actionButton} ${styles.foldButton}`}
              >
                Surrender
              </button>
            </div>
          )}

          {phase === 'settled' && (
            <div className={styles.actionRow}>
              <button
                type="button"
                onClick={handlers.handleNextHand}
                disabled={inFlight}
                className={`${styles.actionButton} ${styles.primaryButton}`}
              >
                Next Hand
              </button>
            </div>
          )}

          <AgentModeBar controller={controller} />

          <div className={styles.legendRow}>
            <span>{controller.fairnessSummary}</span>
            {shoe?.serverSeedHash && (
              <span style={{ maxWidth: 360, wordBreak: 'break-all' }}>
                Commit {shoe.serverSeedHash}
              </span>
            )}
            {shoe?.clientSeed && <span>Client seed {shoe.clientSeed}</span>}
            {revealedSeed && <span>Revealed seed {revealedSeed}</span>}
            <Link href="/cove/history" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--hm-gold-bright)' }}>
              History &amp; verify
            </Link>
            <button
              type="button"
              onClick={() => { void handlers.handleWalkAway(); }}
              disabled={inFlight}
              className={`${styles.actionButton} ${styles.walkButton}`}
            >
              {isRealTier ? 'Walk Away' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
