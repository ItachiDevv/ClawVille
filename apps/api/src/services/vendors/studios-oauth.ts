/**
 * Studios sign-in (OAuth 2.1 authorization code + PKCE S256, public client)
 * for the human's own Studios account (MCP hub phase 3c, migration 0094).
 *
 * Registration: Client ID Metadata Document. ClawVille serves one JSON per
 * environment at `<api base>/.well-known/oauth-client/studios.json`; its URL
 * is the `client_id`. No client secret exists (token auth method `none`).
 *
 * Flow (the routes add the human gates and the linked-wallet proof):
 *   1. `startStudiosSignIn` makes a random `state` and PKCE verifier, stores
 *      the state as a SHA-256 hash and the verifier encrypted (encryptToken),
 *      bound to the human's user id and avatar, for 10 minutes, single use.
 *   2. `completeStudiosSignIn` marks the state used FIRST (conditional
 *      update), checks expiry, user and `iss` (required, RFC 9207), exchanges
 *      code + verifier, then installs the tokens in `user_vendor_oauth_links`
 *      only if the state row, locked, was not cancelled by an unlink meanwhile.
 *   3. `getAccessToken` returns a valid access token. Near expiry it claims
 *      the refresh (status 'refreshing', committed BEFORE the request), sends
 *      it outside any lock and writes the result only while the row still has
 *      its link id, its own claim id and status 'refreshing'. An unknown outcome (timeout, network error, 5xx, unreadable
 *      reply) or `invalid_grant` marks the link 'broken' and throws
 *      `studios_oauth_relink_required`: a refresh token is never sent twice.
 *   4. `unlinkStudiosOAuth` cancels every open sign-in of the avatar and
 *      deletes the link in one transaction, then revokes (best effort).
 *
 * Tokens, codes, verifiers and `state` never go to logs, errors, redirects or
 * responses. Tokens go only to mystudios.fun. All vendor JSON is parsed with
 * zod and read with a byte limit; vendor error text is never relayed.
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import { z } from 'zod';
import {
  and,
  avatars,
  db,
  eq,
  isNull,
  lt,
  sql,
  userVendorOAuthLinks,
  vendorOAuthStates,
} from '@clawville/database';
import { decryptToken, encryptToken } from '../keypair-vault';
import { resolveApiBase } from '../skill-protocol';

export const STUDIOS_OAUTH_VENDOR = 'studios';
export const STUDIOS_OAUTH_ISSUER = 'https://mystudios.fun';
export const STUDIOS_OAUTH_AUTHORIZE_URL = 'https://mystudios.fun/connect/authorize';
export const STUDIOS_OAUTH_TOKEN_URL = 'https://mystudios.fun/api/oauth/token';
export const STUDIOS_OAUTH_REVOKE_URL = 'https://mystudios.fun/api/oauth/revoke';
/** RFC 8707 resource indicator: the Studios MCP server. */
export const STUDIOS_MCP_RESOURCE = 'https://mcp.mystudios.fun/mcp';
export const STUDIOS_OAUTH_SCOPE = 'studio offline_access';
export const STUDIOS_OAUTH_CLIENT_METADATA_PATH = '/.well-known/oauth-client/studios.json';
export const STUDIOS_OAUTH_CALLBACK_PATH = '/api/vendors/studios/oauth/callback';

export const STUDIOS_OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Refresh when the access token expires within this window. */
export const STUDIOS_ACCESS_REFRESH_WINDOW_MS = 60_000;
/** Used when the token response has no `expires_in`; a 401 still forces a refresh. */
export const STUDIOS_ACCESS_DEFAULT_TTL_S = 3600;
const TOKEN_TIMEOUT_MS = 10_000;
const REVOKE_TIMEOUT_MS = 5_000;
/** A 'refreshing' mark older than this belongs to a request whose outcome is lost. */
export const STUDIOS_REFRESH_STALE_MS = TOKEN_TIMEOUT_MS + 5_000;
/** How long a caller waits for another caller's refresh to finish. */
const REFRESH_WAIT_MS = STUDIOS_REFRESH_STALE_MS + 2_000;
const REFRESH_POLL_MS = 100;
export const MAX_VENDOR_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Public URLs (env: CORS_ORIGIN via resolveApiBase; WEB_ORIGIN / CORS_ORIGIN)
// ---------------------------------------------------------------------------

export function studiosClientId(): string {
  return `${resolveApiBase()}${STUDIOS_OAUTH_CLIENT_METADATA_PATH}`;
}

export function studiosRedirectUri(): string {
  return `${resolveApiBase()}${STUDIOS_OAUTH_CALLBACK_PATH}`;
}

/**
 * Public web origin for the post-sign-in redirect. MIRRORS `resolveWebOrigin`
 * in services/session-ticket-service.ts (not exported there): WEB_ORIGIN, then
 * the first CORS_ORIGIN entry, then production.
 */
export function studiosWebOrigin(): string {
  if (process.env.WEB_ORIGIN) return process.env.WEB_ORIGIN.replace(/\/+$/, '');
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (corsOrigin) return corsOrigin.replace(/\/+$/, '');
  return 'https://clawville.world';
}

/** The Client ID Metadata Document. `client_id` is exactly its own URL. */
export function buildStudiosClientMetadata() {
  return {
    client_id: studiosClientId(),
    client_name: 'ClawVille',
    redirect_uris: [studiosRedirectUri()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: STUDIOS_OAUTH_SCOPE,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type StudiosOAuthErrorCode =
  | 'studios_oauth_not_linked'
  | 'studios_oauth_relink_required'
  | 'studios_oauth_exchange_failed'
  | 'studios_oauth_unavailable';

const ERROR_MESSAGES: Record<StudiosOAuthErrorCode, string> = {
  studios_oauth_not_linked: 'No Studios sign-in is linked to this avatar.',
  studios_oauth_relink_required: 'The Studios sign-in stopped working. The human must sign in with Studios again.',
  studios_oauth_exchange_failed: 'Studios refused the sign-in.',
  studios_oauth_unavailable: 'Studios did not answer. Try again later.',
};

/** A typed failure. The message is our own text; vendor text is never included. */
export class StudiosOAuthError extends Error {
  readonly code: StudiosOAuthErrorCode;
  constructor(code: StudiosOAuthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'StudiosOAuthError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** 32 random bytes, base64url: 43 characters (inside the PKCE 43-128 range). */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(366 * 24 * 3600).optional(),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().max(1024).optional(),
}).passthrough();

const tokenErrorSchema = z.object({ error: z.string().max(128) }).passthrough();

export interface StudiosTokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date;
  scope: string;
}

/**
 * What the token endpoint said. `unknown` = the request may have been
 * processed but we cannot tell (network error, timeout, 5xx, a body over the
 * limit or unreadable); `bad_response` = a 2xx we cannot accept.
 */
export type TokenResult =
  | { kind: 'ok'; tokens: StudiosTokenSet }
  | { kind: 'invalid_grant' }
  | { kind: 'refused' }
  | { kind: 'rate_limited' }
  | { kind: 'bad_response' }
  | { kind: 'unknown' };

/**
 * Read a body as a stream, at most `maxBytes`; the read is cancelled as soon
 * as it goes over. Returns null when over the limit.
 */
export async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function requestToken(form: Record<string, string>): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetch(STUDIOS_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unknown' };
  }
  let text: string | null;
  try {
    text = await readBodyWithLimit(res, MAX_VENDOR_BODY_BYTES);
  } catch {
    return { kind: 'unknown' };
  }
  let json: unknown = null;
  try {
    json = text === null ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status === 429) return { kind: 'rate_limited' };
    if (res.status >= 400 && res.status < 500) {
      const err = tokenErrorSchema.safeParse(json);
      if (err.success && err.data.error === 'invalid_grant') return { kind: 'invalid_grant' };
      if (err.success) return { kind: 'refused' };
    }
    return { kind: 'unknown' };
  }
  if (text === null) return { kind: 'unknown' };
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) return { kind: 'bad_response' };
  const scope = parsed.data.scope ?? STUDIOS_OAUTH_SCOPE;
  if (!scope.split(/\s+/).includes('studio')) return { kind: 'bad_response' };
  const ttlS = parsed.data.expires_in ?? STUDIOS_ACCESS_DEFAULT_TTL_S;
  return {
    kind: 'ok',
    tokens: {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      accessExpiresAt: new Date(Date.now() + ttlS * 1000),
      scope,
    },
  };
}

function sealTokens(tokens: StudiosTokenSet) {
  const access = encryptToken(tokens.accessToken);
  const refresh = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
  return {
    accessEnc: access.enc,
    accessIv: access.iv,
    accessTag: access.tag,
    refreshEnc: refresh?.enc ?? null,
    refreshIv: refresh?.iv ?? null,
    refreshTag: refresh?.tag ?? null,
    accessExpiresAt: tokens.accessExpiresAt,
    scope: tokens.scope,
  };
}

function linkRow(avatarId: string) {
  return and(eq(userVendorOAuthLinks.avatarId, avatarId), eq(userVendorOAuthLinks.vendor, STUDIOS_OAUTH_VENDOR));
}

/** Best effort, short timeout; the reply is not read. */
async function revokeToken(token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
  try {
    const res = await fetch(STUDIOS_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: studiosClientId() }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // Best effort only.
  }
}

/** Revoke tokens Studios just issued that no link will keep (best effort). */
async function revokeIssued(tokens: StudiosTokenSet): Promise<void> {
  await revokeToken(tokens.refreshToken ?? tokens.accessToken, tokens.refreshToken ? 'refresh_token' : 'access_token');
}

/** The refresh (else access) token of a stored link, for a best-effort revoke. */
function storedTokenForRevoke(row: {
  accessEnc: string; accessIv: string; accessTag: string;
  refreshEnc: string | null; refreshIv: string | null; refreshTag: string | null;
}): { token: string; hint: 'refresh_token' | 'access_token' } | null {
  try {
    if (row.refreshEnc && row.refreshIv && row.refreshTag) {
      return { token: decryptToken(row.refreshEnc, row.refreshIv, row.refreshTag), hint: 'refresh_token' };
    }
    return { token: decryptToken(row.accessEnc, row.accessIv, row.accessTag), hint: 'access_token' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sign-in start + callback
// ---------------------------------------------------------------------------

export async function startStudiosSignIn(input: { userId: string; avatarId: string }): Promise<{ authorizeUrl: string }> {
  const now = new Date();
  // Clear this human's rows that expired 10+ minutes ago (an exchange in
  // flight is never older than its timeout), so a looping client cannot fill the table.
  await db.delete(vendorOAuthStates).where(and(
    eq(vendorOAuthStates.userId, input.userId),
    lt(vendorOAuthStates.expiresAt, new Date(now.getTime() - STUDIOS_OAUTH_STATE_TTL_MS)),
  ));

  const state = randomToken();
  const verifier = randomToken();
  const sealed = encryptToken(verifier);
  const redirectUri = studiosRedirectUri();
  await db.insert(vendorOAuthStates).values({
    userId: input.userId,
    avatarId: input.avatarId,
    vendor: STUDIOS_OAUTH_VENDOR,
    stateHash: hashOAuthState(state),
    verifierEnc: sealed.enc,
    verifierIv: sealed.iv,
    verifierTag: sealed.tag,
    redirectUri,
    createdAt: now,
    expiresAt: new Date(now.getTime() + STUDIOS_OAUTH_STATE_TTL_MS),
  });

  const url = new URL(STUDIOS_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', studiosClientId());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', STUDIOS_OAUTH_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkceChallengeS256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', STUDIOS_MCP_RESOURCE);
  return { authorizeUrl: url.toString() };
}

/** Reason codes for `/game?studios=error&reason=<code>`. Fixed set; never vendor text. */
export type StudiosCallbackReason =
  | 'invalid_request'
  | 'invalid_state'
  | 'state_used'
  | 'state_expired'
  | 'wrong_user'
  | 'wrong_issuer'
  | 'denied'
  | 'avatar_changed'
  | 'cancelled'
  | 'exchange_failed'
  | 'unavailable'
  | 'needs_login'
  | 'human_only'
  | 'guest'
  | 'rate_limited';

export type StudiosCallbackResult = { ok: true } | { ok: false; reason: StudiosCallbackReason };

export async function completeStudiosSignIn(input: {
  userId: string;
  state: string | undefined;
  code: string | undefined;
  iss: string | undefined;
  error: string | undefined;
}): Promise<StudiosCallbackResult> {
  if (!input.state || input.state.length > 256) return { ok: false, reason: 'invalid_state' };
  const stateHash = hashOAuthState(input.state);
  const now = new Date();

  // Single use: the row is marked used before any other check or network call.
  const [row] = await db
    .update(vendorOAuthStates)
    .set({ usedAt: now })
    .where(and(eq(vendorOAuthStates.stateHash, stateHash), isNull(vendorOAuthStates.usedAt)))
    .returning();
  if (!row) {
    const seen = await db.query.vendorOAuthStates.findFirst({
      where: eq(vendorOAuthStates.stateHash, stateHash),
      columns: { id: true },
    });
    return { ok: false, reason: seen ? 'state_used' : 'invalid_state' };
  }
  if (row.vendor !== STUDIOS_OAUTH_VENDOR) return { ok: false, reason: 'invalid_state' };
  if (row.cancelledAt) return { ok: false, reason: 'cancelled' };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'state_expired' };
  if (row.userId !== input.userId) return { ok: false, reason: 'wrong_user' };
  // RFC 9207: Studios advertises authorization_response_iss_parameter_supported,
  // so `iss` is required; a missing one is refused like a wrong one.
  if (input.iss !== STUDIOS_OAUTH_ISSUER) return { ok: false, reason: 'wrong_issuer' };
  if (input.error !== undefined) return { ok: false, reason: 'denied' };
  if (!input.code || input.code.length > 2048) return { ok: false, reason: 'invalid_request' };

  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, row.avatarId), eq(avatars.userId, input.userId), eq(avatars.isActive, true)),
    columns: { id: true },
  });
  if (!avatar) return { ok: false, reason: 'avatar_changed' };

  const result = await requestToken({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: row.redirectUri,
    client_id: studiosClientId(),
    code_verifier: decryptToken(row.verifierEnc, row.verifierIv, row.verifierTag),
    resource: STUDIOS_MCP_RESOURCE,
  });
  if (result.kind === 'rate_limited' || result.kind === 'unknown') return { ok: false, reason: 'unavailable' };
  if (result.kind !== 'ok') return { ok: false, reason: 'exchange_failed' };

  // Install only if an unlink did not cancel this sign-in while the exchange
  // ran. The state row lock orders this against unlinkStudiosOAuth.
  type Install = { installed: false } | { installed: true; previous: ReturnType<typeof storedTokenForRevoke> };
  let install: Install;
  try {
    install = await db.transaction(async (tx): Promise<Install> => {
      const [locked] = await tx.select({ cancelledAt: vendorOAuthStates.cancelledAt })
        .from(vendorOAuthStates).where(eq(vendorOAuthStates.id, row.id)).for('update');
      if (!locked || locked.cancelledAt) return { installed: false };
      // A link that this one replaces (another account, no unlink first): its
      // token is revoked after this transaction commits.
      const [previousRow] = await tx.select().from(userVendorOAuthLinks).where(linkRow(row.avatarId)).for('update');
      const previous = previousRow ? storedTokenForRevoke(previousRow) : null;
      const sealed = sealTokens(result.tokens);
      const at = new Date();
      // A new link id every time: a refresh claimed on an earlier link can never
      // write into this one.
      const linkId = randomUUID();
      await tx.insert(userVendorOAuthLinks)
        .values({
          avatarId: row.avatarId,
          vendor: STUDIOS_OAUTH_VENDOR,
          ...sealed,
          status: 'active',
          refreshStartedAt: null,
          linkId,
          refreshClaimId: null,
          linkedByUserId: input.userId,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [userVendorOAuthLinks.avatarId, userVendorOAuthLinks.vendor],
          set: {
            ...sealed,
            status: 'active',
            refreshStartedAt: null,
            linkId,
            refreshClaimId: null,
            linkedByUserId: input.userId,
            createdAt: at,
            updatedAt: at,
          },
        });
      return { installed: true, previous };
    });
  } catch (err) {
    // Studios issued tokens that were not stored: revoke them, then fail.
    await revokeIssued(result.tokens);
    throw err;
  }
  if (!install.installed) {
    await revokeIssued(result.tokens);
    return { ok: false, reason: 'cancelled' };
  }
  if (install.previous) await revokeToken(install.previous.token, install.previous.hint);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Status, access token, unlink
// ---------------------------------------------------------------------------

export interface StudiosOAuthStatus {
  linked: boolean;
  status: 'active' | 'broken' | null;
  scope: string | null;
  linkedAt: string | null;
}

export async function readStudiosOAuthStatus(avatarId: string): Promise<StudiosOAuthStatus> {
  const row = await db.query.userVendorOAuthLinks.findFirst({
    where: linkRow(avatarId),
    columns: { status: true, scope: true, createdAt: true },
  });
  if (!row) return { linked: false, status: null, scope: null, linkedAt: null };
  return {
    linked: true,
    // 'refreshing' is an internal step; the human sees an active link.
    status: row.status === 'broken' ? 'broken' : 'active',
    scope: row.scope,
    linkedAt: new Date(row.createdAt).toISOString(),
  };
}

type LinkRow = typeof userVendorOAuthLinks.$inferSelect;

function freshAccess(row: LinkRow, rejectedToken: string | undefined): string | null {
  if (row.accessExpiresAt.getTime() - Date.now() <= STUDIOS_ACCESS_REFRESH_WINDOW_MS) return null;
  const token = decryptToken(row.accessEnc, row.accessIv, row.accessTag);
  return rejectedToken !== undefined && token === rejectedToken ? null : token;
}

interface RefreshClaim {
  linkId: string;
  claimId: string;
}

/** The row is still in THIS refresh claim: same link, same claim, still refreshing. */
function claimRow(avatarId: string, claim: RefreshClaim) {
  return and(
    linkRow(avatarId),
    eq(userVendorOAuthLinks.linkId, claim.linkId),
    eq(userVendorOAuthLinks.refreshClaimId, claim.claimId),
    eq(userVendorOAuthLinks.status, 'refreshing'),
  );
}

/** Mark broken and end the claim, only if the row is still in this claim. */
async function markBroken(avatarId: string, claim: RefreshClaim): Promise<void> {
  await db.update(userVendorOAuthLinks)
    .set({ status: 'broken', refreshStartedAt: null, refreshClaimId: null, updatedAt: new Date() })
    .where(claimRow(avatarId, claim));
}

type Claim =
  | { kind: 'token'; token: string }
  | { kind: 'claimed'; claim: RefreshClaim; refreshToken: string }
  | { kind: 'wait' }
  | { kind: 'broken' }
  | { kind: 'not_linked' };

/**
 * A valid Studios access token for this avatar. Never log the result.
 *
 * `rejectedToken`: the token Studios just answered 401 to. If the stored token
 * is still that one, it is refreshed even when it has time left; if another
 * caller already replaced it, the new one is returned without a network call.
 */
export async function getAccessToken(avatarId: string, options: { rejectedToken?: string } = {}): Promise<string> {
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    const row = await db.query.userVendorOAuthLinks.findFirst({ where: linkRow(avatarId) });
    if (!row) throw new StudiosOAuthError('studios_oauth_not_linked');
    if (row.status === 'broken') throw new StudiosOAuthError('studios_oauth_relink_required');
    if (row.status === 'active') {
      const token = freshAccess(row, options.rejectedToken);
      if (token) return token;
    }

    // Claim the refresh under the row lock; the 'refreshing' mark is committed
    // before the request, so a crash or lost reply can never lead to a second
    // use of the same refresh token.
    const claim = await db.transaction(async (tx): Promise<Claim> => {
      const [locked] = await tx.select().from(userVendorOAuthLinks).where(linkRow(avatarId)).for('update');
      if (!locked) return { kind: 'not_linked' };
      if (locked.status === 'broken') return { kind: 'broken' };
      if (locked.status === 'refreshing') {
        const started = locked.refreshStartedAt?.getTime() ?? 0;
        if (Date.now() - started > STUDIOS_REFRESH_STALE_MS) {
          // The request that set this mark never reported back: its outcome is
          // unknown. End its claim too, so a late reply matches nothing.
          await tx.update(userVendorOAuthLinks)
            .set({ status: 'broken', refreshStartedAt: null, refreshClaimId: null, updatedAt: new Date() })
            .where(linkRow(avatarId));
          return { kind: 'broken' };
        }
        return { kind: 'wait' };
      }
      const token = freshAccess(locked, options.rejectedToken);
      if (token) return { kind: 'token', token };
      if (!locked.refreshEnc || !locked.refreshIv || !locked.refreshTag) {
        await tx.update(userVendorOAuthLinks).set({ status: 'broken', updatedAt: new Date() }).where(linkRow(avatarId));
        return { kind: 'broken' };
      }
      const claim: RefreshClaim = { linkId: locked.linkId, claimId: randomUUID() };
      await tx.update(userVendorOAuthLinks)
        .set({ status: 'refreshing', refreshStartedAt: new Date(), refreshClaimId: claim.claimId, updatedAt: new Date() })
        .where(linkRow(avatarId));
      return { kind: 'claimed', claim, refreshToken: decryptToken(locked.refreshEnc, locked.refreshIv, locked.refreshTag) };
    });

    if (claim.kind === 'not_linked') throw new StudiosOAuthError('studios_oauth_not_linked');
    if (claim.kind === 'broken') throw new StudiosOAuthError('studios_oauth_relink_required');
    if (claim.kind === 'token') return claim.token;
    if (claim.kind === 'wait') {
      if (Date.now() > deadline) throw new StudiosOAuthError('studios_oauth_unavailable');
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
      continue;
    }

    const result = await requestToken({
      grant_type: 'refresh_token',
      refresh_token: claim.refreshToken,
      client_id: studiosClientId(),
      resource: STUDIOS_MCP_RESOURCE,
    });
    if (result.kind === 'ok') {
      let written: Array<{ linkId: string }>;
      try {
        // A server that does not rotate keeps the old refresh token valid.
        const sealed = sealTokens({ ...result.tokens, refreshToken: result.tokens.refreshToken ?? claim.refreshToken });
        written = await db.update(userVendorOAuthLinks)
          .set({ ...sealed, status: 'active', refreshStartedAt: null, refreshClaimId: null, updatedAt: new Date() })
          .where(claimRow(avatarId, claim.claim))
          .returning({ linkId: userVendorOAuthLinks.linkId });
      } catch (err) {
        // The new tokens were not stored (the claim stays and goes stale ->
        // broken): revoke what Studios just issued, then fail.
        await revokeIssued(result.tokens);
        throw err;
      }
      if (written.length === 0) {
        // Unlinked, linked again, or marked broken meanwhile: these tokens
        // belong to no link.
        await revokeIssued(result.tokens);
        continue;
      }
      return result.tokens.accessToken;
    }
    if (result.kind === 'rate_limited' || result.kind === 'refused') {
      // Studios answered and did not use the refresh token: release the claim.
      await db.update(userVendorOAuthLinks)
        .set({ status: 'active', refreshStartedAt: null, refreshClaimId: null, updatedAt: new Date() })
        .where(claimRow(avatarId, claim.claim));
      throw new StudiosOAuthError(result.kind === 'rate_limited' ? 'studios_oauth_unavailable' : 'studios_oauth_exchange_failed');
    }
    // invalid_grant, or an unknown outcome after the request was sent.
    await markBroken(avatarId, claim.claim);
    throw new StudiosOAuthError('studios_oauth_relink_required');
  }
}

/**
 * Cancel every open sign-in of this avatar and delete the link in ONE
 * transaction (an exchange in flight then cannot install its tokens), then
 * revoke at Studios (best effort, short timeout).
 */
export async function unlinkStudiosOAuth(input: { userId: string; avatarId: string }): Promise<void> {
  const removed = await db.transaction(async (tx) => {
    const now = new Date();
    await tx.update(vendorOAuthStates)
      .set({ cancelledAt: now, usedAt: sql`COALESCE(${vendorOAuthStates.usedAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(
        eq(vendorOAuthStates.userId, input.userId),
        eq(vendorOAuthStates.avatarId, input.avatarId),
        eq(vendorOAuthStates.vendor, STUDIOS_OAUTH_VENDOR),
        isNull(vendorOAuthStates.cancelledAt),
      ));
    const [row] = await tx.delete(userVendorOAuthLinks).where(linkRow(input.avatarId)).returning();
    return row ?? null;
  });
  if (!removed) return;
  const stored = storedTokenForRevoke(removed);
  if (stored) await revokeToken(stored.token, stored.hint);
}
