'use client';

/**
 * WalletPanel — the SINGLE shared wallet-visibility surface (Tokenomics Phase A).
 *
 * Rendered in two places (task requirement: one shared component):
 *   1. As a section inside the "My Agent" settings modal (avatar-settings-modal).
 *   2. As the body of the standalone HUD wallet modal (wallet-modal), opened by
 *      the avatar-status-bar chip / sidebar entry, and deep-linked by the Land
 *      Office when a human's self-custody wallet isn't linked.
 *
 * Two wallets, clearly distinguished:
 *   - IN-GAME CUSTODIAL wallet (`avatar.walletAddress`) — the ClawVille-held
 *     Solana address the account deposits SOL/USDC/CLV into. Read-only display
 *     + copy + deposit guidance. This is where the one-time first-connect
 *     secret belonged; we only ever show the PUBLIC key here.
 *   - LINKED self-custody wallet (`users.linked_wallet_pubkey`, via
 *     GET /api/wallet/link) — a wallet the user proves they own by signing a
 *     server challenge. Used for hold-tier / seller-license checks. We display
 *     the pubkey + its CLV balance, and offer the link flow when absent.
 *
 * Plus WITHDRAW (2026-07-08, GameFeatures.md §5e): <WithdrawCard/> moves the
 * account's OWN deposited on-chain assets OUT of the custodial wallet
 * (POST /api/wallet/withdraw — DARK behind server-side
 * `WALLET_WITHDRAW_ENABLED`; while OFF the card shows live balances + an
 * honest "coming soon" note and NO form). Money-facing rules baked in: atomic
 * integer-string amounts (no float math), an explicit confirm step before the
 * POST, an Idempotency-Key bound to the exact frozen payload (retry can never
 * double-send), success shown ONLY on server `status:'sent'`, and
 * reconcile/ambiguous outcomes rendered as "contact support" — never success.
 *
 * CLV LAND-HOLD CONSENT (2026-07-09): a $CLAWVILLE withdrawal that would drop
 * the custodial wallet below its stacked land-hold requirement 409s with
 * `code:'hold_at_risk'` BEFORE any row exists. That is NOT an error state —
 * it renders an explicit consent panel (required vs post-withdrawal balance +
 * every at-risk parcel + the plain consequence: claim enters grace, parcel
 * releases if the hold isn't restored). "Withdraw anyway" is the ONLY path
 * that re-POSTs with `acknowledgeHoldLoss: true` (SAME Idempotency-Key — the
 * unacknowledged 409 created no row); Cancel never sends and clears the key.
 *
 * HARD INVARIANT: this component NEVER fetches or displays any secret key. The
 * custodial secret is disclosed exactly once at first-connect and never again;
 * the linked wallet's key never leaves the user's browser wallet.
 */

import { useCallback, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parcelDisplayName, parseParcelCode } from '@clawville/shared';
import { useAvatar } from '@/hooks/use-avatar';
import { useWalletLink } from '@/hooks/use-wallet-link';
import { useWalletBalances } from '@/hooks/use-wallet-balances';
import { useGameStore } from '@/stores/game';
import {
  api,
  ApiError,
  type WithdrawAsset,
  type WithdrawalReceipt,
  type WithdrawHoldAtRisk,
} from '@/lib/api';
import {
  truncateAddress,
  signWalletLinkMessage,
  hasSolanaWallet,
  WalletSignError,
} from '@/lib/solana-wallet';

export function WalletPanel({ variant = 'section' }: { variant?: 'section' | 'modal' }) {
  const { data: avatar } = useAvatar();
  const custodial = ((avatar as { walletAddress?: string | null } | null)?.walletAddress) ?? null;

  return (
    <div className={variant === 'modal' ? 'space-y-4' : 'space-y-3'}>
      <CustodialWalletCard address={custodial} />
      {custodial && <WithdrawCard custodialAddress={custodial} />}
      <LinkedWalletCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-game custodial wallet
// ---------------------------------------------------------------------------

function CustodialWalletCard({ address }: { address: string | null }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🪙</span>
        <h3 className="font-bold text-sm text-white">In-game wallet</h3>
      </div>
      <div className="bg-amber-500/10 border border-amber-400/25 rounded-lg p-3 space-y-2.5">
        <p className="text-xs text-white/70 leading-relaxed">
          Your ClawVille Solana address. Send SOL, USDC, or{' '}
          <span className="font-mono text-amber-200">$CLAWVILLE</span> here to fund in-game
          purchases — deposits land on this address automatically.
        </p>
        {address ? (
          <AddressField label="Deposit address" address={address} accent="amber" />
        ) : (
          <div className="text-xs text-amber-200/90 bg-amber-500/10 border border-amber-400/20 rounded-md px-3 py-2 leading-relaxed">
            Your in-game wallet is still being provisioned. If this persists,
            reconnect your agent to finish setup.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Withdraw — move deposited SOL/USDC/$CLAWVILLE OUT of the custodial wallet
// (GameFeatures.md §5e — DARK behind server-side WALLET_WITHDRAW_ENABLED).
// ---------------------------------------------------------------------------

/**
 * Display labels ONLY — the API contract value stays 'CLV' (the token-naming
 * sweep standardizes user-facing copy on "$CLAWVILLE", never the wire value).
 */
const ASSET_LABELS: Record<WithdrawAsset, string> = {
  SOL: 'SOL',
  USDC: 'USDC',
  CLV: '$CLAWVILLE',
};

/** Contract-pinned decimals (SOL 9dp lamports; USDC/CLV 6dp) — the SAME
 *  constants the server pins, used for ALL ui↔atomic conversion + display. */
const ASSET_DECIMALS: Record<WithdrawAsset, number> = {
  SOL: 9,
  USDC: 6,
  CLV: 6,
};

/**
 * Client-side "Max" headroom for SOL: the server refuses unless the source
 * keeps rent-exempt-minimum (~890,880 lamports) + the tx fee (5,000) behind
 * (`insufficient_sol_for_fee`), so Max leaves 0.001 SOL — a hair above that
 * reserve. Server remains the authority; this only makes Max not obviously
 * fail. Token (USDC/CLV) Max is the full token balance (fees are paid in SOL).
 */
const SOL_MAX_HEADROOM_LAMPORTS = 1_000_000n;

/** Base58 alphabet, 32-44 chars — the same pre-gate the route's Zod uses.
 *  The server re-validates for real (32 bytes, on-curve, non-self). */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * UI decimal string → atomic bigint with INTEGER math only (no parseFloat —
 * float drift on 9dp amounts is real money). Returns null when the input is
 * not a plain decimal or carries more precision than the asset supports.
 */
function uiAmountToAtomic(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const [wholeRaw = '', fracRaw = ''] = trimmed.split('.');
  if (fracRaw.length > decimals) return null;
  const whole = wholeRaw === '' ? 0n : BigInt(wholeRaw);
  const frac = fracRaw === '' ? 0n : BigInt(fracRaw.padEnd(decimals, '0'));
  return whole * 10n ** BigInt(decimals) + frac;
}

/** Atomic integer string → exact human decimal string (integer math only). */
function atomicToDisplay(atomic: string, decimals: number): string {
  const v = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString();
  const frac = v % base;
  if (frac === 0n) return whole;
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

/** Trim a server fixed-dp decimal string for display ("400.000000" → "400",
 *  "12.500000" → "12.5"). Pure string ops — the value never changes. */
function trimDecimalString(v: string): string {
  if (!v.includes('.')) return v;
  const trimmed = v.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

/** Fresh Idempotency-Key: uuid (36 chars, [0-9a-f-]) with a getRandomValues
 *  fallback — both match the server's ^[A-Za-z0-9_-]{8,64}$ gate. */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface MappedWithdrawError {
  message: string;
  /**
   * retry    — same attempt may be retried (SAME Idempotency-Key reused; the
   *            server replays the row's authoritative state, never re-sends).
   * edit     — the inputs are wrong; go back and change them.
   * terminal — this attempt is dead (nothing sent, or definitively failed);
   *            a new attempt needs a FRESH key (the old row is terminal).
   * support  — needs manual/operator review. NEVER shown as success, NEVER
   *            offered a retry.
   */
  kind: 'retry' | 'edit' | 'terminal' | 'support';
  txSignature?: string;
  withdrawalId?: string;
}

/** Map a withdraw refusal to honest human copy — branch on `err.code`
 *  (+ `err.detail`), NEVER the message string. */
function mapWithdrawError(err: unknown): MappedWithdrawError {
  if (!(err instanceof ApiError)) {
    // Network/parse failure AFTER the POST left the browser — the send may or
    // may not have reached the server. Honest: retry with the SAME key reads
    // back the truth without any double-send risk.
    return {
      kind: 'retry',
      message:
        "We couldn't reach the server, so this withdrawal's outcome is unknown. Retrying is safe — it checks the result, it never sends twice.",
    };
  }
  const extras = { txSignature: err.txSignature, withdrawalId: err.withdrawalId };
  switch (err.code) {
    case 'withdraw_disabled':
      return { kind: 'terminal', message: 'Withdrawals are currently disabled. Nothing was sent.' };
    case 'amount_invalid':
      return { kind: 'edit', message: "That amount isn't valid for this asset. Enter a positive amount." };
    case 'invalid_destination':
      return {
        kind: 'edit',
        message:
          err.detail === 'off_curve'
            ? 'That address is a program (PDA) address — withdrawals can only go to a regular wallet address.'
            : err.detail === 'not_base58'
              ? "That's not a valid Solana address — it contains characters a Solana address can't have."
              : "That's not a valid Solana address.",
      };
    case 'self_send':
      return { kind: 'edit', message: "That's this wallet's own address — enter a different destination." };
    case 'insufficient_balance':
      return { kind: 'edit', message: 'That amount is more than the available on-chain balance.' };
    case 'insufficient_sol_for_fee':
      return {
        kind: 'edit',
        message:
          'Not enough SOL is left to cover the Solana network fee — a small SOL reserve always stays in the wallet to pay it. Lower the amount or deposit a little SOL.',
      };
    case 'wallet_missing':
      return { kind: 'terminal', message: 'No custodial wallet exists for this account yet. Nothing was sent.' };
    case 'guest_not_allowed':
      return { kind: 'terminal', message: 'Guests use the demo economy — withdrawals need a full account.' };
    case 'agent_not_ledger_capable':
      return { kind: 'terminal', message: "This agent session can't settle real assets, so it can't withdraw." };
    case 'idempotency_key_required':
    case 'idempotency_key_invalid':
    case 'invalid_request':
    case 'invalid_json':
      return { kind: 'terminal', message: 'Something went wrong preparing the request. Nothing was sent — go back and start the withdrawal again.' };
    case 'idempotency_conflict':
      return { kind: 'terminal', message: 'This request clashed with an earlier withdrawal attempt. Go back and start a fresh withdrawal.', ...extras };
    case 'withdrawal_in_flight':
      return { kind: 'retry', message: 'This withdrawal is already being processed. Wait a moment, then try again to check its status.', ...extras };
    case 'withdrawal_failed':
      return { kind: 'terminal', message: 'That withdrawal attempt failed — nothing was sent. Go back to start a new one.', ...extras };
    case 'tx_failed':
      return { kind: 'terminal', message: 'The Solana transaction failed — no assets left your wallet. Go back to start a new withdrawal.', ...extras };
    case 'capture_lost':
      return { kind: 'retry', message: 'The attempt was interrupted before anything was sent. You can safely try again.', ...extras };
    case 'balance_unavailable':
      return { kind: 'retry', message: "We couldn't verify the on-chain balance right now — nothing was sent. Try again shortly.", ...extras };
    case 'transient_failure':
    case 'resume_transient':
    case 'released_for_retry':
      return { kind: 'retry', message: 'A temporary error interrupted the withdrawal — nothing was sent. Try again shortly.', ...extras };
    case 'withdrawal_reconcile':
      return { kind: 'support', message: 'This withdrawal needs manual review — please contact support. Do not retry it.', ...extras };
    case 'send_ambiguous':
      return { kind: 'support', message: "We couldn't confirm whether this transaction landed on-chain. It needs manual review — please contact support. Do not retry.", ...extras };
    case 'custody_failed':
      return { kind: 'support', message: "This wallet's custody record failed verification — nothing was sent. Please contact support.", ...extras };
    default:
      return err.status >= 500
        ? { kind: 'retry', message: 'The server hit an error and nothing was confirmed sent. Retrying is safe — it checks the result, it never sends twice.' }
        : { kind: 'terminal', message: err.message || 'The withdrawal was refused. Nothing was sent.' };
  }
}

function WithdrawCard({ custodialAddress }: { custodialAddress: string }) {
  const queryClient = useQueryClient();
  const addToast = useGameStore((s) => s.addToast);
  const balancesQuery = useWalletBalances();
  const data = balancesQuery.data;

  const [step, setStep] = useState<'form' | 'confirm' | 'hold_at_risk' | 'sent'>('form');
  const [asset, setAsset] = useState<WithdrawAsset>('SOL');
  const [amountInput, setAmountInput] = useState('');
  const [destination, setDestination] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  /** Payload frozen at Review time — the confirm step + POST use EXACTLY this. */
  const [attempt, setAttempt] = useState<{
    asset: WithdrawAsset;
    amountAtomic: string;
    destination: string;
  } | null>(null);
  const [submitError, setSubmitError] = useState<MappedWithdrawError | null>(null);
  const [receipt, setReceipt] = useState<{ view: WithdrawalReceipt; replay: boolean } | null>(null);
  /** The `hold_at_risk` 409 figures (null = payload missing — consent still
   *  required, rendered without exact numbers). Only meaningful on the
   *  'hold_at_risk' step. */
  const [holdAtRisk, setHoldAtRisk] = useState<WithdrawHoldAtRisk | null>(null);
  /**
   * True ONLY after the user explicitly clicked "Withdraw anyway" on the
   * consent panel. Consent is bound to the FROZEN attempt: every re-POST of
   * that same payload (e.g. "Try again" after a transient error) keeps
   * `acknowledgeHoldLoss: true`; re-freezing the attempt via Review, Cancel,
   * or starting over resets it — a changed withdrawal needs fresh consent.
   */
  const [holdAcknowledged, setHoldAcknowledged] = useState(false);
  /**
   * Idempotency-Key lifecycle: minted on the FIRST "Confirm & send" click and
   * BOUND to the exact payload fingerprint. Any retry of the same payload —
   * including Back → Review → Confirm with unchanged fields — reuses the key,
   * so an ambiguous outcome (network blip mid-POST) can never double-send.
   * Cleared on confirmed `status:'sent'` and on terminal refusals (the row is
   * dead under that key; a genuinely new attempt needs a fresh key).
   */
  const attemptKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const withdrawMutation = useMutation({
    mutationFn: ({
      payload,
      key,
    }: {
      payload: {
        asset: WithdrawAsset;
        amountAtomic: string;
        destination: string;
        acknowledgeHoldLoss?: boolean;
      };
      key: string;
    }) => api.withdraw(payload, key),
    onSuccess: (res) => {
      if (res.withdrawal.status === 'sent') {
        attemptKeyRef.current = null;
        setSubmitError(null);
        setHoldAtRisk(null);
        setReceipt({ view: res.withdrawal, replay: res.replay });
        setStep('sent');
        addToast('✅', 'Withdrawal sent', 3000);
        queryClient.invalidateQueries({ queryKey: ['wallet-balances'] });
      } else {
        // A 200 whose status isn't 'sent' is NOT success — never render it as one.
        setSubmitError({
          kind: 'support',
          message: `This withdrawal is in state "${res.withdrawal.status}" and needs manual review — please contact support.`,
          txSignature: res.withdrawal.txSignature ?? undefined,
          withdrawalId: res.withdrawal.id,
        });
        // The consent panel doesn't render submitError — surface it on the
        // confirm panel (which owns the typed-error affordances).
        setStep((s) => (s === 'hold_at_risk' ? 'confirm' : s));
      }
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'hold_at_risk') {
        // CLV LAND-HOLD CONSENT GATE — not an error state: NO row exists,
        // nothing was sent. Keep the payload-bound Idempotency-Key (the
        // consented retry MUST reuse it) and ask for explicit consent.
        setHoldAtRisk(err.holdAtRisk ?? null);
        setSubmitError(null);
        setStep('hold_at_risk');
        return;
      }
      const mapped = mapWithdrawError(err);
      if (mapped.kind === 'terminal') attemptKeyRef.current = null;
      setSubmitError(mapped);
      // An error on the consented re-POST renders via the confirm panel's
      // existing typed-error handling (retry keeps the given consent).
      setStep((s) => (s === 'hold_at_risk' ? 'confirm' : s));
      if (err instanceof ApiError && err.code === 'withdraw_disabled') {
        // The flag flipped off under us — refetch so the card falls back to
        // the honest "coming soon" state instead of a dead form.
        queryClient.invalidateQueries({ queryKey: ['wallet-balances'] });
      }
    },
  });

  const onReview = () => {
    if (!data) return;
    setFormError(null);
    const decimals = ASSET_DECIMALS[asset];
    const atomic = uiAmountToAtomic(amountInput, decimals);
    if (atomic === null || atomic <= 0n) {
      setFormError(`Enter a valid ${ASSET_LABELS[asset]} amount (up to ${decimals} decimal places).`);
      return;
    }
    const dest = destination.trim();
    if (!BASE58_RE.test(dest)) {
      setFormError("That doesn't look like a valid Solana address.");
      return;
    }
    if (dest === custodialAddress || dest === data.wallet) {
      setFormError("That's this wallet's own address — withdrawals must go to a different wallet.");
      return;
    }
    const bal = data.balances[asset];
    if (bal.available && bal.amountAtomic !== null && atomic > BigInt(bal.amountAtomic)) {
      setFormError(
        `That's more than the available ${ASSET_LABELS[asset]} balance (${atomicToDisplay(bal.amountAtomic, decimals)}).`,
      );
      return;
    }
    setAttempt({ asset, amountAtomic: atomic.toString(), destination: dest });
    setSubmitError(null);
    // Re-freezing the attempt (even with identical fields) resets land-hold
    // consent — consent never silently outlives the review step.
    setHoldAcknowledged(false);
    setHoldAtRisk(null);
    setStep('confirm');
  };

  /**
   * POST the frozen attempt. `ack` carries the land-hold consent: true ONLY
   * when the user explicitly chose "Withdraw anyway" for THIS attempt.
   * `acknowledgeHoldLoss` is NOT part of the key fingerprint — mirroring the
   * server, which excludes it from withdrawal identity: the unacknowledged
   * 409 created no row, so the consented retry with the SAME key proceeds.
   */
  const postWithdrawal = (ack: boolean) => {
    if (!attempt || withdrawMutation.isPending) return;
    const fingerprint = `${attempt.asset}|${attempt.amountAtomic}|${attempt.destination}`;
    let entry = attemptKeyRef.current;
    if (!entry || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, key: newIdempotencyKey() };
      attemptKeyRef.current = entry;
    }
    setSubmitError(null);
    withdrawMutation.mutate({
      payload: ack ? { ...attempt, acknowledgeHoldLoss: true } : attempt,
      key: entry.key,
    });
  };

  const onConfirmSend = () => postWithdrawal(holdAcknowledged);

  /** The ONLY path that sets `acknowledgeHoldLoss` — explicit consent. */
  const onWithdrawAnyway = () => {
    if (!attempt || withdrawMutation.isPending) return;
    setHoldAcknowledged(true);
    postWithdrawal(true);
  };

  /** Consent declined — never sends. Key cleared so a later attempt is fresh. */
  const onCancelHoldConsent = () => {
    attemptKeyRef.current = null;
    setHoldAtRisk(null);
    setHoldAcknowledged(false);
    setSubmitError(null);
    setAttempt(null);
    setStep('form');
  };

  const onMax = () => {
    if (!data) return;
    const bal = data.balances[asset];
    if (!bal.available || bal.amountAtomic === null) return;
    let max = BigInt(bal.amountAtomic);
    if (asset === 'SOL') {
      max -= SOL_MAX_HEADROOM_LAMPORTS;
      if (max < 0n) max = 0n;
    }
    setAmountInput(max === 0n ? '' : atomicToDisplay(max.toString(), ASSET_DECIMALS[asset]));
    setFormError(null);
  };

  const backToEdit = () => {
    setStep('form');
    setSubmitError(null);
  };

  const resetToForm = () => {
    setStep('form');
    setSubmitError(null);
    setReceipt(null);
    setAttempt(null);
    setAmountInput('');
    setHoldAtRisk(null);
    setHoldAcknowledged(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">📤</span>
        <h3 className="font-bold text-sm text-white">Withdraw</h3>
      </div>
      <div className="bg-emerald-500/10 border border-emerald-400/25 rounded-lg p-3 space-y-2.5">
        {balancesQuery.isPending ? (
          <p className="text-xs text-white/60">Loading on-chain balances…</p>
        ) : balancesQuery.isError || !data ? (
          balancesQuery.error instanceof ApiError && balancesQuery.error.code === 'wallet_missing' ? (
            <p className="text-xs text-white/70 leading-relaxed">
              No custodial wallet exists for this account yet, so there is nothing to withdraw.
            </p>
          ) : (
            <>
              <p className="text-xs text-white/70 leading-relaxed">
                Couldn&apos;t load your on-chain balances right now.
              </p>
              <button
                type="button"
                onClick={() => balancesQuery.refetch()}
                className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-bold text-xs transition-colors"
              >
                Retry
              </button>
            </>
          )
        ) : !data.withdrawEnabled ? (
          // DARK flag — honest "coming soon", live balances, NO form.
          <>
            <p className="text-xs text-white/70 leading-relaxed">
              <span className="font-bold text-emerald-200">Withdrawals are coming soon.</span>{' '}
              You&apos;ll be able to send your deposited SOL, USDC, and{' '}
              <span className="font-mono text-emerald-200">$CLAWVILLE</span> from this wallet to
              any Solana address you control. Your on-chain balances:
            </p>
            <div className="space-y-1 pt-1 border-t border-white/10">
              {(Object.keys(ASSET_LABELS) as WithdrawAsset[]).map((a) => {
                const bal = data.balances[a];
                return (
                  <div key={a} className="flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-[0.16em] font-mono text-white/40">
                      {ASSET_LABELS[a]}
                    </span>
                    <span className="text-xs font-bold text-emerald-200 font-mono">
                      {bal.available && bal.amountAtomic !== null
                        ? atomicToDisplay(bal.amountAtomic, ASSET_DECIMALS[a])
                        : 'unavailable'}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : step === 'sent' && receipt ? (
          <WithdrawSentPanel receipt={receipt} onDone={resetToForm} />
        ) : step === 'hold_at_risk' && attempt ? (
          <WithdrawHoldConsentPanel
            attempt={attempt}
            hold={holdAtRisk}
            pending={withdrawMutation.isPending}
            onWithdrawAnyway={onWithdrawAnyway}
            onCancel={onCancelHoldConsent}
          />
        ) : step === 'confirm' && attempt ? (
          <WithdrawConfirmPanel
            attempt={attempt}
            pending={withdrawMutation.isPending}
            submitError={submitError}
            holdAcknowledged={holdAcknowledged}
            onConfirm={onConfirmSend}
            onBack={backToEdit}
            onClose={resetToForm}
          />
        ) : (
          <WithdrawFormPanel
            balances={data.balances}
            asset={asset}
            setAsset={(a) => {
              setAsset(a);
              setFormError(null);
            }}
            amountInput={amountInput}
            setAmountInput={(v) => {
              setAmountInput(v);
              setFormError(null);
            }}
            destination={destination}
            setDestination={(v) => {
              setDestination(v);
              setFormError(null);
            }}
            formError={formError}
            onMax={onMax}
            onReview={onReview}
          />
        )}
      </div>
    </div>
  );
}

function WithdrawFormPanel({
  balances,
  asset,
  setAsset,
  amountInput,
  setAmountInput,
  destination,
  setDestination,
  formError,
  onMax,
  onReview,
}: {
  balances: Record<WithdrawAsset, { available: boolean; amountAtomic: string | null }>;
  asset: WithdrawAsset;
  setAsset: (a: WithdrawAsset) => void;
  amountInput: string;
  setAmountInput: (v: string) => void;
  destination: string;
  setDestination: (v: string) => void;
  formError: string | null;
  onMax: () => void;
  onReview: () => void;
}) {
  const selBal = balances[asset];
  const maxDisabled = !selBal.available || selBal.amountAtomic === null;
  return (
    <div className="space-y-2.5">
      <p className="text-xs text-white/70 leading-relaxed">
        Send SOL, USDC, or <span className="font-mono text-emerald-200">$CLAWVILLE</span> from
        your in-game wallet to a Solana wallet you control.
      </p>

      <div className="grid grid-cols-3 gap-1.5">
        {(Object.keys(ASSET_LABELS) as WithdrawAsset[]).map((a) => {
          const bal = balances[a];
          const selected = a === asset;
          return (
            <button
              key={a}
              type="button"
              onClick={() => setAsset(a)}
              aria-pressed={selected}
              className={`min-h-[44px] rounded-lg border px-1 py-1.5 text-center transition-colors ${
                selected
                  ? 'border-emerald-300/60 bg-emerald-500/20'
                  : 'border-white/15 bg-black/20 hover:bg-black/30'
              }`}
            >
              <span
                className={`block text-[11px] font-bold ${selected ? 'text-emerald-100' : 'text-white/80'}`}
              >
                {ASSET_LABELS[a]}
              </span>
              <span className="block text-[10px] font-mono text-white/50 truncate">
                {bal.available && bal.amountAtomic !== null
                  ? atomicToDisplay(bal.amountAtomic, ASSET_DECIMALS[a])
                  : '—'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="withdraw-amount"
          className="block text-white/50 text-[10px] font-mono uppercase tracking-wider"
        >
          Amount ({ASSET_LABELS[asset]})
        </label>
        <div className="flex gap-1">
          <input
            id="withdraw-amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder="0.00"
            className="flex-1 min-w-0 min-h-[44px] bg-black/30 border border-white/15 rounded-lg px-3 py-2 text-sm font-mono text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-300/60"
          />
          <button
            type="button"
            onClick={onMax}
            disabled={maxDisabled}
            className="min-h-[44px] px-4 py-2 rounded-lg text-xs font-bold shrink-0 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Max
          </button>
        </div>
        <p className="text-[10px] text-white/40 leading-relaxed">
          {asset === 'SOL'
            ? 'A small SOL reserve stays behind for network fees + rent — Max accounts for it.'
            : 'The Solana network fee is paid in SOL from this wallet — keep a little SOL deposited.'}
        </p>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="withdraw-destination"
          className="block text-white/50 text-[10px] font-mono uppercase tracking-wider"
        >
          Destination address
        </label>
        <input
          id="withdraw-destination"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="Solana wallet address"
          className="w-full min-h-[44px] bg-black/30 border border-white/15 rounded-lg px-3 py-2 text-xs font-mono text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-300/60"
        />
      </div>

      {formError && (
        <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-relaxed">
          {formError}
        </p>
      )}

      <button
        type="button"
        onClick={onReview}
        disabled={!amountInput.trim() || !destination.trim()}
        className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Review withdrawal
      </button>
    </div>
  );
}

function WithdrawConfirmPanel({
  attempt,
  pending,
  submitError,
  holdAcknowledged,
  onConfirm,
  onBack,
  onClose,
}: {
  attempt: { asset: WithdrawAsset; amountAtomic: string; destination: string };
  pending: boolean;
  submitError: MappedWithdrawError | null;
  /** True = the user already consented to breaking the land hold for THIS
   *  attempt (a retry from here re-sends `acknowledgeHoldLoss: true`) — keep
   *  that consequence visible, never silent. */
  holdAcknowledged: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const amountDisplay = atomicToDisplay(attempt.amountAtomic, ASSET_DECIMALS[attempt.asset]);
  const kind = submitError?.kind ?? null;
  const canConfirm = kind === null || kind === 'retry';
  return (
    <div className="space-y-2.5" aria-busy={pending}>
      <p className="text-sm font-bold text-white">Confirm withdrawal</p>
      <div className="bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">Send</span>
          <span className="text-sm font-bold text-emerald-200 font-mono">
            {amountDisplay} {ASSET_LABELS[attempt.asset]}
          </span>
        </div>
        <div className="space-y-0.5">
          <span className="block text-[10px] uppercase tracking-wider font-mono text-white/50">To</span>
          <span className="block text-xs font-mono text-white break-all select-all">
            {attempt.destination}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">Network</span>
          <span className="text-xs text-white/80">Solana mainnet</span>
        </div>
      </div>
      <p className="text-[11px] text-amber-200/90 leading-relaxed">
        On-chain withdrawals cannot be reversed. Double-check the address — assets sent to a
        wrong address are unrecoverable.
      </p>

      {holdAcknowledged && (
        <p className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-400/20 rounded-md px-3 py-2 leading-relaxed">
          Land-hold warning acknowledged: this withdrawal drops your{' '}
          <span className="font-mono">$CLAWVILLE</span> below your land-hold requirement — your
          claim enters grace and the parcel releases if the hold isn&apos;t restored.
        </p>
      )}

      {submitError && (
        <div
          className={`text-xs rounded-lg px-3 py-2 leading-relaxed space-y-1 border ${
            submitError.kind === 'support'
              ? 'text-amber-200 bg-amber-500/10 border-amber-400/25'
              : 'text-red-300 bg-red-500/10 border-red-500/20'
          }`}
        >
          <p>{submitError.message}</p>
          {submitError.txSignature && (
            <p className="font-mono text-[11px] break-all">
              tx:{' '}
              <a
                href={`https://solscan.io/tx/${submitError.txSignature}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {submitError.txSignature}
              </a>
            </p>
          )}
          {submitError.withdrawalId && (
            <p className="font-mono text-[11px] break-all">ref: {submitError.withdrawalId}</p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {kind === 'support' ? (
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white font-bold text-xs transition-colors"
          >
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onBack}
              disabled={pending}
              className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white font-bold text-xs transition-colors disabled:opacity-50"
            >
              {kind === 'edit' ? 'Back to edit' : 'Back'}
            </button>
            {canConfirm && (
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending}
                className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-progress"
              >
                {pending ? 'Sending…' : kind === 'retry' ? 'Try again' : 'Confirm & send'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * CLV land-hold informed-consent panel — rendered when the confirm-step POST
 * 409s with `code:'hold_at_risk'`. NOT an error and NOT a success: no row
 * exists, nothing was sent, and nothing proceeds without an explicit click.
 * States the consequence plainly (claim enters grace; parcel releases if the
 * hold isn't restored), lists every at-risk parcel, and offers exactly two
 * actions: "Withdraw anyway" (the ONLY path that sets `acknowledgeHoldLoss`,
 * re-POSTing with the SAME Idempotency-Key) and Cancel (never sends).
 */
function WithdrawHoldConsentPanel({
  attempt,
  hold,
  pending,
  onWithdrawAnyway,
  onCancel,
}: {
  attempt: { asset: WithdrawAsset; amountAtomic: string; destination: string };
  /** null = the 409 payload was missing/malformed — consent is still required,
   *  we just can't show exact figures. */
  hold: WithdrawHoldAtRisk | null;
  pending: boolean;
  onWithdrawAnyway: () => void;
  onCancel: () => void;
}) {
  const amountDisplay = atomicToDisplay(attempt.amountAtomic, ASSET_DECIMALS[attempt.asset]);
  const many = (hold?.parcels.length ?? 0) > 1;
  return (
    <div className="space-y-2.5" aria-busy={pending}>
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">⚠️</span>
        <p className="text-sm font-bold text-white">This withdrawal breaks your land hold</p>
      </div>

      <p className="text-xs text-white/80 leading-relaxed">
        Withdrawing{' '}
        <span className="font-mono font-bold text-amber-200">{amountDisplay} $CLAWVILLE</span>{' '}
        leaves this wallet below the{' '}
        <span className="font-mono">$CLAWVILLE</span> hold backing your land{' '}
        {many ? 'claims' : 'claim'}. Nothing has been sent yet.
      </p>

      {hold ? (
        <div className="bg-black/30 border border-amber-400/25 rounded-lg px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">
              Hold requires
            </span>
            <span className="text-xs font-bold text-amber-200 font-mono">
              {hold.requiredUiAmount.toLocaleString()} $CLAWVILLE
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">
              You&apos;d have
            </span>
            <span className="text-xs font-bold text-red-300 font-mono">
              {trimDecimalString(hold.postUiAmount)} $CLAWVILLE
            </span>
          </div>
          {hold.parcels.length > 0 && (
            <div className="pt-1.5 border-t border-white/10 space-y-1">
              <span className="block text-[10px] uppercase tracking-wider font-mono text-white/50">
                At-risk parcel{many ? 's' : ''}
              </span>
              {hold.parcels.map((p) => {
                const tier = parseParcelCode(p.parcelCode)?.tier;
                const displayName = tier
                  ? parcelDisplayName(p.parcelCode, tier)
                  : p.parcelCode;
                return (
                <div key={p.parcelCode} className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white">{displayName}</span>
                  <span className="text-[11px] font-mono text-white/60 shrink-0">
                    holds {p.holdThresholdCt.toLocaleString()} $CLAWVILLE
                  </span>
                </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-white/80 bg-black/30 border border-amber-400/25 rounded-lg px-3 py-2 leading-relaxed">
          We couldn&apos;t load the exact figures, but this withdrawal would leave less{' '}
          <span className="font-mono">$CLAWVILLE</span> than your land hold requires.
        </p>
      )}

      <p className="text-[11px] text-amber-200/90 leading-relaxed">
        If you withdraw anyway, your claim enters a grace period — and the{' '}
        {many ? 'parcels are' : 'parcel is'} released if the hold isn&apos;t restored before it
        ends.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-white font-bold text-xs transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onWithdrawAnyway}
          disabled={pending}
          className="flex-1 min-h-[44px] px-3 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 font-bold text-xs transition-colors disabled:opacity-50 disabled:cursor-progress"
        >
          {pending ? 'Sending…' : 'Withdraw anyway'}
        </button>
      </div>
    </div>
  );
}

function WithdrawSentPanel({
  receipt,
  onDone,
}: {
  receipt: { view: WithdrawalReceipt; replay: boolean };
  onDone: () => void;
}) {
  const { view, replay } = receipt;
  const amountDisplay = atomicToDisplay(view.amountAtomic, ASSET_DECIMALS[view.asset]);
  const explorerHref =
    view.explorerUrl ?? (view.txSignature ? `https://solscan.io/tx/${view.txSignature}` : null);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block w-2 h-2 rounded-full bg-emerald-300 shadow-[0_0_6px_rgba(52,211,153,0.6)]"
        />
        <p className="text-sm font-bold text-white">Withdrawal sent</p>
      </div>
      {replay && (
        <p className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-400/20 rounded-md px-3 py-2 leading-relaxed">
          This matches an earlier completed withdrawal — the retry returned its result. Nothing
          was sent twice.
        </p>
      )}
      <div className="bg-black/30 border border-white/15 rounded-lg px-3 py-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">Sent</span>
          <span className="text-sm font-bold text-emerald-200 font-mono">
            {amountDisplay} {ASSET_LABELS[view.asset]}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">To</span>
          <span className="text-xs font-mono text-white" title={view.destination}>
            {truncateAddress(view.destination, 6, 6)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wider font-mono text-white/50">
            Transaction
          </span>
          {view.txSignature && explorerHref ? (
            <a
              href={explorerHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-emerald-200 underline underline-offset-2 hover:text-emerald-100"
              title={view.txSignature}
            >
              {truncateAddress(view.txSignature, 8, 8)} ↗
            </a>
          ) : (
            <span className="text-xs text-white/60">confirmed on-chain</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-bold text-xs transition-colors"
      >
        Done
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Linked self-custody wallet
// ---------------------------------------------------------------------------

function LinkedWalletCard() {
  const queryClient = useQueryClient();
  const addToast = useGameStore((s) => s.addToast);
  const [error, setError] = useState<string | null>(null);

  const linkQuery = useWalletLink();

  const linkMutation = useMutation({
    mutationFn: async () => {
      // 1) server challenge → exact SIWS-lite message. 2) browser wallet signs.
      // 3) POST pubkey + nonce + signature. Public-key + signature only.
      const challenge = await api.walletLinkChallenge();
      const { walletPubkey, signatureBase58 } = await signWalletLinkMessage(
        challenge.messageToSign,
      );
      return api.linkWallet({
        walletPubkey,
        nonce: challenge.nonce,
        signature: signatureBase58,
      });
    },
    onSuccess: (res) => {
      setError(null);
      queryClient.setQueryData(['wallet-link'], {
        linked: true,
        walletPubkey: res.walletPubkey,
        clv: res.clv,
      });
      queryClient.invalidateQueries({ queryKey: ['wallet-link'] });
      addToast('🔗', 'Wallet linked', 3000);
    },
    onError: (err) => {
      if (err instanceof WalletSignError) {
        setError(err.message);
      } else {
        // ApiError carries a code/status; message is safe to show.
        setError(err instanceof Error && err.message ? err.message : 'Could not link wallet.');
      }
    },
  });

  const linked = linkQuery.linked;
  const clv = linkQuery.clv;

  const onLink = () => {
    setError(null);
    if (!hasSolanaWallet()) {
      setError(
        'No Solana wallet detected. Install Phantom, Solflare, or Backpack, then try again.',
      );
      return;
    }
    linkMutation.mutate();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🔗</span>
        <h3 className="font-bold text-sm text-white">Your linked wallet</h3>
      </div>

      {linked ? (
        <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block w-2 h-2 rounded-full bg-teal-300 shadow-[0_0_6px_rgba(45,212,191,0.6)]"
            />
            <p className="text-sm font-bold text-white">Self-custody wallet linked</p>
          </div>
          <AddressField
            label="Linked wallet"
            address={linkQuery.walletPubkey!}
            accent="cyan"
          />
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/10">
            <span className="text-[11px] uppercase tracking-[0.16em] font-mono text-white/40">
              $CLAWVILLE balance
            </span>
            <span className="text-sm font-bold text-cyan-200 font-mono">
              {clv?.available && clv.uiAmount !== null
                ? `${clv.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} $CLAWVILLE`
                : 'unavailable'}
            </span>
          </div>
          <p className="text-[10px] text-white/40 leading-relaxed">
            Used for hold-tier perks and land hold-to-keep checks. Your $CLAWVILLE never
            leaves this wallet — ClawVille only reads the balance.
          </p>
        </div>
      ) : (
        <div className="bg-cyan-500/10 border border-cyan-400/25 rounded-lg p-3 space-y-2.5">
          <p className="text-xs text-white/70 leading-relaxed">
            Link a self-custody wallet (Phantom, Solflare, Backpack) to prove your{' '}
            <span className="font-mono text-cyan-200">$CLAWVILLE</span> holdings for hold-tier
            perks and land benefits. You sign a message — no funds move, no key
            leaves your wallet.
          </p>
          <button
            type="button"
            onClick={onLink}
            disabled={linkMutation.isPending}
            className="w-full min-h-[44px] px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-sky-500 hover:from-cyan-400 hover:to-sky-400 text-white font-bold text-xs transition-all disabled:opacity-50 disabled:cursor-progress"
          >
            {linkMutation.isPending ? 'Waiting for wallet…' : 'Link wallet'}
          </button>
          {error && (
            <p className="text-red-300 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-relaxed">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddressField — truncated pill (click to reveal full) + copy button.
// ---------------------------------------------------------------------------

function AddressField({
  label,
  address,
  accent,
}: {
  label: string;
  address: string;
  accent: 'amber' | 'cyan';
}) {
  const addToast = useGameStore((s) => s.addToast);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const tone =
    accent === 'amber'
      ? { pill: 'border-amber-400/30 text-amber-100', btn: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-100' }
      : { pill: 'border-cyan-400/30 text-cyan-100', btn: 'bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-100' };

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      addToast('📋', 'Address copied', 2000);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (iOS sandbox / permissions) — reveal so the user can
      // select-and-copy manually.
      setRevealed(true);
    }
  }, [address, addToast]);

  return (
    <div className="space-y-1">
      <span className="block text-white/50 text-[10px] font-mono uppercase tracking-wider">
        {label}
      </span>
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          title={revealed ? 'Hide full address' : 'Show full address'}
          className={`flex-1 min-w-0 min-h-[44px] text-left bg-black/30 border rounded-lg px-3 py-2 text-sm font-mono break-all select-all ${tone.pill}`}
        >
          {revealed ? address : truncateAddress(address, 6, 6)}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className={`min-h-[44px] px-4 py-2 rounded-lg text-xs font-bold shrink-0 transition-colors ${tone.btn}`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
