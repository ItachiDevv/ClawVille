'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LAND_TIERS,
  MAX_PARCELS_PER_AVATAR,
  holdThresholdForTier,
  parcelDisplayName,
  tierLabel,
  type LandTier,
} from '@clawville/shared';
import { RpgButton } from '@/components/rpg';
import { useWalletLink } from '@/hooks/use-wallet-link';
import { api, ApiError } from '@/lib/api';
import { useGameStore } from '@/stores/game';
import { hasSolanaWallet, signWalletLinkMessage, WalletSignError } from '@/lib/solana-wallet';
import type {
  LandHoldTransferChallenge,
  LandHoldTransferChallengeState,
  LandHoldTransferRefundState,
  LandHoldTransferRejectedReason,
  LandHoldWalletStatus,
  LandHoldWalletVerification,
  LandHoldWalletVerificationMethod,
  LandParcelDTO,
} from './types';

const HOLD_WALLET_KEY = ['land-hold-wallet'] as const;

const TIER_ACCENT: Record<LandTier, string> = {
  founder: '#f5c842',
  a: '#7ecef4',
  b: '#9fc975',
  c: '#c49a6c',
  starter: '#cbd5e1',
};

function codeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code ?? error.message : undefined;
}

function formatClv(amount: number): string {
  return amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-6)}`;
}

function tenureError(error: unknown): string {
  switch (codeOf(error)) {
    case 'wallet_not_declared': return 'Declare the wallet that will back this CLV hold first.';
    case 'wallet_locked_by_hold': return 'This wallet cannot change while an active hold parcel depends on it.';
    case 'wallet_change_requires_human': return 'An agent may declare the first wallet, but only a human session may change it.';
    case 'wallet_already_declared': return 'That wallet is already declared by another account.';
    case 'insufficient_clv_hold': return 'The declared wallet does not hold enough CLV for the stacked requirement.';
    case 'clv_balance_unavailable': return 'The live CLV balance could not be verified. Try again shortly.';
    case 'insufficient_clawtokens': return 'You do not have enough vCLAW for this action.';
    case 'parcel_not_available': return 'Someone else just claimed this parcel.';
    case 'parcel_cap_reached': return `You already hold the maximum of ${MAX_PARCELS_PER_AVATAR} parcels.`;
    case 'founder_no_rent_door': return 'Founder parcels are hold-only and allocated through the auction.';
    case 'tier_not_claimable': return 'That tenure door is not available for this tier.';
    case 'not_parcel_owner': return 'This parcel is no longer owned by your active avatar.';
    case 'not_deposit_tenure': return 'Only rent-door parcels can receive prepaid rent.';
    case 'deed_locked_by_listing': return 'Remove the live deed listing before releasing this parcel.';
    case 'idempotency_key_conflict': return 'This action key belongs to an earlier parcel state. Reopen the Land Office and try again.';
    case 'autonomous_daily_cap': return 'This agent reached its autonomous daily land-spend limit.';
    // ── Hold-wallet ownership proof ─────────────────────────────────────────
    case 'wallet_not_verified': return 'Prove that this wallet is yours before you claim a hold parcel. It takes about a minute.';
    case 'invalid_challenge': return 'That verification request is no longer valid. Start it again.';
    case 'invalid_signature': return 'The signature could not be read. Sign it again.';
    case 'signature_verification_failed': return 'That signature did not come from the declared wallet. Switch to the declared wallet in your browser wallet and try again.';
    case 'not_custodial_wallet': return 'This is not the ClawVille wallet for your own agent, so it cannot be verified automatically. Use one of the two options instead.';
    case 'transfer_door_unavailable': return 'The send-a-small-amount option is offline right now. Use connect and sign, or check back shortly.';
    case 'verify_attempt_cap': return 'You started too many transfer checks today. Try again tomorrow, or use connect and sign.';
    case 'challenge_expired': return 'That check closed before a matching transfer arrived. Start a new one.';
    case 'challenge_not_found': return 'That check could not be found. Start a new one.';
    case 'transaction_not_finalized': return 'Solana has not finished with that transfer yet, or that transaction ID does not exist. Wait a few seconds and try again.';
    case 'transaction_failed': return 'That transaction did not go through on Solana, so nothing was sent. Send it again and paste the new ID.';
    case 'transfer_not_found': return 'That transaction does not contain the exact amount going to the address we gave you. Check that you sent the exact amount from the declared wallet, then paste the right transaction ID.';
    case 'signature_already_used': return 'That transaction has already been used for a check. Send a new transfer for this one.';
    case 'challenge_already_settled': return 'This check already has a transfer recorded against it. Start a new one if you need to try again.';
    case 'transaction_lookup_failed': return 'We could not reach Solana to look that up. Try again in a moment.';
    case 'invalid_challenge_id': return 'That check could not be found. Start a new one.';
    case 'invalid_wallet_pubkey': return 'That does not look like a Solana wallet address. Check it and declare it again.';
    case 'identity_binding_changed': return 'Your session changed while that was in flight. Reopen the Land Office and try again.';
    case 'rate_limited': return 'That was a lot of tries in a short time. Wait a moment and try again.';
    default: return 'The Land Office could not complete that action. Try again.';
  }
}

function TierBadge({ tier }: { tier: LandTier }) {
  const accent = TIER_ACCENT[tier];
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
      style={{ color: accent, borderColor: `${accent}55`, background: `${accent}18` }}
    >
      {tierLabel(tier)}
    </span>
  );
}

function WeeksSelect({ value, onChange, label }: { value: number; onChange: (weeks: number) => void; label: string }) {
  return (
    <label className="flex min-h-[44px] items-center gap-2 text-[11px] text-slate-200">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-h-[44px] rounded-lg border border-cyan-300/30 bg-slate-950 px-3 font-mono text-cyan-100"
      >
        {Array.from({ length: 26 }, (_, index) => index + 1).map((weeks) => (
          <option key={weeks} value={weeks}>{weeks}</option>
        ))}
      </select>
    </label>
  );
}

// ── Hold-wallet ownership proof ─────────────────────────────────────────────
// Declaring a wallet used to be enough to claim hold-door land, which meant a
// claim could be backed by someone else's balance. Proof is now required, with
// TWO doors so a user who will not connect a browser wallet is never locked
// out, plus a one-click attest for the ClawVille wallet we already hold.

const VERIFY_TRANSFER_STORAGE_KEY = 'clawville:land-hold-verify-transfer';

const VERIFY_METHOD_LABEL: Record<LandHoldWalletVerificationMethod, string> = {
  signature: 'signed from your wallet',
  transfer: 'confirmed by a small transfer',
  custodial: 'confirmed automatically, because ClawVille holds this wallet',
};

const TRANSFER_STATE_COPY: Record<LandHoldTransferChallengeState, string> = {
  pending: 'Send the amount with the note, then paste the transaction ID below.',
  observed: 'Your transfer checked out. Finishing up.',
  verified: 'Verified. This wallet is proven.',
  expired: 'This check closed before a matching transfer arrived. Start a new one.',
  failed: 'This check could not be completed. Start a new one, or use connect and sign.',
  rejected: 'Your transfer arrived, but it could not be used as proof. It is on its way back to you.',
  unclaimed:
    'We found your transfer, but it was never submitted here, so it could not be used to verify. It is on its way back to you. Start a new check and paste the transaction ID next time.',
};

/**
 * A transfer can arrive, match to the lamport, and still not prove anything.
 * Saying which of the two happened is the difference between a one-minute retry
 * and a user staring at a screen until the check lapses.
 */
const TRANSFER_REJECTED_COPY: Record<LandHoldTransferRejectedReason, string> = {
  memo_missing:
    'The transfer did not carry the note we asked for in the part you signed, so we cannot tell that you meant it for this account. Start a new check and put the note in the memo field of the transfer itself, exactly as shown, along with the exact amount.',
  source_not_signer:
    'That transfer was signed by a smart contract wallet, such as a Squads vault, rather than by the wallet key itself. We cannot verify that kind of wallet yet, with either option. Declare a wallet whose key you hold and verify that one instead.',
  transfer_not_top_level:
    'The payment was made by a program on your behalf rather than by the transfer you signed, so it cannot prove the wallet is yours. Send the exact amount and the note directly from your wallet, as one plain transfer.',
};

/**
 * The refund line describes the REFUND only. It must never assert a verification
 * outcome, because `reconcile` and `skipped` also accompany rejected, expired
 * and unclaimed rows, where telling someone "your verification is complete"
 * would be flatly untrue. When the wallet really is verified we say so
 * separately, from the verification state rather than the refund state.
 */
function transferRefundCopy(
  refundState: LandHoldTransferRefundState,
  verified: boolean,
): string {
  const reassurance = verified ? ' Your wallet stays verified either way.' : '';
  switch (refundState) {
    case 'none':
      return 'Refund: it goes back on its own once your transfer is final.';
    case 'sending':
      return 'Refund: on its way back to you now.';
    case 'sent':
      return 'Refund: sent back to your wallet.';
    case 'reconcile':
      return `Refund: held for a manual check by our team.${reassurance}`;
    // NOT "no refund needed": the service uses `skipped` when the address that
    // received the money is one we can no longer sign for, so a person has to
    // send it back by hand. Saying "not needed" would hide money we owe.
    case 'skipped':
      return `Refund: our team has to send this one back by hand, and it is recorded so it is not forgotten.${reassurance}`;
    default:
      return 'Refund: we are working out where this one stands.';
  }
}

/** Branch on the typed WalletSignError code, never on the message text. */
function walletSignErrorMessage(error: unknown): string {
  if (!(error instanceof WalletSignError)) return tenureError(error);
  switch (error.code) {
    case 'no_wallet':
      return 'No browser wallet was found. Install Phantom, Solflare, or Backpack, or use the other option.';
    case 'user_rejected':
      return 'You cancelled the request in your wallet. Nothing was sent and nothing changed.';
    case 'no_pubkey':
      return 'Your wallet did not return an address. Unlock it and try again.';
    default:
      return 'Your wallet could not finish signing. Try again, or use the other option.';
  }
}

/** EXACT SOL text from integer lamports — attribution is by exact amount, so no float drift. */
function lamportsToSolText(lamports: number): string {
  const abs = Math.abs(Math.trunc(lamports));
  const whole = Math.floor(abs / 1_000_000_000);
  const frac = String(abs % 1_000_000_000).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

// An open transfer check survives closing the Land Office: the user may already
// have sent the amount, and losing the destination would leave them staring at
// a payment they cannot track. sessionStorage only — nothing sensitive here.
function readStoredTransferChallenge(wallet: string): LandHoldTransferChallenge | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(VERIFY_TRANSFER_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<LandHoldTransferChallenge & { wallet: string }>;
    const lamports = Number(stored.lamports);
    if (stored.wallet !== wallet || !stored.challengeId || !stored.destination) return null;
    if (!Number.isSafeInteger(lamports) || lamports <= 0) return null;
    if (!stored.expiresAt || new Date(stored.expiresAt).getTime() <= Date.now()) return null;
    return {
      challengeId: stored.challengeId,
      destination: stored.destination,
      lamports,
      amountSol: Number(stored.amountSol ?? lamports / 1_000_000_000),
      // Older stored blobs predate the note; fall back to the check id, which
      // is what the server asks for.
      memo: stored.memo ?? stored.challengeId,
      expiresAt: stored.expiresAt,
    };
  } catch {
    return null;
  }
}

function writeStoredTransferChallenge(wallet: string, challenge: LandHoldTransferChallenge): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(VERIFY_TRANSFER_STORAGE_KEY, JSON.stringify({ ...challenge, wallet }));
  } catch {
    // Private mode / quota — the check just does not survive a reload.
  }
}

function clearStoredTransferChallenge(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(VERIFY_TRANSFER_STORAGE_KEY);
  } catch {
    // Nothing to recover from; the value expires server-side regardless.
  }
}

function VerifyCopyRow({ label, value, display }: { label: string; value: string; display: string }) {
  const addToast = useGameStore((state) => state.addToast);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      addToast('📋', `${label} copied.`, 2000);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      addToast('⚠️', 'Copying is blocked in this browser. Select the value and copy it by hand.', 5000);
    }
  };
  return (
    <div className="mt-2">
      <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-slate-300">{label}</span>
      <div className="mt-1 flex flex-col gap-1 sm:flex-row">
        <span className="flex min-h-[44px] min-w-0 flex-1 select-all items-center break-all rounded-lg border border-cyan-300/25 bg-slate-950 px-3 py-2 font-mono text-[11px] text-cyan-50">
          {display}
        </span>
        <RpgButton size="sm" variant="secondary" className="min-h-[44px] shrink-0" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </RpgButton>
      </div>
    </div>
  );
}

function HoldWalletVerification({
  walletAddress,
  verification,
}: {
  walletAddress: string;
  verification: LandHoldWalletVerification;
}) {
  const queryClient = useQueryClient();
  const addToast = useGameStore((state) => state.addToast);
  const [walletAvailable, setWalletAvailable] = useState(false);
  const [signing, setSigning] = useState(false);
  const [attesting, setAttesting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txSignature, setTxSignature] = useState('');
  const [challenge, setChallenge] = useState<LandHoldTransferChallenge | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Provider detection reads `window`, so run it after mount to keep the first
  // client render identical to the server render.
  useEffect(() => {
    setWalletAvailable(hasSolanaWallet());
  }, []);

  useEffect(() => {
    setChallenge(readStoredTransferChallenge(walletAddress));
  }, [walletAddress]);

  useEffect(() => {
    if (!challenge) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [challenge]);

  const poll = useQuery({
    queryKey: ['land-hold-verify-transfer', challenge?.challengeId ?? 'none'],
    queryFn: () => api.getLandHoldTransferChallenge(challenge!.challengeId),
    // Deliberately still enabled after verification: the refund runs AFTER the
    // wallet is proven, so switching this off the moment we verify hid a later
    // `sending` or `reconcile` from the person owed the money.
    enabled: challenge != null,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      const state = data?.state;
      const settled =
        state === 'verified' ||
        state === 'expired' ||
        state === 'failed' ||
        state === 'rejected' ||
        state === 'unclaimed';
      // Keep polling a settled row while its refund is still in flight.
      const refundPending = data?.refundState === 'none' || data?.refundState === 'sending';
      return settled && !refundPending ? false : 6_000;
    },
  });

  const pollState = poll.data?.state ?? null;
  const refundState = poll.data?.refundState ?? null;
  const rejectedReason = poll.data?.rejectedReason ?? null;

  useEffect(() => {
    if (pollState !== 'verified') return;
    void queryClient.invalidateQueries({ queryKey: HOLD_WALLET_KEY });
    addToast('✅', 'Hold wallet verified. Your transfer is on its way back to you.', 6000);
  }, [pollState, queryClient, addToast]);

  // The check is only cleared once the money is actually home, so the refund
  // panel cannot vanish while a refund is still moving or held for review.
  useEffect(() => {
    if (pollState !== 'verified') return;
    if (refundState !== 'sent') return;
    clearStoredTransferChallenge();
  }, [pollState, refundState]);

  const busy = signing || attesting || opening || submitting;
  const msLeft = challenge ? new Date(challenge.expiresAt).getTime() - now : 0;
  const closed = challenge != null && msLeft <= 0;
  const terminal =
    pollState === 'expired' ||
    pollState === 'failed' ||
    pollState === 'rejected' ||
    pollState === 'unclaimed';

  const finishVerified = async () => {
    clearStoredTransferChallenge();
    setChallenge(null);
    setNotice(null);
    await queryClient.invalidateQueries({ queryKey: HOLD_WALLET_KEY });
    addToast('✅', 'Hold wallet verified.', 5000);
  };

  const signAndVerify = async () => {
    setNotice(null);
    setSigning(true);
    try {
      const request = await api.landHoldWalletVerifyChallenge();
      const proof = await signWalletLinkMessage(request.messageToSign);
      if (proof.walletPubkey !== walletAddress) {
        // The server rejects this too; saying it here saves a round trip and
        // names the actual mismatch instead of a generic refusal.
        setNotice(
          `Your wallet signed as ${shortWallet(proof.walletPubkey)}, but you declared ${shortWallet(walletAddress)}. Switch accounts in your wallet, or declare the wallet you just signed with.`,
        );
        return;
      }
      await api.verifyLandHoldWalletSignature({
        nonce: request.nonce,
        signature: proof.signatureBase58,
      });
      await finishVerified();
    } catch (error) {
      setNotice(walletSignErrorMessage(error));
    } finally {
      setSigning(false);
    }
  };

  const attestCustodial = async () => {
    setNotice(null);
    setAttesting(true);
    try {
      await api.verifyLandHoldWalletCustodial();
      await finishVerified();
    } catch (error) {
      setNotice(tenureError(error));
    } finally {
      setAttesting(false);
    }
  };

  const openTransfer = async () => {
    setNotice(null);
    setOpening(true);
    try {
      const opened = await api.openLandHoldTransferChallenge();
      writeStoredTransferChallenge(walletAddress, opened);
      setChallenge(opened);
      setTxSignature('');
      setNow(Date.now());
    } catch (error) {
      setNotice(tenureError(error));
    } finally {
      setOpening(false);
    }
  };

  /**
   * THE verification step for this option. We look up the exact transaction the
   * person hands us instead of hunting for it among everything else arriving at
   * our address, which is both faster for them and impossible to lose.
   */
  const submitSignature = async () => {
    if (!challenge) return;
    const signature = txSignature.trim();
    if (signature.length < 64) {
      setNotice('That does not look like a transaction ID yet. Copy the whole thing from your wallet.');
      return;
    }
    setNotice(null);
    setSubmitting(true);
    try {
      const status = await api.submitLandHoldTransferSignature(challenge.challengeId, signature);
      await poll.refetch();
      if (status.state === 'verified') {
        await queryClient.invalidateQueries({ queryKey: HOLD_WALLET_KEY });
        addToast('✅', 'Hold wallet verified. Your transfer is on its way back to you.', 6000);
      }
    } catch (error) {
      setNotice(tenureError(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (verification.state === 'verified') {
    const method = verification.method;
    return (
      <div className="mt-3 rounded-lg border border-emerald-300/25 bg-emerald-400/[0.08] p-3">
        <p className="font-semibold text-emerald-100">Wallet verified</p>
        <p className="mt-1 text-[11px] text-slate-200">
          You proved control of {shortWallet(walletAddress)}
          {method ? `, ${VERIFY_METHOD_LABEL[method]}` : ''}
          {verification.verifiedAt ? ` on ${new Date(verification.verifiedAt).toLocaleString()}` : ''}.
          The hold door is open for this wallet.
        </p>
        {/* The refund happens AFTER verification, so this has to stay visible
            here. Hiding it the moment we verified meant a person owed money saw
            nothing about a refund still moving or held for review. */}
        {refundState && (
          <p className="mt-2 text-[11px] text-slate-200">
            {transferRefundCopy(refundState, true)}
          </p>
        )}
      </div>
    );
  }

  const amountText = challenge ? lamportsToSolText(challenge.lamports) : '';
  // The server derives the note from the check id, so an older api that does not
  // send one still gives the right value.
  const memoText = challenge ? challenge.memo ?? challenge.challengeId : '';

  return (
    <div className="mt-3">
      {verification.state === 'grandfathered' ? (
        <div className="rounded-lg border border-amber-300/25 bg-amber-400/[0.07] p-3">
          <p className="font-semibold text-amber-100">Verify this wallet to claim more land</p>
          <p className="mt-1 text-[11px] text-slate-200">
            Your parcels and the holds you already have keep working exactly as they do now, and
            nothing is at risk. Claiming a NEW hold parcel needs a verified wallet, so take the short
            step below when you want to claim again. It takes about a minute.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-cyan-300/25 bg-cyan-400/[0.07] p-3">
          <p className="font-semibold text-cyan-100">One short step: prove this wallet is yours</p>
          <p className="mt-1 text-[11px] text-slate-200">
            A hold parcel is backed by the $CLAWVILLE balance in this wallet, so we ask for proof that
            the wallet is yours before the hold door opens. Pick either option. Both take about a
            minute.
          </p>
        </div>
      )}
      <p className="mt-2 text-[11px] text-slate-300">
        Both options need a wallet whose key you hold. A wallet run by a smart contract, such as a
        Squads vault, cannot be verified yet.
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <section className="rounded-lg border border-cyan-300/20 bg-cyan-400/[0.05] p-3">
          <div className="font-semibold text-cyan-100">Connect wallet and sign</div>
          <p className="mt-1 text-[11px] text-slate-200">
            Free and instant. Your wallet signs a short message. No funds move and no key leaves your
            wallet.
          </p>
          {walletAvailable ? (
            <RpgButton
              size="sm"
              variant="primary"
              className="mt-3 min-h-[44px] w-full"
              onClick={signAndVerify}
              loading={signing}
              disabled={busy}
            >
              Connect wallet and sign
            </RpgButton>
          ) : (
            <p className="mt-3 text-[11px] text-amber-200">
              This option needs a browser wallet such as Phantom, Solflare, or Backpack. Install one
              and reload the page, or use the other option.
            </p>
          )}
        </section>

        <section className="rounded-lg border border-cyan-300/20 bg-cyan-400/[0.05] p-3">
          <div className="font-semibold text-cyan-100">Send a small amount, and we send it back</div>
          <p className="mt-1 text-[11px] text-slate-200">
            For a wallet you would rather not connect. Send one exact amount of SOL from the declared
            wallet, with the note we give you in the memo field, then paste back the transaction ID.
            We match it, verify you, and send the amount back. That return is usually automatic, and
            once in a while it needs a person, in which case support sorts it out. Solana charges a
            small network fee on each transfer, and that fee is not refundable. Your wallet has to
            let you set a memo, so check that before you start.
          </p>
          {!verification.transferDoorAvailable ? (
            <p className="mt-3 text-[11px] text-amber-200">
              This option is offline right now. Use connect and sign, or check back shortly.
            </p>
          ) : challenge && !closed && !terminal ? (
            <p className="mt-3 text-[11px] text-cyan-100">A check is open. The details are below.</p>
          ) : (
            <RpgButton
              size="sm"
              variant="secondary"
              className="mt-3 min-h-[44px] w-full"
              onClick={openTransfer}
              loading={opening}
              disabled={busy}
            >
              Start a transfer check
            </RpgButton>
          )}
        </section>
      </div>

      {challenge && (
        <div className="mt-2 rounded-lg border border-cyan-300/25 bg-slate-950/60 p-3">
          <p className="font-semibold text-cyan-100">
            Send exactly this amount from {shortWallet(walletAddress)}, with this note
          </p>
          <VerifyCopyRow label="Send to" value={challenge.destination} display={challenge.destination} />
          <VerifyCopyRow label="Exact amount" value={amountText} display={`${amountText} SOL`} />
          <VerifyCopyRow
            label="Note (memo field)"
            value={memoText}
            display={memoText}
          />
          <p className="mt-2 text-[11px] text-slate-200">
            Both parts have to match. The amount has to be exact to the last digit, which is{' '}
            {challenge.lamports.toLocaleString()} lamports, and the note has to go in the memo field
            of the same transfer. The amount tells us which check the money is for, and the note is
            what tells us you meant it for this account. Send both straight from your wallet as one
            plain transfer. A transfer without the note, or one a program makes for you, is returned
            to you and does not verify anything.
          </p>
          {!closed && !terminal && pollState !== 'verified' && (
            <div className="mt-3 rounded-lg border border-cyan-300/25 bg-cyan-400/[0.06] p-3">
              <p className="font-semibold text-cyan-100">Then paste the transaction ID</p>
              <p className="mt-1 text-[11px] text-slate-200">
                Your wallet shows a transaction ID as soon as the transfer is sent. Some wallets call
                it a signature. Paste it here and we look up that exact transfer, which is what proves
                the wallet is yours. This is the reliable path. If you send the money without pasting
                the ID we normally still spot it and send it back, but that part is best effort, and
                it never verifies anything.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  aria-label="Transaction ID"
                  value={txSignature}
                  onChange={(event) => setTxSignature(event.target.value.trim())}
                  className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-cyan-300/25 bg-slate-950 px-3 font-mono text-[11px] text-cyan-50"
                  placeholder="Paste the transaction ID"
                />
                <RpgButton
                  size="sm"
                  variant="primary"
                  className="min-h-[44px] shrink-0"
                  onClick={submitSignature}
                  loading={submitting}
                  disabled={busy || txSignature.trim().length < 64}
                >
                  Verify this transfer
                </RpgButton>
              </div>
            </div>
          )}
          <p className="mt-2 text-[11px] text-cyan-100">
            {closed ? 'This check has closed. Start a new one.' : `This check closes in ${formatCountdown(msLeft)}.`}
          </p>
          <p className="mt-1 text-[11px] text-slate-200">
            {TRANSFER_STATE_COPY[pollState ?? (closed ? 'expired' : 'pending')]}
          </p>
          {pollState === 'rejected' && rejectedReason && (
            <p className="mt-1 text-[11px] text-amber-200">
              {TRANSFER_REJECTED_COPY[rejectedReason]}
            </p>
          )}
          {refundState && (refundState !== 'none' || pollState === 'observed' || pollState === 'verified') && (
            <p className="mt-1 text-[11px] text-slate-200">
              {/* `verified` comes from the VERIFICATION state, never from the
                  refund state: reconcile and skipped also accompany rejected,
                  expired and unclaimed rows. */}
              {transferRefundCopy(refundState, pollState === 'verified')}
            </p>
          )}
          {poll.isError && <p className="mt-1 text-[11px] text-amber-200">{tenureError(poll.error)}</p>}
          {/* Conditional for the same reason the refund line is: this panel also
              renders for rejected, expired and unclaimed checks, where telling
              someone their wallet "stays verified" would be untrue. */}
          <p className="mt-1 text-[11px] text-slate-300">
            {pollState === 'verified'
              ? 'A slow refund never affects your verification. Your wallet stays verified, whatever the refund does afterwards.'
              : 'However this check ends, anything we received stays at the address we gave you, and we keep the keys to those addresses so it can come back to you. The refund is usually automatic, and support can return it if it ever needs a person. A refund on its own does not verify the wallet.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RpgButton
              size="sm"
              variant="secondary"
              className="min-h-[44px]"
              onClick={async () => {
                // Deliberately NOT `poll.isFetching`: that flips true on every
                // background poll, so the button would sit disabled and read
                // "loading" while nobody pressed anything.
                setChecking(true);
                try {
                  await poll.refetch();
                } finally {
                  setChecking(false);
                }
              }}
              loading={checking}
              disabled={busy}
            >
              Check now
            </RpgButton>
            {(closed || terminal) && verification.transferDoorAvailable && (
              <RpgButton
                size="sm"
                variant="primary"
                className="min-h-[44px]"
                onClick={openTransfer}
                loading={opening}
                disabled={busy}
              >
                Start a new check
              </RpgButton>
            )}
          </div>
          <p className="mt-2 text-[11px] text-slate-300">
            If you change your mind, send nothing. The check closes on its own.
          </p>
        </div>
      )}

      <div className="mt-2 rounded-lg border border-cyan-300/15 bg-cyan-400/[0.03] p-3">
        <p className="text-[11px] text-slate-200">
          Did you declare the ClawVille wallet that belongs to your own agent? ClawVille already holds
          that key, so it can be verified in one click.
        </p>
        <RpgButton
          size="sm"
          variant="ghost"
          className="mt-2 min-h-[44px]"
          onClick={attestCustodial}
          loading={attesting}
          disabled={busy}
        >
          Verify my ClawVille wallet
        </RpgButton>
      </div>

      {notice && <p className="mt-2 text-[11px] text-amber-200">{notice}</p>}
    </div>
  );
}

function WalletDeclaration({
  status,
  hasLiveHold,
}: {
  status: LandHoldWalletStatus | undefined;
  hasLiveHold: boolean;
}) {
  const queryClient = useQueryClient();
  const addToast = useGameStore((state) => state.addToast);
  const { walletPubkey } = useWalletLink();
  const [wallet, setWallet] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setWallet(status?.walletAddress ?? walletPubkey ?? '');
  }, [status?.walletAddress, walletPubkey]);

  const changing = status?.walletAddress != null && wallet !== status.walletAddress;
  const lockedReason = changing && hasLiveHold
    ? 'wallet_locked_by_hold: release active hold parcels before changing this wallet.'
    : null;

  const save = async () => {
    setSaving(true);
    try {
      await api.declareLandHoldWallet(wallet.trim());
      await queryClient.invalidateQueries({ queryKey: HOLD_WALLET_KEY });
      addToast('🔗', status?.walletAddress ? 'Land hold wallet changed.' : 'Land hold wallet declared.');
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-cyan-300/20 bg-cyan-400/[0.05] p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-200">Hold wallet</div>
      <p className="mt-1 text-[12px] text-slate-200">
        Declare the Solana wallet whose live CLV balance backs hold-door parcels. The first declaration works from any ledger-capable session.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          aria-label="Land hold wallet address"
          value={wallet}
          onChange={(event) => setWallet(event.target.value.trim())}
          className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-cyan-300/25 bg-slate-950 px-3 font-mono text-[11px] text-cyan-50"
          placeholder="Canonical Solana wallet address"
        />
        <RpgButton
          size="sm"
          variant="secondary"
          className="min-h-[44px]"
          onClick={save}
          loading={saving}
          disabled={wallet.length < 32 || !!lockedReason || wallet === status?.walletAddress}
        >
          {status?.walletAddress ? 'Change wallet' : 'Declare wallet'}
        </RpgButton>
      </div>
      {lockedReason && <p className="mt-2 text-[11px] text-amber-200">{lockedReason}</p>}
      {status?.walletAddress && (
        <p className="mt-2 font-mono text-[11px] text-slate-300">
          Declared {shortWallet(status.walletAddress)} ·{' '}
          {status.balance?.available && status.balance.uiAmount != null
            ? `${formatClv(status.balance.uiAmount)} CLV live balance`
            : 'live balance unavailable'}
        </p>
      )}
      {!status?.walletAddress && (
        <p className="mt-2 text-[11px] text-slate-300">
          After you declare it, one short step proves the wallet is yours. That step is what opens the
          hold door.
        </p>
      )}
      {status?.walletAddress && status.verification && (
        <HoldWalletVerification
          walletAddress={status.walletAddress}
          verification={status.verification}
        />
      )}
    </section>
  );
}

function AvailableParcelCard({
  parcel,
  wallet,
  existingHoldSum,
  isMobile,
  onChanged,
}: {
  parcel: LandParcelDTO;
  wallet: LandHoldWalletStatus | undefined;
  existingHoldSum: number;
  isMobile: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const [weeks, setWeeks] = useState(1);
  const [busy, setBusy] = useState<'hold' | 'rent' | null>(null);
  const claimKeys = useRef(new Map<string, string>());
  const threshold = holdThresholdForTier(parcel.tier);
  const required = existingHoldSum + (threshold ?? 0);
  const held = wallet?.balance?.available ? wallet.balance.uiAmount : null;
  const holdReason = threshold == null
    ? 'Hold door unavailable for this tier.'
    : !wallet?.walletAddress
      ? 'Declare a hold wallet first.'
      : held == null
        ? 'Live CLV balance is unavailable.'
        : held < required
          ? `${formatClv(required - held)} CLV short.`
          : null;
  const weekly = parcel.claimRentCtWeekly;
  const rentAllowed = (parcel.tier === 'starter' || parcel.tier === 'c') && weekly != null;

  const claim = async (door: 'hold' | 'rent') => {
    setBusy(door);
    try {
      const semanticAction = door === 'hold' ? 'hold' : `rent:${weeks}`;
      const key = claimKeys.current.get(semanticAction) ?? crypto.randomUUID();
      claimKeys.current.set(semanticAction, key);
      if (door === 'hold') {
        await api.claimHoldParcel(parcel.id, key);
        addToast('🏝️', `Claimed ${parcelDisplayName(parcel.parcelCode, parcel.tier)} through the rent-free hold door.`);
      } else {
        await api.claimRentParcel(parcel.id, weeks, key);
        addToast('🏝️', `Rented ${parcelDisplayName(parcel.parcelCode, parcel.tier)} for ${weeks} week${weeks === 1 ? '' : 's'}.`);
      }
      claimKeys.current.delete(semanticAction);
      await onChanged();
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`rounded-xl border border-cyan-300/15 bg-cyan-400/[0.04] ${isMobile ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="block font-semibold text-cyan-50">
            {parcelDisplayName(parcel.parcelCode, parcel.tier)}
          </span>
          <span className="block font-mono text-[10px] text-slate-400">{parcel.parcelCode}</span>
        </span>
        <TierBadge tier={parcel.tier} />
      </div>
      <div className="mt-3 rounded-lg border border-emerald-300/25 bg-emerald-400/[0.08] px-3 py-2">
        <p className="font-semibold text-emerald-100">
          Hold {threshold == null ? '$CLAWVILLE' : `${formatClv(threshold)} $CLAWVILLE`} — rent-free
        </p>
        {rentAllowed && (
          <p className="mt-0.5 text-[12px] font-semibold text-amber-100">
            or rent {weekly.toLocaleString()} vCLAW/week
          </p>
        )}
      </div>
      <div className={`mt-3 grid gap-3 ${isMobile || !rentAllowed ? 'grid-cols-1' : 'grid-cols-2'}`}>
        <section className="rounded-lg border border-emerald-300/20 bg-emerald-400/[0.05] p-3">
          <div className="font-semibold text-emerald-100">Hold door · rent-free</div>
          <p className="mt-1 text-[11px] text-slate-200">
            {threshold == null ? 'Not offered for this tier.' : `${formatClv(required)} CLV minimum (stacked).`}
          </p>
          <p className="mt-1 break-all font-mono text-[10px] text-slate-300">
            {wallet?.walletAddress ?? 'No wallet declared'} · {held == null ? 'balance unverified' : `${formatClv(held)} CLV`}
          </p>
          <RpgButton
            size="sm"
            variant="primary"
            className="mt-3 min-h-[44px] w-full"
            onClick={() => claim('hold')}
            loading={busy === 'hold'}
            disabled={!!holdReason || busy != null}
          >
            Claim with hold
          </RpgButton>
          {holdReason && <p className="mt-2 text-[10px] text-amber-200">{holdReason}</p>}
        </section>
        {rentAllowed ? (
          <section className="rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-3">
            <div className="font-semibold text-amber-100">Rent door</div>
            <p className="mt-1 text-[11px] text-slate-200">{weekly.toLocaleString()} vCLAW/week</p>
            <WeeksSelect value={weeks} onChange={setWeeks} label="Weeks" />
            <p className="font-mono text-[11px] text-cyan-100">Total {(weekly * weeks).toLocaleString()} vCLAW</p>
            <p className="mt-1 text-[10px] text-amber-200">The first week is non-refundable. Later weeks stay refundable in escrow.</p>
            <RpgButton
              size="sm"
              variant="primary"
              className="mt-3 min-h-[44px] w-full"
              onClick={() => claim('rent')}
              loading={busy === 'rent'}
              disabled={busy != null}
            >
              Rent parcel
            </RpgButton>
          </section>
        ) : parcel.tier === 'founder' ? (
          <p className="rounded-lg border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-100">
            Founder parcels are hold-only.
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function LandTenureForSalePanel({
  ownedParcels,
  isMobile,
  focusParcelCode,
  onChanged,
}: {
  ownedParcels: LandParcelDTO[];
  isMobile: boolean;
  focusParcelCode?: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const focusedCardRef = useRef<HTMLDivElement>(null);
  const parcels = useQuery({
    queryKey: ['land-tenure-available'],
    queryFn: () => api.getLandParcels({ status: 'available' }),
  });
  const wallet = useQuery({ queryKey: HOLD_WALLET_KEY, queryFn: api.getLandHoldWallet, retry: false });
  const existingHoldSum = useMemo(
    () => ownedParcels.reduce(
      (sum, parcel) => parcel.tenure === 'hold'
        ? sum + (parcel.holdThresholdCt ?? holdThresholdForTier(parcel.tier) ?? 0)
        : sum,
      0,
    ),
    [ownedParcels],
  );
  const available = parcels.data ?? [];
  useEffect(() => {
    if (!focusParcelCode || available.length === 0) return;
    if (!available.some((parcel) => parcel.parcelCode === focusParcelCode)) return;
    const frame = requestAnimationFrame(() => {
      focusedCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      focusedCardRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [available, focusParcelCode]);

  if (parcels.isLoading) return <p className="py-10 text-center text-sm text-slate-300">Loading available parcels…</p>;
  if (parcels.isError) return <p className="py-10 text-center text-sm text-rose-200">Available parcels could not be loaded.</p>;

  return (
    <div>
      <WalletDeclaration status={wallet.data} hasLiveHold={ownedParcels.some((parcel) => parcel.tenure === 'hold')} />
      <p className="mb-4 text-[12px] leading-relaxed text-slate-200">
        Hold $CLAWVILLE — rent-free — or rent vCLAW by the week. Starter is 100,000 $CLAWVILLE or 1,000 vCLAW/week; C is 250,000 $CLAWVILLE or 2,500 vCLAW/week. Founder is hold-only.
      </p>
      <div className="max-h-[52vh] space-y-5 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        {LAND_TIERS.map((tier) => {
          const tierParcels = available.filter((parcel) => parcel.tier === tier);
          if (tierParcels.length === 0) return null;
          return (
            <section key={tier}>
              <div className="mb-2 flex items-center gap-2"><TierBadge tier={tier} /><span className="text-[10px] text-slate-300">{tierParcels.length} available</span></div>
              <div className={`grid gap-2 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {tierParcels.map((parcel) => (
                  <div
                    key={parcel.id}
                    id={`land-tenure-${parcel.parcelCode}`}
                    ref={focusParcelCode === parcel.parcelCode ? focusedCardRef : undefined}
                    tabIndex={focusParcelCode === parcel.parcelCode ? -1 : undefined}
                    aria-current={focusParcelCode === parcel.parcelCode ? 'true' : undefined}
                    className={focusParcelCode === parcel.parcelCode
                      ? 'col-span-full rounded-xl ring-2 ring-cyan-300 ring-offset-2 ring-offset-[#071321]'
                      : undefined}
                  >
                    <AvailableParcelCard
                      parcel={parcel}
                      wallet={wallet.data}
                      existingHoldSum={existingHoldSum}
                      isMobile={isMobile}
                      onChanged={async () => {
                        await Promise.all([parcels.refetch(), wallet.refetch()]);
                        await onChanged();
                      }}
                    />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function OwnedTenureControls({
  parcel,
  wallet,
  onChanged,
}: {
  parcel: LandParcelDTO;
  wallet: LandHoldWalletStatus | undefined;
  onChanged: () => Promise<void> | void;
}) {
  const addToast = useGameStore((state) => state.addToast);
  const [weeks, setWeeks] = useState(1);
  const [busy, setBusy] = useState<'prepay' | 'release' | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const prepayKeys = useRef(new Map<number, string>());
  const releaseKey = useRef<string | null>(null);
  const weekly = parcel.rentCtWeekly;
  const graceMs = parcel.graceUntil ? new Date(parcel.graceUntil).getTime() - Date.now() : null;
  const graceHours = graceMs == null ? null : Math.max(0, Math.ceil(graceMs / 3_600_000));

  const prepay = async () => {
    if (weekly == null) return;
    setBusy('prepay');
    try {
      const key = prepayKeys.current.get(weeks) ?? crypto.randomUUID();
      prepayKeys.current.set(weeks, key);
      await api.prepayLandRent(parcel.id, weeks, key);
      prepayKeys.current.delete(weeks);
      addToast('🪙', `Prepaid ${weeks} week${weeks === 1 ? '' : 's'} on ${parcelDisplayName(parcel.parcelCode, parcel.tier)}.`);
      await onChanged();
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setBusy(null);
    }
  };

  const release = async () => {
    setBusy('release');
    try {
      const key = releaseKey.current ?? crypto.randomUUID();
      releaseKey.current = key;
      const result = await api.releaseLandParcel(parcel.id, key);
      releaseKey.current = null;
      addToast('↩️', result.refundedCt > 0
        ? `Released ${parcelDisplayName(parcel.parcelCode, parcel.tier)}; ${result.refundedCt.toLocaleString()} vCLAW escrow returned.`
        : `Released ${parcelDisplayName(parcel.parcelCode, parcel.tier)}.`);
      setConfirmRelease(false);
      await onChanged();
    } catch (error) {
      addToast('⚠️', tenureError(error), 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 w-full basis-full border-t border-cyan-300/15 pt-3 text-[11px] text-slate-200">
      {parcel.tenure === 'hold' ? (
        <div>
          <span className="font-semibold text-emerald-100">Rent-free hold</span> ·{' '}
          <span className="font-mono">{wallet?.walletAddress ? shortWallet(wallet.walletAddress) : 'wallet unavailable'}</span>
          <div className="mt-1 text-slate-300">Last check: {parcel.tenureLastCheckedAt ? new Date(parcel.tenureLastCheckedAt).toLocaleString() : 'pending'}</div>
        </div>
      ) : parcel.tenure === 'deposit' ? (
        <div>
          <div>
            Rent paid through: <span className="font-mono text-cyan-100">{parcel.rentPaidThrough ? new Date(parcel.rentPaidThrough).toLocaleString() : 'pending'}</span>
          </div>
          {graceHours != null && <div className="mt-1 font-semibold text-amber-200">Grace ends in about {graceHours} hour{graceHours === 1 ? '' : 's'}.</div>}
          {weekly != null && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <WeeksSelect value={weeks} onChange={setWeeks} label="Prepay" />
              <span className="font-mono text-cyan-100">{(weekly * weeks).toLocaleString()} vCLAW</span>
              <RpgButton size="sm" variant="secondary" className="min-h-[44px]" onClick={prepay} loading={busy === 'prepay'} disabled={busy != null}>Prepay rent</RpgButton>
            </div>
          )}
        </div>
      ) : (
        <div className="text-slate-300">Legacy tenure · no P2 rent controls.</div>
      )}

      {!confirmRelease ? (
        <RpgButton size="sm" variant="ghost" className="mt-3 min-h-[44px]" onClick={() => setConfirmRelease(true)}>Release parcel</RpgButton>
      ) : (
        <div role="alertdialog" aria-label={`Release ${parcelDisplayName(parcel.parcelCode, parcel.tier)}`} className="mt-3 rounded-lg border border-rose-300/30 bg-rose-400/[0.08] p-3">
          <p className="text-rose-100">
            Release {parcelDisplayName(parcel.parcelCode, parcel.tier)}? {parcel.tenure === 'deposit'
              ? 'Remaining escrow is returned, but the first week and rent already drawn are not refundable. Your build is archived.'
              : 'The CLV hold is removed with no deposit refund. Your build is archived.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RpgButton size="sm" variant="ghost" className="min-h-[44px]" onClick={() => setConfirmRelease(false)} disabled={busy != null}>Keep parcel</RpgButton>
            <RpgButton size="sm" variant="primary" className="min-h-[44px]" onClick={release} loading={busy === 'release'} disabled={busy != null}>Confirm release</RpgButton>
          </div>
        </div>
      )}
    </div>
  );
}

export function useLandHoldWalletStatus(enabled: boolean) {
  return useQuery({ queryKey: HOLD_WALLET_KEY, queryFn: api.getLandHoldWallet, enabled, retry: false });
}
