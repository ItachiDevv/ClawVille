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
 * The image is stored in `avatar_media` and served at GET /api/media/:id.
 * Vendor text is untrusted: only the image and our own status leave here.
 */

import { and, avatarMedia, db, desc, eq, inArray } from '@clawville/database';
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
  | 'image_missing';

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
  | { ok: false; code: StudiosImageFailure; message: string; httpStatus: 400 | 402 | 403 | 409 | 502; ledgerId: string | null };

const MESSAGES: Record<StudiosImageFailure, { httpStatus: 400 | 402 | 403 | 409 | 502; message: string }> = {
  duplicate_request: { httpStatus: 409, message: 'This Idempotency-Key was already used. Use a new key for a new image.' },
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
  studios_key_invalid: { httpStatus: 403, message: 'Studios refused the saved API key. Ask your human to save a new key in the wallet panel.' },
  studios_account_refused: { httpStatus: 402, message: "Studios refused the call on your human's Studios account (for example, no credits left). ClawVille paid nothing." },
  image_missing: { httpStatus: 502, message: 'Studios sent no readable image. Contact support with the ledgerId if one is shown.' },
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
  image: { imageUrl: string | null; imageBase64: string | null };
}): Promise<string | null> {
  const decoded = input.image.imageBase64 ? decodeImage(input.image.imageBase64) : null;
  if (!decoded && !input.image.imageUrl) return null;
  const [row] = await db
    .insert(avatarMedia)
    .values({
      avatarId: input.avatarId,
      vendor: 'studios',
      mode: input.mode,
      actor: input.actor,
      mimeType: decoded?.mime ?? null,
      bytes: decoded?.bytes ?? null,
      externalUrl: decoded ? null : input.image.imageUrl,
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
}): Promise<StudiosImageResult> {
  const request = buildStudiosImageRequest({ prompt: input.prompt, model: input.model });

  let key: string | null = null;
  try {
    key = await loadVendorKey(input.avatarId, 'studios');
  } catch {
    key = null;
  }

  if (key) {
    const result = await callWithAccountKey(key, request);
    key = null;
    if (!result.ok) return failure(result.code);
    const image = parseStudiosImage(result.json);
    if (!image) return failure('image_missing');
    const mediaId = await storeMedia({ avatarId: input.avatarId, mode: 'account', actor: input.actor, prompt: input.prompt, ledgerId: null, image });
    if (!mediaId) return failure('image_missing');
    return { ok: true, mode: 'account', mediaId, mediaPath: `/api/media/${mediaId}`, ledgerId: null, paidUsdCents: null, txSignature: null };
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
  if (!paid.ok) return failure(paid.code, paid.ledgerId ?? null);
  const image = parseStudiosImage(paid.responseJson);
  const mediaId = image
    ? await storeMedia({ avatarId: input.avatarId, mode: 'wallet', actor: input.actor, prompt: input.prompt, ledgerId: paid.ledgerId, image })
    : null;
  if (!mediaId) return failure('image_missing', paid.ledgerId);
  return {
    ok: true,
    mode: 'wallet',
    mediaId,
    mediaPath: `/api/media/${mediaId}`,
    ledgerId: paid.ledgerId,
    paidUsdCents: paid.usdCents,
    txSignature: paid.txSignature,
  };
}

/** One stored image, for GET /api/media/:id. */
export async function readMedia(id: string): Promise<
  { kind: 'bytes'; mime: string; bytes: Buffer } | { kind: 'link'; url: string } | null
> {
  const row = await db.query.avatarMedia.findFirst({
    where: eq(avatarMedia.id, id),
    columns: { mimeType: true, bytes: true, externalUrl: true },
  });
  if (!row) return null;
  if (row.bytes && row.mimeType) return { kind: 'bytes', mime: row.mimeType, bytes: Buffer.from(row.bytes) };
  if (row.externalUrl) return { kind: 'link', url: row.externalUrl };
  return null;
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
