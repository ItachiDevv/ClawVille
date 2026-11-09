'use client';

/**
 * How Studios is paid (MCP hub phase 3 web): the human's pay mode choice and
 * the Studios sign-in, inside the Studios card.
 *
 * Pay mode: saved through the spend rules (`studiosPayMode`). Any change of
 * the payer counts as a raise on the server, so the linked wallet ALWAYS signs:
 * POST /api/wallet/spend-policy/challenge with the exact values, then PUT with
 * the proof. The other rule values are sent unchanged.
 *
 * Sign-in: POST /api/vendors/studios/oauth/challenge (link), the linked wallet
 * signs, POST /oauth/start with the proof, then this tab goes to the returned
 * Studios URL. Studios sends the browser back to `/game?studios=linked` or
 * `/game?studios=error&reason=<code>`; `StudiosReturnHandler` (mounted with the
 * wallet modal) opens the wallet panel, shows a plain message and removes the
 * query parameters. Sign-out signs an `unlink` challenge, then DELETE /oauth.
 * The two sign-in reads (account, My Media) share a 12 per minute limit with
 * the agent, so they never poll and never refetch on focus.
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { useGameStore } from '@/stores/game';
import { SPEND_POLICY_QUERY_KEY, saveErrorText, useHumanSpendPolicy } from './spending-card';
import { KEY_QUERY, studiosErrorText, type StudiosPayMode } from './studios-card';

export const STUDIOS_OAUTH_QUERY = ['studios-oauth'] as const;
export const STUDIOS_ACCOUNT_QUERY = ['studios-signin-account'] as const;

/** Where the Studios sign-in page lives. The browser goes nowhere else. */
const STUDIOS_ORIGIN = 'https://mystudios.fun';
/** The Studios sign-in page (`STUDIOS_OAUTH_AUTHORIZE_URL` on the API). */
const STUDIOS_AUTHORIZE_PATH = '/connect/authorize';

export const PAY_MODE_CHOICES: ReadonlyArray<{ mode: StudiosPayMode; label: string; can: string }> = [
  { mode: 'wallet', label: 'My agent wallet (USDC)', can: 'Images and videos. Your agent wallet pays in USDC, only inside your spend caps.' },
  { mode: 'key', label: 'My Studios API key', can: 'Everything: images, videos, character shots and recast. Studios bills your Studios credits.' },
  { mode: 'signin', label: 'My Studios sign-in', can: 'Everything, and you see your Studios media and balance here. Studios bills your Studios credits.' },
];

// ---------------------------------------------------------------------------
// Return from the Studios sign-in page
// ---------------------------------------------------------------------------

const RETURN_TEXT: Record<string, string> = {
  invalid_request: 'Studios sent back an incomplete answer. Nothing changed. Try again.',
  invalid_state: 'This sign-in does not match one you started here. Nothing changed. Press "Sign in with Studios" again.',
  state_used: 'This sign-in was used already. Nothing changed. If you are not signed in, press "Sign in with Studios" again.',
  state_expired: 'The sign-in took too long and expired. Nothing changed. Try again.',
  wrong_user: 'Another ClawVille account started this sign-in. Nothing changed. Sign in with Studios from your own account.',
  wrong_issuer: 'The answer did not come from Studios. Nothing changed.',
  denied: 'You did not allow ClawVille on Studios. Nothing changed.',
  avatar_changed: 'Your avatar changed during the sign-in. Nothing changed. Try again.',
  cancelled: 'The sign-in was cancelled. Nothing changed.',
  exchange_failed: 'Studios did not finish the sign-in. Nothing changed. Try again later.',
  unavailable: 'The Studios sign-in is not available now. Nothing changed. Try again later.',
  needs_login: 'For your safety, sign out and sign in again in this browser. Then sign in with Studios.',
  human_only: 'Only you can sign in with Studios, from your own browser sign-in.',
  guest: 'A guest account cannot sign in with Studios. Make an account first.',
  rate_limited: 'Too many sign-in tries. Wait ten minutes.',
};

/** The message for `?studios=<result>&reason=<code>`; null when the page did not come back from Studios. */
export function studiosReturnMessage(studios: string | null, reason: string | null): { ok: boolean; text: string } | null {
  if (studios === 'linked') {
    return { ok: true, text: 'You are signed in with Studios. To pay with it, choose "My Studios sign-in" under "How Studios is paid".' };
  }
  if (studios === 'error') {
    const known = reason !== null && Object.prototype.hasOwnProperty.call(RETURN_TEXT, reason);
    return { ok: false, text: known ? RETURN_TEXT[reason!]! : 'The Studios sign-in did not finish. Nothing changed. Try again.' };
  }
  return null;
}

export const useStudiosReturnStore = create<{
  message: { ok: boolean; text: string } | null;
  show: (message: { ok: boolean; text: string }) => void;
  clear: () => void;
}>((set) => ({
  message: null,
  show: (message) => set({ message }),
  clear: () => set({ message: null }),
}));

/** Reads the return parameters once on /game, opens the wallet panel and removes them. Renders nothing. */
export function StudiosReturnHandler() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const studios = url.searchParams.get('studios');
    if (studios === null) return;
    const message = studiosReturnMessage(studios, url.searchParams.get('reason'));
    url.searchParams.delete('studios');
    url.searchParams.delete('reason');
    window.history.replaceState(window.history.state, '', url.toString());
    if (!message) return;
    useStudiosReturnStore.getState().show(message);
    queryClient.invalidateQueries({ queryKey: STUDIOS_OAUTH_QUERY });
    queryClient.invalidateQueries({ queryKey: STUDIOS_ACCOUNT_QUERY });
    useGameStore.getState().openWalletLink();
  }, [queryClient]);
  return null;
}

// ---------------------------------------------------------------------------
// Pay mode
// ---------------------------------------------------------------------------

/** Plain text for a failed pay mode save. */
export function payModeErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'invalid_spend_policy') {
    return 'Your spend rules did not pass the check. Open Spending above, check the caps, and save them first.';
  }
  return saveErrorText(error);
}

/** The text under the choices: what is missing for the chosen mode, if anything. */
export function payModeWarning(
  mode: StudiosPayMode | null,
  key: { linked: boolean } | undefined,
  oauth: { linked: boolean; status: 'active' | 'broken' | null } | undefined,
): string | null {
  if (mode === 'key' && !key?.linked) return 'No Studios key is saved yet. Save one below, or nothing is made.';
  if (mode === 'signin' && !oauth?.linked) return 'You are not signed in with Studios yet. Sign in below, or nothing is made.';
  if (mode === 'signin' && oauth?.status === 'broken') return 'Your Studios sign-in stopped working. Sign in again below, or nothing is made.';
  return null;
}

async function signedProof(challenge: { nonce: string; messageToSign: string; walletPubkey: string }) {
  const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
  return { nonce: challenge.nonce, signature: signed.signatureBase58 };
}

function PayModeChooser() {
  const queryClient = useQueryClient();
  const { signedIn, query: policyQuery } = useHumanSpendPolicy();
  const policy = policyQuery.data;
  const keyQuery = useQuery({ queryKey: KEY_QUERY, queryFn: api.studiosKeyStatus, enabled: signedIn, retry: false });
  const oauthQuery = useQuery({ queryKey: STUDIOS_OAUTH_QUERY, queryFn: api.studiosOAuthStatus, enabled: signedIn, retry: false });
  const [choice, setChoice] = useState<StudiosPayMode | null>(null);
  useEffect(() => {
    if (policy) setChoice(policy.studiosPayMode ?? null);
  }, [policy]);

  const save = useMutation({
    mutationFn: async (mode: StudiosPayMode) => {
      if (!policy) throw new ApiError('not_loaded', 0, 'not_loaded');
      // Every other value stays as saved; the message names them all.
      const values = {
        dailyCapUsdCents: policy.dailyCapUsdCents,
        perCallCapUsdCents: policy.perCallCapUsdCents,
        allowedVendors: policy.allowedVendors,
        studiosKeyImagesPerDay: policy.studiosKeyImagesPerDay,
        requireApproval: policy.requireApproval,
        studiosPayMode: mode,
      };
      const proof = await signedProof(await api.spendPolicyChallenge(values));
      return api.putSpendPolicy({ ...values, proof });
    },
    onSuccess: (next) => queryClient.setQueryData(SPEND_POLICY_QUERY_KEY, next),
    onError: () => queryClient.invalidateQueries({ queryKey: SPEND_POLICY_QUERY_KEY }),
  });

  if (policyQuery.isLoading) return <p className="text-xs text-white/60">Loading your spend rules...</p>;
  if (!policy) return <p className="text-xs text-red-300">Your spend rules did not load. Try again later.</p>;
  const saved = policy.studiosPayMode ?? null;
  const warning = payModeWarning(choice, keyQuery.data, oauthQuery.data);

  return (
    <fieldset className="space-y-2" data-testid="pay-mode">
      <legend className="text-xs font-semibold text-white/85">Who pays for Studios</legend>
      {saved === null && (
        <p className="text-xs text-white/60 leading-relaxed">
          Not chosen yet: your saved Studios key pays if you saved one. If not, your agent wallet pays.
        </p>
      )}
      {PAY_MODE_CHOICES.map((item) => (
        <label key={item.mode} className="flex items-start gap-3 min-h-[44px] text-xs text-white/85">
          <input
            type="radio"
            name="studios-pay-mode"
            className="h-5 w-5 mt-0.5 shrink-0"
            checked={choice === item.mode}
            onChange={() => setChoice(item.mode)}
          />
          <span className="min-w-0 space-y-0.5">
            <span className="block font-semibold">{item.label}{saved === item.mode ? ' (saved)' : ''}</span>
            <span className="block text-white/55 leading-relaxed">{item.can}</span>
          </span>
        </label>
      ))}
      {warning && <p className="text-xs text-amber-200 leading-relaxed">{warning}</p>}
      <p className="text-xs text-white/55 leading-relaxed">Your linked wallet signs each change. Your agent cannot change this.</p>
      {save.isError && <p className="text-xs text-red-300">{payModeErrorText(save.error)}</p>}
      <button
        type="button"
        onClick={() => choice && save.mutate(choice)}
        disabled={save.isPending || choice === null || choice === saved}
        className="w-full min-h-[44px] rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-50 text-sm font-bold text-white"
      >
        {save.isPending ? 'Approve in your wallet...' : 'Save who pays'}
      </button>
      {save.isSuccess && choice === saved && <p className="text-xs text-emerald-300">Saved.</p>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Studios sign-in
// ---------------------------------------------------------------------------

/** Plain dollars, or a note when Studios did not say. */
export function usdOrUnknown(value: number | null): string {
  return value === null ? 'Studios did not say' : `$${value.toFixed(2)}`;
}

/** Only the Studios https sign-in page, with no user info; anything else is refused before the tab moves. */
export function checkedAuthorizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('studios_signin_bad_redirect', 0, 'studios_signin_bad_redirect');
  }
  const ok = url.protocol === 'https:'
    && url.origin === STUDIOS_ORIGIN
    && url.pathname === STUDIOS_AUTHORIZE_PATH
    && url.username === ''
    && url.password === '';
  if (!ok) throw new ApiError('studios_signin_bad_redirect', 0, 'studios_signin_bad_redirect');
  return url.toString();
}

/** Test seam: the same-tab move to the Studios sign-in page. */
export const studiosNavigation = { go: (url: string) => window.location.assign(url) };

function StudiosSigninBlock() {
  const queryClient = useQueryClient();
  const { signedIn } = useHumanSpendPolicy();
  const oauthQuery = useQuery({ queryKey: STUDIOS_OAUTH_QUERY, queryFn: api.studiosOAuthStatus, enabled: signedIn, retry: false });
  const status = oauthQuery.data;
  const active = status?.linked === true && status.status === 'active';
  const accountQuery = useQuery({
    queryKey: STUDIOS_ACCOUNT_QUERY,
    queryFn: api.studiosSigninAccount,
    enabled: signedIn && active,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const signIn = useMutation({
    mutationFn: async () => {
      useStudiosReturnStore.getState().clear();
      const proof = await signedProof(await api.studiosOAuthChallenge('link'));
      const { authorizeUrl } = await api.studiosOAuthStart(proof);
      studiosNavigation.go(checkedAuthorizeUrl(authorizeUrl));
    },
  });
  const signOut = useMutation({
    mutationFn: async () => api.studiosOAuthUnlink(await signedProof(await api.studiosOAuthChallenge('unlink'))),
    onSuccess: (next) => {
      useStudiosReturnStore.getState().clear();
      queryClient.setQueryData(STUDIOS_OAUTH_QUERY, next);
      queryClient.removeQueries({ queryKey: STUDIOS_ACCOUNT_QUERY });
    },
  });
  const failure = signIn.error ?? signOut.error;
  const busy = signIn.isPending || signOut.isPending;
  const account = accountQuery.data;

  const signInButton = (label: string) => (
    <button
      type="button"
      onClick={() => signIn.mutate()}
      disabled={busy}
      className="w-full min-h-[44px] rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-50 text-sm font-bold text-white"
    >
      {signIn.isPending ? 'Approve in your wallet...' : label}
    </button>
  );

  return (
    <div className="pt-2 border-t border-white/10 space-y-2" data-testid="studios-signin">
      <p className="text-xs font-semibold text-white/85">My Studios sign-in</p>
      {oauthQuery.isLoading ? (
        <p className="text-xs text-white/60">Loading...</p>
      ) : !status?.linked ? (
        <>
          <p className="text-xs text-white/70 leading-relaxed">
            Sign in with your own Studios account. Your linked wallet signs first. Then this tab opens Studios, and Studios
            sends you back here. ClawVille never shows your Studios password or token to your agent.
          </p>
          {signInButton('Sign in with Studios')}
        </>
      ) : status.status === 'broken' ? (
        <>
          <p className="text-xs text-amber-200 leading-relaxed">Your Studios sign-in stopped working. Sign in again to use it.</p>
          {signInButton('Sign in again')}
        </>
      ) : (
        <>
          <p className="text-xs text-emerald-300">Signed in with Studios.</p>
          {accountQuery.isLoading ? (
            <p className="text-xs text-white/60">Loading your Studios balance...</p>
          ) : accountQuery.isError ? (
            <p className="text-xs text-red-300">{studiosErrorText(accountQuery.error)}</p>
          ) : account && !account.readable ? (
            <p className="text-xs text-white/60">Studios did not send numbers that ClawVille can read.</p>
          ) : account ? (
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 text-xs" data-testid="studios-account">
              <dt className="text-white/60">Studios balance</dt>
              <dd className="text-white text-right">{usdOrUnknown(account.balanceUsd)}</dd>
              <dt className="text-white/60">Free use left today</dt>
              <dd className="text-white text-right">{account.freeUsageLeft === null ? 'Studios did not say' : String(account.freeUsageLeft)}</dd>
              <dt className="text-white/60">ClawVille may still spend today</dt>
              <dd className="text-white text-right">{usdOrUnknown(account.connectionSpendLeftUsd)}</dd>
            </dl>
          ) : null}
          <p className="text-xs text-white/55 leading-relaxed">You set how much ClawVille may spend per day on Studios itself.</p>
        </>
      )}
      {status?.linked && (
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={busy}
          className="w-full min-h-[44px] rounded-md border border-white/20 text-sm text-white/80 hover:bg-white/10 disabled:opacity-50"
        >
          {signOut.isPending ? 'Approve in your wallet...' : 'Sign out of Studios'}
        </button>
      )}
      {failure && <p className="text-xs text-red-300">{studiosErrorText(failure)}</p>}
    </div>
  );
}

/** Pay mode chooser and Studios sign-in (inside "How Studios is paid"). */
export function StudiosPaySection() {
  return (
    <>
      <PayModeChooser />
      <StudiosSigninBlock />
    </>
  );
}
