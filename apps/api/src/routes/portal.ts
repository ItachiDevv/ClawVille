/**
 * Phase 5.1 — cross-world portal endpoints (plan §6.2, §9.6, §9.7, §15).
 *
 * Two directions + one link-code flow:
 *
 *   POST /api/portal/scape             (Lucia cookie)
 *     ClawVille → 'scape. Signs a hosted-session-issue request with the
 *     service issuer keypair, posts to SCAPE_HOSTED_SESSION_URL, relays
 *     the returned sessionToken to the caller in a redirect URL.
 *
 *   POST /api/portal/mint-for-scape    (scape signature)
 *     'scape → ClawVille reverse portal. Verifies the scape-side
 *     signature against PARTNER_PUBKEYS.scape, resolves the user,
 *     mints a magic-link ticket, returns { redirectUrl }.
 *
 *   POST /api/portal/accept-scape-link (scape signature)
 *     Link-code redemption §15. Scape's server POSTs the linkCode plus
 *     the user's scape identity; we verify the signature, look up the
 *     pending-link row, write the linked_scape_* columns, mark the
 *     link consumed.
 *
 *   POST /api/portal/scape-link-code   (Lucia cookie)
 *     Mint a link code the human pastes into scape to start the linking
 *     flow. 10-minute TTL, rate-limited 3/min/user.
 *
 * All four endpoints write to the unified events table (not a dedicated
 * portal_crossings table — see plan §4.2). Event types:
 *   - portal.scape.crossed         (both directions, direction field)
 *   - portal.scape.cross_failed
 *   - portal.scape.linked
 *
 * Partner-signature verification (for the two endpoints that don't use
 * Lucia): scape sends `X-Scape-Issuer-Pubkey` + `X-Scape-Signature`
 * over sha256(raw body). We compare the pubkey against the
 * `PARTNER_PUBKEYS.scape` allowlist from env; allowlist miss = 401,
 * signature mismatch = 401. Mirrors how we sign outbound (see
 * service-issuer.ts §5.3).
 */

import { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { eq } from 'drizzle-orm';
import {
  db,
  users,
  pets,
  openclawBots,
  pendingAccountLinks,
} from '@clawville/database';
import type { AppContext } from '../types';
import { sessionMiddleware, requireAuth } from '../middleware/auth';
import { createRateLimiter, getClientIp } from '../middleware/rate-limit';
import { signPayload } from '../services/service-issuer';
import { mintSessionTicket } from '../services/session-ticket-service';
import { logEvent } from '../services/event-logger';

export const portalRoutes = new Hono<AppContext>();

// Default scape endpoints. Both can be overridden via env on Coolify for
// staging / dev. Trim trailing slashes defensively so users setting
// `https://xrsps.com/` vs `https://xrsps.com` both work.
function resolveScapeIssueUrl(): string {
  const raw = process.env.SCAPE_HOSTED_SESSION_URL ?? 'https://xrsps.com/hosted-session/issue';
  return raw.replace(/\/+$/, '');
}
function resolveScapeWebOrigin(): string {
  const raw = process.env.SCAPE_WEB_ORIGIN ?? 'https://xrsps.com';
  return raw.replace(/\/+$/, '');
}

/**
 * Parse PARTNER_PUBKEYS env var (JSON: `{"scape":"<base58>"}`) into a
 * lookup map. Keyed by partner id. Returns null if the env var is
 * missing or malformed — callers treat that as "no partners allowed"
 * and 401 all inbound signed requests.
 */
function loadPartnerPubkeys(): Record<string, string> | null {
  const raw = process.env.PARTNER_PUBKEYS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// /api/portal/scape — plan §11.2 says 10/min per USER, not IP. Hono doesn't
// have a per-user limiter out of the box, so we do per-IP as a pragmatic
// approximation (a single user behind a home IP is one bucket). When we
// add Redis we can swap to user-scoped keys.
const scapePortalRateLimiter = createRateLimiter({
  maxPerWindow: 10,
  windowMs: 60_000,
});

// Link-code mint is the most precious operation (short TTL, user-initiated,
// low steady-state volume). Plan §15 caps at 3/min/user — again pragmatic
// per-IP for now.
const linkCodeRateLimiter = createRateLimiter({
  maxPerWindow: 3,
  windowMs: 60_000,
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Verify a scape-signed inbound request. Returns the partner id on
 * success, or a sanitized 401 reason. All decoding failures map to a
 * single generic reason so callers return an opaque 401.
 *
 * The signature is ed25519(sha256(rawBody)) — matches the signPayload()
 * scheme on the outbound side (service-issuer.ts).
 */
function verifyScapeSignature(args: {
  pubkeyHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
}): { ok: true; partnerId: string } | { ok: false; reason: string } {
  if (!args.pubkeyHeader || !args.signatureHeader) {
    return { ok: false, reason: 'missing_signature' };
  }
  const allowlist = loadPartnerPubkeys();
  if (!allowlist) return { ok: false, reason: 'no_partner_allowlist' };

  // Only scape is wired today, so the partner id must be exactly 'scape'.
  const expectedPubkey = allowlist.scape;
  if (!expectedPubkey || args.pubkeyHeader !== expectedPubkey) {
    return { ok: false, reason: 'unknown_partner' };
  }

  // Digest MUST be computed over the exact raw body bytes the partner
  // signed; verifying against a re-parsed-then-re-stringified JSON would
  // fail as soon as key order or whitespace differed.
  const digest = createHash('sha256').update(args.rawBody).digest();
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(args.signatureHeader);
    pubBytes = bs58.decode(args.pubkeyHeader);
  } catch {
    return { ok: false, reason: 'bad_signature_encoding' };
  }
  if (sigBytes.length !== 64 || pubBytes.length !== 32) {
    return { ok: false, reason: 'bad_signature_length' };
  }
  if (!nacl.sign.detached.verify(new Uint8Array(digest), sigBytes, pubBytes)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, partnerId: 'scape' };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Alphabet matches the base58 we use elsewhere so link codes are
// visually unambiguous when a human reads them out. 8 chars over this
// 58-char alphabet = ~47 bits of entropy, well above brute-force within
// the 10-minute TTL.
const BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function generateLinkCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += BASE58_ALPHA[b % BASE58_ALPHA.length];
  return `link-${out}`;
}

// ---------------------------------------------------------------------------
// POST /api/portal/scape  — ClawVille → 'scape outbound portal
// ---------------------------------------------------------------------------

portalRoutes.post('/scape', sessionMiddleware, requireAuth, async (c) => {
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!scapePortalRateLimiter.check(ip)) {
    return c.json({ error: 'Too many portal requests. Try again in 1 minute.' }, 429);
  }

  const user = c.get('user');
  if (!user) {
    // requireAuth already covers this — belt-and-suspenders for the
    // TypeScript narrowing below.
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Load user + pet + most-recent bot in a single hop each. Plan §9.6
  // portal payload wants the most-recent openclaw_bots.uuid if present
  // (so scape associates the crossing with the user's current agent),
  // nullable otherwise.
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: {
      id: true,
      linkedScapePrincipalId: true,
      linkedScapeWorldCharacterId: true,
      linkedScapeDisplayName: true,
      scapePrincipalId: true,
      scapeWorldCharacterId: true,
    },
  });
  if (!userRow) {
    return c.json({ error: 'User not found' }, 404);
  }

  const userPet = await db.query.pets.findFirst({
    where: eq(pets.userId, user.id),
    columns: { id: true, name: true },
  });
  if (!userPet) {
    return c.json({ error: 'No pet — create your agent first' }, 400);
  }

  const latestBot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.userId, user.id),
    orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
    columns: { id: true },
  });

  // Plan §15.4 — prefer linked values when present. Falls back to the
  // auto-provisioned defaults for users who haven't linked a real
  // scape account.
  const principalId =
    userRow.linkedScapePrincipalId ?? `principal:clawville:${user.id}`;
  const worldCharacterId =
    userRow.linkedScapeWorldCharacterId ?? `cv-${userPet.id}`;
  const displayName =
    userRow.linkedScapeDisplayName ?? `${userPet.name}-cv`;
  const agentId = latestBot?.id ?? null;

  const payload = {
    kind: 'human' as const,
    principalId,
    worldCharacterId,
    displayName,
    agentId,
    ttlMs: 300_000,
  };

  // Sign + POST. Failure modes split into two buckets:
  //   1. Our signing key isn't configured → 503 (env var missing)
  //   2. Scape is unreachable / rejects → 502 (their side)
  let signed: ReturnType<typeof signPayload>;
  try {
    signed = signPayload(payload);
  } catch (err) {
    console.error('[Portal/Scape] signing failed:', err);
    return c.json({ error: 'portal_issuer_unconfigured' }, 503);
  }

  const scapeUrl = resolveScapeIssueUrl();
  let scapeResponse: Response;
  try {
    scapeResponse = await fetch(scapeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Clawville-Issuer-Pubkey': signed.pubkey,
        'X-Clawville-Signature': signed.signature,
      },
      body: signed.body,
    });
  } catch (err) {
    console.error('[Portal/Scape] fetch failed:', err);
    await logEvent({
      eventType: 'portal.scape.cross_failed',
      userId: user.id,
      petId: userPet.id,
      agentId,
      payload: { reason: 'fetch_error', message: String(err) },
    });
    return c.json({ error: 'scape_unreachable' }, 502);
  }

  if (!scapeResponse.ok) {
    const body = await scapeResponse.text().catch(() => '');
    await logEvent({
      eventType: 'portal.scape.cross_failed',
      userId: user.id,
      petId: userPet.id,
      agentId,
      payload: {
        reason: 'partner_rejected',
        status: scapeResponse.status,
        bodySnippet: body.slice(0, 200),
      },
    });
    return c.json({ error: 'scape_rejected', status: scapeResponse.status }, 502);
  }

  let scapeJson: { sessionToken?: string; claims?: Record<string, unknown> } = {};
  try {
    scapeJson = (await scapeResponse.json()) as typeof scapeJson;
  } catch (err) {
    await logEvent({
      eventType: 'portal.scape.cross_failed',
      userId: user.id,
      petId: userPet.id,
      agentId,
      payload: { reason: 'partner_bad_json', message: String(err) },
    });
    return c.json({ error: 'scape_bad_response' }, 502);
  }

  const sessionToken = scapeJson.sessionToken;
  if (!sessionToken || typeof sessionToken !== 'string') {
    await logEvent({
      eventType: 'portal.scape.cross_failed',
      userId: user.id,
      petId: userPet.id,
      agentId,
      payload: { reason: 'partner_missing_session_token' },
    });
    return c.json({ error: 'scape_missing_token' }, 502);
  }

  // Backfill scape_* columns on first successful crossing so future
  // queries can short-circuit without the scape round-trip (though we
  // always go through scape for token minting — this is just audit).
  if (!userRow.scapePrincipalId) {
    try {
      await db
        .update(users)
        .set({
          scapePrincipalId: principalId,
          scapeWorldCharacterId: worldCharacterId,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
    } catch (err) {
      // Uniqueness violation means someone else took the key first —
      // extremely unlikely in practice but don't crash the portal over
      // it. The audit event still fires.
      console.error('[Portal/Scape] scape_* backfill failed (non-fatal):', err);
    }
  }

  await logEvent({
    eventType: 'portal.scape.crossed',
    userId: user.id,
    petId: userPet.id,
    agentId,
    payload: {
      direction: 'clawville_to_scape',
      principalId,
      worldCharacterId,
      ticketRefHash: sha256Hex(sessionToken),
      ttlMs: 300_000,
    },
  });

  const webOrigin = resolveScapeWebOrigin();
  const redirectUrl = `${webOrigin}/?sessionToken=${encodeURIComponent(
    sessionToken,
  )}&worldCharacterId=${encodeURIComponent(worldCharacterId)}`;

  return c.json({ redirectUrl });
});

// ---------------------------------------------------------------------------
// POST /api/portal/mint-for-scape  — 'scape → ClawVille reverse portal
// ---------------------------------------------------------------------------
// No Lucia cookie. Auth is the scape-side signature. Plan §7.2 + §9.7.
// V1 only accepts principalId in the form `principal:clawville:<uuid>`
// so scape can't probe for arbitrary ClawVille users by guessing IDs.
// ---------------------------------------------------------------------------

const mintForScapeSchema = z.object({
  clawvillePrincipalId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(64).optional(),
  requestingScapeUserId: z.string().min(1).max(128),
});

portalRoutes.post('/mint-for-scape', async (c) => {
  // Read the raw body string first — sig verification must be over the
  // exact bytes the partner signed, not the re-stringified object.
  const raw = await c.req.text();

  const verify = verifyScapeSignature({
    pubkeyHeader: c.req.header('X-Scape-Issuer-Pubkey') ?? null,
    signatureHeader: c.req.header('X-Scape-Signature') ?? null,
    rawBody: raw,
  });
  if (!verify.ok) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = mintForScapeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  // V1 — only accept `principal:clawville:<uuid>`. Tighter pattern than
  // a general `principalId` so scape can't phish for ClawVille account
  // metadata via bulk guesses.
  const m = /^principal:clawville:([0-9a-f-]{36})$/i.exec(parsed.data.clawvillePrincipalId);
  if (!m) {
    return c.json({ error: 'invalid_principal_format' }, 400);
  }
  const userId = m[1];

  const userRow = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true },
  });
  if (!userRow) {
    return c.json({ error: 'not_found' }, 404);
  }

  const userPet = await db.query.pets.findFirst({
    where: eq(pets.userId, userId),
    columns: { id: true, name: true },
  });

  const latestBot = await db.query.openclawBots.findFirst({
    where: eq(openclawBots.userId, userId),
    orderBy: (t, { desc }) => [desc(t.lastSeenAt)],
    columns: { id: true },
  });

  let sessionTicket: Awaited<ReturnType<typeof mintSessionTicket>>;
  try {
    sessionTicket = await mintSessionTicket({
      userId,
      petId: userPet?.id ?? null,
      identityType: 'portal-scape',
      identityKey: `scape:${parsed.data.requestingScapeUserId}`,
      petName: userPet?.name ?? null,
    });
  } catch (err) {
    console.error('[Portal/MintForScape] ticket mint failed:', err);
    return c.json({ error: 'ticket_mint_failed' }, 500);
  }

  await logEvent({
    eventType: 'portal.scape.crossed',
    userId,
    petId: userPet?.id ?? null,
    agentId: latestBot?.id ?? null,
    payload: {
      direction: 'scape_to_clawville',
      principalId: parsed.data.clawvillePrincipalId,
      ticketRefHash: sha256Hex(sessionTicket.ticket),
      requestingScapePrefix: parsed.data.requestingScapeUserId.slice(0, 16),
    },
  });

  return c.json({ redirectUrl: sessionTicket.url });
});

// ---------------------------------------------------------------------------
// POST /api/portal/accept-scape-link  — redeem a link code (plan §15.2)
// ---------------------------------------------------------------------------

const acceptScapeLinkSchema = z.object({
  linkCode: z.string().min(5).max(32),
  scapePrincipalId: z.string().min(1).max(128),
  scapeWorldCharacterId: z.string().min(1).max(64),
  scapeDisplayName: z.string().min(1).max(64),
});

portalRoutes.post('/accept-scape-link', async (c) => {
  const raw = await c.req.text();

  const verify = verifyScapeSignature({
    pubkeyHeader: c.req.header('X-Scape-Issuer-Pubkey') ?? null,
    signatureHeader: c.req.header('X-Scape-Signature') ?? null,
    rawBody: raw,
  });
  if (!verify.ok) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = acceptScapeLinkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const {
    linkCode,
    scapePrincipalId,
    scapeWorldCharacterId,
    scapeDisplayName,
  } = parsed.data;

  // 1. Look up the pending link. Unconsumed + unexpired only.
  const pending = await db.query.pendingAccountLinks.findFirst({
    where: eq(pendingAccountLinks.code, linkCode),
  });
  if (!pending || pending.consumedAt || pending.expiresAt.getTime() < Date.now()) {
    return c.json({ error: 'link_expired_or_invalid' }, 404);
  }

  // 2. Make sure the target user isn't already linked to a scape
  //    account (UNIQUE constraint would also catch this, but the 409
  //    is friendlier than a 500 from a unique-violation surface).
  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, pending.clawvilleUserId),
    columns: { id: true, linkedScapePrincipalId: true, name: true },
  });
  if (!targetUser) {
    return c.json({ error: 'target_user_missing' }, 404);
  }
  if (targetUser.linkedScapePrincipalId) {
    return c.json({ error: 'already_linked' }, 409);
  }

  // 3. Make sure this scape principal isn't already linked to a
  //    different ClawVille user.
  const collision = await db.query.users.findFirst({
    where: eq(users.linkedScapePrincipalId, scapePrincipalId),
    columns: { id: true },
  });
  if (collision && collision.id !== targetUser.id) {
    return c.json({ error: 'scape_principal_already_linked' }, 409);
  }

  // 4. Commit the link + mark the code consumed. Ideally in one tx;
  //    Drizzle's db.transaction wraps both writes atomically.
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          linkedScapePrincipalId: scapePrincipalId,
          linkedScapeWorldCharacterId: scapeWorldCharacterId,
          linkedScapeDisplayName: scapeDisplayName,
          linkedScapeAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, pending.clawvilleUserId));

      await tx
        .update(pendingAccountLinks)
        .set({ consumedAt: new Date() })
        .where(eq(pendingAccountLinks.code, linkCode));
    });
  } catch (err) {
    console.error('[Portal/AcceptScapeLink] tx failed:', err);
    return c.json({ error: 'link_commit_failed' }, 500);
  }

  // Pet lookup for the caller-facing response (confirmation copy).
  const userPet = await db.query.pets.findFirst({
    where: eq(pets.userId, pending.clawvilleUserId),
    columns: { name: true },
  });

  // Privacy: log only a short prefix of the scape principal. The
  // event-logger sanitizer won't redact the field name
  // `scapePrincipalId` (no sensitive-word match), but we still keep
  // full principals out of the audit log by choice.
  await logEvent({
    eventType: 'portal.scape.linked',
    userId: pending.clawvilleUserId,
    payload: {
      scapePrincipalPrefix: scapePrincipalId.slice(0, 16),
      scapeDisplayName,
      linkCodeHash: sha256Hex(linkCode),
    },
  });

  return c.json({
    linked: true,
    clawvilleDisplayName: targetUser.name ?? null,
    petName: userPet?.name ?? null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/portal/scape-link-code  — mint a link code (Lucia auth)
// ---------------------------------------------------------------------------

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 min per plan §15.2

portalRoutes.post('/scape-link-code', sessionMiddleware, requireAuth, async (c) => {
  const ip = getClientIp({ get: (name) => c.req.header(name) ?? null });
  if (!linkCodeRateLimiter.check(ip)) {
    return c.json({ error: 'Too many link code requests. Try again in 1 minute.' }, 429);
  }

  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  // Generate a fresh code. The primary-key uniqueness on the table
  // serialises any collision — extremely unlikely (47 bits over 8
  // chars) but a 23505 here means we retry once.
  let code = generateLinkCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

  try {
    await db.insert(pendingAccountLinks).values({
      code,
      clawvilleUserId: user.id,
      remoteWorld: 'scape',
      expiresAt,
    });
  } catch (err) {
    // 23505 = unique_violation on PK — retry once with a fresh code.
    const errCode = (err as { code?: string; cause?: { code?: string } })?.code
      ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (errCode === '23505') {
      code = generateLinkCode();
      try {
        await db.insert(pendingAccountLinks).values({
          code,
          clawvilleUserId: user.id,
          remoteWorld: 'scape',
          expiresAt,
        });
      } catch (err2) {
        console.error('[Portal/LinkCode] second insert failed:', err2);
        return c.json({ error: 'link_code_mint_failed' }, 500);
      }
    } else {
      console.error('[Portal/LinkCode] insert failed:', err);
      return c.json({ error: 'link_code_mint_failed' }, 500);
    }
  }

  return c.json({ code, expiresAt: expiresAt.toISOString() });
});
