'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  TRADE_SCORING_RULE_LINES,
  TRADING_FLOOR_GUARDRAIL_LINES,
  TRADING_FLOOR_RULES,
} from '@clawville/shared';

import { useAvatar } from '@/hooks/use-avatar';
import {
  floorErrorCode,
  floorForbiddenCopy,
  isFloorGuestBlocked,
  useBindCustodialWallet,
  useBindLinkedWallet,
  useBindSignedWallet,
  useFloorConsumer,
  useFloorFeed,
  useFloorStreamState,
  useMyTrades,
  useMyTradingWallets,
  useReportTrade,
  useRevokeTradingWallet,
  type ReportTradeResult,
  type TradingWallet,
} from '@/hooks/use-trading-floor';
import { useWalletLink } from '@/hooks/use-wallet-link';
import { ApiError } from '@/lib/api';
import { hasSolanaWallet } from '@/lib/solana-wallet';
import { useTradeTickerStore } from '@/stores/trade-ticker';
import { useWorldStreamStore } from '@/stores/world-stream-state';
import {
  liquidityHint,
  rejectDetailCopy,
  shortMint,
  tradeAgeLabel,
  unscoredReasonCopy,
} from './format';
import { ClawPumpTemplatesSection } from './clawpump-templates';
import { HouseTradersSection } from './house-traders';
import { floorStatusCopy } from './floor-tape';
import { TapeRow } from './trade-row';
import {
  FLOOR_TEXT,
  TRADING_SELF_SERVE_COMING_SOON,
  TRADING_SELF_SERVE_ENABLED,
  TRADING_SELF_SERVE_WALLET_EXPLANATION,
} from './tokens';

export interface TradingFloorTabProps {
  active: boolean;
  isGuest: boolean;
  onGuestBlocked: () => void;
}

const cardStyle = {
  border: '1px solid rgba(125,211,252,0.18)',
  borderRadius: 12,
  background: 'rgba(2,8,23,0.80)',
  padding: 14,
  color: FLOOR_TEXT.primary,
} as const;

const buttonStyle = {
  minHeight: 44,
  borderRadius: 8,
  border: '1px solid rgba(125,211,252,0.28)',
  background: 'rgba(14,116,144,0.20)',
  color: FLOOR_TEXT.primary,
  padding: '8px 12px',
  cursor: 'pointer',
} as const;

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ margin: '0 0 10px', color: FLOOR_TEXT.value, fontSize: 14 }}>
      {children}
    </h3>
  );
}

const WALLET_SOURCE_LABELS: Record<TradingWallet['source'], string> = {
  linked: 'Linked wallet',
  clawpump: 'Agent-managed',
  custodial: 'In-game wallet',
  signed: 'Signed wallet',
};

function walletSourceLabel(source: TradingWallet['source']): string {
  return WALLET_SOURCE_LABELS[source];
}

function shortWallet(pubkey: string): string {
  return pubkey.length <= 15
    ? pubkey
    : `${pubkey.slice(0, 6)}...${pubkey.slice(-5)}`;
}

function reportErrorCopy(error: unknown): string {
  const code = floorErrorCode(error);
  if (error instanceof ApiError && code === 'not_a_swap') {
    return rejectDetailCopy(error.detail ?? null);
  }
  if (code === 'invalid_request' || code === 'invalid_json') {
    return 'That does not look like a Solana signature.';
  }
  if (code === 'signature_not_found') {
    return 'We could not find that signature on chain yet. Wait for confirmation and try again.';
  }
  if (code === 'wallet_not_bound') {
    return 'That trade was not paid for by a wallet you have bound.';
  }
  if (code === 'tx_failed') {
    return 'That transaction failed on chain, so there is nothing to score.';
  }
  if (code === 'rate_limited') return 'Too many reports. Wait a moment and try again.';
  if (code === 'upstream_unavailable') {
    return 'The chain lookup is unavailable. Try again shortly.';
  }
  if (code === 'settlement_write_failed') {
    return 'The trade record could not be saved. Try again.';
  }
  return floorForbiddenCopy(error);
}

function WalletRow({
  wallet,
  onRevoke,
  pending,
}: {
  wallet: TradingWallet;
  onRevoke: () => void;
  pending: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '9px 0',
        borderBottom: '1px solid rgba(125,211,252,0.10)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ color: FLOOR_TEXT.value, fontSize: 12 }}>
          {shortWallet(wallet.pubkey)}
        </div>
        <div style={{ color: FLOOR_TEXT.muted, fontSize: 10 }}>
          <span
            style={{
              display: 'inline-flex',
              border: '1px solid rgba(125,211,252,0.22)',
              borderRadius: 999,
              padding: '2px 6px',
              color: FLOOR_TEXT.accent,
            }}
          >
            {walletSourceLabel(wallet.source)}
          </span>{' '}
          bound {new Date(wallet.boundAt).toLocaleDateString()}
        </div>
        <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>
          {wallet.lastPolledAt
            ? `checked ${new Date(wallet.lastPolledAt).toLocaleString()}`
            : 'not checked yet'}
        </div>
        {wallet.operatedByClawville ? (
          <div style={{ color: FLOOR_TEXT.accent, fontSize: 10 }}>
            ClawVille-operated
          </div>
        ) : null}
        {wallet.source === 'linked' ? (
          <div style={{ color: FLOOR_TEXT.muted, fontSize: 10 }}>
            Linking a different wallet in Wallet settings replaces this row.
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRevoke}
        disabled={pending}
        style={{ ...buttonStyle, color: FLOOR_TEXT.danger }}
      >
        {pending ? 'Revoking...' : 'Revoke'}
      </button>
    </div>
  );
}

function BindButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={TRADING_SELF_SERVE_ENABLED ? onClick : undefined}
      disabled={!TRADING_SELF_SERVE_ENABLED || disabled}
      aria-disabled={!TRADING_SELF_SERVE_ENABLED || disabled}
      title={!TRADING_SELF_SERVE_ENABLED ? TRADING_SELF_SERVE_WALLET_EXPLANATION : undefined}
      style={{
        ...buttonStyle,
        width: '100%',
        color: !TRADING_SELF_SERVE_ENABLED ? FLOOR_TEXT.muted : disabled ? FLOOR_TEXT.disabled : FLOOR_TEXT.primary,
        opacity: !TRADING_SELF_SERVE_ENABLED ? 0.55 : 1,
        cursor: !TRADING_SELF_SERVE_ENABLED || disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
      {!TRADING_SELF_SERVE_ENABLED ? (
        <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
      ) : null}
    </button>
  );
}

export function TradingFloorTab({
  active,
  isGuest,
  onGuestBlocked,
}: TradingFloorTabProps) {
  const { nowMs } = useFloorConsumer(active);
  const feed = useFloorFeed(active);
  const myTrades = useMyTrades(active && !isGuest);
  const wallets = useMyTradingWallets(active && !isGuest);
  const stream = useFloorStreamState();
  const streamHasOpened = useWorldStreamStore((state) => state.hasOpened);
  const entries = useTradeTickerStore((state) => state.entries);
  const seedTrades = useTradeTickerStore((state) => state.seedTrades);
  const linkedWallet = useWalletLink();
  const { data: avatar } = useAvatar();
  const bindLinked = useBindLinkedWallet();
  const bindCustodial = useBindCustodialWallet();
  const bindSigned = useBindSignedWallet();
  const revoke = useRevokeTradingWallet();
  const report = useReportTrade();
  const [signature, setSignature] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ReportTradeResult | null>(null);
  const [showBindPrompt, setShowBindPrompt] = useState(false);

  useEffect(() => {
    if (feed.data?.trades.length) seedTrades(feed.data.trades);
  }, [feed.data?.trades, seedTrades]);

  const rows = wallets.data?.wallets ?? [];
  const atLimit = rows.length >= 5;
  const linkedActive = rows.some((wallet) => wallet.source === 'linked');
  const custodialActive = rows.some((wallet) => wallet.source === 'custodial');
  const custodialAddress = (avatar as { walletAddress?: string | null } | undefined)
    ?.walletAddress;
  const canReport = signature.trim().length >= 64 && signature.trim().length <= 128;
  const status = floorStatusCopy(stream, feed.data?.observer, streamHasOpened);
  const generatedAge = useMemo(() => {
    if (!feed.data?.generatedAt) return null;
    const seconds = Date.parse(feed.data.generatedAt) / 1_000;
    return Number.isFinite(seconds) ? tradeAgeLabel(seconds, nowMs) : null;
  }, [feed.data?.generatedAt, nowMs]);

  const handleMutationError = (error: unknown) => {
    if (isFloorGuestBlocked(error)) {
      onGuestBlocked();
      return;
    }
    setMessage(floorForbiddenCopy(error));
  };

  const submitReport = () => {
    if (isGuest) {
      onGuestBlocked();
      return;
    }
    if (!canReport) {
      setMessage('That does not look like a Solana signature.');
      return;
    }
    setMessage(null);
    setResult(null);
    setShowBindPrompt(false);
    report.mutate(
      { signature: signature.trim() },
      {
        onSuccess: (next) => {
          setResult(next);
          setMessage(
            next.replayed
              ? 'Already counted.'
              : next.scored
                ? 'COUNTED'
                : unscoredReasonCopy(next.reason),
          );
        },
        onError: (error) => {
          if (isFloorGuestBlocked(error)) {
            onGuestBlocked();
            return;
          }
          setShowBindPrompt(floorErrorCode(error) === 'wallet_not_bound');
          setMessage(reportErrorCopy(error));
        },
      },
    );
  };

  return (
    <div
      data-testid="trading-floor-tab"
      style={{
        display: active ? 'flex' : 'none',
        flexDirection: 'column',
        gap: 14,
        padding: '16px 22px 22px',
        color: FLOOR_TEXT.primary,
      }}
    >
      <header style={cardStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, color: FLOOR_TEXT.value, fontSize: 16 }}>
              {TRADING_SELF_SERVE_ENABLED ? 'Trade in your wallet, then it shows here.' : 'Watch the house traders.'}
            </h2>
            {TRADING_SELF_SERVE_ENABLED ? (
              <a
                href="https://jup.ag/swap"
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-flex', minHeight: 44, alignItems: 'center', color: FLOOR_TEXT.link }}
              >
                Open Jupiter
              </a>
            ) : (
              <button
                type="button"
                disabled={!TRADING_SELF_SERVE_ENABLED}
                aria-disabled={!TRADING_SELF_SERVE_ENABLED}
                title={TRADING_SELF_SERVE_WALLET_EXPLANATION}
                style={{ ...buttonStyle, color: FLOOR_TEXT.muted, opacity: 0.55, cursor: 'not-allowed', marginTop: 8 }}
              >
                Open Jupiter
                <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
              </button>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: status.warning ? FLOOR_TEXT.warning : FLOOR_TEXT.accent, fontWeight: 800 }}>
              {status.label}
            </div>
            {generatedAge ? (
              <div style={{ color: FLOOR_TEXT.muted, fontSize: 10 }}>Updated {generatedAge}</div>
            ) : null}
            {stream === 'stopped' && streamHasOpened ? (
              <button type="button" onClick={() => window.location.reload()} style={buttonStyle}>
                Reload
              </button>
            ) : null}
          </div>
        </div>
        {status.detail ? (
          <p style={{ margin: '8px 0 0', color: FLOOR_TEXT.muted, fontSize: 11 }}>
            {status.detail}
          </p>
        ) : null}
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))',
          gap: 14,
        }}
      >
        <section id="trading-floor-wallets" style={cardStyle}>
          <CardTitle>Bound wallets</CardTitle>
          {isGuest ? (
            <div>
              <p style={{ color: FLOOR_TEXT.muted }}>
                Create a free account to bind a wallet and verify your trades.
              </p>
              <BindButton onClick={onGuestBlocked} disabled={false}>
                Create a free account
              </BindButton>
            </div>
          ) : (
            <>
              {rows.map((wallet) => (
                <WalletRow
                  key={`${wallet.subjectKind}:${wallet.pubkey}`}
                  wallet={wallet}
                  pending={revoke.isPending}
                  onRevoke={() => {
                    if (!window.confirm('Revoke this Trading Floor wallet?')) return;
                    revoke.mutate(
                      { pubkey: wallet.pubkey },
                      { onError: handleMutationError },
                    );
                  }}
                />
              ))}
              {rows.length === 0 ? (
                <p style={{ color: FLOOR_TEXT.muted }}>No wallet is bound yet.</p>
              ) : null}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {linkedWallet.linked && !linkedActive ? (
                  <BindButton
                    disabled={atLimit || bindLinked.isPending}
                    onClick={() => bindLinked.mutate(undefined, { onError: handleMutationError })}
                  >
                    Use my linked wallet
                  </BindButton>
                ) : null}
                {custodialAddress && !custodialActive ? (
                  <BindButton
                    disabled={atLimit || bindCustodial.isPending}
                    onClick={() => bindCustodial.mutate(undefined, { onError: handleMutationError })}
                  >
                    Use my in-game wallet
                  </BindButton>
                ) : null}
                {hasSolanaWallet() ? (
                  <BindButton
                    disabled={atLimit || bindSigned.isPending}
                    onClick={() => bindSigned.mutate(undefined, { onError: handleMutationError })}
                  >
                    Connect and sign
                  </BindButton>
                ) : null}
              </div>
              {atLimit ? (
                <p style={{ color: FLOOR_TEXT.warning, fontSize: 11 }}>
                  Five wallets are already bound. Revoke one before you add another.
                </p>
              ) : null}
            </>
          )}
          {!TRADING_SELF_SERVE_ENABLED ? (
            <p style={{ margin: '10px 0 0', color: FLOOR_TEXT.muted, fontSize: 11 }}>
              {TRADING_SELF_SERVE_WALLET_EXPLANATION}
            </p>
          ) : null}
        </section>

        <section style={cardStyle}>
          <CardTitle>Report a signature</CardTitle>
          <label style={{ display: 'block', color: FLOOR_TEXT.muted, fontSize: 11 }}>
            Solana transaction signature
            {!TRADING_SELF_SERVE_ENABLED ? (
              <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
            ) : null}
            <input
              value={signature}
              maxLength={128}
              onChange={TRADING_SELF_SERVE_ENABLED ? (event) => setSignature(event.target.value) : undefined}
              disabled={!TRADING_SELF_SERVE_ENABLED}
              aria-disabled={!TRADING_SELF_SERVE_ENABLED}
              title={!TRADING_SELF_SERVE_ENABLED ? TRADING_SELF_SERVE_WALLET_EXPLANATION : undefined}
              placeholder="Paste a confirmed swap signature"
              style={{
                display: 'block',
                width: '100%',
                minHeight: 44,
                marginTop: 6,
                borderRadius: 8,
                border: '1px solid rgba(125,211,252,0.24)',
                background: 'rgba(2,8,23,0.90)',
                color: TRADING_SELF_SERVE_ENABLED ? FLOOR_TEXT.value : FLOOR_TEXT.muted,
                opacity: TRADING_SELF_SERVE_ENABLED ? 1 : 0.55,
                padding: '8px 10px',
              }}
            />
          </label>
          <button
            type="button"
            onClick={TRADING_SELF_SERVE_ENABLED ? submitReport : undefined}
            disabled={!TRADING_SELF_SERVE_ENABLED || report.isPending || (!isGuest && !canReport)}
            aria-disabled={!TRADING_SELF_SERVE_ENABLED || report.isPending || (!isGuest && !canReport)}
            title={!TRADING_SELF_SERVE_ENABLED ? TRADING_SELF_SERVE_WALLET_EXPLANATION : undefined}
            style={{
              ...buttonStyle,
              width: '100%',
              marginTop: 10,
              color: TRADING_SELF_SERVE_ENABLED ? FLOOR_TEXT.primary : FLOOR_TEXT.muted,
              opacity: TRADING_SELF_SERVE_ENABLED ? 1 : 0.55,
              cursor: TRADING_SELF_SERVE_ENABLED ? 'pointer' : 'not-allowed',
            }}
          >
            {report.isPending ? 'Checking...' : 'Verify trade'}
            {!TRADING_SELF_SERVE_ENABLED ? (
              <small style={{ display: 'block', fontSize: 10 }}>{TRADING_SELF_SERVE_COMING_SOON}</small>
            ) : null}
          </button>
          {!TRADING_SELF_SERVE_ENABLED ? (
            <p style={{ margin: '10px 0 0', color: FLOOR_TEXT.muted, fontSize: 11 }}>
              {TRADING_SELF_SERVE_WALLET_EXPLANATION}
            </p>
          ) : null}
          {message ? (
            <p
              role="status"
              style={{
                color: result
                  ? (result.scored ? FLOOR_TEXT.accent : FLOOR_TEXT.muted)
                  : FLOOR_TEXT.warning,
                fontSize: 11,
              }}
            >
              {message}
            </p>
          ) : null}
          {showBindPrompt ? (
            <a
              href="#trading-floor-wallets"
              style={{
                display: 'inline-flex',
                minHeight: 44,
                alignItems: 'center',
                color: FLOOR_TEXT.link,
              }}
            >
              Bind wallet
            </a>
          ) : null}
          {result ? (
            <TapeRow
              entry={result.trade}
              density="panel"
              showTrader={false}
              nowMs={nowMs}
            />
          ) : null}
        </section>
      </div>

      <section style={cardStyle}>
        <CardTitle>Your verified trades</CardTitle>
        {isGuest ? (
          <p style={{ color: FLOOR_TEXT.muted }}>Sign in to see avatar-wide verified history.</p>
        ) : myTrades.isLoading ? (
          <p style={{ color: FLOOR_TEXT.muted }}>Loading verified trades...</p>
        ) : (myTrades.data?.trades.length ?? 0) === 0 ? (
          <p style={{ color: FLOOR_TEXT.muted }}>No verified trades yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myTrades.data!.trades.map((trade) => (
              <TapeRow key={trade.signature} entry={trade} density="panel" showTrader={false} nowMs={nowMs} />
            ))}
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <CardTitle>Live floor</CardTitle>
        {entries.length === 0 ? (
          <p style={{ color: FLOOR_TEXT.muted }}>Waiting for a verified trade.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entries.slice(0, 10).map((entry) => (
              <TapeRow key={entry.keys.join('|')} entry={entry} density="panel" nowMs={nowMs} />
            ))}
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <CardTitle>How scoring works</CardTitle>
        <ul style={{ margin: 0, paddingLeft: 18, color: FLOOR_TEXT.primary }}>
          {TRADE_SCORING_RULE_LINES.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 8, marginTop: 12 }}>
          {Object.entries(TRADING_FLOOR_RULES.multiplierTiers).map(([tier, multiplier]) => {
            const mint = tier === 'ansem'
              ? TRADING_FLOOR_RULES.mints.ANSEM
              : tier === 'clv'
                ? TRADING_FLOOR_RULES.mints.CLAWVILLE
                : null;
            const hint = mint ? liquidityHint(mint) : null;
            const tierLabel = tier === 'ansem' ? '$ANSEM pairs' : tier === 'clv' ? '$CLAWVILLE pairs' : 'Every other pair';
            return (
              <div key={tier} style={{ border: '1px solid rgba(125,211,252,0.14)', borderRadius: 8, padding: 10 }}>
                <div style={{ color: FLOOR_TEXT.value }}>
                  {tierLabel} · {multiplier}x
                </div>
                {mint ? <div style={{ color: FLOOR_TEXT.muted, fontSize: 10 }}>{shortMint(mint)}</div> : null}
                {hint ? <div style={{ color: FLOOR_TEXT.faint, fontSize: 10 }}>{hint}</div> : null}
              </div>
            );
          })}
        </div>
        <p style={{ color: FLOOR_TEXT.muted }}>Every other pair scores 1x.</p>
      </section>

      <HouseTradersSection active={active} />

      <ClawPumpTemplatesSection />

      {TRADING_FLOOR_GUARDRAIL_LINES.length > 0 || TRADING_FLOOR_RULES.executionWhitelist !== null ? (
        <section style={cardStyle}>
          <CardTitle>Rules for ClawVille's own agents</CardTitle>
          <p style={{ color: FLOOR_TEXT.muted }}>
            These limits apply to the agents ClawVille runs. They do not change what your own trades are worth.
          </p>
          <ul style={{ paddingLeft: 18 }}>
            {TRADING_FLOOR_GUARDRAIL_LINES.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {TRADING_FLOOR_RULES.executionWhitelist ? (
            <>
              <h4 style={{ color: FLOOR_TEXT.value }}>What ClawVille's agents may buy</h4>
              <ul style={{ paddingLeft: 18 }}>
                {TRADING_FLOOR_RULES.executionWhitelist.map((mint) => (
                  <li key={mint}>{shortMint(mint)}</li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
