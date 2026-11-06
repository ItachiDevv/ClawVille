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
 * Limits are the human's own (founder 2026-11-05: each user's agent pays for
 * its own tools; ClawVille sets no fixed image count). The spend caps bound
 * the wallet mode. They do not cover the human's Studios credits, so mode
 * 'account' is bounded by the human's `studiosKeyImagesPerDay` spend rule:
 * the avatar's mode-'account' requests of this UTC day, ANY actor and surface
 * (an agent that holds its owner's magic-link session looks like the human),
 * counted from the same rows under the same lock, so it survives a restart.
 *
 * The image is stored in `avatar_media` (checked png/jpeg/webp bytes only; a
 * reply with only a link is `image_missing`) and served at GET /api/media/:id.
 * Vendor text is untrusted: only the image and our own status leave here.
 */

import { and, avatarMedia, db, desc, eq, inArray, sql, userSpendPolicies, vendorCallRequests, vendorSpendLedger } from '@clawville/database';
import { STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT } from '@clawville/shared';
import { callVendorWithAvatarWallet, readJsonCapped, type VendorCallFailure } from './outbound-x402';
import { loadVendorKey } from './vendor-credentials';
import {
  STUDIOS_MAX_CALL_ATOMIC,
  STUDIOS_PAY_TO,
  buildStudiosImageRequest,
  parseStudiosImage,
  type StudiosImageModel,
} from './vendors/studios';

export const MEDIA_KEEP_PER_AVATAR = 50;
const ACCOUNT_CALL_TIMEOUT_MS = 120_000;

export type StudiosImageFailure =
  | VendorCallFailure
  | 'studios_key_invalid'
  | 'studios_account_refused'
  | 'image_missing'
  | 'daily_limit';

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
  | { ok: false; code: StudiosImageFailure; message: string; httpStatus: FailureStatus; ledgerId: string | null };

type FailureStatus = 400 | 402 | 403 | 409 | 429 | 502;

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
};

function failure(code: StudiosImageFailure, ledgerId: string | null = null): StudiosImageResult {
  return { ok: false, code, ...MESSAGES[code], ledgerId };
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
}): Promise<Reservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vendor-call:${input.avatarId}`}))`);
    const [prior] = await tx
      .select({ status: vendorCallRequests.status, mode: vendorCallRequests.mode, mediaId: vendorCallRequests.mediaId, ledgerId: vendorCallRequests.ledgerId })
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
      return { kind: 'done', result: failure('duplicate_request', prior.ledgerId) };
    }
    if (input.mode === 'account') {
      const [rule] = await tx.select({ perDay: userSpendPolicies.studiosKeyImagesPerDay })
        .from(userSpendPolicies).where(eq(userSpendPolicies.avatarId, input.avatarId)).limit(1);
      const perDay = rule?.perDay ?? STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT;
      const dayStart = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(vendorCallRequests).where(and(
        eq(vendorCallRequests.avatarId, input.avatarId),
        eq(vendorCallRequests.mode, 'account'),
        sql`${vendorCallRequests.createdAt} >= ${dayStart}`,
      ));
      if ((row?.n ?? 0) >= perDay) return { kind: 'done', result: failure('daily_limit') };
    }
    const [created] = await tx.insert(vendorCallRequests).values({
      avatarId: input.avatarId,
      vendor: 'studios',
      actor: input.actor,
      surface: input.surface,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
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
    updatedAt: new Date(),
  }).where(eq(vendorCallRequests.id, requestId));
  return result;
}

/**
 * Make one Studios image for `avatarId`. The caller has already proved the
 * caller acts for this avatar (human session, ledger-capable agent session,
 * or the hosted runtime of this avatar).
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
  const request = buildStudiosImageRequest({ prompt: input.prompt, model: input.model });

  // A saved key that cannot be read is an error, never a silent switch to the
  // wallet: the human chose their own account.
  let key: string | null;
  try {
    key = await loadVendorKey(input.avatarId, 'studios');
  } catch {
    return failure('studios_key_invalid');
  }
  const mode = key ? 'account' : 'wallet';

  const reservation = await reserveRequest({
    avatarId: input.avatarId,
    actor: input.actor,
    surface: input.surface ?? 'api',
    mode,
    idempotencyKey: input.idempotencyKey,
  });
  if (reservation.kind === 'done') return reservation.result;
  const { requestId } = reservation;

  if (key) {
    const result = await callWithAccountKey(key, request);
    key = null;
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
    pin: { vendor: 'studios', payTo: STUDIOS_PAY_TO, maxCallAtomic: STUDIOS_MAX_CALL_ATOMIC },
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
