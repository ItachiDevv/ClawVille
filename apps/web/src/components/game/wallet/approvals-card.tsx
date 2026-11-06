'use client';

/**
 * "Ask me before each payment" (founder go 2026-11-06).
 *
 * ApprovalsCard (wallet panel): every paid-tool request that waits for the
 * human (the agent's, and the human's own from the Studios images card), with
 * Approve and Decline. Approve asks the server for a challenge and the human's
 * linked wallet signs it (a session cookie alone never approves a payment);
 * Decline needs no signature. The prompt is the agent's own text, so it is
 * untrusted: it renders as plain React text only (never HTML, never markdown,
 * never a link).
 *
 * ApprovalNotice (/game): a small pill while a request waits; it opens the
 * wallet panel. Both read GET /api/vendors/studios/approvals (human session
 * only) and poll at a modest interval only while the human is signed in and
 * the rule is on or a request still waits.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VendorCallApprovalView } from '@clawville/shared';
import { api, ApiError } from '@/lib/api';
import { WalletSignError, signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useGameStore } from '@/stores/game';
import { STUDIOS_APPROVALS_QUERY_KEY, useHumanSpendPolicy } from './spending-card';
import { IMAGES_QUERY, studiosErrorText } from './studios-card';

const POLL_MS = 30_000;

/** Plain text for the time a request has left. */
export function timeLeftText(expiresAt: string, nowMs: number): string {
  const left = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(left) || left <= 0) return 'Expired';
  const minutes = Math.floor(left / 60_000);
  return minutes < 1 ? 'Less than 1 minute left' : `${minutes} min left`;
}

/** Plain text for who pays and how much at most. */
export function approvalPriceText(item: Pick<VendorCallApprovalView, 'mode' | 'maxUsdCents'>): string {
  if (item.mode === 'account') return 'Your Studios key pays (your Studios credits).';
  const cents = item.maxUsdCents ?? 0;
  return `Your agent wallet pays, at most $${(cents / 100).toFixed(2)} (the price comes when you approve).`;
}

/** Plain text for a failed approve or decline. Branches on the API code only. */
export function approvalErrorText(error: unknown): string {
  // The wallet's own messages are plain text written for people.
  if (error instanceof WalletSignError) return error.message;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'studios_approval_needs_wallet_link':
        return 'Link your own wallet in the wallet panel first. It signs each payment you approve.';
      case 'studios_approval_needs_wallet_proof':
      case 'studios_approval_invalid_wallet_proof':
        return 'Your wallet signature did not match. Try again and approve the request in your wallet.';
      case 'approval_terms_changed':
        return 'The request or its price limit changed. Nothing was paid. Approve it again.';
      case 'approval_expired':
        return 'This request expired. Nothing was paid.';
      case 'approval_not_awaiting':
      case 'approval_not_found':
        return 'This request does not wait any more. Nothing new was paid.';
      case 'approval_mode_changed':
        return 'You saved or removed your Studios key after this request was made. Nothing was paid. Decline it.';
      case 'studios_approval_needs_human_login':
        return 'For your safety, sign out and sign in again in this browser. Then approve or decline.';
      case 'studios_approval_human_only':
        return 'Only you can approve, from your own browser sign-in.';
      default:
        return studiosErrorText(error);
    }
  }
  return studiosErrorText(error);
}

export function useStudiosApprovals() {
  const { signedIn, query: policyQuery } = useHumanSpendPolicy();
  const query = useQuery({
    queryKey: STUDIOS_APPROVALS_QUERY_KEY,
    queryFn: api.studiosApprovals,
    enabled: signedIn,
    retry: false,
    staleTime: 10_000,
    // Poll only while the rule is on or a request still waits (one can wait
    // after the human turned the rule off; it expires in 15 minutes).
    refetchInterval: (q) => (
      policyQuery.data?.requireApproval || (q.state.data?.approvals.length ?? 0) > 0 ? POLL_MS : false
    ),
  });
  return { signedIn, query, approvals: query.data?.approvals ?? [] };
}

/** A clock for "time left", ticking every 15 seconds while something waits. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function ApprovalsCard() {
  const queryClient = useQueryClient();
  const { signedIn, query, approvals } = useStudiosApprovals();
  const now = useNow(approvals.length > 0);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: STUDIOS_APPROVALS_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
  };
  const decide = useMutation({
    mutationFn: async (input: { requestId: string; approve: boolean }) => {
      if (!input.approve) return api.declineStudiosRequest(input.requestId);
      // Approving a payment: the human's linked wallet signs this one request.
      const challenge = await api.studiosApprovalChallenge(input.requestId);
      const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
      return api.approveStudiosRequest(input.requestId, { nonce: challenge.nonce, signature: signed.signatureBase58 });
    },
    onMutate: (input) => setErrors((current) => {
      const next = { ...current };
      delete next[input.requestId];
      return next;
    }),
    onSuccess: refresh,
    onError: (err, input) => {
      setErrors((current) => ({ ...current, [input.requestId]: approvalErrorText(err) }));
      refresh();
    },
  });

  if (!signedIn) return null;
  const busyId = decide.isPending ? decide.variables?.requestId : null;

  return (
    <div className="space-y-2" data-testid="approvals-card">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">✅</span>
        <h3 className="font-bold text-sm text-white">Approvals</h3>
      </div>
      <div className="bg-sky-500/10 border border-sky-400/25 rounded-lg p-3 space-y-3">
        {query.isError ? (
          <p className="text-xs text-red-300">{approvalErrorText(query.error)}</p>
        ) : approvals.length === 0 ? (
          <p className="text-xs text-white/60">
            No payment waits for you. With &quot;Ask me before each payment&quot; on (Spending, above), each paid image waits here until you approve it with your linked wallet.
          </p>
        ) : (
          approvals.map((item) => (
            <div key={item.requestId} className="rounded-md border border-white/15 bg-black/30 p-3 space-y-2" data-testid="approval-item">
              <p className="text-xs text-white/55">{item.surface === 'hosted' ? 'Your agent asks' : 'A request asks'} for a Studios image:</p>
              {/* Agent text: plain text only. */}
              <p className="text-sm text-white whitespace-pre-wrap break-words" data-testid="approval-prompt">{item.prompt}</p>
              <p className="text-xs text-white/70">{approvalPriceText(item)}</p>
              <p className="text-xs text-white/55">{timeLeftText(item.expiresAt, now)}</p>
              {errors[item.requestId] && <p className="text-xs text-red-300">{errors[item.requestId]}</p>}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ requestId: item.requestId, approve: true })}
                  className="min-h-[44px] rounded-md bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-sm font-bold text-white"
                >
                  {busyId === item.requestId && decide.variables?.approve ? 'Approving...' : 'Approve'}
                </button>
                <button
                  type="button"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ requestId: item.requestId, approve: false })}
                  className="min-h-[44px] rounded-md border border-white/25 hover:bg-white/10 disabled:opacity-50 text-sm text-white"
                >
                  Decline
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The /game pill while a payment waits. Registered in `GAME_HUD` at
 * `HUD_Z.approvalNotice` (48): above the hotbar, below every dialog.
 */
export function ApprovalNotice() {
  const isMobile = useIsMobile();
  const { approvals } = useStudiosApprovals();
  const walletOpen = useGameStore((s) => s.walletLinkModalOpen);
  const openWallet = useGameStore((s) => s.openWalletLink);
  if (approvals.length === 0 || walletOpen) return null;
  const count = approvals.length;
  const label = isMobile
    ? `${count} payment${count === 1 ? '' : 's'} to approve`
    : `${count} payment${count === 1 ? '' : 's'} wait${count === 1 ? 's' : ''} for your approval. Open the wallet.`;
  return (
    <button
      type="button"
      onClick={openWallet}
      data-testid="approval-notice"
      className={`fixed left-1/2 -translate-x-1/2 z-[48] min-h-[44px] rounded-full border border-amber-300/50 bg-amber-500/90 text-slate-950 font-bold shadow-lg ${isMobile ? 'px-4 text-xs' : 'px-5 text-sm'}`}
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 8.5rem)' }}
    >
      {label}
    </button>
  );
}
