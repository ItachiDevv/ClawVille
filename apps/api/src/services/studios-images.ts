/**
 * Studios calls for an avatar, in the mode its human chose (MCP hub step 2
 * phase 2b; every operation since phase 3b). ONE service for every surface:
 * the human web form and REST routes, the MCP tools and the hosted-agent
 * `[ACTION:]` verbs. The operations and their rules live in
 * `vendors/studios-operations.ts` (image, video, character_shots, recast).
 *
 *   - mode 'account' (A): the human saved their own Studios API key. Studios
 *     bills the human's Studios credits and saves the result to their My Media.
 *     ClawVille moves no money and writes no spend-ledger row.
 *   - mode 'wallet' (B): no key saved. The avatar wallet pays with x402 inside
 *     the human's spend rules (`outbound-x402.ts`). Only image and video take
 *     x402; character shots and recast refuse with `operation_needs_studios_key`.
 *
 * Every request first reserves a `vendor_call_requests` row (unique per
 * avatar + idempotency key) under a per-avatar advisory lock, so a retry never
 * bills twice in either mode. A retry of a finished request returns the same
 * result; a retry of a running one returns 'running'; a retry of a failed one
 * is `duplicate_request`. In account mode the row keeps the SHA-256 of the key
 * it was made with (never the key).
 *
 * Long jobs (video, recast) never hold an HTTP request: the row is 'running'
 * and `studios-job-runner.ts` finishes it in the API process; the agent reads
 * GET /api/vendors/studios/requests/:id. An ambiguous outcome is never retried.
 *
 * "Ask me before each payment" (founder go 2026-11-06, migration 0093): when
 * the human turns `requireApproval` on, EVERY request (any actor, any
 * surface, the human's own web form too) runs only the checks that need no
 * vendor call, then its row waits as `awaiting_approval` for 15 minutes.
 * Nothing is called, signed or paid. The human approves with a signature from
 * their linked wallet over terms that name the operation (`approveStudiosRequest`:
 * the SAME pipeline, every cap and limit checked again at that moment) or
 * declines it; nobody answering makes it `expired` (lazily, on the next read
 * or write of that avatar's rows).
 *
 * Limits are the human's own (founder 2026-11-05). The spend caps bound the
 * wallet mode. Per-UTC-day counts bound each operation class: images on the
 * human's own key (`studiosKeyImagesPerDay`, key mode only, as in phase 2b),
 * and videos, character shots and recasts in BOTH modes (phase 3b). The
 * hosted verbs also have a fixed per-avatar daily cap (`hostedPerDay`). A
 * request counts on the UTC day it ran (an approved one on its approve day); a
 * waiting request counts as a reservation; a declined or expired one does not.
 *
 * Media is stored in `avatar_media` (`studios-media.ts`: checked bytes, a
 * per-avatar quota checked BEFORE any spend) and served at GET /api/media/:id.
 * Vendor text is untrusted: only media and our own status leave here.
 */

import { createHash, randomUUID } from 'crypto';
import { and, asc, avatarMedia, db, desc, eq, inArray, isNull, or, sql, userSpendPolicies, vendorCallRequests, vendorSpendLedger } from '@clawville/database';
import {
  SPEND_APPROVAL_MAX_AWAITING,
  SPEND_APPROVAL_TTL_MS,
  type StudiosOperationId,
  type VendorCallApprovalView,
  type VendorCallStatus,
} from '@clawville/shared';
import { callVendorWithAvatarWallet, readJsonCapped, type LedgerTx, type VendorCallFailure } from './outbound-x402';
import { policyColumns, toSpendPolicyView } from './spend-policy';
import { promptSha256, vendorKeyRef, type ApprovalTerms } from './spend-policy-proof';
import { loadVendorKey } from './vendor-credentials';
import { STUDIOS_IMAGE_MODELS, STUDIOS_PAY_TO, type StudiosImageModel } from './vendors/studios';
import {
  MEDIA_QUOTA_BYTES_PER_AVATAR,
  fetchStudiosArtifact,
  maxBytesFor,
  sniffMedia,
  storedMediaBytes,
  type MediaKind,
} from './studios-media';
import {
  STUDIOS_OPERATIONS,
  canonicalJson,
  perDayLimit,
  readRecastPoll,
  readRecastStart,
  recastPollUrl,
  type MediaSource,
  type StudiosMode,
  type StudiosOperationDef,
  type StudiosParams,
} from './vendors/studios-operations';

export const MEDIA_KEEP_PER_AVATAR = 50;
const ATOMIC_PER_CENT = 10_000n;
/** The hosted verb keeps at most one request waiting; it must not queue more. */
const HOSTED_MAX_AWAITING = 1;
/** A long job's lease; the runner renews it every LEASE_RENEW_MS. */
export const JOB_LEASE_MS = 120_000;
/** Hard end of a recast job after its start call. */
export const RECAST_DEADLINE_MS = 30 * 60_000;
export const RECAST_POLL_MS = 15_000;

export type StudiosImageFailure =
  | VendorCallFailure
  | 'studios_key_invalid'
  | 'studios_key_changed'
  | 'studios_account_refused'
  | 'operation_needs_studios_key'
  | 'image_missing'
  | 'media_missing'
  | 'media_quota_full'
  | 'daily_limit'
  | 'hosted_daily_cap'
  | 'outcome_unknown'
  | 'interrupted_not_paid'
  | 'result_lost'
  | 'job_failed'
  | 'job_timeout'
  | 'approval_pending_limit'
  | 'approval_declined'
  | 'approval_expired'
  | 'approval_not_found'
  | 'approval_not_awaiting'
  | 'approval_mode_changed'
  | 'approval_terms_changed';

/** The request waits for the human (HTTP 202). Nothing was called or paid. */
export interface StudiosImageAwaiting {
  ok: false;
  code: 'awaiting_approval';
  httpStatus: 202;
  message: string;
  ledgerId: null;
  requestId: string;
  expiresAt: string;
}

/** A long job runs in the background (HTTP 202). Read the request for the result. */
export interface StudiosRunning {
  ok: false;
  code: 'running';
  httpStatus: 202;
  message: string;
  ledgerId: null;
  requestId: string;
}

/** A finished image (phase 2b shape, unchanged). */
export interface StudiosImageSuccess {
  ok: true;
  mode: 'wallet' | 'account';
  mediaId: string;
  /** Path on the ClawVille API (prefix the API base URL). */
  mediaPath: string;
  /** Wallet mode only. */
  ledgerId: string | null;
  paidUsdCents: number | null;
  txSignature: string | null;
}

export interface StudiosMediaItem {
  slot: string;
  mediaId: string;
  mediaPath: string;
}

/** A finished video, character-shot or recast request. */
export interface StudiosOperationSuccess {
  ok: true;
  operation: Exclude<StudiosOperationId, 'image'>;
  requestId: string;
  mode: 'wallet' | 'account';
  /** The first stored item; null when nothing was copied (see `note`). */
  mediaId: string | null;
  mediaPath: string | null;
  media: StudiosMediaItem[];
  /** Key mode: the item in the human's Studios My Media (reference only). */
  vendorMediaId: string | null;
  /** 'media_not_copied': Studios made it (key mode, it is in My Media) but ClawVille could not copy it. */
  note: 'media_not_copied' | null;
  ledgerId: string | null;
  paidUsdCents: number | null;
  txSignature: string | null;
}

export type StudiosImageResult = StudiosImageSuccess | StudiosImageRefusal | StudiosImageAwaiting;
export type StudiosOperationResult = StudiosImageSuccess | StudiosOperationSuccess | StudiosImageRefusal | StudiosImageAwaiting | StudiosRunning;

/** A refusal or failure with our own code and message. */
export interface StudiosImageRefusal { ok: false; code: StudiosImageFailure; message: string; httpStatus: FailureStatus; ledgerId: string | null }

type FailureStatus = 400 | 402 | 403 | 404 | 409 | 413 | 429 | 502;

const MESSAGES: Record<StudiosImageFailure, { httpStatus: FailureStatus; message: string }> = {
  duplicate_request: { httpStatus: 409, message: 'This Idempotency-Key was already used for a request that did not finish. Do not retry it; use a new key only for a new image.' },
  daily_limit: { httpStatus: 429, message: "Your human's daily limit for images on their own Studios key is used up. Try again after 00:00 UTC, or ask your human to raise it in the wallet panel (Spending)." },
  hosted_daily_cap: { httpStatus: 429, message: 'Your hosted agent reached its own daily cap for this Studios action. Try again after 00:00 UTC.' },
  media_quota_full: { httpStatus: 413, message: 'Your avatar media storage is full (500 MB). Nothing was called or paid. Ask your human to delete old media in ClawVille first.' },
  operation_needs_studios_key: { httpStatus: 403, message: "This Studios action works only with your human's own Studios key (Studios takes no wallet payment for it). Nothing was paid. Ask your human to save their Studios key in the wallet panel." },
  vendor_unreachable: { httpStatus: 502, message: 'Studios did not answer. Nothing was paid. Try again later.' },
  vendor_refused: { httpStatus: 502, message: 'Studios refused the request before payment. Nothing was paid.' },
  vendor_quote_invalid: { httpStatus: 502, message: 'Studios sent a price ClawVille cannot accept. Nothing was paid.' },
  vendor_pay_to_changed: { httpStatus: 502, message: 'Studios asked to be paid at an unknown wallet. Nothing was paid.' },
  spend_rules_not_set: { httpStatus: 403, message: 'Spend caps are not set. Ask your human to set them in the wallet panel (Spending).' },
  vendor_not_allowed: { httpStatus: 403, message: 'Studios is not an allowed paid tool. Ask your human to allow it in the wallet panel (Spending).' },
  over_per_call_cap: { httpStatus: 402, message: 'This call costs more than the per-call cap. Nothing was paid.' },
  over_daily_cap: { httpStatus: 402, message: 'This call would pass the daily cap. Nothing was paid.' },
  wallet_missing: { httpStatus: 403, message: 'This avatar has no wallet. Nothing was paid.' },
  payment_prepare_failed: { httpStatus: 502, message: 'The payment could not be signed. Nothing was paid. Try again later.' },
  payment_ambiguous: { httpStatus: 502, message: 'Studios did not confirm the result. The payment may have gone through (for example, the wallet may not hold enough USDC, or the reply was lost). Do not retry; it counts toward the daily cap until it is checked on chain.' },
  studios_key_invalid: { httpStatus: 403, message: 'The saved Studios API key does not work. Ask your human to save it again in the wallet panel. Nothing was paid.' },
  studios_key_changed: { httpStatus: 409, message: 'The saved Studios key changed after this request was made, so it was not sent. Nothing was paid. Send a new request.' },
  studios_account_refused: { httpStatus: 402, message: "Studios refused the call on your human's Studios account (for example, no credits left). ClawVille paid nothing." },
  image_missing: { httpStatus: 502, message: 'Studios sent no readable image. Do not retry; contact support with the ledgerId if one is shown.' },
  media_missing: { httpStatus: 502, message: 'Studios sent no media that ClawVille could store. Do not retry; contact support with the ledgerId if one is shown.' },
  outcome_unknown: { httpStatus: 502, message: "Do not retry; ask your human to check their Studios My Media and credits. ClawVille cannot tell how this Studios call ended (the answer was lost, or Studios stopped answering after the job started), so it may have used their Studios credits." },
  payment_fenced: { httpStatus: 502, message: 'Another ClawVille worker took this request over before this one paid, so this one sent nothing. Do not retry; read the request status.' },
  interrupted_not_paid: { httpStatus: 502, message: 'The ClawVille server restarted before this request paid anything. Nothing was paid. Send a new request with a new key.' },
  result_lost: { httpStatus: 502, message: 'The wallet paid, but the ClawVille server restarted before it stored the result. Do not retry; contact support with the ledgerId.' },
  job_failed: { httpStatus: 502, message: 'Studios says the job failed (Studios refunds a failed job). Do not retry the same request.' },
  job_timeout: { httpStatus: 502, message: "The job did not finish in 30 minutes, so ClawVille stopped waiting. It may still finish in your human's Studios My Media. Do not retry." },
  approval_pending_limit: { httpStatus: 429, message: "Earlier requests still wait for your human's approval. Do not send another one; wait until your human approves or declines them in the wallet panel (each one expires after 15 minutes)." },
  approval_declined: { httpStatus: 403, message: 'Your human declined this request. Nothing was called or paid. Do not send it again.' },
  approval_expired: { httpStatus: 409, message: 'Nobody approved this request within 15 minutes, so it expired. Nothing was called or paid.' },
  approval_not_found: { httpStatus: 404, message: 'There is no such Studios request for this avatar.' },
  approval_not_awaiting: { httpStatus: 409, message: 'This request does not wait for approval any more: it was already approved, declined or finished.' },
  approval_terms_changed: { httpStatus: 409, message: 'The request or its price limit changed after the signature. Nothing was paid. Approve it again and sign the new message.' },
  approval_mode_changed: { httpStatus: 409, message: 'The Studios key was saved or removed after this request was made, so a different account would pay now. Nothing was paid. Decline it; your agent can send a new request.' },
};

const DAILY_LIMIT_MESSAGES: Record<Exclude<StudiosOperationId, 'image'>, string> = {
  video: "Your human's daily limit for Studios videos is used up (or set to 0). Try again after 00:00 UTC, or ask your human to raise it in the wallet panel (Spending).",
  character_shots: "Your human's daily limit for Studios character shots is used up (or set to 0). Try again after 00:00 UTC, or ask your human to raise it in the wallet panel (Spending).",
  recast: "Your human's daily limit for Studios recasts is used up (or set to 0). Try again after 00:00 UTC, or ask your human to raise it in the wallet panel (Spending).",
};

function failure(code: StudiosImageFailure, ledgerId: string | null = null, operation: StudiosOperationId = 'image'): StudiosImageRefusal {
  const base = MESSAGES[code];
  const message = code === 'daily_limit' && operation !== 'image' ? DAILY_LIMIT_MESSAGES[operation] : base.message;
  return { ok: false, code, httpStatus: base.httpStatus, message, ledgerId };
}

/** Our own refusal (code, message, status) for a stored failure code, or null for an unknown code. */
export function studiosRefusalFor(code: string, operation: StudiosOperationId = 'image'): StudiosImageRefusal | null {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? failure(code as StudiosImageFailure, null, operation) : null;
}

function awaiting(requestId: string, expiresAt: Date | string): StudiosImageAwaiting {
  return {
    ok: false,
    code: 'awaiting_approval',
    httpStatus: 202,
    message: `Your human asked to approve each payment. This request waits for them in the wallet panel (Approvals) and expires in 15 minutes. Nothing was called or paid yet. Do not send it again; read GET /api/vendors/studios/requests/${requestId} for the result.`,
    ledgerId: null,
    requestId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function running(requestId: string): StudiosRunning {
  return {
    ok: false,
    code: 'running',
    httpStatus: 202,
    message: `Studios is making it now (a video or recast can take several minutes). Do not send it again; read GET /api/vendors/studios/requests/${requestId} at most once a minute for the result.`,
    ledgerId: null,
    requestId,
  };
}

function storedModel(model: string | null): StudiosImageModel | undefined {
  return (STUDIOS_IMAGE_MODELS as readonly string[]).includes(model ?? '') ? (model as StudiosImageModel) : undefined;
}

/** Image bytes and type from base64, or null when it is not a png, jpeg or webp of at most 8 MB. */
export function decodeImage(base64: string): { bytes: Buffer; mime: string } | null {
  const bytes = Buffer.from(base64, 'base64');
  const kind = sniffMedia(bytes, 'image');
  return kind ? { bytes, mime: kind.mime } : null;
}

async function storeMediaBytes(input: {
  avatarId: string;
  mode: 'wallet' | 'account';
  actor: 'human' | 'agent';
  prompt: string;
  ledgerId: string | null;
  bytes: Buffer;
  mime: string;
}): Promise<string | null> {
  const [row] = await db
    .insert(avatarMedia)
    .values({
      avatarId: input.avatarId,
      vendor: 'studios',
      mode: input.mode,
      actor: input.actor,
      mimeType: input.mime,
      bytes: input.bytes,
      prompt: input.prompt,
      ledgerId: input.ledgerId,
    })
    .returning({ id: avatarMedia.id });
  // Keep the newest MEDIA_KEEP_PER_AVATAR rows.
  const keep = await db
    .select({ id: avatarMedia.id })
    .from(avatarMedia)
    .where(eq(avatarMedia.avatarId, input.avatarId))
    .orderBy(desc(avatarMedia.createdAt))
    .limit(MEDIA_KEEP_PER_AVATAR);
  const keepIds = new Set(keep.map((r) => r.id));
  const all = await db.select({ id: avatarMedia.id }).from(avatarMedia).where(eq(avatarMedia.avatarId, input.avatarId));
  const drop = all.map((r) => r.id).filter((id) => !keepIds.has(id));
  if (drop.length) await db.delete(avatarMedia).where(and(eq(avatarMedia.avatarId, input.avatarId), inArray(avatarMedia.id, drop)));
  return row?.id ?? null;
}

const KIND_OF: Record<StudiosOperationId, MediaKind> = { image: 'image', video: 'video', character_shots: 'image', recast: 'video' };

/**
 * Check and store each slot of a reply (the first source of a slot that
 * stores wins; recast lists the full clip, then the lighter copy). A URL is
 * downloaded only from Studios' own host (`fetchStudiosArtifact`).
 */
async function storeSources(input: {
  avatarId: string;
  mode: 'wallet' | 'account';
  actor: 'human' | 'agent';
  prompt: string;
  ledgerId: string | null;
  operation: StudiosOperationId;
  sources: MediaSource[];
}): Promise<StudiosMediaItem[]> {
  const kind = KIND_OF[input.operation];
  const stored: StudiosMediaItem[] = [];
  for (const source of input.sources) {
    if (stored.some((item) => item.slot === source.slot)) continue;
    let bytes: Buffer | null = null;
    if ('base64' in source) {
      bytes = Buffer.from(source.base64, 'base64');
    } else {
      const fetched = await fetchStudiosArtifact(source.url, maxBytesFor(kind));
      if (fetched.ok) bytes = fetched.bytes;
    }
    const checked = bytes ? sniffMedia(bytes, kind) : null;
    if (!bytes || !checked) continue;
    const mediaId = await storeMediaBytes({ ...input, bytes, mime: checked.mime });
    if (mediaId) stored.push({ slot: source.slot, mediaId, mediaPath: `/api/media/${mediaId}` });
  }
  return stored;
}

type AccountCall =
  | { ok: true; json: unknown }
  | { ok: false; code: 'studios_key_invalid' | 'studios_account_refused' | 'vendor_refused' | 'outcome_unknown' };

/**
 * One call with the human's own key (Codex review 2026-11-06). Only a
 * refusal that is clearly not charged says "nothing was paid": 401/403 (the
 * key), 402 (no credits), and the statuses docs.md marks as not charged for
 * this endpoint (`unchargedStatus` in vendors/studios-operations.ts). Every
 * other outcome may already have billed the key: any other status (a 5xx
 * included), a timeout, a network error (it cannot tell before from after the
 * send) and a 2xx that cannot be read are `outcome_unknown`, never retried.
 */
async function callWithAccountKey(
  key: string,
  request: { method?: 'POST' | 'GET'; url: string; body?: Record<string, unknown>; headers?: Record<string, string> },
  opts: { timeoutMs: number; replyMaxBytes?: number; unchargedStatus: (status: number) => boolean },
): Promise<AccountCall> {
  let res: Response;
  try {
    res = await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: {
        Accept: 'application/json',
        ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        ...(request.headers ?? {}),
        Authorization: `Bearer ${key}`,
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: 'error',
    });
  } catch {
    return { ok: false, code: 'outcome_unknown' };
  }
  if (res.ok) {
    const json = await readJsonCapped(res, opts.replyMaxBytes).catch(() => null);
    return json === null ? { ok: false, code: 'outcome_unknown' } : { ok: true, json };
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'studios_key_invalid' };
  if (res.status === 402) return { ok: false, code: 'studios_account_refused' };
  if (opts.unchargedStatus(res.status)) return { ok: false, code: 'vendor_refused' };
  return { ok: false, code: 'outcome_unknown' };
}

type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;

function lockAvatarRequests(tx: Executor, avatarId: string) {
  return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vendor-call:${avatarId}`}))`);
}

/** Mark this avatar's overdue waiting requests 'expired' (nothing was called or paid). */
async function expireOverdue(executor: Executor, avatarId: string): Promise<void> {
  await executor.update(vendorCallRequests)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(
      eq(vendorCallRequests.avatarId, avatarId),
      eq(vendorCallRequests.status, 'awaiting_approval'),
      // The wall clock, not the transaction start: a call that waited on the
      // avatar lock past the deadline must see the request as overdue.
      sql`${vendorCallRequests.expiresAt} <= clock_timestamp()`,
    ));
}

const DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

const EXECUTED_STATUSES: VendorCallStatus[] = ['pending', 'running', 'done', 'failed', 'ambiguous'];
const UNFINISHED_STATUSES: VendorCallStatus[] = ['awaiting_approval', 'pending', 'running'];

/**
 * The avatar's requests of one operation that count toward a per-day rule for
 * this UTC day. A request counts on the day it RAN: `decided_at` for an
 * approved request, else `created_at`. `includeWaiting`: also every request
 * that still waits, whatever day it was made (a reservation; it expires in 15
 * minutes). Declined and expired requests never reached Studios and never
 * count. `mode` limits the count to one mode (images: the human's own key);
 * `surface` to one surface (the hosted verb's own cap).
 */
async function requestsToday(executor: Executor, avatarId: string, opts: {
  operation: StudiosOperationId;
  mode?: StudiosMode;
  surface?: 'api' | 'hosted';
  includeWaiting: boolean;
  exceptId?: string;
}): Promise<number> {
  const [row] = await executor.select({ n: sql<number>`count(*)::int` }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.operation, opts.operation),
    opts.mode ? eq(vendorCallRequests.mode, opts.mode) : sql`true`,
    opts.surface ? eq(vendorCallRequests.surface, opts.surface) : sql`true`,
    opts.exceptId ? sql`${vendorCallRequests.id} <> ${opts.exceptId}` : sql`true`,
    or(
      and(
        inArray(vendorCallRequests.status, EXECUTED_STATUSES),
        sql`coalesce(${vendorCallRequests.decidedAt}, ${vendorCallRequests.createdAt}) >= ${DAY_START}`,
      ),
      opts.includeWaiting ? eq(vendorCallRequests.status, 'awaiting_approval') : sql`false`,
    ),
  ));
  return row?.n ?? 0;
}

/**
 * The per-day refusal for one more request of `op` (the human's class count,
 * then the hosted verb's own cap), or null. `includeWaiting` counts waiting
 * requests as reservations (a new request); at approve the request itself
 * counts on today instead.
 */
async function dayLimitRefusal(executor: Executor, input: {
  avatarId: string;
  op: StudiosOperationDef;
  mode: StudiosMode;
  surface: 'api' | 'hosted';
  policy: ReturnType<typeof toSpendPolicyView>;
  includeWaiting: boolean;
  exceptId?: string;
}): Promise<'daily_limit' | 'hosted_daily_cap' | null> {
  const { op } = input;
  const perDay = perDayLimit(op, input.mode, input.policy);
  if (perDay !== null) {
    // Images count the human's own key only (phase 2b); the other classes count both modes.
    const used = await requestsToday(executor, input.avatarId, {
      operation: op.id,
      mode: op.limit.modes.length === 1 ? op.limit.modes[0] : undefined,
      includeWaiting: input.includeWaiting,
      exceptId: input.exceptId,
    });
    if (used + 1 > perDay) return 'daily_limit';
  }
  if (input.surface === 'hosted' && op.hostedPerDay !== null) {
    const used = await requestsToday(executor, input.avatarId, {
      operation: op.id,
      surface: 'hosted',
      includeWaiting: input.includeWaiting,
      exceptId: input.exceptId,
    });
    if (used + 1 > op.hostedPerDay) return 'hosted_daily_cap';
  }
  return null;
}

/**
 * True when the stored media, plus the reserve of every unfinished request,
 * plus this request's reserve, passes the avatar's quota.
 */
async function overMediaQuota(executor: Executor, avatarId: string, reserve: number, exceptId?: string): Promise<boolean> {
  const stored = await storedMediaBytes(executor, avatarId);
  const open = await executor.select({ id: vendorCallRequests.id, operation: vendorCallRequests.operation, params: vendorCallRequests.params })
    .from(vendorCallRequests)
    .where(and(eq(vendorCallRequests.avatarId, avatarId), inArray(vendorCallRequests.status, UNFINISHED_STATUSES)));
  let reserved = 0;
  for (const row of open) {
    if (row.id === exceptId) continue;
    const op = STUDIOS_OPERATIONS[row.operation as StudiosOperationId] ?? STUDIOS_OPERATIONS.image;
    reserved += op.reserveBytes((row.params ?? {}) as StudiosParams);
  }
  return stored + reserved + reserve > MEDIA_QUOTA_BYTES_PER_AVATAR;
}

async function readPolicyRow(executor: Executor, avatarId: string) {
  const [row] = await executor.select(policyColumns).from(userSpendPolicies).where(eq(userSpendPolicies.avatarId, avatarId)).limit(1);
  return toSpendPolicyView(row);
}

/**
 * Wallet-mode checks that need no vendor call (the price comes only with the
 * vendor's quote, so the exact per-call and daily checks run again at approve,
 * in `outbound-x402.ts admit`, under the spend-rules lock).
 */
async function walletPrecheck(executor: Executor, avatarId: string, policy: ReturnType<typeof toSpendPolicyView>): Promise<StudiosImageFailure | null> {
  if (!policy.configured || policy.dailyCapUsdCents === null || policy.perCallCapUsdCents === null) return 'spend_rules_not_set';
  if (!policy.allowedVendors.includes('studios')) return 'vendor_not_allowed';
  if (policy.perCallCapUsdCents <= 0) return 'over_per_call_cap';
  const spent = await executor.execute<{ total: string | null }>(sql`
    SELECT COALESCE(SUM(usdc_atomic), 0)::text AS total
    FROM vendor_spend_ledger
    WHERE avatar_id = ${avatarId}
      AND status IN ('pending', 'paid', 'ambiguous')
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  const spentToday = BigInt(Array.from(spent)[0]?.total ?? '0');
  if (spentToday >= BigInt(policy.dailyCapUsdCents) * ATOMIC_PER_CENT) return 'over_daily_cap';
  return null;
}

type RequestRow = typeof vendorCallRequests.$inferSelect;

/** The finished result of a 'done' row, our own fields only. */
async function successFromRow(executor: Executor, row: RequestRow): Promise<StudiosOperationResult> {
  const [ledger] = row.ledgerId
    ? await executor.select({ usdCents: vendorSpendLedger.usdCents, txSignature: vendorSpendLedger.txSignature })
      .from(vendorSpendLedger).where(eq(vendorSpendLedger.id, row.ledgerId)).limit(1)
    : [];
  const mode = row.mode === 'account' ? 'account' : 'wallet';
  if (row.operation === 'image') {
    if (!row.mediaId) return failure('duplicate_request', row.ledgerId);
    return {
      ok: true,
      mode,
      mediaId: row.mediaId,
      mediaPath: `/api/media/${row.mediaId}`,
      ledgerId: row.ledgerId,
      paidUsdCents: ledger?.usdCents ?? null,
      txSignature: ledger?.txSignature ?? null,
    };
  }
  const media = mediaItemsOf(row.result);
  return {
    ok: true,
    operation: row.operation as Exclude<StudiosOperationId, 'image'>,
    requestId: row.id,
    mode,
    mediaId: media[0]?.mediaId ?? null,
    mediaPath: media[0]?.mediaPath ?? null,
    media,
    vendorMediaId: row.vendorMediaId,
    note: media.length === 0 ? 'media_not_copied' : null,
    ledgerId: row.ledgerId,
    paidUsdCents: ledger?.usdCents ?? null,
    txSignature: ledger?.txSignature ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mediaItemsOf(result: unknown): StudiosMediaItem[] {
  const media = (result as { media?: unknown } | null)?.media;
  if (!Array.isArray(media)) return [];
  return media.flatMap((m) => {
    const item = m as { slot?: unknown; mediaId?: unknown };
    return typeof item?.slot === 'string' && typeof item.mediaId === 'string' && UUID_RE.test(item.mediaId)
      ? [{ slot: item.slot, mediaId: item.mediaId, mediaPath: `/api/media/${item.mediaId}` }]
      : [];
  });
}

/** A row and the token of the runner that holds it (`lease_owner`). */
export interface JobClaim {
  requestId: string;
  owner: string;
}

type Reservation =
  | { kind: 'new'; requestId: string; owner: string }
  | { kind: 'done'; result: StudiosOperationResult };

/** Reserve the request, or find the earlier one, under the avatar's lock. */
async function reserveRequest(input: {
  avatarId: string;
  actor: 'human' | 'agent';
  surface: 'api' | 'hosted';
  mode: StudiosMode;
  op: StudiosOperationDef;
  params: StudiosParams;
  idempotencyKey: string;
  /** Account mode: SHA-256 of the saved key, bound to the request (never the key). */
  credentialSha256: string | null;
}): Promise<Reservation> {
  const { op } = input;
  return db.transaction(async (tx) => {
    await lockAvatarRequests(tx, input.avatarId);
    await expireOverdue(tx, input.avatarId);
    const [prior] = await tx
      .select()
      .from(vendorCallRequests)
      .where(and(
        eq(vendorCallRequests.avatarId, input.avatarId),
        eq(vendorCallRequests.vendor, 'studios'),
        eq(vendorCallRequests.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (prior) {
      // One key, one request: a key reused for another operation never runs.
      if (prior.operation !== op.id) return { kind: 'done', result: failure('duplicate_request', prior.ledgerId) };
      if (prior.status === 'done') return { kind: 'done', result: await successFromRow(tx, prior) };
      // The same key again returns the same waiting or running request, never a new row.
      if (prior.status === 'awaiting_approval' && prior.expiresAt) return { kind: 'done', result: awaiting(prior.id, prior.expiresAt) };
      if (prior.status === 'running') return { kind: 'done', result: running(prior.id) };
      if (prior.status === 'declined') return { kind: 'done', result: failure('approval_declined') };
      if (prior.status === 'expired') return { kind: 'done', result: failure('approval_expired') };
      if (prior.status === 'ambiguous') return { kind: 'done', result: failure('payment_ambiguous', prior.ledgerId) };
      return { kind: 'done', result: failure('duplicate_request', prior.ledgerId) };
    }
    if (!op.modes.includes(input.mode)) return { kind: 'done', result: failure('operation_needs_studios_key') };
    const policy = await readPolicyRow(tx, input.avatarId);
    const limited = await dayLimitRefusal(tx, {
      avatarId: input.avatarId, op, mode: input.mode, surface: input.surface, policy, includeWaiting: true,
    });
    if (limited) return { kind: 'done', result: failure(limited, null, op.id) };
    if (await overMediaQuota(tx, input.avatarId, op.reserveBytes(input.params))) {
      return { kind: 'done', result: failure('media_quota_full') };
    }
    const base = {
      avatarId: input.avatarId,
      vendor: 'studios',
      actor: input.actor,
      surface: input.surface,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      operation: op.id,
      prompt: op.promptOf(input.params),
      model: op.modelOf(input.params),
      // Image keeps its phase 2b columns (prompt + model); the others keep their settings.
      params: op.id === 'image' ? null : input.params,
      credentialSha256: input.credentialSha256,
    };
    // "Ask me before each payment": EVERY request waits, the human's own web
    // form too (lead decision 2026-11-06, Codex review): a magic link passes
    // through the agent, so a cookie cannot prove the human pressed the
    // button. Only a signature from the linked wallet approves a payment.
    if (policy.requireApproval) {
      if (input.mode === 'wallet') {
        const refused = await walletPrecheck(tx, input.avatarId, policy);
        if (refused) return { kind: 'done', result: failure(refused) };
      }
      const [waiting] = await tx.select({ n: sql<number>`count(*)::int` }).from(vendorCallRequests).where(and(
        eq(vendorCallRequests.avatarId, input.avatarId),
        eq(vendorCallRequests.status, 'awaiting_approval'),
      ));
      const maxAwaiting = input.surface === 'hosted' ? HOSTED_MAX_AWAITING : SPEND_APPROVAL_MAX_AWAITING;
      if ((waiting?.n ?? 0) >= maxAwaiting) return { kind: 'done', result: failure('approval_pending_limit') };
      const expiresAt = new Date(Date.now() + SPEND_APPROVAL_TTL_MS);
      const [created] = await tx.insert(vendorCallRequests).values({ ...base, status: 'awaiting_approval', expiresAt })
        .returning({ id: vendorCallRequests.id });
      if (!created) throw new Error('vendor_call_requests insert returned no row');
      return { kind: 'done', result: awaiting(created.id, expiresAt) };
    }
    const owner = randomUUID();
    const [created] = await tx.insert(vendorCallRequests).values({
      ...base,
      leaseOwner: owner,
      // A long job is 'running' from the start, with a lease its runner renews.
      ...(op.long ? { status: 'running', leaseUntil: new Date(Date.now() + JOB_LEASE_MS) } : {}),
    }).returning({ id: vendorCallRequests.id });
    if (!created) throw new Error('vendor_call_requests insert returned no row');
    return { kind: 'new', requestId: created.id, owner };
  });
}

/**
 * Record the outcome on the request row, then return it unchanged. Only a row
 * that still runs AND is still held by this claim's token is written, so a row
 * that a recovery pass took over or settled stays as it is.
 */
async function finishRequest<T extends StudiosOperationResult>(
  claim: JobClaim,
  result: T,
  extra: { result?: unknown; vendorMediaId?: string | null; status?: 'done' | 'failed' | 'ambiguous' } = {},
): Promise<T> {
  await db.update(vendorCallRequests).set({
    status: extra.status ?? (result.ok ? 'done' : 'failed'),
    mediaId: result.ok ? result.mediaId : null,
    ledgerId: result.ledgerId,
    failureCode: result.ok ? null : result.code,
    ...(extra.result !== undefined ? { result: extra.result } : {}),
    ...(extra.vendorMediaId !== undefined ? { vendorMediaId: extra.vendorMediaId } : {}),
    leaseUntil: null,
    updatedAt: new Date(),
  }).where(and(
    eq(vendorCallRequests.id, claim.requestId),
    eq(vendorCallRequests.leaseOwner, claim.owner),
    inArray(vendorCallRequests.status, ['pending', 'running']),
  ));
  return result;
}

/** True while this claim still holds the row (checked before any result is stored). */
async function holdsClaim(claim: JobClaim): Promise<boolean> {
  const [row] = await db.select({ id: vendorCallRequests.id }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, claim.requestId),
    eq(vendorCallRequests.leaseOwner, claim.owner),
    inArray(vendorCallRequests.status, ['pending', 'running']),
  )).limit(1);
  return Boolean(row);
}

/**
 * The ownership check passed to the wallet payment (`fence`): locks the row
 * and is true only while this claim holds it and it is not terminal. A
 * recovery pass writes a new `lease_owner` first, so an old runner that wakes
 * up later cannot insert a ledger row or store a signature, and sends nothing.
 */
function claimFence(claim: JobClaim): (tx: LedgerTx) => Promise<boolean> {
  return async (tx) => {
    const rows = await tx.execute(sql`
      SELECT 1 FROM vendor_call_requests
      WHERE id = ${claim.requestId} AND lease_owner = ${claim.owner} AND status IN ('pending', 'running')
      FOR UPDATE`);
    return Array.from(rows).length > 0;
  };
}

/** The answer when another runner took the row over: nothing is written or stored. */
function lostClaim(): StudiosImageRefusal {
  return failure('outcome_unknown');
}

/** The finished result of a non-image operation, written to the row. */
async function finishOperation(input: {
  requestId: string;
  owner: string;
  op: StudiosOperationDef;
  mode: StudiosMode;
  media: StudiosMediaItem[];
  vendorMediaId: string | null;
  ledgerId: string | null;
  paidUsdCents: number | null;
  txSignature: string | null;
}): Promise<StudiosOperationResult> {
  // Wallet mode: nothing stored means the paid result is lost (Studios keeps
  // no copy of an x402 call). Key mode: Studios keeps it in My Media.
  if (input.media.length === 0 && input.mode === 'wallet') {
    return finishRequest({ requestId: input.requestId, owner: input.owner }, failure('media_missing', input.ledgerId));
  }
  const success: StudiosOperationSuccess = {
    ok: true,
    operation: input.op.id as Exclude<StudiosOperationId, 'image'>,
    requestId: input.requestId,
    mode: input.mode,
    mediaId: input.media[0]?.mediaId ?? null,
    mediaPath: input.media[0]?.mediaPath ?? null,
    media: input.media,
    vendorMediaId: input.vendorMediaId,
    note: input.media.length === 0 ? 'media_not_copied' : null,
    ledgerId: input.ledgerId,
    paidUsdCents: input.paidUsdCents,
    txSignature: input.txSignature,
  };
  return finishRequest({ requestId: input.requestId, owner: input.owner }, success, {
    result: { media: input.media.map(({ slot, mediaId }) => ({ slot, mediaId })) },
    vendorMediaId: input.vendorMediaId,
  });
}

interface RunInput {
  requestId: string;
  /** The token of the runner that holds the row. */
  owner: string;
  avatarId: string;
  actor: 'human' | 'agent';
  op: StudiosOperationDef;
  params: StudiosParams;
  idempotencyKey: string;
  key: string | null;
  /** Approve only: the most the human signed for (wallet mode); a higher quote pays nothing. */
  maxCallAtomic?: bigint;
}

function walletPin(op: StudiosOperationDef, signedMax: bigint | undefined): bigint {
  const ceiling = op.maxCallAtomic ?? 0n;
  return signedMax !== undefined && signedMax < ceiling ? signedMax : ceiling;
}

/**
 * Run one reserved request that makes its media in one call (image,
 * character shots, video): the human's own key when `key` is set, else the
 * avatar wallet inside the spend rules. The row's idempotency key is also the
 * spend-ledger key, so a payment is never made twice.
 */
async function runOneCall(input: RunInput): Promise<StudiosOperationResult> {
  const { op, requestId } = input;
  const claim: JobClaim = { requestId, owner: input.owner };
  const request = op.build(input.params, { requestId });
  const prompt = op.promptOf(input.params);
  const isImage = op.id === 'image';

  if (input.key) {
    const result = await callWithAccountKey(input.key, request, {
      timeoutMs: op.callTimeoutMs,
      replyMaxBytes: op.replyMaxBytes,
      unchargedStatus: op.unchargedStatus,
    });
    if (!result.ok) return finishRequest(claim, failure(result.code));
    if (!(await holdsClaim(claim))) return lostClaim();
    const media = await storeSources({ avatarId: input.avatarId, mode: 'account', actor: input.actor, prompt, ledgerId: null, operation: op.id, sources: op.readMedia(result.json) });
    if (isImage) {
      if (!media[0]) return finishRequest(claim, failure('image_missing'));
      return finishRequest(claim, { ok: true, mode: 'account', mediaId: media[0].mediaId, mediaPath: media[0].mediaPath, ledgerId: null, paidUsdCents: null, txSignature: null });
    }
    return finishOperation({ requestId, owner: input.owner, op, mode: 'account', media, vendorMediaId: null, ledgerId: null, paidUsdCents: null, txSignature: null });
  }

  if (!op.modes.includes('wallet') || op.maxCallAtomic === null) return finishRequest(claim, failure('operation_needs_studios_key'));
  const paid = await callVendorWithAvatarWallet({
    avatarId: input.avatarId,
    actor: input.actor,
    pin: { vendor: 'studios', payTo: STUDIOS_PAY_TO, maxCallAtomic: walletPin(op, input.maxCallAtomic) },
    tool: isImage ? 'images.generations' : 'videos.generations',
    idempotencyKey: input.idempotencyKey,
    url: request.url,
    body: request.body,
    ...(isImage ? {} : { paidTimeoutMs: op.callTimeoutMs, replyMaxBytes: op.replyMaxBytes }),
    fence: claimFence(claim),
  });
  // Taken over before paying: the new holder settles the row; write nothing.
  if (!paid.ok && paid.code === 'payment_fenced') return lostClaim();
  if (!paid.ok) {
    return finishRequest(claim, failure(paid.code, paid.ledgerId ?? null), paid.code === 'payment_ambiguous' && !isImage ? { status: 'ambiguous' } : {});
  }
  if (!(await holdsClaim(claim))) return lostClaim();
  const media = await storeSources({ avatarId: input.avatarId, mode: 'wallet', actor: input.actor, prompt, ledgerId: paid.ledgerId, operation: op.id, sources: op.readMedia(paid.responseJson) });
  if (isImage) {
    if (!media[0]) return finishRequest(claim, failure('image_missing', paid.ledgerId));
    return finishRequest(claim, {
      ok: true,
      mode: 'wallet',
      mediaId: media[0].mediaId,
      mediaPath: media[0].mediaPath,
      ledgerId: paid.ledgerId,
      paidUsdCents: paid.usdCents,
      txSignature: paid.txSignature,
    });
  }
  return finishOperation({ requestId, owner: input.owner, op, mode: 'wallet', media, vendorMediaId: null, ledgerId: paid.ledgerId, paidUsdCents: paid.usdCents, txSignature: paid.txSignature });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test seam for the recast poll interval. */
export const recastTiming = { pollMs: RECAST_POLL_MS, deadlineMs: RECAST_DEADLINE_MS };

/**
 * A key-mode recast: start the job once (its id is stored at once), then
 * poll every 15 s until it finishes or the hard deadline passes. A start
 * that cannot be read is `outcome_unknown` and never sent again.
 */
async function runRecast(input: RunInput & { vendorJobId: string | null; deadlineAt: Date | null }): Promise<StudiosOperationResult> {
  const { op, requestId, key } = input;
  const claim: JobClaim = { requestId, owner: input.owner };
  // Once a start returned a job id, credits may be in use: never "nothing was paid".
  if (!key) return finishRequest(claim, failure(input.vendorJobId ? 'outcome_unknown' : 'operation_needs_studios_key'));
  let jobId = input.vendorJobId;
  let deadline = input.deadlineAt?.getTime() ?? null;
  if (!jobId) {
    const start = await callWithAccountKey(key, op.build(input.params, { requestId }), {
      timeoutMs: op.callTimeoutMs,
      replyMaxBytes: op.replyMaxBytes,
      unchargedStatus: op.unchargedStatus,
    });
    if (!start.ok) return finishRequest(claim, failure(start.code));
    jobId = readRecastStart(start.json);
    if (!jobId) return finishRequest(claim, failure('outcome_unknown'));
    deadline = Date.now() + recastTiming.deadlineMs;
    await db.update(vendorCallRequests)
      .set({ vendorJobId: jobId, jobDeadlineAt: new Date(deadline), updatedAt: new Date() })
      .where(and(eq(vendorCallRequests.id, requestId), eq(vendorCallRequests.leaseOwner, input.owner), eq(vendorCallRequests.status, 'running')));
  }
  const pollUrl = recastPollUrl(jobId);
  if (!pollUrl) return finishRequest(claim, failure('outcome_unknown'));
  const end = deadline ?? Date.now() + recastTiming.deadlineMs;
  for (;;) {
    if (Date.now() >= end) return finishRequest(claim, failure('job_timeout'));
    await sleep(Math.min(recastTiming.pollMs, Math.max(0, end - Date.now())));
    if (Date.now() >= end) return finishRequest(claim, failure('job_timeout'));
    // A poll is free (docs.md: GET /api/v1/videos/recast/{id} "Billing: free"); any failed poll is tried again.
    const reply = await callWithAccountKey(key, { method: 'GET', url: pollUrl }, { timeoutMs: 30_000, replyMaxBytes: op.replyMaxBytes, unchargedStatus: () => true });
    if (!reply.ok) {
      // The job already started (it may have used credits): a key refused now is
      // outcome_unknown, never "nothing was paid". The job id stays on the row.
      if (reply.code === 'studios_key_invalid') return finishRequest(claim, failure('outcome_unknown'));
      continue; // A poll that fails changes nothing; try again until the deadline.
    }
    const poll = readRecastPoll(reply.json);
    if (!poll || poll.state === 'running') continue;
    if (poll.state === 'failed') return finishRequest(claim, failure('job_failed'));
    if (!(await holdsClaim(claim))) return lostClaim();
    const media = await storeSources({
      avatarId: input.avatarId, mode: 'account', actor: input.actor, prompt: op.promptOf(input.params), ledgerId: null, operation: op.id, sources: poll.sources,
    });
    return finishOperation({ requestId, owner: input.owner, op, mode: 'account', media, vendorMediaId: poll.vendorMediaId, ledgerId: null, paidUsdCents: null, txSignature: null });
  }
}

/** The saved key, `undefined` when it cannot be read (never a silent switch to the wallet). */
async function loadKeyOrInvalid(avatarId: string): Promise<string | null | undefined> {
  try {
    return await loadVendorKey(avatarId, 'studios');
  } catch {
    return undefined;
  }
}

function keySha(key: string | null): string | null {
  return key ? vendorKeyRef(key).sha256 : null;
}

/**
 * Run one 'running' row to its end (video or recast). Called by the runner
 * right after the reservation or the approve, and by its recovery pass for a
 * recast that already has a job id. `key` is the key the request was made or
 * approved with; when absent it is loaded again and must still be the key the
 * row was made with (the credential digest is bound to the request).
 */
export async function executeLongJob(requestId: string, owner: string, key?: string | null): Promise<StudiosOperationResult | null> {
  const [row] = await db.select().from(vendorCallRequests).where(eq(vendorCallRequests.id, requestId)).limit(1);
  if (!row || row.status !== 'running' || row.leaseOwner !== owner) return null;
  const claim: JobClaim = { requestId, owner };
  const op = STUDIOS_OPERATIONS[row.operation as StudiosOperationId];
  if (!op?.long) return finishRequest(claim, failure('outcome_unknown'));
  const params = (row.params ?? {}) as StudiosParams;
  const actor = row.actor === 'human' ? 'human' : 'agent';
  let useKey: string | null = null;
  if (row.mode === 'account') {
    const current = key === undefined ? await loadKeyOrInvalid(row.avatarId) : key;
    // A recast that already has a job id was started (credits may be in use):
    // a key that is gone or changed now is outcome_unknown, not "nothing paid".
    if (current === undefined) return finishRequest(claim, failure(row.vendorJobId ? 'outcome_unknown' : 'studios_key_invalid'));
    if (!current || keySha(current) !== row.credentialSha256) return finishRequest(claim, failure(row.vendorJobId ? 'outcome_unknown' : 'studios_key_changed'));
    useKey = current;
  }
  const maxCallAtomic = (row.result as { signedMaxAtomic?: unknown } | null)?.signedMaxAtomic;
  const base: RunInput = {
    requestId,
    owner,
    avatarId: row.avatarId,
    actor,
    op,
    params,
    idempotencyKey: row.idempotencyKey,
    key: useKey,
    maxCallAtomic: typeof maxCallAtomic === 'string' && /^\d{1,18}$/.test(maxCallAtomic) ? BigInt(maxCallAtomic) : undefined,
  };
  if (op.id === 'recast') return runRecast({ ...base, vendorJobId: row.vendorJobId, deadlineAt: row.jobDeadlineAt });
  return runOneCall(base);
}

async function startLongJob(claim: JobClaim, key: string | null): Promise<void> {
  const { startStudiosJob } = await import('./studios-job-runner');
  startStudiosJob(claim.requestId, claim.owner, key);
}

/**
 * Run one Studios operation for `avatarId`. The caller has already proved the
 * caller acts for this avatar (human session, ledger-capable agent session, or
 * the hosted runtime of this avatar) and validated `params` with the
 * operation's schema. `actor` is recorded: pass 'agent' for every request that
 * the human did not make themselves.
 */
export async function requestStudiosOperation(input: {
  avatarId: string;
  actor: 'human' | 'agent';
  operation: StudiosOperationId;
  params: StudiosParams;
  idempotencyKey: string;
  /** 'hosted' = an [ACTION:] verb (recorded on the request row). Default 'api'. */
  surface?: 'api' | 'hosted';
}): Promise<StudiosOperationResult> {
  const op = STUDIOS_OPERATIONS[input.operation];
  // A saved key that cannot be read is an error, never a silent switch to the
  // wallet: the human chose their own account.
  const key = await loadKeyOrInvalid(input.avatarId);
  if (key === undefined) return failure('studios_key_invalid');

  const reservation = await reserveRequest({
    avatarId: input.avatarId,
    actor: input.actor,
    surface: input.surface ?? 'api',
    mode: key ? 'account' : 'wallet',
    op,
    params: input.params,
    idempotencyKey: input.idempotencyKey,
    credentialSha256: keySha(key),
  });
  if (reservation.kind === 'done') return reservation.result;
  if (op.long) {
    await startLongJob(reservation, key);
    return running(reservation.requestId);
  }
  return runOneCall({
    requestId: reservation.requestId,
    owner: reservation.owner,
    avatarId: input.avatarId,
    actor: input.actor,
    op,
    params: input.params,
    idempotencyKey: input.idempotencyKey,
    key,
  });
}

/**
 * Make one Studios image for `avatarId` (phase 2b entry point, unchanged
 * behaviour). `actor` decides nothing about the wait: with "ask me before each
 * payment" on, every request waits for the human.
 */
export async function generateStudiosImage(input: {
  avatarId: string;
  actor: 'human' | 'agent';
  prompt: string;
  idempotencyKey: string;
  model?: StudiosImageModel;
  /** 'hosted' = the [ACTION:] verb (recorded on the request row). Default 'api'. */
  surface?: 'api' | 'hosted';
}): Promise<StudiosImageResult> {
  const result = await requestStudiosOperation({
    avatarId: input.avatarId,
    actor: input.actor,
    operation: 'image',
    params: { prompt: input.prompt, ...(input.model ? { model: input.model } : {}) },
    idempotencyKey: input.idempotencyKey,
    surface: input.surface,
  });
  // The image operation never answers 'running' or a non-image success.
  return result as StudiosImageResult;
}

/**
 * Lock this avatar's requests, expire overdue ones, and return the request row
 * when it still waits, or the refusal. Runs inside the caller's transaction.
 */
async function lockAwaitingRow(tx: Executor, avatarId: string, requestId: string): Promise<{ ok: true; row: RequestRow } | { ok: false; result: StudiosImageRefusal }> {
  await lockAvatarRequests(tx, avatarId);
  await expireOverdue(tx, avatarId);
  const [row] = await tx.select().from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, requestId),
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
  )).limit(1);
  if (!row) return { ok: false, result: failure('approval_not_found') };
  if (row.status === 'expired') return { ok: false, result: failure('approval_expired') };
  if (row.status !== 'awaiting_approval' || row.prompt === null) return { ok: false, result: failure('approval_not_awaiting') };
  return { ok: true, row };
}

export type StudiosDecision = { result: StudiosOperationResult; surface: 'api' | 'hosted' | null; operation: StudiosOperationId | null };

/** The most a wallet-mode request may cost, from the current spend rules and the operation's ceiling. */
function walletMaxCents(policy: ReturnType<typeof toSpendPolicyView>, op: StudiosOperationDef): number {
  const ceilingCents = Number((op.maxCallAtomic ?? 0n) / ATOMIC_PER_CENT);
  return Math.min(policy.perCallCapUsdCents ?? 0, ceilingCents);
}

/** SHA-256 of the canonical settings; null for image (its prompt hash covers it). */
function paramsSha256(row: { operation: string; params: unknown }): string | null {
  if (row.operation === 'image') return null;
  return createHash('sha256').update(canonicalJson(row.params ?? null), 'utf8').digest('hex');
}

function operationOf(row: { operation: string }): StudiosOperationDef {
  return STUDIOS_OPERATIONS[row.operation as StudiosOperationId] ?? STUDIOS_OPERATIONS.image;
}

/**
 * The terms the human's linked wallet signs to approve one waiting request:
 * the avatar, the request, the operation, who pays, the most it can cost now,
 * the SHA-256 of the prompt and of the settings. Refuses a request that does
 * not wait any more.
 */
export async function readApprovalTerms(avatarId: string, requestId: string): Promise<{ ok: true; terms: ApprovalTerms } | { ok: false; result: StudiosImageRefusal }> {
  await expireOverdue(db, avatarId);
  const [row] = await db.select({
    status: vendorCallRequests.status,
    mode: vendorCallRequests.mode,
    operation: vendorCallRequests.operation,
    params: vendorCallRequests.params,
    prompt: vendorCallRequests.prompt,
    credentialSha256: vendorCallRequests.credentialSha256,
  }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, requestId),
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
  )).limit(1);
  if (!row) return { ok: false, result: failure('approval_not_found') };
  if (row.status === 'expired') return { ok: false, result: failure('approval_expired') };
  if (row.status !== 'awaiting_approval' || row.prompt === null) return { ok: false, result: failure('approval_not_awaiting') };
  const mode = row.mode === 'account' ? 'account' : 'wallet';
  const op = operationOf(row);
  return {
    ok: true,
    terms: {
      avatarId,
      requestId,
      operation: op.id,
      mode,
      maxUsdCents: mode === 'account' ? null : walletMaxCents(await readPolicyRow(db, avatarId), op),
      promptSha256: promptSha256(row.prompt),
      paramsSha256: paramsSha256(row),
      credentialSha256: mode === 'account' ? row.credentialSha256 : null,
    },
  };
}

/**
 * The human approves one waiting request. The route has verified the linked
 * wallet's signature over `terms` (`readApprovalTerms`, `verifyApprovalProof`);
 * a session alone never gets here. Under the avatar's lock: the row must still
 * wait and not be expired; its operation, mode, prompt and settings must equal
 * the signed terms; the payer must be the same as when it was made (a key
 * saved, removed or replaced since then refuses); the per-day counts and the
 * media quota are checked again, counting this request on today (the day it
 * runs). In wallet mode the call may cost at most the signed amount. The row
 * then becomes 'pending' (or 'running' for a long job) in the same
 * transaction, so a second approve click finds it not waiting and pays
 * nothing. The SAME pipeline as a direct request runs next; the wallet mode
 * checks every cap again with the real price (`admit`), writes the ledger row
 * before signing, and never retries an ambiguous payment.
 */
export async function approveStudiosRequest(input: { avatarId: string; userId: string; requestId: string; terms: ApprovalTerms }): Promise<StudiosDecision> {
  if (input.terms.requestId !== input.requestId || input.terms.avatarId !== input.avatarId) {
    return { result: failure('approval_terms_changed'), surface: null, operation: null };
  }
  const key = await loadKeyOrInvalid(input.avatarId);
  if (key === undefined) return { result: failure('studios_key_invalid'), surface: null, operation: null };
  const currentMode = key ? 'account' : 'wallet';
  const currentCredential = keySha(key);
  const signedMaxAtomic = input.terms.mode === 'wallet' ? BigInt(input.terms.maxUsdCents ?? 0) * ATOMIC_PER_CENT : undefined;
  const owner = randomUUID();

  const claim = await db.transaction(async (tx) => {
    const found = await lockAwaitingRow(tx, input.avatarId, input.requestId);
    if (!found.ok) return found;
    const { row } = found;
    const op = operationOf(row);
    if (
      row.operation !== input.terms.operation
      || row.mode !== input.terms.mode
      || promptSha256(row.prompt!) !== input.terms.promptSha256
      || paramsSha256(row) !== input.terms.paramsSha256
      || (row.mode === 'account' ? row.credentialSha256 : null) !== input.terms.credentialSha256
    ) {
      return { ok: false as const, result: failure('approval_terms_changed') };
    }
    if (row.mode !== currentMode) return { ok: false as const, result: failure('approval_mode_changed') };
    // Key A replaced by key B (maybe another Studios account): B must not pay.
    if (row.mode === 'account' && row.credentialSha256 !== currentCredential) {
      return { ok: false as const, result: failure('approval_mode_changed') };
    }
    const policy = await readPolicyRow(tx, input.avatarId);
    // This request counts too, on today: the requests that already ran today plus this one.
    const limited = await dayLimitRefusal(tx, {
      avatarId: input.avatarId,
      op,
      mode: row.mode === 'account' ? 'account' : 'wallet',
      surface: row.surface === 'hosted' ? 'hosted' : 'api',
      policy,
      includeWaiting: false,
      exceptId: row.id,
    });
    if (limited) return { ok: false as const, result: failure(limited, null, op.id) };
    if (await overMediaQuota(tx, input.avatarId, op.reserveBytes((row.params ?? { prompt: row.prompt }) as StudiosParams), row.id)) {
      return { ok: false as const, result: failure('media_quota_full') };
    }
    // Flip only a row that still waits and is not overdue NOW (wall clock):
    // the checks above take time, and a read outside this lock can expire the
    // row. Nothing flipped means nothing runs.
    const [flipped] = await tx.update(vendorCallRequests).set({
      status: op.long ? 'running' : 'pending',
      leaseOwner: owner,
      ...(op.long ? {
        leaseUntil: new Date(Date.now() + JOB_LEASE_MS),
        // The signed amount travels with the row to the runner (our own value).
        result: signedMaxAtomic !== undefined ? { signedMaxAtomic: signedMaxAtomic.toString() } : null,
      } : {}),
      decidedAt: new Date(),
      decidedByUserId: input.userId,
      updatedAt: new Date(),
    }).where(and(
      eq(vendorCallRequests.id, row.id),
      eq(vendorCallRequests.status, 'awaiting_approval'),
      sql`${vendorCallRequests.expiresAt} > clock_timestamp()`,
    )).returning({ id: vendorCallRequests.id });
    if (!flipped) {
      await expireOverdue(tx, input.avatarId);
      const [now] = await tx.select({ status: vendorCallRequests.status }).from(vendorCallRequests).where(eq(vendorCallRequests.id, row.id)).limit(1);
      return { ok: false as const, result: failure(now?.status === 'expired' ? 'approval_expired' : 'approval_not_awaiting') };
    }
    return { ok: true as const, row, op };
  });
  if (!claim.ok) return { result: claim.result, surface: null, operation: null };
  const { row, op } = claim;
  const surface = row.surface === 'hosted' ? 'hosted' : 'api';
  if (op.long) {
    await startLongJob({ requestId: row.id, owner }, key);
    return { result: running(row.id), surface, operation: op.id };
  }
  const result = await runOneCall({
    requestId: row.id,
    owner,
    avatarId: input.avatarId,
    actor: row.actor === 'human' ? 'human' : 'agent',
    op,
    params: op.id === 'image'
      ? { prompt: row.prompt!, ...(storedModel(row.model) ? { model: storedModel(row.model) } : {}) }
      : (row.params as StudiosParams),
    idempotencyKey: row.idempotencyKey,
    key,
    maxCallAtomic: signedMaxAtomic,
  });
  return { result, surface, operation: op.id };
}

/** The human declines one waiting request. Nothing is called or paid. */
export async function declineStudiosRequest(input: { avatarId: string; userId: string; requestId: string }): Promise<
  { ok: true; requestId: string; status: 'declined'; surface: 'api' | 'hosted'; operation: StudiosOperationId } | { ok: false; result: StudiosImageRefusal }
> {
  return db.transaction(async (tx) => {
    const found = await lockAwaitingRow(tx, input.avatarId, input.requestId);
    if (!found.ok) return found;
    const [flipped] = await tx.update(vendorCallRequests).set({
      status: 'declined',
      decidedAt: new Date(),
      decidedByUserId: input.userId,
      updatedAt: new Date(),
    }).where(and(eq(vendorCallRequests.id, found.row.id), eq(vendorCallRequests.status, 'awaiting_approval')))
      .returning({ id: vendorCallRequests.id });
    if (!flipped) return { ok: false as const, result: failure('approval_not_awaiting') };
    return {
      ok: true as const,
      requestId: found.row.id,
      status: 'declined' as const,
      surface: found.row.surface === 'hosted' ? 'hosted' as const : 'api' as const,
      operation: operationOf(found.row).id,
    };
  });
}

/** The avatar's waiting requests, oldest first, for the human's Approvals list. */
export async function listAwaitingApprovals(avatarId: string): Promise<VendorCallApprovalView[]> {
  await expireOverdue(db, avatarId);
  const rows = await db.select({
    id: vendorCallRequests.id,
    operation: vendorCallRequests.operation,
    prompt: vendorCallRequests.prompt,
    model: vendorCallRequests.model,
    mode: vendorCallRequests.mode,
    surface: vendorCallRequests.surface,
    createdAt: vendorCallRequests.createdAt,
    expiresAt: vendorCallRequests.expiresAt,
  }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
    eq(vendorCallRequests.status, 'awaiting_approval'),
  )).orderBy(asc(vendorCallRequests.createdAt)).limit(SPEND_APPROVAL_MAX_AWAITING * 2);
  const policy = await readPolicyRow(db, avatarId);
  return rows.map((r) => {
    const op = operationOf(r);
    return {
      requestId: r.id,
      vendor: 'studios',
      operation: op.id,
      prompt: r.prompt ?? '',
      model: r.model,
      mode: r.mode === 'account' ? 'account' : 'wallet',
      surface: r.surface === 'hosted' ? 'hosted' : 'api',
      maxUsdCents: r.mode === 'account' ? null : walletMaxCents(policy, op),
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: new Date(r.expiresAt ?? r.createdAt).toISOString(),
    };
  });
}

export interface StudiosRequestStatusView {
  requestId: string;
  operation: StudiosOperationId;
  status: VendorCallStatus;
  mode: 'wallet' | 'account';
  createdAt: string;
  /** Only for a request that waited for approval. */
  expiresAt: string | null;
  decidedAt: string | null;
  mediaId: string | null;
  mediaPath: string | null;
  /** Every stored item (character shots: one per shot). */
  media: StudiosMediaItem[];
  /** Key mode: the item in the human's Studios My Media (reference only). */
  vendorMediaId: string | null;
  /** Our own refusal code for a failed or ambiguous request (never vendor text). */
  code: string | null;
  ledgerId: string | null;
}

/** One request of this avatar, for its agent or its human. Null when not found. */
export async function readStudiosRequest(avatarId: string, requestId: string): Promise<StudiosRequestStatusView | null> {
  await expireOverdue(db, avatarId);
  const [row] = await db.select().from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, requestId),
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
  )).limit(1);
  if (!row) return null;
  const media = row.operation === 'image'
    ? (row.mediaId ? [{ slot: 'image', mediaId: row.mediaId, mediaPath: `/api/media/${row.mediaId}` }] : [])
    : mediaItemsOf(row.result);
  return {
    requestId: row.id,
    operation: operationOf(row).id,
    status: row.status as VendorCallStatus,
    mode: row.mode === 'account' ? 'account' : 'wallet',
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    mediaId: row.mediaId,
    mediaPath: row.mediaId ? `/api/media/${row.mediaId}` : null,
    media,
    vendorMediaId: row.vendorMediaId,
    code: row.failureCode,
    ledgerId: row.ledgerId,
  };
}

/** One stored item, for GET /api/media/:id. */
export async function readMedia(id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const row = await db.query.avatarMedia.findFirst({
    where: eq(avatarMedia.id, id),
    columns: { mimeType: true, bytes: true },
  });
  return row ? { mime: row.mimeType, bytes: Buffer.from(row.bytes) } : null;
}

/** The newest media of one avatar (ids, types and prompts only). */
export async function listMedia(avatarId: string, limit = 20): Promise<Array<{ id: string; mediaPath: string; mimeType: string; prompt: string; mode: string; actor: string; createdAt: string }>> {
  const rows = await db
    .select({ id: avatarMedia.id, mimeType: avatarMedia.mimeType, prompt: avatarMedia.prompt, mode: avatarMedia.mode, actor: avatarMedia.actor, createdAt: avatarMedia.createdAt })
    .from(avatarMedia)
    .where(eq(avatarMedia.avatarId, avatarId))
    .orderBy(desc(avatarMedia.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({ ...r, mediaPath: `/api/media/${r.id}`, createdAt: new Date(r.createdAt).toISOString() }));
}

// ---------------------------------------------------------------------------
// Recovery of unfinished rows (the runner calls this; never pays or calls again)
// ---------------------------------------------------------------------------

export type RecoveryOutcome = 'resume' | 'failed' | 'ambiguous' | 'skipped';

/**
 * Settle one unfinished row whose runner is gone (an API restart): a 'running'
 * row with an expired lease, or a 'pending' row (a one-call request) older than
 * 15 minutes. The runner claimed it (renewed lease) first.
 *   - key-mode recast with a stored job id: 'resume' (the runner polls it
 *     again; no new start) when `resumeRecast`, else `outcome_unknown`.
 *   - wallet mode: read the spend-ledger row by (avatar, idempotency key).
 *     None, or no stored payer signature: nothing was sent -> failed
 *     `interrupted_not_paid`. This is safe because the claim wrote a new
 *     `lease_owner` first: the old runner's admission and signature store are
 *     fenced by it (`claimFence`), and an unsigned 'pending' ledger row is
 *     closed here as 'failed' in one conditional UPDATE, so it can never be
 *     signed or sent afterwards.
 *     A stored payer signature: the payment may have settled -> the request is
 *     'ambiguous' (terminal) and a 'pending' ledger row becomes 'ambiguous' for
 *     the existing reconcile path. A 'paid' ledger row: paid, result lost ->
 *     failed `result_lost`. Never called or paid again.
 *   - any other key-mode row: Studios may have billed the key -> failed
 *     `outcome_unknown` (not sent again).
 */
export async function recoverUnfinishedRequest(requestId: string, owner: string, opts: { resumeRecast: boolean }): Promise<RecoveryOutcome> {
  const [row] = await db.select().from(vendorCallRequests).where(eq(vendorCallRequests.id, requestId)).limit(1);
  if (!row || (row.status !== 'running' && row.status !== 'pending') || row.leaseOwner !== owner) return 'skipped';
  const claim: JobClaim = { requestId, owner };
  if (opts.resumeRecast && row.operation === 'recast' && row.mode === 'account' && row.status === 'running' && row.vendorJobId) {
    return 'resume';
  }
  if (row.mode === 'wallet') {
    const [ledger] = await db.select({
      id: vendorSpendLedger.id,
      status: vendorSpendLedger.status,
      payerSignature: vendorSpendLedger.payerSignature,
    }).from(vendorSpendLedger).where(and(
      eq(vendorSpendLedger.avatarId, row.avatarId),
      eq(vendorSpendLedger.idempotencyKey, row.idempotencyKey),
    )).limit(1);
    if (!ledger) {
      await finishRequest(claim, failure('interrupted_not_paid'));
      return 'failed';
    }
    if (ledger.status === 'paid') {
      await finishRequest(claim, failure('result_lost', ledger.id));
      return 'failed';
    }
    if (ledger.status === 'failed') {
      await finishRequest(claim, failure('payment_prepare_failed', ledger.id));
      return 'failed';
    }
    // 'pending' with no stored signature was never sent (the signature is
    // stored before sending). Close it in one conditional UPDATE; if a
    // signature landed first, fall through to 'ambiguous'.
    if (ledger.status === 'pending' && !ledger.payerSignature) {
      const closed = await db.update(vendorSpendLedger)
        .set({ status: 'failed', failureReason: 'never_sent_runner_interrupted', updatedAt: new Date() })
        .where(and(eq(vendorSpendLedger.id, ledger.id), eq(vendorSpendLedger.status, 'pending'), isNull(vendorSpendLedger.payerSignature)))
        .returning({ id: vendorSpendLedger.id });
      if (closed.length > 0) {
        await finishRequest(claim, failure('interrupted_not_paid', ledger.id));
        return 'failed';
      }
    }
    await db.update(vendorSpendLedger)
      .set({ status: 'ambiguous', failureReason: 'runner_interrupted_after_signing', updatedAt: new Date() })
      .where(and(eq(vendorSpendLedger.id, ledger.id), eq(vendorSpendLedger.status, 'pending')));
    await finishRequest(claim, failure('payment_ambiguous', ledger.id), { status: 'ambiguous' });
    return 'ambiguous';
  }
  await finishRequest(claim, failure('outcome_unknown'));
  return 'failed';
}
