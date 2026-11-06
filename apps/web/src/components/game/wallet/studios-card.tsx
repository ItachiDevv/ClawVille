'use client';

/**
 * StudiosCard: the human path for Studios images (MCP hub step 2 phase 2b).
 * The human makes an image, sees the recent images of the avatar (also the
 * ones the agent made), and chooses who pays: their own Studios account (an
 * API key; Studios keeps the image in My Media) or the agent wallet inside the
 * spend caps. Same service as the agent path (POST /api/vendors/studios/images).
 * Saving or removing the key needs a signature from the human's linked wallet.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type StudiosRequestView } from '@/lib/api';
import { WalletSignError, signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { STUDIOS_APPROVALS_QUERY_KEY, useHumanSpendPolicy } from './spending-card';

const KEY_QUERY = ['studios-key'] as const;
export const IMAGES_QUERY = ['studios-images'] as const;

/** Plain text for a failed call. Branches on the API code, never on raw text. */
export function studiosErrorText(error: unknown): string {
  if (error instanceof WalletSignError) return error.message;
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'spend_rules_not_set':
        return 'Set your spend caps first (Spending, above).';
      case 'vendor_not_allowed':
        return 'Allow Studios in your spend rules first (Spending, above).';
      case 'over_per_call_cap':
      case 'over_daily_cap':
        return 'This image would pass your spend caps. Nothing was paid.';
      case 'payment_ambiguous':
        return 'Studios did not confirm the result. The payment may have gone through; it counts toward your daily cap until it is checked. Do not try the same image again.';
      case 'studios_key_invalid':
        return 'Your saved Studios API key does not work. Save it again below.';
      case 'studios_account_refused':
        return 'Studios refused the call on your Studios account (for example, no credits left).';
      case 'studios_key_missing':
        return 'You chose your own Studios key to pay, but no key is saved. Nothing was paid.';
      case 'studios_signin_missing':
        return 'You chose your Studios sign-in to pay, but you are not signed in with Studios. Nothing was paid.';
      case 'studios_signin_broken':
        return 'Your Studios sign-in stopped working. Sign in with Studios again. Nothing was paid.';
      case 'rate_limited':
        return 'Too many images. Wait one minute.';
      case 'awaiting_approval':
        return '"Ask me before each payment" is on, so this image waits in Approvals below. Approve it there with your linked wallet.';
      case 'running':
        return 'Studios is making this image on your Studios account (Studios sign-in). It appears here and in your recent images when it is ready.';
      case 'approval_declined':
        return 'You declined this image in Approvals. Nothing was paid.';
      case 'approval_expired':
        return 'This image waited too long in Approvals and expired. Nothing was paid.';
      case 'approval_pending_limit':
        return 'Five requests already wait in Approvals. Approve or decline them first.';
      case 'daily_limit':
        return 'Your images per day with your own Studios key are used up. Try again after 00:00 UTC, or raise the number in Spending above.';
      case 'invalid_studios_key':
        return 'A Studios API key starts with chk_.';
      case 'studios_key_needs_human_login':
        return 'For your safety, sign out and sign in again in this browser. Then save the key.';
      case 'studios_key_human_only':
        return 'Only you can change the Studios key, in your own browser session.';
      case 'studios_key_needs_wallet_link':
        return 'Link your own wallet in the wallet panel first. It signs to approve a key change.';
      case 'studios_key_needs_wallet_proof':
      case 'studios_key_invalid_wallet_proof':
        return 'Your wallet signature did not match. Try again and approve the request in your wallet.';
      case 'wallet_missing':
        return 'Your avatar has no agent wallet yet.';
      case 'payment_prepare_failed':
        return 'The payment could not be prepared. Check that your agent wallet holds USDC. Nothing was paid.';
      case 'vendor_unreachable':
      case 'vendor_refused':
      case 'vendor_quote_invalid':
      case 'vendor_pay_to_changed':
        return 'Studios is not available now, or its price changed. Nothing was paid.';
      case 'duplicate_request':
        return 'This image is still being made, or its request did not finish. Wait a minute and check your recent images; press again to check. Change the text to make a new image.';
      case 'image_missing':
        return 'Studios sent no readable image.';
      case 'outcome_unknown':
        return 'Studios did not tell us the result. Studios may have charged for it. Do not try it again. Check your Studios My Media and credits (when your agent wallet pays: check the wallet history).';
      case 'job_timeout':
        return 'Studios took too long, and we stopped waiting. Studios may have charged for it. Do not try it again. Check your Studios My Media and credits (when your agent wallet pays: check the wallet history).';
      case 'result_lost':
        return 'The result was lost after the call. Studios may have charged for it. Do not try it again. Check your Studios My Media and credits (when your agent wallet pays: check the wallet history).';
      case 'media_missing':
        return 'Studios finished, but we could not get the media. Studios may have charged for it. Do not try it again. Check your Studios My Media and credits (when your agent wallet pays: check the wallet history).';
      case 'payload_too_large':
        return 'The text is too long.';
      default:
        break;
    }
    if (error.status === 400) return 'Check the text and try again.';
  }
  return 'That did not work. Try again later.';
}

/**
 * Who pays for the next image, from the human's chosen pay mode (spend
 * rules); not chosen = the saved key if any, else the agent wallet. The same
 * rule as the server (`resolveStudiosPayer`).
 */
export function studiosPayerNotice(
  payMode: 'wallet' | 'key' | 'signin' | null | undefined,
  key: { linked: boolean; last4: string | null } | undefined,
): string {
  const mode = payMode ?? (key?.linked ? 'key' : 'wallet');
  if (mode === 'signin') {
    return 'Images are made with your Studios sign-in. Studios bills your Studios credits and keeps the images in My Media.';
  }
  if (mode === 'key') {
    return key?.linked
      ? `Images are made with your own Studios account (key ending ${key.last4 ?? ''}). Studios bills your credits and keeps the images in My Media.`
      : 'You chose your own Studios key to pay, but no key is saved. Save it below; until then nothing is made.';
  }
  return 'Images are paid from your agent wallet, about half a cent each, only inside your spend caps. Studios does not keep these images in your Studios account.';
}

function newIdempotencyKey(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `web-${random}`.slice(0, 64);
}

/**
 * Refusals where the server recorded the request as finished and nothing was
 * charged: the next click may use a new request key. After any other outcome
 * (a lost reply, duplicate_request, rate_limited, payment_ambiguous,
 * image_missing) the card keeps the key, so a retry of the same text returns
 * the first result instead of paying again.
 */
const FINAL_NOTHING_CHARGED = new Set([
  'spend_rules_not_set', 'vendor_not_allowed', 'over_per_call_cap', 'over_daily_cap', 'vendor_unreachable',
  'vendor_refused', 'vendor_quote_invalid', 'vendor_pay_to_changed', 'wallet_missing', 'payment_prepare_failed',
  'studios_key_invalid', 'studios_account_refused', 'daily_limit',
  'studios_key_missing', 'studios_signin_missing', 'studios_signin_broken',
]);

export function keepsRequestKey(error: unknown): boolean {
  return !(error instanceof ApiError && typeof error.code === 'string' && FINAL_NOTHING_CHARGED.has(error.code));
}

/** The request of the current prompt: its key, and its id after a 202. */
export interface StudiosPendingRequest {
  operation: 'image';
  prompt: string;
  key: string;
  /** Set after a 202 (waiting for approval or running): poll it until it ends. */
  requestId: string | null;
}

/**
 * The request to send. The same prompt and operation reuse the open key, so a
 * second click returns the same request and never pays twice. Only a new
 * prompt or operation (or no open request: it ended) gets a new key.
 */
export function studiosRequestFor(
  pending: StudiosPendingRequest | null,
  operation: 'image',
  prompt: string,
  newKey: () => string,
): StudiosPendingRequest {
  if (pending && pending.operation === operation && pending.prompt === prompt) return pending;
  return { operation, prompt, key: newKey(), requestId: null };
}

const TERMINAL_STATUSES = new Set<StudiosRequestView['status']>(['done', 'failed', 'ambiguous', 'declined', 'expired']);

/**
 * What the polled request says. null: it has not ended yet (keep the key, keep
 * the button off). Else the end: the image, or the code to show and whether
 * the same prompt must not be sent again (it may have been charged).
 */
export function studiosRequestOutcome(view: StudiosRequestView | undefined):
  | null
  | { kind: 'done'; mediaPath: string | null; note: string }
  | { kind: 'failed'; code: string; blockPrompt: boolean } {
  if (!view || !TERMINAL_STATUSES.has(view.status)) return null;
  if (view.status === 'done') {
    return {
      kind: 'done',
      mediaPath: view.media[0]?.mediaPath ?? view.mediaPath,
      note: view.mode === 'wallet' ? 'Paid from your agent wallet.' : 'Made with your Studios account.',
    };
  }
  if (view.status === 'declined') return { kind: 'failed', code: 'approval_declined', blockPrompt: false };
  if (view.status === 'expired') return { kind: 'failed', code: 'approval_expired', blockPrompt: false };
  if (view.status === 'ambiguous') return { kind: 'failed', code: 'payment_ambiguous', blockPrompt: true };
  const code = view.code ?? 'failed';
  return { kind: 'failed', code, blockPrompt: !FINAL_NOTHING_CHARGED.has(code) };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signKeyChange(body: { action: 'save'; last4: string; sha256: string } | { action: 'remove' }) {
  const challenge = await api.studiosKeyChallenge(body);
  const signed = await signMessageWithSolanaWallet(challenge.messageToSign, challenge.walletPubkey);
  return { nonce: challenge.nonce, signature: signed.signatureBase58 };
}

export function StudiosCard() {
  const queryClient = useQueryClient();
  const { signedIn, query: policyQuery } = useHumanSpendPolicy();
  const [prompt, setPrompt] = useState('');
  const [keyText, setKeyText] = useState('');
  const [last, setLast] = useState<{ mediaPath: string; note: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The request key for the current prompt. A retry after a lost reply, or a
  // click while the request waits or runs, reuses it, so the server returns
  // the same request instead of paying again.
  const [pending, setPending] = useState<StudiosPendingRequest | null>(null);
  // After payment_ambiguous, the same prompt cannot be sent again.
  const [blockedPrompt, setBlockedPrompt] = useState<string | null>(null);

  const keyQuery = useQuery({ queryKey: KEY_QUERY, queryFn: api.studiosKeyStatus, enabled: signedIn, retry: false });
  const imagesQuery = useQuery({ queryKey: IMAGES_QUERY, queryFn: api.studiosImages, enabled: signedIn, retry: false });
  // After a 202 the request ends in the background: read it until it ends.
  const openRequestId = pending?.requestId ?? null;
  const requestQuery = useQuery({
    queryKey: ['studios-request', openRequestId],
    queryFn: () => api.studiosRequest(openRequestId!),
    enabled: signedIn && openRequestId !== null,
    refetchInterval: (query) => (studiosRequestOutcome(query.state.data) ? false : 4000),
    retry: 2,
  });
  const outcome = openRequestId !== null && requestQuery.data?.requestId === openRequestId
    ? studiosRequestOutcome(requestQuery.data)
    : null;

  useEffect(() => {
    if (!outcome || !pending) return;
    // The request ended: show the result and drop the key (the next click is a new request).
    if (outcome.kind === 'done') {
      setError(null);
      if (outcome.mediaPath) setLast({ mediaPath: outcome.mediaPath, note: outcome.note });
    } else {
      setError(new ApiError(outcome.code, 200, outcome.code));
      if (outcome.blockPrompt) setBlockedPrompt(pending.prompt);
    }
    setPending(null);
    queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
  }, [outcome, pending, queryClient]);

  const make = useMutation({
    mutationFn: (request: StudiosPendingRequest) => api.studiosImage({ prompt: request.prompt }, request.key),
    onMutate: () => {
      setError(null);
      setLast(null);
    },
    onSuccess: (result, request) => {
      // With "ask me before each payment" on, every image waits in Approvals
      // (below) until the linked wallet signs the approval. With the Studios
      // sign-in, the image is a Studios job that finishes in the background.
      // Both keep the key and the request id until the request ends.
      if ('status' in result) {
        setPending({ ...request, requestId: result.requestId });
        setError(new ApiError(result.status, 202, result.status));
        if (result.status === 'awaiting_approval') queryClient.invalidateQueries({ queryKey: STUDIOS_APPROVALS_QUERY_KEY });
        return;
      }
      setPending(null);
      setLast({
        mediaPath: result.mediaPath,
        note: result.mode !== 'wallet'
          ? 'Made with your Studios account.'
          : `Paid from your agent wallet: ${((result.paidUsdCents ?? 0) / 100).toFixed(2)} USD.`,
      });
      queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
    },
    onError: (err, request) => {
      setError(err);
      if (err instanceof ApiError && (err.code === 'payment_ambiguous' || err.code === 'image_missing')) setBlockedPrompt(request.prompt);
      if (!keepsRequestKey(err)) setPending(null);
      queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
    },
  });
  const saveKey = useMutation({
    mutationFn: async (key: string) => {
      // Check the shape before the wallet is asked to sign anything.
      if (!/^chk_[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ApiError('invalid_studios_key', 400, 'invalid_studios_key');
      return api.saveStudiosKey(key, await signKeyChange({ action: 'save', last4: key.slice(-4), sha256: await sha256Hex(key) }));
    },
    onMutate: () => setError(null),
    onSuccess: (status) => {
      setKeyText('');
      queryClient.setQueryData(KEY_QUERY, status);
    },
    onError: (err) => setError(err),
  });
  const removeKey = useMutation({
    mutationFn: async () => api.deleteStudiosKey(await signKeyChange({ action: 'remove' })),
    onMutate: () => setError(null),
    onSuccess: (status) => queryClient.setQueryData(KEY_QUERY, status),
    onError: (err) => setError(err),
  });

  if (!signedIn) return null;
  const linked = keyQuery.data?.linked === true;
  const text = prompt.trim();
  const blocked = blockedPrompt !== null && blockedPrompt === text;
  // A request that waits or runs keeps the button off until it ends.
  const open = openRequestId !== null && outcome === null;
  const waitingApproval = open && (requestQuery.data
    ? requestQuery.data.status === 'awaiting_approval'
    : error instanceof ApiError && error.code === 'awaiting_approval');

  const submit = () => {
    if (open) return;
    const request = studiosRequestFor(pending, 'image', text, newIdempotencyKey);
    setPending(request);
    make.mutate(request);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🎨</span>
        <h3 className="font-bold text-sm text-white">Studios images</h3>
      </div>
      <div className="bg-violet-500/10 border border-violet-400/25 rounded-lg p-3 space-y-3">
        <p className="text-xs text-white/70 leading-relaxed">
          {studiosPayerNotice(policyQuery.data?.studiosPayMode, keyQuery.data)}
        </p>

        <label className="block space-y-1">
          <span className="text-xs text-white/80">Describe the image</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, 1000))}
            rows={3}
            className="w-full rounded-md bg-black/40 border border-white/15 p-2 text-sm text-white"
            placeholder="A small green crab waving"
          />
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={make.isPending || open || text.length === 0 || blocked}
          className="w-full min-h-[44px] rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-50 text-sm font-bold text-white"
        >
          {make.isPending
            ? 'Making the image...'
            : open
              ? waitingApproval ? 'Waiting for your approval...' : 'Running...'
              : blocked ? 'Change the text to make a new image' : 'Make image'}
        </button>

        {last && (
          <div className="space-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.mediaUrl(last.mediaPath)} alt="Your new image" className="w-full rounded-md border border-white/10" />
            <p className="text-xs text-emerald-300">{last.note}</p>
          </div>
        )}
        {error !== null && <p className="text-xs text-red-300">{studiosErrorText(error)}</p>}

        {(imagesQuery.data?.images.length ?? 0) > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-white/60">Recent images (yours and your agent&apos;s)</p>
            <div className="grid grid-cols-3 gap-1">
              {imagesQuery.data!.images.slice(0, 6).map((image) => (
                <a key={image.id} href={api.mediaUrl(image.mediaPath)} target="_blank" rel="noreferrer" title={image.prompt} className="block min-h-[44px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={api.mediaUrl(image.mediaPath)} alt={image.prompt} loading="lazy" className="w-full aspect-square object-cover rounded" />
                </a>
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-white/10 space-y-2">
          <p className="text-xs text-white/70">
            Use your own Studios account instead (optional). Paste an API key from mystudios.fun. Your linked wallet signs to approve
            each change. Only you can change this; your agent cannot.
          </p>
          {linked ? (
            <button
              type="button"
              onClick={() => removeKey.mutate()}
              disabled={removeKey.isPending}
              className="w-full min-h-[44px] rounded-md border border-white/20 text-sm text-white/80 hover:bg-white/10"
            >
              {removeKey.isPending ? 'Approve in your wallet...' : 'Remove my Studios key (pay from the agent wallet)'}
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="off"
                value={keyText}
                onChange={(e) => setKeyText(e.target.value.trim())}
                placeholder="chk_..."
                aria-label="Studios API key"
                className="flex-1 min-w-0 min-h-[44px] rounded-md bg-black/40 border border-white/15 px-2 text-sm text-white"
              />
              <button
                type="button"
                onClick={() => saveKey.mutate(keyText)}
                disabled={saveKey.isPending || keyText.length === 0}
                className="min-h-[44px] px-3 rounded-md bg-white/15 hover:bg-white/25 disabled:opacity-50 text-sm text-white"
              >
                {saveKey.isPending ? 'Approve...' : 'Save'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
