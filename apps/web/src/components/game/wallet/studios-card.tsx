'use client';

/**
 * StudiosCard: the human path for every Studios feature (MCP hub step 2 phase
 * 2b, phase 3 web). The human chooses who pays (agent wallet, own Studios API
 * key or own Studios sign-in), makes images, videos, character shots and
 * recast clips, and sees and deletes the stored media of the avatar (also the
 * media the agent made). Same service as the agent path
 * (POST /api/vendors/studios/{images,videos,characters,recasts}).
 * Saving or removing the key, the pay mode, the sign-in and each delete need a
 * signature from the human's linked wallet.
 *
 * Every form uses ONE request pattern (`useStudiosRequest`): the request key
 * stays with the exact input (operation + every field) until the request
 * ends, a 202 is polled every 4 s, the button stays off while the request
 * waits or runs, and an outcome that may have charged blocks the same input.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type StudiosAccepted, type StudiosOperationDone, type StudiosRequestView } from '@/lib/api';
import { WalletSignError, signMessageWithSolanaWallet } from '@/lib/solana-wallet';
import { useAvatar } from '@/hooks/use-avatar';
import { STUDIOS_APPROVALS_QUERY_KEY, useHumanSpendPolicy } from './spending-card';
import { StudiosPaySection, STUDIOS_OAUTH_QUERY, useStudiosReturnStore } from './studios-pay-mode';
import { CharacterForm, RecastForm, VideoForm } from './studios-forms';
import { StudiosMediaGallery, StudiosSigninMediaList } from './studios-media';
import { readStudiosSlot, studiosSlotId, useStudiosRequestStore } from './studios-request-store';

export const KEY_QUERY = ['studios-key'] as const;
export const IMAGES_QUERY = ['studios-images'] as const;

export type StudiosOperation = 'image' | 'video' | 'character_shots' | 'recast';
export type StudiosPayMode = 'wallet' | 'key' | 'signin';

/** The end of every "may have charged" text (`STUDIOS_MAY_HAVE_CHARGED_CODES`). For 30 minutes the server answers the same input with the first request. */
const MAY_HAVE_CHARGED_TAIL = ' Studios may have charged for it. Do not try it again for now. Check your Studios My Media and credits (when your agent wallet pays: check the wallet history).';

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
        return 'This request would pass your spend caps. Nothing was paid.';
      case 'payment_ambiguous':
        return `Studios did not confirm the result. The payment may have gone through; it counts toward your daily cap until it is checked.${MAY_HAVE_CHARGED_TAIL}`;
      case 'studios_key_invalid':
        return 'Your saved Studios API key does not work. Save it again under "How Studios is paid".';
      case 'studios_key_changed':
        return 'Your saved Studios key changed after this request, so it was not sent. Nothing was paid. Send it again.';
      case 'studios_account_refused':
        return 'Studios refused the call on your Studios account (for example, no credits left).';
      case 'studios_key_missing':
        return 'You chose your own Studios key to pay, but no key is saved. Nothing was paid.';
      case 'studios_signin_missing':
        return 'You chose your Studios sign-in to pay, but you are not signed in with Studios. Nothing was paid.';
      case 'studios_signin_broken':
        return 'Your Studios sign-in stopped working. Sign in with Studios again. Nothing was paid.';
      case 'studios_signin_changed':
        return 'You signed in with Studios again after this request, so it was not sent. Nothing was paid. Send it again.';
      case 'studios_connection_limit':
        return 'Your daily limit for ClawVille on Studios is too low for this. Nothing was sent or paid. Raise it on mystudios.fun, or wait for Studios to reset it.';
      case 'signin_option_unsupported':
        return 'Your Studios sign-in does not take one of these settings. Nothing was paid. Remove it and try again.';
      case 'operation_needs_studios_key':
        return 'Studios takes no wallet payment for this. Choose your Studios key or your Studios sign-in under "How Studios is paid". Nothing was paid.';
      case 'rate_limited':
        return 'Too many Studios requests. Wait one minute.';
      case 'awaiting_approval':
        return '"Ask me before each payment" is on, so this request waits in Approvals above. Approve it there with your linked wallet.';
      case 'already_running':
        return 'This request is already running. The result shows here when it is ready.';
      case 'running':
        return 'Studios is working on it. This can take a few minutes. The result shows here and in Your media when it is ready.';
      case 'approval_declined':
        return 'You declined this request in Approvals. Nothing was paid.';
      case 'approval_expired':
        return 'This request waited too long in Approvals and expired. Nothing was paid.';
      case 'approval_pending_limit':
        return 'Five requests already wait in Approvals. Approve or decline them first.';
      case 'daily_limit':
        return 'Your number per day for this kind of Studios request is used up. Try again after 00:00 UTC, or raise the number in Spending above.';
      case 'hosted_daily_cap':
        return 'Your hosted agent used its own daily cap for this. Try again after 00:00 UTC.';
      case 'media_quota_full':
        return 'Your media storage is full (500 MB). Nothing was paid. Delete old items in Your media below.';
      case 'interrupted_not_paid':
        return 'The ClawVille server restarted before anything was paid. Nothing was paid. Try again.';
      case 'job_failed':
        return 'Studios says the job failed. Studios gives back the credits of a failed job. Change something before you try again.';
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
      case 'studios_signin_needs_wallet_proof':
      case 'studios_signin_invalid_wallet_proof':
      case 'media_delete_needs_wallet_proof':
      case 'media_delete_invalid_wallet_proof':
        return 'Your wallet signature did not match. Try again and approve the request in your wallet.';
      case 'studios_signin_needs_wallet_link':
        return 'Link your own wallet in the wallet panel first. It signs to approve a Studios sign-in or sign-out.';
      case 'studios_signin_human_only':
        return 'Only you can sign in with Studios or sign out, from your own browser sign-in.';
      case 'studios_signin_needs_human_login':
        return 'For your safety, sign out and sign in again in this browser. Then sign in with Studios.';
      case 'studios_signin_bad_redirect':
        return 'The Studios sign-in is not available now. Nothing changed. Try again later.';
      case 'media_delete_needs_wallet_link':
        return 'Link your own wallet in the wallet panel first. It signs to delete media.';
      case 'media_delete_human_only':
        return 'Only you can delete media, from your own browser sign-in.';
      case 'media_delete_needs_human_login':
        return 'For your safety, sign out and sign in again in this browser. Then delete the media.';
      case 'not_found':
        return 'This item is gone already.';
      case 'request_not_found':
        return 'This request was not found.';
      case 'wallet_missing':
        return 'Your avatar has no agent wallet yet.';
      case 'payment_prepare_failed':
        return 'The payment could not be prepared. Check that your agent wallet holds USDC. Nothing was paid.';
      case 'vendor_unreachable':
      case 'vendor_refused':
      case 'vendor_quote_invalid':
      case 'vendor_pay_to_changed':
        return 'Studios refused this or is not available now, or its price changed. Nothing was paid.';
      case 'vendor_reply_unreadable':
        return 'Studios sent a reply that ClawVille could not read. Try again later.';
      case 'duplicate_request':
        return 'This request ended earlier, or it did not finish. Check Your media before you send it again.';
      case 'already_done':
        return 'This request finished already. Its result is in Your media.';
      case 'image_missing':
        return `Studios sent no readable image.${MAY_HAVE_CHARGED_TAIL}`;
      case 'outcome_unknown':
        return `Studios did not tell us the result.${MAY_HAVE_CHARGED_TAIL}`;
      case 'job_timeout':
        return `Studios took too long, and we stopped waiting.${MAY_HAVE_CHARGED_TAIL}`;
      case 'result_lost':
        return `The result was lost after the call.${MAY_HAVE_CHARGED_TAIL}`;
      case 'media_missing':
        return `Studios finished, but we could not get the media.${MAY_HAVE_CHARGED_TAIL}`;
      case 'payload_too_large':
        return 'The text is too long.';
      case 'invalid_request':
        return 'Check the settings and try again. A start image or a photo must be one of your stored images.';
      default:
        break;
    }
    if (error.status === 400) return 'Check the settings and try again.';
  }
  return 'That did not work. Try again later.';
}

/** The pay mode in force: the human's choice, or (not chosen) the saved key if any, else the wallet. Same rule as the server. */
export function effectiveStudiosPayMode(
  payMode: StudiosPayMode | null | undefined,
  key: { linked: boolean } | undefined,
): StudiosPayMode {
  return payMode ?? (key?.linked ? 'key' : 'wallet');
}

/** What each pay mode can make (the server's operation registry). */
const MODE_OPERATIONS: Record<StudiosPayMode, readonly StudiosOperation[]> = {
  wallet: ['image', 'video'],
  key: ['image', 'video', 'character_shots', 'recast'],
  signin: ['image', 'video', 'character_shots', 'recast'],
};

export function operationAllowed(mode: StudiosPayMode, operation: StudiosOperation): boolean {
  return MODE_OPERATIONS[mode].includes(operation);
}

/**
 * Who pays for the next request, from the human's chosen pay mode (spend
 * rules); not chosen = the saved key if any, else the agent wallet. The same
 * rule as the server (`resolveStudiosPayer`).
 */
export function studiosPayerNotice(
  payMode: StudiosPayMode | null | undefined,
  key: { linked: boolean; last4: string | null } | undefined,
): string {
  const mode = effectiveStudiosPayMode(payMode, key);
  if (mode === 'signin') {
    return 'Studios is paid with your Studios sign-in. Studios bills your Studios credits and keeps every result in My Media.';
  }
  if (mode === 'key') {
    return key?.linked
      ? `Studios is paid with your own Studios account (key ending ${key.last4 ?? ''}). Studios bills your credits and keeps every result in My Media.`
      : 'You chose your own Studios key to pay, but no key is saved. Save it under "How Studios is paid". Until then nothing is made.';
  }
  return 'Studios is paid from your agent wallet in USDC, only inside your spend caps. An image costs about half a cent. Studios does not keep these results in your Studios account.';
}

export function newIdempotencyKey(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `web-${random}`.slice(0, 64);
}

/**
 * Refusals where the server recorded the request as finished and nothing was
 * charged (the server's NOT_CHARGED_FAILURES): the next click may use a new
 * request key. After any other outcome (a lost reply, rate_limited,
 * payment_ambiguous, image_missing) the form keeps the key, so a
 * retry of the same input returns the first result instead of paying again.
 */
const FINAL_NOTHING_CHARGED = new Set([
  'spend_rules_not_set', 'vendor_not_allowed', 'over_per_call_cap', 'over_daily_cap', 'vendor_unreachable',
  'vendor_refused', 'vendor_quote_invalid', 'vendor_pay_to_changed', 'wallet_missing', 'payment_prepare_failed',
  'studios_key_invalid', 'studios_key_changed', 'studios_account_refused', 'daily_limit', 'hosted_daily_cap',
  'studios_key_missing', 'studios_signin_missing', 'studios_signin_broken', 'studios_signin_changed', 'studios_connection_limit',
  'signin_option_unsupported', 'operation_needs_studios_key', 'interrupted_not_paid', 'job_failed', 'media_quota_full',
  // A replay of a request the human declined, or that expired, ends it: a new click needs a new key.
  'approval_declined', 'approval_expired',
]);

/** Codes that say where a request is, not that something went wrong. */
const STATUS_CODES = new Set(['running', 'awaiting_approval', 'already_running']);

/**
 * The status line for a request the form attached to after
 * `409 duplicate_request_in_flight` (the same input already made it, in this
 * or another tab). Its own status decides the text; polling shows the end.
 */
export function attachedStatusCode(status: string | undefined): 'awaiting_approval' | 'already_running' {
  return status === 'awaiting_approval' ? 'awaiting_approval' : 'already_running';
}

const OPEN_STATUSES = new Set(['awaiting_approval', 'pending', 'running']);
const ENDED_STATUSES = new Set(['done', 'failed', 'ambiguous', 'declined', 'expired']);

/**
 * What a refused POST says about a request the same input or key already made.
 * Any error body with `requestId` and a `status` names that request:
 * - not ended (`awaiting_approval`, `pending`, `running`): attach and read it;
 * - ended: drop the key and show that request's own end (`failureCode`, or the
 *   body's code; a "may have charged" code gets its "may have charged" text).
 *   A same-key replay of an ended request answers with that request's code
 *   (for example `outcome_unknown` or `studios_key_invalid`), not only
 *   `duplicate_request`.
 * `409 duplicate_request_in_flight` with an id always attaches (the server
 * also answers it for 30 minutes after a "may have charged" end; the read then
 * shows that end). `duplicate_request` with no id (an older server): drop the
 * key, show the code. null: any other refusal.
 */
export function studiosReplayAnswer(error: unknown):
  | null
  | { kind: 'attach'; requestId: string; code: 'awaiting_approval' | 'already_running' }
  | { kind: 'ended'; code: string } {
  if (!(error instanceof ApiError)) return null;
  const { requestId, requestStatus: status } = error;
  if (error.code === 'duplicate_request_in_flight' && requestId) {
    return { kind: 'attach', requestId, code: attachedStatusCode(status) };
  }
  if (requestId && status && OPEN_STATUSES.has(status)) {
    return { kind: 'attach', requestId, code: attachedStatusCode(status) };
  }
  if (requestId && status && ENDED_STATUSES.has(status)) {
    if (status === 'done') return { kind: 'ended', code: 'already_done' };
    if (status === 'declined') return { kind: 'ended', code: 'approval_declined' };
    if (status === 'expired') return { kind: 'ended', code: 'approval_expired' };
    if (status === 'ambiguous') return { kind: 'ended', code: 'payment_ambiguous' };
    const own = error.requestFailureCode ?? (error.code !== 'duplicate_request' ? error.code : undefined);
    return { kind: 'ended', code: own ?? 'duplicate_request' };
  }
  if (error.code === 'duplicate_request') return { kind: 'ended', code: 'duplicate_request' };
  return null;
}


export function keepsRequestKey(error: unknown): boolean {
  return !(error instanceof ApiError && typeof error.code === 'string' && FINAL_NOTHING_CHARGED.has(error.code));
}

/** A stable text for a request body: the same fields and values give the same text. */
export function studiosInputFingerprint(body: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sort((value as Record<string, unknown>)[k])]));
    }
    return value;
  };
  return JSON.stringify(sort(body));
}

/** The request of the current input: its key, and its id after a 202. */
export interface StudiosPendingRequest {
  operation: StudiosOperation;
  /** `studiosInputFingerprint` of the body. */
  input: string;
  key: string;
  /** Set after a 202 (waiting for approval or running): poll it until it ends. */
  requestId: string | null;
}

/**
 * The request to send. The same operation and input reuse the open key, so a
 * second click returns the same request and never pays twice. Only a changed
 * input or operation (or no open request: it ended) gets a new key.
 */
export function studiosRequestFor(
  pending: StudiosPendingRequest | null,
  operation: StudiosOperation,
  input: string,
  newKey: () => string,
): StudiosPendingRequest {
  if (pending && pending.operation === operation && pending.input === input) return pending;
  return { operation, input, key: newKey(), requestId: null };
}

/** One result item to show: a stored image or video. */
export interface StudiosResultItem {
  mediaPath: string;
  video: boolean;
}

const VIDEO_OPERATIONS = new Set(['video', 'recast']);

function resultItems(
  operation: string,
  media: Array<{ slot: string; mediaPath: string }> | undefined,
  mediaPath: string | null,
): StudiosResultItem[] {
  const list = media && media.length > 0 ? media : mediaPath ? [{ slot: VIDEO_OPERATIONS.has(operation) ? 'video' : 'image', mediaPath }] : [];
  return list.map((m) => ({ mediaPath: m.mediaPath, video: m.slot === 'video' || VIDEO_OPERATIONS.has(operation) }));
}

const NOT_COPIED_NOTE = 'Studios made it. It is in your Studios My Media. ClawVille could not copy it here.';

const TERMINAL_STATUSES = new Set<StudiosRequestView['status']>(['done', 'failed', 'ambiguous', 'declined', 'expired']);

/**
 * What the polled request says. null: it has not ended yet (keep the key, keep
 * the button off). Else the end: the media, or the code to show. The server
 * guards a "may have charged" input (409 with the first request id).
 */
export function studiosRequestOutcome(view: StudiosRequestView | undefined):
  | null
  | { kind: 'done'; media: StudiosResultItem[]; note: string }
  | { kind: 'failed'; code: string } {
  if (!view || !TERMINAL_STATUSES.has(view.status)) return null;
  if (view.status === 'done') {
    const media = resultItems(view.operation, view.media, view.mediaPath);
    return {
      kind: 'done',
      media,
      note: media.length === 0 ? NOT_COPIED_NOTE : view.mode === 'wallet' ? 'Paid from your agent wallet.' : 'Made with your Studios account.',
    };
  }
  if (view.status === 'declined') return { kind: 'failed', code: 'approval_declined' };
  if (view.status === 'expired') return { kind: 'failed', code: 'approval_expired' };
  if (view.status === 'ambiguous') return { kind: 'failed', code: 'payment_ambiguous' };
  return { kind: 'failed', code: view.code ?? 'failed' };
}

/** How often an open request is read: every 4 s until it ends, then never. */
export const STUDIOS_POLL_MS = 4000;
export function studiosPollInterval(view: StudiosRequestView | undefined): number | false {
  return studiosRequestOutcome(view) ? false : STUDIOS_POLL_MS;
}

/** The finished answer of a POST (no 202), as items and a note. */
export function studiosDoneResult(operation: StudiosOperation, result: StudiosOperationDone): { media: StudiosResultItem[]; note: string } {
  const media = resultItems(result.operation ?? operation, result.media, result.mediaPath);
  if (media.length === 0) return { media, note: NOT_COPIED_NOTE };
  return {
    media,
    note: result.mode !== 'wallet'
      ? 'Made with your Studios account.'
      : `Paid from your agent wallet: ${((result.paidUsdCents ?? 0) / 100).toFixed(2)} USD.`,
  };
}

type StudiosSend = (body: Record<string, unknown>, key: string) => Promise<StudiosOperationDone | StudiosAccepted>;

/**
 * The shared request flow of one form. `submit(body)` sends the body with the
 * key of that exact input; the state says what the form shows.
 *
 * The open request (key, request id) lives in
 * `studios-request-store.ts` per avatar and operation, outside the modal's
 * life and across a reload of the tab: closing the wallet panel after a 202
 * and sending the same input again reuses the same key, so the server returns
 * the same request and never charges twice. On mount a restored open request
 * is read again until it ends. The server is the authority on repeats: the
 * same input that waits, runs or may have charged answers 409 with the first
 * request id, and the form attaches to it.
 */
export function useStudiosRequest(operation: StudiosOperation, send: StudiosSend) {
  const queryClient = useQueryClient();
  const { signedIn } = useHumanSpendPolicy();
  const { data: avatar } = useAvatar();
  const avatarId = (avatar as { id?: string } | null | undefined)?.id ?? null;
  const slotId = avatarId ? studiosSlotId(avatarId, operation) : null;
  const ensureLoaded = useStudiosRequestStore((st) => st.ensureLoaded);
  const update = useStudiosRequestStore((st) => st.update);
  useEffect(() => ensureLoaded(), [ensureLoaded]);
  const slot = useStudiosRequestStore((st) => readStudiosSlot(st.slots, slotId));
  // The request key for the current input. A retry after a lost reply, or a
  // click while the request waits or runs, reuses it, so the server returns
  // the same request instead of paying again.
  const pending = slot.pending;
  const [last, setLast] = useState<{ media: StudiosResultItem[]; note: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  // After a 202 the request ends in the background: read it until it ends.
  const openRequestId = pending?.requestId ?? null;
  const requestQuery = useQuery({
    queryKey: ['studios-request', openRequestId],
    queryFn: () => api.studiosRequest(openRequestId!),
    enabled: signedIn && openRequestId !== null,
    refetchInterval: (query) => studiosPollInterval(query.state.data),
    retry: 2,
  });
  const outcome = openRequestId !== null && requestQuery.data?.requestId === openRequestId
    ? studiosRequestOutcome(requestQuery.data)
    : null;

  useEffect(() => {
    if (!outcome || !pending || !slotId) return;
    // The request ended: show the result and drop the key (the next click is a new request).
    if (outcome.kind === 'done') {
      setError(null);
      setLast({ media: outcome.media, note: outcome.note });
      update(slotId, { pending: null });
    } else {
      setError(new ApiError(outcome.code, 200, outcome.code));
      update(slotId, { pending: null });
    }
    queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
  }, [outcome, pending, slotId, update, queryClient]);

  const make = useMutation({
    mutationFn: (vars: { slotId: string; request: StudiosPendingRequest; body: Record<string, unknown> }) => send(vars.body, vars.request.key),
    onMutate: () => {
      setError(null);
      setLast(null);
    },
    // These run even when the form unmounted meanwhile (the modal closed):
    // the store keeps what the server answered.
    onSuccess: (result, vars) => {
      // "Ask me before each payment" (202 awaiting_approval), a long job or
      // any sign-in request (202 running): keep the key and the request id
      // until the request ends.
      if ('status' in result) {
        update(vars.slotId, { pending: { ...vars.request, requestId: result.requestId } });
        setError(new ApiError(result.status, 202, result.status));
        if (result.status === 'awaiting_approval') queryClient.invalidateQueries({ queryKey: STUDIOS_APPROVALS_QUERY_KEY });
        return;
      }
      update(vars.slotId, { pending: null });
      setLast(studiosDoneResult(operation, result));
      queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
    },
    onError: (err, vars) => {
      const replay = studiosReplayAnswer(err);
      if (replay?.kind === 'attach') {
        // The same input already made a request that has not ended (this tab,
        // another tab, or a lost reply): attach to it and read it. Not an error.
        update(vars.slotId, { pending: { ...vars.request, requestId: replay.requestId } });
        setError(new ApiError(replay.code, 202, replay.code));
        return;
      }
      if (replay?.kind === 'ended') {
        // A replay of a request that already ended: never keep a dead key.
        update(vars.slotId, { pending: null });
        setError(new ApiError(replay.code, 200, replay.code));
        queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
        return;
      }
      setError(err);
      if (!keepsRequestKey(err)) update(vars.slotId, { pending: null });
      queryClient.invalidateQueries({ queryKey: IMAGES_QUERY });
    },
  });

  // A request that waits or runs keeps the button off until it ends.
  const open = openRequestId !== null && outcome === null;
  const waitingApproval = open && (requestQuery.data
    ? requestQuery.data.status === 'awaiting_approval'
    : error instanceof ApiError && error.code === 'awaiting_approval');
  const runningCode = waitingApproval ? 'awaiting_approval' : error instanceof ApiError && error.code === 'already_running' ? 'already_running' : 'running';
  // A request restored after the modal reopened (or a reload) says what it waits for.
  const shownError = error ?? (open ? new ApiError(runningCode, 202, runningCode) : null);

  const submit = (body: Record<string, unknown>) => {
    if (open || make.isPending || !slotId) return;
    const input = studiosInputFingerprint(body);
    const request = studiosRequestFor(pending, operation, input, newIdempotencyKey);
    update(slotId, { pending: request });
    make.mutate({ slotId, request, body });
  };

  return {
    submit,
    sending: make.isPending,
    open,
    waitingApproval,
    /** The button stays off: sending, waiting or running, or the avatar is not loaded yet. */
    busy: make.isPending || open || slotId === null,
    /** Keep the section open while a request is in use. */
    inUse: make.isPending || open,
    last,
    error: shownError,
  };
}

export type StudiosRequestState = ReturnType<typeof useStudiosRequest>;

/** The submit button text for one form. */
export function submitLabel(state: Pick<StudiosRequestState, 'sending' | 'open' | 'waitingApproval'>, idle: string): string {
  if (state.sending) return 'Sending...';
  if (state.open) return state.waitingApproval ? 'Waiting for your approval...' : 'Running...';
  return idle;
}

/** The result and the error line under one form. */
function isStatusLine(error: unknown): boolean {
  return error instanceof ApiError && typeof error.code === 'string' && STATUS_CODES.has(error.code);
}

export function StudiosRequestResult({ state }: { state: StudiosRequestState }) {
  return (
    <>
      {state.last && (
        <div className="space-y-1">
          {state.last.media.map((item) => <StudiosMediaView key={item.mediaPath} item={item} alt="Your new result" />)}
          <p className="text-xs text-emerald-300">{state.last.note}</p>
        </div>
      )}
      {state.error !== null && (
        <p className={`text-xs ${isStatusLine(state.error) ? 'text-white/75' : 'text-red-300'}`}>{studiosErrorText(state.error)}</p>
      )}
    </>
  );
}

/** One stored image or video. A video never plays by itself (preload none, no autoplay). */
export function StudiosMediaView({ item, alt }: { item: StudiosResultItem; alt: string }) {
  const src = api.mediaUrl(item.mediaPath);
  if (item.video) {
    return <video src={src} controls preload="none" playsInline className="w-full rounded-md border border-white/10 bg-black" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" className="w-full rounded-md border border-white/10" />;
}

/** A collapsible section; `forceOpen` keeps it open while its request is in use. */
export function StudiosSection({
  title,
  forceOpen = false,
  defaultOpen = false,
  children,
}: {
  title: string;
  forceOpen?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = open || forceOpen;
  return (
    <div className="rounded-md border border-white/10 bg-black/20">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        className="w-full min-h-[44px] px-3 flex items-center justify-between gap-2 text-left text-sm font-semibold text-white"
      >
        <span className="min-w-0 break-words">{title}</span>
        <span aria-hidden className="shrink-0 text-white/60">{shown ? '−' : '+'}</span>
      </button>
      {shown && <div className="px-3 pb-3 space-y-3">{children}</div>}
    </div>
  );
}

/** Text shown in place of a form the pay mode cannot use. */
export function walletModeBlockedText(): string {
  return 'Your agent wallet cannot pay for this: Studios takes no wallet payment for character shots or recast. To use it, choose "My Studios API key" or "My Studios sign-in" under "How Studios is paid".';
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

/** The saved Studios API key: save or remove it (the linked wallet signs each change). */
function StudiosKeyBlock() {
  const queryClient = useQueryClient();
  const { signedIn } = useHumanSpendPolicy();
  const [keyText, setKeyText] = useState('');
  const keyQuery = useQuery({ queryKey: KEY_QUERY, queryFn: api.studiosKeyStatus, enabled: signedIn, retry: false });
  const saveKey = useMutation({
    mutationFn: async (key: string) => {
      // Check the shape before the wallet is asked to sign anything.
      if (!/^chk_[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ApiError('invalid_studios_key', 400, 'invalid_studios_key');
      return api.saveStudiosKey(key, await signKeyChange({ action: 'save', last4: key.slice(-4), sha256: await sha256Hex(key) }));
    },
    onSuccess: (status) => {
      setKeyText('');
      queryClient.setQueryData(KEY_QUERY, status);
    },
  });
  const removeKey = useMutation({
    mutationFn: async () => api.deleteStudiosKey(await signKeyChange({ action: 'remove' })),
    onSuccess: (status) => queryClient.setQueryData(KEY_QUERY, status),
  });
  const linked = keyQuery.data?.linked === true;
  const failure = saveKey.error ?? removeKey.error;

  return (
    <div className="pt-2 border-t border-white/10 space-y-2">
      <p className="text-xs font-semibold text-white/85">My Studios API key</p>
      <p className="text-xs text-white/70">
        Paste an API key from mystudios.fun (optional). Your linked wallet signs to approve each change. Only you can change
        this; your agent cannot.
      </p>
      {linked ? (
        <button
          type="button"
          onClick={() => removeKey.mutate()}
          disabled={removeKey.isPending}
          className="w-full min-h-[44px] rounded-md border border-white/20 text-sm text-white/80 hover:bg-white/10"
        >
          {removeKey.isPending ? 'Approve in your wallet...' : `Remove my Studios key (ending ${keyQuery.data?.last4 ?? ''})`}
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
      {failure && <p className="text-xs text-red-300">{studiosErrorText(failure)}</p>}
    </div>
  );
}

/** The image form. */
function ImageForm({ state }: { state: StudiosRequestState }) {
  const [prompt, setPrompt] = useState('');
  const text = prompt.trim();
  const body = { prompt: text };
  return (
    <>
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
        onClick={() => state.submit(body)}
        disabled={state.busy || text.length === 0}
        className="w-full min-h-[44px] rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-50 text-sm font-bold text-white"
      >
        {submitLabel(state, 'Make image')}
      </button>
      <StudiosRequestResult state={state} />
    </>
  );
}

export function StudiosCard() {
  const { signedIn, query: policyQuery } = useHumanSpendPolicy();
  const keyQuery = useQuery({ queryKey: KEY_QUERY, queryFn: api.studiosKeyStatus, enabled: signedIn, retry: false });
  const oauthQuery = useQuery({ queryKey: STUDIOS_OAUTH_QUERY, queryFn: api.studiosOAuthStatus, enabled: signedIn, retry: false });
  const returned = useStudiosReturnStore((s) => s.message);
  const image = useStudiosRequest('image', (body, key) => api.studiosImage(body as { prompt: string }, key));
  const video = useStudiosRequest('video', api.studiosVideo);
  const character = useStudiosRequest('character_shots', api.studiosCharacter);
  const recast = useStudiosRequest('recast', api.studiosRecast);

  if (!signedIn) return null;
  const mode = effectiveStudiosPayMode(policyQuery.data?.studiosPayMode, keyQuery.data);
  const signinActive = oauthQuery.data?.linked === true && oauthQuery.data.status === 'active';

  return (
    <div className="space-y-2" data-testid="studios-card">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base">🎨</span>
        <h3 className="font-bold text-sm text-white">Studios</h3>
      </div>
      <div className="bg-violet-500/10 border border-violet-400/25 rounded-lg p-3 space-y-2 min-w-0">
        <p className="text-xs text-white/70 leading-relaxed">
          {studiosPayerNotice(policyQuery.data?.studiosPayMode, keyQuery.data)}
        </p>
        {returned && (
          <p role="status" className={`text-xs leading-relaxed ${returned.ok ? 'text-emerald-300' : 'text-red-300'}`}>{returned.text}</p>
        )}

        <StudiosSection title="How Studios is paid" forceOpen={returned !== null}>
          <StudiosPaySection />
          <StudiosKeyBlock />
        </StudiosSection>

        <StudiosSection title="Image" forceOpen={image.inUse}>
          <ImageForm state={image} />
        </StudiosSection>
        <StudiosSection title="Video" forceOpen={video.inUse}>
          <VideoForm state={video} mode={mode} perCallCapUsdCents={policyQuery.data?.perCallCapUsdCents ?? null} />
        </StudiosSection>
        <StudiosSection title="Character shots" forceOpen={character.inUse}>
          {operationAllowed(mode, 'character_shots') || character.inUse
            ? <CharacterForm state={character} />
            : <p className="text-xs text-amber-200 leading-relaxed">{walletModeBlockedText()}</p>}
        </StudiosSection>
        <StudiosSection title="Recast" forceOpen={recast.inUse}>
          {operationAllowed(mode, 'recast') || recast.inUse
            ? <RecastForm state={recast} />
            : <p className="text-xs text-amber-200 leading-relaxed">{walletModeBlockedText()}</p>}
        </StudiosSection>

        <StudiosSection title="Your media">
          <StudiosMediaGallery />
        </StudiosSection>
        {signinActive && (
          <StudiosSection title="My Studios media">
            <StudiosSigninMediaList />
          </StudiosSection>
        )}
      </div>
    </div>
  );
}
