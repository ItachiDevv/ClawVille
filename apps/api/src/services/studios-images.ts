/**
 * Studios image generation for an avatar, in the mode its human chose
 * (MCP hub step 2 phase 2b). ONE service for every surface: the human web
 * form and REST route, the MCP tool and the hosted-agent `[ACTION:]` verb.
 *
 *   - mode 'account' (A): the human saved their own Studios API key. Studios
 *     bills the human's Studios credits and saves the image to their My Media.
 *     ClawVille moves no money and writes no spend-ledger row.
 *   - mode 'wallet' (B): no key saved. The avatar wallet pays with x402 inside
 *     the human's spend rules (`outbound-x402.ts`).
 *
 * Every request first reserves a `vendor_call_requests` row (unique per
 * avatar + idempotency key) under a per-avatar advisory lock, so a retry never
 * bills twice in either mode. A retry of a finished request returns the same
 * image; a retry of an unfinished or failed one is `duplicate_request`.
 *
 * "Ask me before each payment" (founder go 2026-11-06, migration 0093): when
 * the human turns `requireApproval` on, EVERY request (any actor, any
 * surface, the human's own web form too) runs only the checks that need no
 * vendor call, then its row waits as `awaiting_approval` for 15 minutes.
 * Nothing is called, signed or paid. The human approves with a signature from
 * their linked wallet (`approveStudiosRequest`: the SAME pipeline, every cap
 * and limit checked again at that moment) or declines it; nobody answering
 * makes it `expired` (lazily, on the next read or write of that avatar's rows).
 *
 * Limits are the human's own (founder 2026-11-05: each user's agent pays for
 * its own tools; ClawVille sets no fixed image count). The spend caps bound
 * the wallet mode. They do not cover the human's Studios credits, so mode
 * 'account' is bounded by the human's `studiosKeyImagesPerDay` spend rule:
 * the avatar's mode-'account' requests of this UTC day, ANY actor and surface
 * (an agent that holds its owner's magic-link session looks like the human),
 * counted from the same rows under the same lock, so it survives a restart.
 * A request counts on the UTC day it ran (an approved one on its approve
 * day); a waiting request counts as a reservation; a declined or expired one
 * does not (it never reached Studios).
 *
 * The image is stored in `avatar_media` (checked png/jpeg/webp bytes only; a
 * reply with only a link is `image_missing`) and served at GET /api/media/:id.
 * Vendor text is untrusted: only the image and our own status leave here.
 */

import { and, asc, avatarMedia, db, desc, eq, inArray, or, sql, userSpendPolicies, vendorCallRequests, vendorSpendLedger } from '@clawville/database';
import {
  SPEND_APPROVAL_MAX_AWAITING,
  SPEND_APPROVAL_TTL_MS,
  STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT,
  type VendorCallApprovalView,
  type VendorCallStatus,
} from '@clawville/shared';
import { callVendorWithAvatarWallet, readJsonCapped, type VendorCallFailure } from './outbound-x402';
import { toSpendPolicyView } from './spend-policy';
import { promptSha256, type ApprovalTerms } from './spend-policy-proof';
import { loadVendorKey } from './vendor-credentials';
import {
  STUDIOS_IMAGE_MODELS,
  STUDIOS_MAX_CALL_ATOMIC,
  STUDIOS_PAY_TO,
  buildStudiosImageRequest,
  parseStudiosImage,
  type StudiosImageModel,
} from './vendors/studios';

export const MEDIA_KEEP_PER_AVATAR = 50;
const ACCOUNT_CALL_TIMEOUT_MS = 120_000;
const ATOMIC_PER_CENT = 10_000n;
/** The most one Studios call can cost, in US cents (the hard ceiling in vendors/studios.ts). */
const STUDIOS_MAX_CALL_CENTS = Number(STUDIOS_MAX_CALL_ATOMIC / ATOMIC_PER_CENT);
/** The hosted verb keeps at most one request waiting; it must not queue more. */
const HOSTED_MAX_AWAITING = 1;

export type StudiosImageFailure =
  | VendorCallFailure
  | 'studios_key_invalid'
  | 'studios_account_refused'
  | 'image_missing'
  | 'daily_limit'
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

export type StudiosImageResult =
  | {
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
  | StudiosImageRefusal
  | StudiosImageAwaiting;

/** A refusal or failure with our own code and message. */
export interface StudiosImageRefusal { ok: false; code: StudiosImageFailure; message: string; httpStatus: FailureStatus; ledgerId: string | null }

type FailureStatus = 400 | 402 | 403 | 404 | 409 | 429 | 502;

const MESSAGES: Record<StudiosImageFailure, { httpStatus: FailureStatus; message: string }> = {
  duplicate_request: { httpStatus: 409, message: 'This Idempotency-Key was already used for a request that did not finish. Do not retry it; use a new key only for a new image.' },
  daily_limit: { httpStatus: 429, message: "Your human's daily limit for images on their own Studios key is used up. Try again after 00:00 UTC, or ask your human to raise it in the wallet panel (Spending)." },
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
  studios_account_refused: { httpStatus: 402, message: "Studios refused the call on your human's Studios account (for example, no credits left). ClawVille paid nothing." },
  image_missing: { httpStatus: 502, message: 'Studios sent no readable image. Do not retry; contact support with the ledgerId if one is shown.' },
  approval_pending_limit: { httpStatus: 429, message: "Earlier requests still wait for your human's approval. Do not send another one; wait until your human approves or declines them in the wallet panel (each one expires after 15 minutes)." },
  approval_declined: { httpStatus: 403, message: 'Your human declined this request. Nothing was called or paid. Do not send it again.' },
  approval_expired: { httpStatus: 409, message: 'Nobody approved this request within 15 minutes, so it expired. Nothing was called or paid.' },
  approval_not_found: { httpStatus: 404, message: 'There is no such image request for this avatar.' },
  approval_not_awaiting: { httpStatus: 409, message: 'This request does not wait for approval any more: it was already approved, declined or finished.' },
  approval_terms_changed: { httpStatus: 409, message: 'The request or its price limit changed after the signature. Nothing was paid. Approve it again and sign the new message.' },
  approval_mode_changed: { httpStatus: 409, message: 'The Studios key was saved or removed after this request was made, so a different account would pay now. Nothing was paid. Decline it; your agent can send a new request.' },
};

function failure(code: StudiosImageFailure, ledgerId: string | null = null): StudiosImageRefusal {
  return { ok: false, code, ...MESSAGES[code], ledgerId };
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

function storedModel(model: string | null): StudiosImageModel | undefined {
  return (STUDIOS_IMAGE_MODELS as readonly string[]).includes(model ?? '') ? (model as StudiosImageModel) : undefined;
}

const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** Image bytes and type from base64, or null when it is not a png, jpeg or webp. */
export function decodeImage(base64: string): { bytes: Buffer; mime: string } | null {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null;
  const kind = MAGIC.find((m) => m.test(bytes));
  return kind ? { bytes, mime: kind.mime } : null;
}

async function storeMedia(input: {
  avatarId: string;
  mode: 'wallet' | 'account';
  actor: 'human' | 'agent';
  prompt: string;
  ledgerId: string | null;
  imageBase64: string;
}): Promise<string | null> {
  const decoded = decodeImage(input.imageBase64);
  if (!decoded) return null;
  const [row] = await db
    .insert(avatarMedia)
    .values({
      avatarId: input.avatarId,
      vendor: 'studios',
      mode: input.mode,
      actor: input.actor,
      mimeType: decoded.mime,
      bytes: decoded.bytes,
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

async function callWithAccountKey(key: string, request: { url: string; body: Record<string, unknown> }): Promise<
  { ok: true; json: unknown } | { ok: false; code: 'studios_key_invalid' | 'studios_account_refused' | 'vendor_refused' | 'vendor_unreachable' }
> {
  let res: Response;
  try {
    res = await fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(ACCOUNT_CALL_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    return { ok: false, code: 'vendor_unreachable' };
  }
  if (res.ok) return { ok: true, json: await readJsonCapped(res).catch(() => null) };
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'studios_key_invalid' };
  if (res.status === 402) return { ok: false, code: 'studios_account_refused' };
  return { ok: false, code: 'vendor_refused' };
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
      sql`${vendorCallRequests.expiresAt} <= now()`,
    ));
}

const DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

const EXECUTED_STATUSES: VendorCallStatus[] = ['pending', 'done', 'failed'];

/**
 * The avatar's own-key requests that count toward the human's per-day rule for
 * this UTC day. A request counts on the day it RAN: `decided_at` for an
 * approved request (approved at 00:01, it counts for the new day even when it
 * was made at 23:59), else `created_at`. `includeWaiting`: also every request
 * that still waits, whatever day it was made (a reservation; it expires in 15
 * minutes). Declined and expired requests never reached Studios and never count.
 */
async function ownKeyRequestsToday(executor: Executor, avatarId: string, opts: { includeWaiting: boolean; exceptId?: string }): Promise<number> {
  const [row] = await executor.select({ n: sql<number>`count(*)::int` }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.mode, 'account'),
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

async function readPolicyRow(executor: Executor, avatarId: string) {
  const [row] = await executor.select({
    dailyCapUsdCents: userSpendPolicies.dailyCapUsdCents,
    perCallCapUsdCents: userSpendPolicies.perCallCapUsdCents,
    allowedVendors: userSpendPolicies.allowedVendors,
    studiosKeyImagesPerDay: userSpendPolicies.studiosKeyImagesPerDay,
    requireApproval: userSpendPolicies.requireApproval,
    updatedAt: userSpendPolicies.updatedAt,
  }).from(userSpendPolicies).where(eq(userSpendPolicies.avatarId, avatarId)).limit(1);
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

type Reservation =
  | { kind: 'new'; requestId: string }
  | { kind: 'done'; result: StudiosImageResult };

/** Reserve the request, or find the earlier one, under the avatar's lock. */
async function reserveRequest(input: {
  avatarId: string;
  actor: 'human' | 'agent';
  surface: 'api' | 'hosted';
  mode: 'wallet' | 'account';
  idempotencyKey: string;
  prompt: string;
  model: StudiosImageModel | undefined;
}): Promise<Reservation> {
  return db.transaction(async (tx) => {
    await lockAvatarRequests(tx, input.avatarId);
    await expireOverdue(tx, input.avatarId);
    const [prior] = await tx
      .select({
        id: vendorCallRequests.id,
        status: vendorCallRequests.status,
        mode: vendorCallRequests.mode,
        mediaId: vendorCallRequests.mediaId,
        ledgerId: vendorCallRequests.ledgerId,
        expiresAt: vendorCallRequests.expiresAt,
      })
      .from(vendorCallRequests)
      .where(and(
        eq(vendorCallRequests.avatarId, input.avatarId),
        eq(vendorCallRequests.vendor, 'studios'),
        eq(vendorCallRequests.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1);
    if (prior) {
      if (prior.status === 'done' && prior.mediaId) {
        const [ledger] = prior.ledgerId
          ? await tx.select({ usdCents: vendorSpendLedger.usdCents, txSignature: vendorSpendLedger.txSignature })
            .from(vendorSpendLedger).where(eq(vendorSpendLedger.id, prior.ledgerId)).limit(1)
          : [];
        return {
          kind: 'done',
          result: {
            ok: true,
            mode: prior.mode === 'account' ? 'account' : 'wallet',
            mediaId: prior.mediaId,
            mediaPath: `/api/media/${prior.mediaId}`,
            ledgerId: prior.ledgerId,
            paidUsdCents: ledger?.usdCents ?? null,
            txSignature: ledger?.txSignature ?? null,
          },
        };
      }
      // The same key again returns the same waiting request, never a new row.
      if (prior.status === 'awaiting_approval' && prior.expiresAt) return { kind: 'done', result: awaiting(prior.id, prior.expiresAt) };
      if (prior.status === 'declined') return { kind: 'done', result: failure('approval_declined') };
      if (prior.status === 'expired') return { kind: 'done', result: failure('approval_expired') };
      return { kind: 'done', result: failure('duplicate_request', prior.ledgerId) };
    }
    const policy = await readPolicyRow(tx, input.avatarId);
    if (input.mode === 'account') {
      const perDay = policy.studiosKeyImagesPerDay ?? STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT;
      if (await ownKeyRequestsToday(tx, input.avatarId, { includeWaiting: true }) >= perDay) {
        return { kind: 'done', result: failure('daily_limit') };
      }
    }
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
      const [created] = await tx.insert(vendorCallRequests).values({
        avatarId: input.avatarId,
        vendor: 'studios',
        actor: input.actor,
        surface: input.surface,
        mode: input.mode,
        status: 'awaiting_approval',
        idempotencyKey: input.idempotencyKey,
        prompt: input.prompt,
        model: input.model ?? null,
        expiresAt,
      }).returning({ id: vendorCallRequests.id });
      if (!created) throw new Error('vendor_call_requests insert returned no row');
      return { kind: 'done', result: awaiting(created.id, expiresAt) };
    }
    const [created] = await tx.insert(vendorCallRequests).values({
      avatarId: input.avatarId,
      vendor: 'studios',
      actor: input.actor,
      surface: input.surface,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      model: input.model ?? null,
    }).returning({ id: vendorCallRequests.id });
    if (!created) throw new Error('vendor_call_requests insert returned no row');
    return { kind: 'new', requestId: created.id };
  });
}

/** Record the outcome on the request row, then return it unchanged. */
async function finishRequest(requestId: string, result: StudiosImageResult): Promise<StudiosImageResult> {
  await db.update(vendorCallRequests).set({
    status: result.ok ? 'done' : 'failed',
    mediaId: result.ok ? result.mediaId : null,
    ledgerId: result.ledgerId,
    failureCode: result.ok ? null : result.code,
    updatedAt: new Date(),
  }).where(eq(vendorCallRequests.id, requestId));
  return result;
}

/**
 * Run one reserved ('pending') request: the human's own key when `key` is
 * set, else the avatar wallet inside the spend rules. The row's idempotency
 * key is also the spend-ledger key, so a payment is never made twice.
 */
async function runReservedRequest(input: {
  requestId: string;
  avatarId: string;
  actor: 'human' | 'agent';
  prompt: string;
  model: StudiosImageModel | undefined;
  idempotencyKey: string;
  key: string | null;
  /** Approve only: the most the human signed for (wallet mode); a higher quote pays nothing. */
  maxCallAtomic?: bigint;
}): Promise<StudiosImageResult> {
  const request = buildStudiosImageRequest({ prompt: input.prompt, model: input.model });
  const maxCallAtomic = input.maxCallAtomic !== undefined && input.maxCallAtomic < STUDIOS_MAX_CALL_ATOMIC
    ? input.maxCallAtomic
    : STUDIOS_MAX_CALL_ATOMIC;
  const { requestId } = input;

  if (input.key) {
    const result = await callWithAccountKey(input.key, request);
    if (!result.ok) return finishRequest(requestId, failure(result.code));
    const image = parseStudiosImage(result.json);
    const mediaId = image
      ? await storeMedia({ avatarId: input.avatarId, mode: 'account', actor: input.actor, prompt: input.prompt, ledgerId: null, imageBase64: image.imageBase64 })
      : null;
    if (!mediaId) return finishRequest(requestId, failure('image_missing'));
    return finishRequest(requestId, { ok: true, mode: 'account', mediaId, mediaPath: `/api/media/${mediaId}`, ledgerId: null, paidUsdCents: null, txSignature: null });
  }

  const paid = await callVendorWithAvatarWallet({
    avatarId: input.avatarId,
    actor: input.actor,
    pin: { vendor: 'studios', payTo: STUDIOS_PAY_TO, maxCallAtomic },
    tool: 'images.generations',
    idempotencyKey: input.idempotencyKey,
    url: request.url,
    body: request.body,
  });
  if (!paid.ok) return finishRequest(requestId, failure(paid.code, paid.ledgerId ?? null));
  const image = parseStudiosImage(paid.responseJson);
  const mediaId = image
    ? await storeMedia({ avatarId: input.avatarId, mode: 'wallet', actor: input.actor, prompt: input.prompt, ledgerId: paid.ledgerId, imageBase64: image.imageBase64 })
    : null;
  if (!mediaId) return finishRequest(requestId, failure('image_missing', paid.ledgerId));
  return finishRequest(requestId, {
    ok: true,
    mode: 'wallet',
    mediaId,
    mediaPath: `/api/media/${mediaId}`,
    ledgerId: paid.ledgerId,
    paidUsdCents: paid.usdCents,
    txSignature: paid.txSignature,
  });
}

/** The saved key, `undefined` when it cannot be read (never a silent switch to the wallet). */
async function loadKeyOrInvalid(avatarId: string): Promise<string | null | undefined> {
  try {
    return await loadVendorKey(avatarId, 'studios');
  } catch {
    return undefined;
  }
}

/**
 * Make one Studios image for `avatarId`. The caller has already proved the
 * caller acts for this avatar (human session, ledger-capable agent session,
 * or the hosted runtime of this avatar). `actor` decides whether the request
 * waits for the human when "ask me before each payment" is on: pass 'agent'
 * for every request that the human did not make themselves.
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
  // A saved key that cannot be read is an error, never a silent switch to the
  // wallet: the human chose their own account.
  const key = await loadKeyOrInvalid(input.avatarId);
  if (key === undefined) return failure('studios_key_invalid');

  const reservation = await reserveRequest({
    avatarId: input.avatarId,
    actor: input.actor,
    surface: input.surface ?? 'api',
    mode: key ? 'account' : 'wallet',
    idempotencyKey: input.idempotencyKey,
    prompt: input.prompt,
    model: input.model,
  });
  if (reservation.kind === 'done') return reservation.result;
  return runReservedRequest({
    requestId: reservation.requestId,
    avatarId: input.avatarId,
    actor: input.actor,
    prompt: input.prompt,
    model: input.model,
    idempotencyKey: input.idempotencyKey,
    key,
  });
}

type DecisionRow = {
  id: string;
  status: string;
  mode: string;
  actor: string;
  surface: string;
  prompt: string | null;
  model: string | null;
  idempotencyKey: string;
};

/**
 * Lock this avatar's requests, expire overdue ones, and return the request row
 * when it still waits, or the refusal. Runs inside the caller's transaction.
 */
async function lockAwaitingRow(tx: Executor, avatarId: string, requestId: string): Promise<{ ok: true; row: DecisionRow } | { ok: false; result: StudiosImageRefusal }> {
  await lockAvatarRequests(tx, avatarId);
  await expireOverdue(tx, avatarId);
  const [row] = await tx.select({
    id: vendorCallRequests.id,
    status: vendorCallRequests.status,
    mode: vendorCallRequests.mode,
    actor: vendorCallRequests.actor,
    surface: vendorCallRequests.surface,
    prompt: vendorCallRequests.prompt,
    model: vendorCallRequests.model,
    idempotencyKey: vendorCallRequests.idempotencyKey,
  }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, requestId),
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
  )).limit(1);
  if (!row) return { ok: false, result: failure('approval_not_found') };
  if (row.status === 'expired') return { ok: false, result: failure('approval_expired') };
  if (row.status !== 'awaiting_approval' || !row.prompt) return { ok: false, result: failure('approval_not_awaiting') };
  return { ok: true, row };
}

export type StudiosDecision = { result: StudiosImageResult; surface: 'api' | 'hosted' | null };

/** The most a wallet-mode request may cost, from the current spend rules. */
function walletMaxCents(policy: ReturnType<typeof toSpendPolicyView>): number {
  return Math.min(policy.perCallCapUsdCents ?? 0, STUDIOS_MAX_CALL_CENTS);
}

/**
 * The terms the human's linked wallet signs to approve one waiting request:
 * the avatar, the request, who pays, the most it can cost now, and the SHA-256
 * of the prompt. Refuses a request that does not wait any more.
 */
export async function readApprovalTerms(avatarId: string, requestId: string): Promise<{ ok: true; terms: ApprovalTerms } | { ok: false; result: StudiosImageRefusal }> {
  await expireOverdue(db, avatarId);
  const [row] = await db.select({
    status: vendorCallRequests.status,
    mode: vendorCallRequests.mode,
    prompt: vendorCallRequests.prompt,
  }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, requestId),
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
  )).limit(1);
  if (!row) return { ok: false, result: failure('approval_not_found') };
  if (row.status === 'expired') return { ok: false, result: failure('approval_expired') };
  if (row.status !== 'awaiting_approval' || row.prompt === null) return { ok: false, result: failure('approval_not_awaiting') };
  const mode = row.mode === 'account' ? 'account' : 'wallet';
  return {
    ok: true,
    terms: {
      avatarId,
      requestId,
      mode,
      maxUsdCents: mode === 'account' ? null : walletMaxCents(await readPolicyRow(db, avatarId)),
      promptSha256: promptSha256(row.prompt),
    },
  };
}

/**
 * The human approves one waiting request. The route has verified the linked
 * wallet's signature over `terms` (`readApprovalTerms`, `verifyApprovalProof`);
 * a session alone never gets here. Under the avatar's lock: the row must still
 * wait and not be expired, its mode and prompt must equal the signed terms,
 * the payer must be the same as when it was made (a key saved or removed since
 * then refuses), and the own-key day limit is checked again, counting this
 * request on today (the day it runs). In wallet mode the call may cost at most
 * the signed amount. The
 * row then becomes 'pending' in the same transaction, so a second approve
 * click finds it not waiting and pays nothing. The SAME pipeline as a direct
 * request runs next; the wallet mode checks every cap again with the real
 * price (`admit`), writes the ledger row before signing, and never retries an
 * ambiguous payment.
 */
export async function approveStudiosRequest(input: { avatarId: string; userId: string; requestId: string; terms: ApprovalTerms }): Promise<StudiosDecision> {
  if (input.terms.requestId !== input.requestId || input.terms.avatarId !== input.avatarId) {
    return { result: failure('approval_terms_changed'), surface: null };
  }
  const key = await loadKeyOrInvalid(input.avatarId);
  if (key === undefined) return { result: failure('studios_key_invalid'), surface: null };
  const currentMode = key ? 'account' : 'wallet';

  const claim = await db.transaction(async (tx) => {
    const found = await lockAwaitingRow(tx, input.avatarId, input.requestId);
    if (!found.ok) return found;
    const { row } = found;
    if (row.mode !== input.terms.mode || promptSha256(row.prompt!) !== input.terms.promptSha256) {
      return { ok: false as const, result: failure('approval_terms_changed') };
    }
    if (row.mode !== currentMode) return { ok: false as const, result: failure('approval_mode_changed') };
    if (row.mode === 'account') {
      const policy = await readPolicyRow(tx, input.avatarId);
      // This request counts too, on today: the requests that already ran today plus this one.
      const ranToday = await ownKeyRequestsToday(tx, input.avatarId, { includeWaiting: false, exceptId: row.id });
      if (ranToday + 1 > policy.studiosKeyImagesPerDay) {
        return { ok: false as const, result: failure('daily_limit') };
      }
    }
    // A read outside this lock can expire the row between the select and here;
    // then no row flips and nothing runs.
    const [flipped] = await tx.update(vendorCallRequests).set({
      status: 'pending',
      decidedAt: new Date(),
      decidedByUserId: input.userId,
      updatedAt: new Date(),
    }).where(and(eq(vendorCallRequests.id, row.id), eq(vendorCallRequests.status, 'awaiting_approval')))
      .returning({ id: vendorCallRequests.id });
    if (!flipped) return { ok: false as const, result: failure('approval_not_awaiting') };
    return { ok: true as const, row };
  });
  if (!claim.ok) return { result: claim.result, surface: null };
  const { row } = claim;
  const result = await runReservedRequest({
    requestId: row.id,
    avatarId: input.avatarId,
    actor: row.actor === 'human' ? 'human' : 'agent',
    prompt: row.prompt!,
    model: storedModel(row.model),
    idempotencyKey: row.idempotencyKey,
    key,
    maxCallAtomic: input.terms.mode === 'wallet' ? BigInt(input.terms.maxUsdCents ?? 0) * ATOMIC_PER_CENT : undefined,
  });
  return { result, surface: row.surface === 'hosted' ? 'hosted' : 'api' };
}

/** The human declines one waiting request. Nothing is called or paid. */
export async function declineStudiosRequest(input: { avatarId: string; userId: string; requestId: string }): Promise<
  { ok: true; requestId: string; status: 'declined'; surface: 'api' | 'hosted' } | { ok: false; result: StudiosImageRefusal }
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
    return { ok: true as const, requestId: found.row.id, status: 'declined' as const, surface: found.row.surface === 'hosted' ? 'hosted' as const : 'api' as const };
  });
}

/** The avatar's waiting requests, oldest first, for the human's Approvals list. */
export async function listAwaitingApprovals(avatarId: string): Promise<VendorCallApprovalView[]> {
  await expireOverdue(db, avatarId);
  const rows = await db.select({
    id: vendorCallRequests.id,
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
  const walletMax = walletMaxCents(policy);
  return rows.map((r) => ({
    requestId: r.id,
    vendor: 'studios',
    prompt: r.prompt ?? '',
    model: r.model,
    mode: r.mode === 'account' ? 'account' : 'wallet',
    surface: r.surface === 'hosted' ? 'hosted' : 'api',
    maxUsdCents: r.mode === 'account' ? null : walletMax,
    createdAt: new Date(r.createdAt).toISOString(),
    expiresAt: new Date(r.expiresAt ?? r.createdAt).toISOString(),
  }));
}

export interface StudiosRequestStatusView {
  requestId: string;
  status: VendorCallStatus;
  mode: 'wallet' | 'account';
  createdAt: string;
  /** Only for a request that waited for approval. */
  expiresAt: string | null;
  decidedAt: string | null;
  mediaId: string | null;
  mediaPath: string | null;
  /** Our own refusal code for a failed request (never vendor text). */
  code: string | null;
  ledgerId: string | null;
}

/** One request of this avatar, for its agent or its human. Null when not found. */
export async function readStudiosRequest(avatarId: string, requestId: string): Promise<StudiosRequestStatusView | null> {
  await expireOverdue(db, avatarId);
  const [row] = await db.select({
    id: vendorCallRequests.id,
    status: vendorCallRequests.status,
    mode: vendorCallRequests.mode,
    createdAt: vendorCallRequests.createdAt,
    expiresAt: vendorCallRequests.expiresAt,
    decidedAt: vendorCallRequests.decidedAt,
    mediaId: vendorCallRequests.mediaId,
    failureCode: vendorCallRequests.failureCode,
    ledgerId: vendorCallRequests.ledgerId,
  }).from(vendorCallRequests).where(and(
    eq(vendorCallRequests.id, requestId),
    eq(vendorCallRequests.avatarId, avatarId),
    eq(vendorCallRequests.vendor, 'studios'),
  )).limit(1);
  if (!row) return null;
  return {
    requestId: row.id,
    status: row.status as VendorCallStatus,
    mode: row.mode === 'account' ? 'account' : 'wallet',
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    mediaId: row.mediaId,
    mediaPath: row.mediaId ? `/api/media/${row.mediaId}` : null,
    code: row.failureCode,
    ledgerId: row.ledgerId,
  };
}

/** One stored image, for GET /api/media/:id. */
export async function readMedia(id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const row = await db.query.avatarMedia.findFirst({
    where: eq(avatarMedia.id, id),
    columns: { mimeType: true, bytes: true },
  });
  return row ? { mime: row.mimeType, bytes: Buffer.from(row.bytes) } : null;
}

/** The newest images of one avatar (ids and prompts only). */
export async function listMedia(avatarId: string, limit = 20): Promise<Array<{ id: string; mediaPath: string; prompt: string; mode: string; actor: string; createdAt: string }>> {
  const rows = await db
    .select({ id: avatarMedia.id, prompt: avatarMedia.prompt, mode: avatarMedia.mode, actor: avatarMedia.actor, createdAt: avatarMedia.createdAt })
    .from(avatarMedia)
    .where(eq(avatarMedia.avatarId, avatarId))
    .orderBy(desc(avatarMedia.createdAt))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map((r) => ({ ...r, mediaPath: `/api/media/${r.id}`, createdAt: new Date(r.createdAt).toISOString() }));
}
