'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { floorArenaErrorCode } from '@/hooks/use-floor-arena';
import {
  ARENA_WITHDRAW_ASSETS,
  arenaOpenWithdrawal,
  arenaWithdrawCodeCopy,
  arenaWithdrawDelayText,
  arenaWithdrawErrorCopy,
  arenaWithdrawLocalTime,
  arenaWithdrawMinimumCopy,
  arenaWithdrawStateCopy,
  formatArenaAtomic,
  newArenaWithdrawKey,
  useArenaWithdrawChallenge,
  useCancelArenaWithdrawal,
  useFloorArenaWithdrawals,
  useRequestArenaWithdrawal,
  useRevokeArenaWithdrawAddress,
  useSetArenaWithdrawAddress,
  type ArenaWithdrawAsset,
  type ArenaWithdrawLimits,
  type ArenaWithdrawStateView,
  type ArenaWithdrawalView,
} from '@/hooks/use-floor-arena-withdraw';
import { WalletSignError, connectSolanaWallet, hasSolanaWallet, signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { FLOOR_TEXT } from '../tokens';
import { ArenaMuted, arenaButtonStyle, arenaInnerCardStyle, arenaInputStyle, arenaPrimaryButtonStyle } from './arena-kit';

// The withdraw part of My Trader > Wallet (P5, D34; contract
// ops/house-traders/arena-review/P5_CONTRACT_2026-10-02.md §7). The human
// proves a receiving address (a signed message from that wallet, or the
// account's linked wallet), then asks for USDC or SOL. The API only writes a
// row; the engine leader sends it once. Every limit number comes from the
// `limits` object of GET /me/withdrawals.

export const ARENA_WITHDRAW_NO_ADDRESS =
  'Add a withdraw address first. Sign a message with the wallet that will receive the money.';
export const ARENA_WITHDRAW_NO_WALLET_APP =
  'No wallet app found in this browser. Open ClawVille in the browser of your wallet app, or use your linked wallet.';

/** The amount rule of the route (contract §6 withdrawRequestBodySchema). */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,9})?$/;
const ASSET_DECIMALS: Record<ArenaWithdrawAsset, number> = { USDC: 6, SOL: 9 };
/** The panel shows this many rows of history. */
const HISTORY_ROWS = 10;

type Message = { text: string; tone: string } | null;

function shortAddress(value: string | null): string {
  if (!value) return 'n/a';
  return value.length > 11 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

/** A problem with the typed amount, or null. `max` is always valid. */
export function arenaWithdrawAmountProblem(amount: string, asset: ArenaWithdrawAsset): string | null {
  if (amount === 'max') return null;
  if (!AMOUNT_PATTERN.test(amount)) return 'Type an amount, for example 1.5, or press Max.';
  const fraction = amount.split('.')[1] ?? '';
  if (fraction.length > ASSET_DECIMALS[asset]) return `${asset} has at most ${ASSET_DECIMALS[asset]} decimals.`;
  if (!/[1-9]/.test(amount)) return 'Type an amount of more than 0.';
  return null;
}

function solMaxCopy(limits: ArenaWithdrawLimits | null): string {
  const keep = limits ? `${formatArenaAtomic(limits.solKeepLamports, 'SOL')} SOL` : 'a small amount of SOL';
  return `Max SOL leaves ${keep} in the wallet. After that, a USDC withdrawal needs more SOL.`;
}

function limitsCopy(limits: ArenaWithdrawLimits | null): string {
  if (!limits) return 'Daily limits apply. ClawVille checks each request.';
  const cooldownMinutes = Math.round(limits.cooldownMs / 60_000);
  return (
    `${arenaWithdrawMinimumCopy(limits)} You can withdraw ${limits.agentDailyRequests} times and at most ` +
    `${formatArenaAtomic(limits.agentDailyUsdcAtomic, 'USDC')} USDC a day, with ${cooldownMinutes} ` +
    `${cooldownMinutes === 1 ? 'minute' : 'minutes'} between withdrawals.`
  );
}

function walletErrorCopy(error: WalletSignError): string {
  if (error.code === 'no_wallet') return ARENA_WITHDRAW_NO_WALLET_APP;
  if (error.code === 'user_rejected') return 'You cancelled the request in your wallet.';
  if (error.code === 'wallet_changed') return 'The active wallet changed. Try again.';
  return 'The wallet could not sign. Try again.';
}

/** A SOL amount without an exponent and without trailing zeros. */
function solText(value: number): string {
  return value.toFixed(9).replace(/\.?0+$/, '');
}

function InlineMessage({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <div role="status" style={{ color: message.tone, fontSize: 12 }}>
      {message.text}
    </div>
  );
}

/** Null until mounted (server render), then whether the browser has a Solana wallet. */
function useWalletAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => setAvailable(hasSolanaWallet()), []);
  return available;
}

function AddressSection({ view, compact }: { view: ArenaWithdrawStateView; compact: boolean }) {
  const challenge = useArenaWithdrawChallenge();
  const setAddress = useSetArenaWithdrawAddress();
  const revoke = useRevokeArenaWithdrawAddress();
  const walletAvailable = useWalletAvailable();
  const [noWallet, setNoWallet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const { address, linkedWallet, limits } = view;
  const delay = arenaWithdrawDelayText(limits);
  const showNoWallet = walletAvailable === false || noWallet;
  const linkedChoice = linkedWallet && linkedWallet.address !== address?.address ? linkedWallet : null;

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ text: await action(), tone: FLOOR_TEXT.accent });
    } catch (error) {
      if (error instanceof WalletSignError) {
        if (error.code === 'no_wallet') setNoWallet(true);
        else setMessage({ text: walletErrorCopy(error), tone: FLOOR_TEXT.warning });
      } else {
        setMessage({ text: arenaWithdrawErrorCopy(error, limits), tone: FLOOR_TEXT.warning });
      }
    } finally {
      setBusy(false);
    }
  };

  // Connect first, so the challenge is for the key that signs. The wallet
  // shows the server text; the signature proves this key receives the money.
  const signWithWallet = () =>
    run(async () => {
      const pubkey = await connectSolanaWallet();
      const issued = await challenge.mutateAsync({ address: pubkey });
      const signed = await signMessageWithSolanaWallet(issued.messageToSign, pubkey);
      await setAddress.mutateAsync({ proof: 'signed', address: pubkey, nonce: issued.nonce, signature: signed.signatureBase58 });
      return 'Address saved.';
    });

  const pickLinked = () =>
    run(async () => {
      await setAddress.mutateAsync({ proof: 'linked_wallet' });
      return 'Address saved.';
    });

  const remove = (addressId: string) =>
    run(async () => {
      await revoke.mutateAsync({ addressId });
      return 'Address removed.';
    });

  let status: { text: string; tone: string };
  if (!address) {
    status = { text: ARENA_WITHDRAW_NO_ADDRESS, tone: FLOOR_TEXT.primary };
  } else if (address.state === 'active') {
    status = { text: `Withdrawals go to ${shortAddress(address.address)}.`, tone: FLOOR_TEXT.primary };
  } else {
    const time = arenaWithdrawLocalTime(address.activeAt);
    status = {
      text:
        `${time ? `This address works from ${time}.` : 'This address does not work yet.'} ` +
        `${delay ? `A new address waits ${delay}.` : 'A new address waits before it works.'} ` +
        'If you did not add it, remove it now.',
      tone: FLOOR_TEXT.warning,
    };
  }

  const buttonStyle = compact ? { ...arenaButtonStyle, width: '100%' } : arenaButtonStyle;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="arena-withdraw-address">
      <div style={{ color: status.tone, fontSize: 12 }} data-testid="arena-withdraw-address-status">
        {status.text}
      </div>
      {address?.setBy === 'agent' ? <ArenaMuted size={11}>Your agent set this address.</ArenaMuted> : null}
      {address?.state === 'active' ? (
        <ArenaMuted size={11}>
          A new signed address replaces this one and waits {delay ?? 'some time'} before it works.
        </ArenaMuted>
      ) : null}
      {linkedChoice ? (
        <ArenaMuted size={11}>
          Your linked wallet: {shortAddress(linkedChoice.address)}.{' '}
          {linkedChoice.activeNow ? 'It works at once.' : `It works ${delay ?? 'some time'} after you select it.`}
        </ArenaMuted>
      ) : null}
      {showNoWallet ? (
        <div style={{ color: FLOOR_TEXT.warning, fontSize: 12 }} data-testid="arena-withdraw-no-wallet">
          {ARENA_WITHDRAW_NO_WALLET_APP}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', flexWrap: 'wrap', gap: 8 }}>
        {!showNoWallet ? (
          <button type="button" disabled={busy} onClick={() => void signWithWallet()} style={buttonStyle}>
            Sign with my wallet
          </button>
        ) : null}
        {linkedChoice ? (
          <button type="button" disabled={busy} onClick={() => void pickLinked()} style={buttonStyle}>
            Use my linked wallet
          </button>
        ) : null}
        {address ? (
          <button type="button" disabled={busy} onClick={() => void remove(address.id)} style={buttonStyle}>
            Remove this address
          </button>
        ) : null}
      </div>
      <InlineMessage message={message} />
    </div>
  );
}

function WithdrawForm({ view, compact }: { view: ArenaWithdrawStateView; compact: boolean }) {
  const inputId = useId();
  const request = useRequestArenaWithdrawal();
  const [asset, setAsset] = useState<ArenaWithdrawAsset>('USDC');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState<Message>(null);
  // The Idempotency-Key of the current attempt and the values it was made for.
  // A retry of the same values sends the same key, so the route answers with
  // the same request instead of a second one. Any change of asset or amount,
  // and every success, clears it.
  const attempt = useRef<{ key: string; asset: ArenaWithdrawAsset; amount: string } | null>(null);
  const limits = view.limits;
  const open = arenaOpenWithdrawal(view);
  const normalized = amount.trim().toLowerCase() === 'max' ? 'max' : amount.trim();
  const problem = normalized === '' ? null : arenaWithdrawAmountProblem(normalized, asset);

  const changeAsset = (next: ArenaWithdrawAsset) => {
    attempt.current = null;
    setAsset(next);
    setMessage(null);
  };
  const changeAmount = (next: string) => {
    attempt.current = null;
    setAmount(next);
    setMessage(null);
  };

  const submit = () => {
    if (normalized === '' || problem) {
      setMessage({ text: problem ?? 'Type an amount, or press Max.', tone: FLOOR_TEXT.danger });
      return;
    }
    if (!attempt.current || attempt.current.asset !== asset || attempt.current.amount !== normalized) {
      attempt.current = { key: newArenaWithdrawKey(), asset, amount: normalized };
    }
    const sent = attempt.current;
    request.mutate(
      { asset: sent.asset, amount: sent.amount, idempotencyKey: sent.key },
      {
        onSuccess: (result) => {
          attempt.current = null;
          setAmount('');
          setMessage({
            text: result.replay
              ? 'This request was sent before. Its state shows below.'
              : 'Withdrawal requested. Its state shows below.',
            tone: FLOOR_TEXT.accent,
          });
        },
        onError: (error) => {
          // The key belongs to other values on the server: the next press needs a new one.
          if (floorArenaErrorCode(error) === 'idempotency_conflict') attempt.current = null;
          setMessage({ text: arenaWithdrawErrorCopy(error, limits), tone: FLOOR_TEXT.warning });
        },
      },
    );
  };

  const minimum = limits
    ? asset === 'USDC'
      ? formatArenaAtomic(limits.minUsdcAtomic, 'USDC')
      : formatArenaAtomic(limits.minSolLamports, 'SOL')
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="arena-withdraw-form">
      <div role="group" aria-label="Asset to withdraw" style={{ display: 'flex', gap: 8 }}>
        {ARENA_WITHDRAW_ASSETS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={asset === option}
            disabled={request.isPending}
            onClick={() => changeAsset(option)}
            data-testid={`arena-withdraw-asset-${option}`}
            style={{ ...(asset === option ? arenaPrimaryButtonStyle : arenaButtonStyle), flex: compact ? '1 1 0' : undefined }}
          >
            {option}
          </button>
        ))}
      </div>
      <label htmlFor={inputId} style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
        Amount of {asset} to withdraw
      </label>
      <div style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', gap: 8 }}>
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          placeholder={minimum ? `At least ${minimum}` : 'Amount'}
          disabled={request.isPending}
          onChange={(event) => changeAmount(event.target.value)}
          data-testid="arena-withdraw-amount"
          style={compact ? arenaInputStyle : { ...arenaInputStyle, flex: '1 1 160px' }}
        />
        <button
          type="button"
          disabled={request.isPending}
          onClick={() => changeAmount('max')}
          data-testid="arena-withdraw-max"
          style={arenaButtonStyle}
        >
          Max
        </button>
        <button
          type="button"
          disabled={request.isPending || open !== null}
          onClick={submit}
          data-testid="arena-withdraw-submit"
          style={arenaPrimaryButtonStyle}
        >
          {request.isPending ? 'Sending request...' : 'Withdraw'}
        </button>
      </div>
      {asset === 'SOL' && normalized === 'max' ? (
        <div style={{ color: FLOOR_TEXT.warning, fontSize: 12 }}>{solMaxCopy(limits)}</div>
      ) : null}
      {open ? (
        <div style={{ color: FLOOR_TEXT.warning, fontSize: 12 }}>{arenaWithdrawCodeCopy('withdrawal_open', limits)}</div>
      ) : null}
      {problem ? (
        <div role="alert" style={{ color: FLOOR_TEXT.danger, fontSize: 12 }}>
          {problem}
        </div>
      ) : null}
      <ArenaMuted size={11}>{limitsCopy(limits)}</ArenaMuted>
      <InlineMessage message={message} />
    </div>
  );
}

function stateTone(state: ArenaWithdrawalView['state']): string {
  if (state === 'confirmed') return FLOOR_TEXT.positive;
  if (state === 'refused' || state === 'failed' || state === 'failed_no_send') return FLOOR_TEXT.danger;
  if (state === 'needs_review') return FLOOR_TEXT.warning;
  if (state === 'cancelled' || state === null) return FLOOR_TEXT.muted;
  return FLOOR_TEXT.accent;
}

function History({ view }: { view: ArenaWithdrawStateView }) {
  const cancel = useCancelArenaWithdrawal();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const rows = view.withdrawals.slice(0, HISTORY_ROWS);
  if (rows.length === 0) return <ArenaMuted size={11}>No withdrawals yet.</ArenaMuted>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="arena-withdraw-history">
      <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>Your last withdrawals</div>
      {rows.map((row) => {
        const amountText = row.amount ? `${row.amount} ${row.asset}` : row.amountMode === 'max' ? `Max ${row.asset}` : row.asset;
        const time = arenaWithdrawLocalTime(row.requestedAt);
        return (
          <div key={row.id} style={arenaInnerCardStyle} data-testid={`arena-withdrawal-${row.id}`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
              <span style={{ color: FLOOR_TEXT.value, fontSize: 12, fontWeight: 700 }}>{amountText}</span>
              <span style={{ color: stateTone(row.state), fontSize: 12 }}>{arenaWithdrawStateCopy(row, view.limits)}</span>
            </div>
            <div style={{ color: FLOOR_TEXT.muted, fontSize: 11 }}>
              {time ? `${time} · ` : ''}to {shortAddress(row.destination)}
              {row.subjectKind === 'agent' ? ' · by your agent' : ''}
              {row.txSignature ? ` · transaction ${shortAddress(row.txSignature)}` : ''}
            </div>
            {row.state === 'requested' ? (
              <button
                type="button"
                disabled={cancel.isPending}
                onClick={() =>
                  cancel.mutate(
                    { withdrawalId: row.id },
                    {
                      onSuccess: () => setMessage(null),
                      onError: (error) => setMessage({ id: row.id, text: arenaWithdrawErrorCopy(error, view.limits) }),
                    },
                  )
                }
                style={{ ...arenaButtonStyle, alignSelf: 'flex-start' }}
              >
                Cancel request
              </button>
            ) : null}
            {message?.id === row.id ? (
              <div role="status" style={{ color: FLOOR_TEXT.warning, fontSize: 12 }}>
                {message.text}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Wallet block's withdraw panel: the receiving address, the withdraw form
 * and the last 10 withdrawals. The form shows only for an active address.
 */
export function ArenaWithdrawPanel({ compact }: { compact: boolean }) {
  const query = useFloorArenaWithdrawals(true);
  const view = query.data ?? null;
  return (
    <div style={{ ...arenaInnerCardStyle, marginTop: 4 }} data-testid="arena-withdraw">
      <div style={{ color: FLOOR_TEXT.value, fontSize: 13, fontWeight: 700 }}>Withdraw</div>
      {view ? (
        <>
          <AddressSection view={view} compact={compact} />
          {view.address?.state === 'active' ? <WithdrawForm view={view} compact={compact} /> : null}
          <History view={view} />
        </>
      ) : query.isError ? (
        <ArenaMuted>Your withdraw details could not be loaded right now. Try again shortly.</ArenaMuted>
      ) : (
        <ArenaMuted>Loading your withdraw details...</ArenaMuted>
      )}
    </div>
  );
}

/** "SOL in the wallet" for the Wallet block. Same query as the panel, so one poll feeds both. */
export function ArenaWalletSolLine() {
  const query = useFloorArenaWithdrawals(true);
  const sol = query.data?.wallet?.sol ?? null;
  const keep = query.data?.limits?.recommendedSolText ?? null;
  return (
    <ArenaMuted size={11}>
      SOL in the wallet: {sol === null ? 'not known right now' : solText(sol)} (
      {keep ? `keep at least ${keep} SOL for network fees` : 'keep some SOL for network fees'})
    </ArenaMuted>
  );
}
