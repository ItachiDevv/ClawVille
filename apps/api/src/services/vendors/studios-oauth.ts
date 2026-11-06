/**
 * Studios sign-in (OAuth 2.1 authorization code + PKCE S256, public client)
 * for the human's own Studios account (MCP hub phase 3c, migration 0094).
 *
 * Registration: Client ID Metadata Document. ClawVille serves one JSON per
 * environment at `<api base>/.well-known/oauth-client/studios.json`; its URL
 * is the `client_id`. No client secret exists (token auth method `none`).
 *
 * Flow:
 *   1. `startStudiosSignIn` makes a random `state` and PKCE verifier, stores
 *      the state as a SHA-256 hash and the verifier encrypted (encryptToken),
 *      bound to the human's user id and avatar, for 10 minutes, single use.
 *   2. `completeStudiosSignIn` marks the row used FIRST (conditional update),
 *      then checks expiry, user, `iss` (required, RFC 9207), exchanges code + verifier at the token
 *      endpoint and stores the access and refresh tokens encrypted
 *      (user_vendor_credentials kind 'oauth').
 *   3. `getAccessToken` returns a valid access token. Within 60 s of expiry it
 *      refreshes under a row lock and stores the rotated pair in the same
 *      transaction. `invalid_grant` marks the link 'broken'
 *      (`studios_oauth_relink_required`); there is no retry loop.
 *   4. `unlinkStudiosOAuth` revokes the refresh token (best effort) and
 *      deletes the row.
 *
 * Tokens, codes, verifiers and `state` never go to logs, errors, redirects or
 * responses. Tokens go only to mystudios.fun. All vendor JSON is parsed with
 * zod; vendor error text is never relayed.
 */

import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import {
  and,
  avatars,
  db,
  eq,
  isNotNull,
  isNull,
  lt,
  or,
  userVendorCredentials,
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
const MAX_VENDOR_BODY_BYTES = 64 * 1024;

const OAUTH_KIND = 'oauth';

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
  | 'studios_oauth_unavailable'
  | 'studios_oauth_bad_response';

const ERROR_MESSAGES: Record<StudiosOAuthErrorCode, string> = {
  studios_oauth_not_linked: 'No Studios sign-in is linked to this avatar.',
  studios_oauth_relink_required: 'The Studios sign-in stopped working. The human must sign in with Studios again.',
  studios_oauth_exchange_failed: 'Studios refused the sign-in.',
  studios_oauth_unavailable: 'Studios did not answer. Try again later.',
  studios_oauth_bad_response: 'Studios sent a reply that ClawVille could not read.',
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

async function readCappedText(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_VENDOR_BODY_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_VENDOR_BODY_BYTES) return null;
  return new TextDecoder().decode(buf);
}

/**
 * POST a form to the Studios token endpoint and parse the answer.
 * `invalid_grant` -> relink_required; another 4xx -> exchange_failed;
 * 5xx / 429 / network / timeout -> unavailable; unreadable -> bad_response.
 */
async function requestToken(form: Record<string, string>): Promise<StudiosTokenSet> {
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
    throw new StudiosOAuthError('studios_oauth_unavailable');
  }
  let text: string | null;
  try {
    text = await readCappedText(res);
  } catch {
    throw new StudiosOAuthError('studios_oauth_unavailable');
  }
  let json: unknown = null;
  try {
    json = text === null ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new StudiosOAuthError('studios_oauth_unavailable');
    const err = tokenErrorSchema.safeParse(json);
    if (err.success && err.data.error === 'invalid_grant') throw new StudiosOAuthError('studios_oauth_relink_required');
    throw new StudiosOAuthError('studios_oauth_exchange_failed');
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new StudiosOAuthError('studios_oauth_bad_response');
  const scope = parsed.data.scope ?? STUDIOS_OAUTH_SCOPE;
  if (!scope.split(/\s+/).includes('studio')) throw new StudiosOAuthError('studios_oauth_bad_response');
  const ttlS = parsed.data.expires_in ?? STUDIOS_ACCESS_DEFAULT_TTL_S;
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    accessExpiresAt: new Date(Date.now() + ttlS * 1000),
    scope,
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

function oauthRow(avatarId: string) {
  return and(
    eq(userVendorCredentials.avatarId, avatarId),
    eq(userVendorCredentials.vendor, STUDIOS_OAUTH_VENDOR),
    eq(userVendorCredentials.kind, OAUTH_KIND),
  );
}

// ---------------------------------------------------------------------------
// Sign-in start + callback
// ---------------------------------------------------------------------------

export async function startStudiosSignIn(input: { userId: string; avatarId: string }): Promise<{ authorizeUrl: string }> {
  const now = new Date();
  // Clear this human's used or expired sign-ins, so a looping client cannot fill the table.
  await db.delete(vendorOAuthStates).where(and(
    eq(vendorOAuthStates.userId, input.userId),
    or(isNotNull(vendorOAuthStates.usedAt), lt(vendorOAuthStates.expiresAt, now)),
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

  let tokens: StudiosTokenSet;
  try {
    tokens = await requestToken({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: row.redirectUri,
      client_id: studiosClientId(),
      code_verifier: decryptToken(row.verifierEnc, row.verifierIv, row.verifierTag),
      resource: STUDIOS_MCP_RESOURCE,
    });
  } catch (err) {
    if (err instanceof StudiosOAuthError && err.code === 'studios_oauth_unavailable') {
      return { ok: false, reason: 'unavailable' };
    }
    if (err instanceof StudiosOAuthError) return { ok: false, reason: 'exchange_failed' };
    throw err;
  }

  const values = { ...sealTokens(tokens), status: 'active', updatedByUserId: input.userId, updatedAt: now, createdAt: now };
  await db
    .insert(userVendorCredentials)
    .values({ avatarId: row.avatarId, vendor: STUDIOS_OAUTH_VENDOR, kind: OAUTH_KIND, ...values })
    .onConflictDoUpdate({
      target: [userVendorCredentials.avatarId, userVendorCredentials.vendor, userVendorCredentials.kind],
      set: values,
    });
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
  const row = await db.query.userVendorCredentials.findFirst({
    where: oauthRow(avatarId),
    columns: { status: true, scope: true, createdAt: true },
  });
  if (!row) return { linked: false, status: null, scope: null, linkedAt: null };
  return {
    linked: true,
    status: row.status === 'broken' ? 'broken' : 'active',
    scope: row.scope ?? null,
    linkedAt: new Date(row.createdAt).toISOString(),
  };
}

type LockedOutcome = { kind: 'token'; token: string } | { kind: 'broken' } | { kind: 'not_linked' };

/**
 * A valid Studios access token for this avatar. Never log the result.
 *
 * `rejectedToken`: the token Studios just answered 401 to. If the stored token
 * is still that one, it is refreshed even when it has time left; if another
 * caller already replaced it, the new one is returned without a network call.
 */
export async function getAccessToken(avatarId: string, options: { rejectedToken?: string } = {}): Promise<string> {
  const row = await db.query.userVendorCredentials.findFirst({ where: oauthRow(avatarId) });
  if (!row) throw new StudiosOAuthError('studios_oauth_not_linked');
  if (row.status === 'broken') throw new StudiosOAuthError('studios_oauth_relink_required');
  if (!options.rejectedToken && row.accessEnc && row.accessIv && row.accessTag && row.accessExpiresAt
    && row.accessExpiresAt.getTime() - Date.now() > STUDIOS_ACCESS_REFRESH_WINDOW_MS) {
    return decryptToken(row.accessEnc, row.accessIv, row.accessTag);
  }

  const outcome = await db.transaction(async (tx): Promise<LockedOutcome> => {
    const [locked] = await tx.select().from(userVendorCredentials).where(oauthRow(avatarId)).for('update');
    if (!locked) return { kind: 'not_linked' };
    if (locked.status === 'broken') return { kind: 'broken' };
    // Re-check under the lock: a concurrent caller may have refreshed already.
    if (locked.accessEnc && locked.accessIv && locked.accessTag && locked.accessExpiresAt
      && locked.accessExpiresAt.getTime() - Date.now() > STUDIOS_ACCESS_REFRESH_WINDOW_MS) {
      const current = decryptToken(locked.accessEnc, locked.accessIv, locked.accessTag);
      if (!options.rejectedToken || current !== options.rejectedToken) return { kind: 'token', token: current };
    }
    const markBroken = async () => {
      await tx.update(userVendorCredentials).set({ status: 'broken', updatedAt: new Date() }).where(oauthRow(avatarId));
    };
    if (!locked.refreshEnc || !locked.refreshIv || !locked.refreshTag) {
      await markBroken();
      return { kind: 'broken' };
    }
    const refreshToken = decryptToken(locked.refreshEnc, locked.refreshIv, locked.refreshTag);
    let tokens: StudiosTokenSet;
    try {
      tokens = await requestToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: studiosClientId(),
        resource: STUDIOS_MCP_RESOURCE,
      });
    } catch (err) {
      if (err instanceof StudiosOAuthError && err.code === 'studios_oauth_relink_required') {
        await markBroken();
        return { kind: 'broken' };
      }
      throw err;
    }
    // A server that does not rotate keeps the old refresh token valid.
    const sealed = sealTokens({ ...tokens, refreshToken: tokens.refreshToken ?? refreshToken });
    await tx.update(userVendorCredentials).set({ ...sealed, updatedAt: new Date() }).where(oauthRow(avatarId));
    return { kind: 'token', token: tokens.accessToken };
  });

  if (outcome.kind === 'not_linked') throw new StudiosOAuthError('studios_oauth_not_linked');
  if (outcome.kind === 'broken') throw new StudiosOAuthError('studios_oauth_relink_required');
  return outcome.token;
}

/** Revoke at Studios (best effort, short timeout), then delete the link. */
export async function unlinkStudiosOAuth(avatarId: string): Promise<void> {
  const row = await db.query.userVendorCredentials.findFirst({ where: oauthRow(avatarId) });
  if (!row) return;
  let token: string | null = null;
  let hint: 'refresh_token' | 'access_token' = 'refresh_token';
  try {
    if (row.refreshEnc && row.refreshIv && row.refreshTag) {
      token = decryptToken(row.refreshEnc, row.refreshIv, row.refreshTag);
    } else if (row.accessEnc && row.accessIv && row.accessTag) {
      token = decryptToken(row.accessEnc, row.accessIv, row.accessTag);
      hint = 'access_token';
    }
  } catch {
    token = null;
  }
  if (token) {
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
      // Best effort: the link is removed on our side even when Studios does not answer.
    }
  }
  await db.delete(userVendorCredentials).where(oauthRow(avatarId));
}
