/**
 * Partner-signature verification — shared by the cross-world portal
 * (`apps/api/src/routes/portal.ts`) and the Hatcher partner-registration API
 * (`apps/api/src/routes/partner-hatcher.ts`).
 *
 * Inbound partner-signed requests carry `X-<Partner>-Issuer-Pubkey` +
 * `X-<Partner>-Signature` over `sha256(rawBody)`. We compare the presented
 * pubkey against the `PARTNER_PUBKEYS[partnerId]` allowlist from env and
 * verify the ed25519 signature over the EXACT raw body bytes the partner
 * sent (no canonicalization on the inbound side — verify what was received).
 * This mirrors the outbound `signPayload()` scheme in `service-issuer.ts`.
 *
 * Extracted from portal.ts (2026-06-01, Hatcher Phase A) so the Hatcher
 * partner API can reuse the identical primitive instead of duplicating it —
 * one verification implementation, one allowlist parser.
 */

import { createHash } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

/**
 * Parse PARTNER_PUBKEYS env var (JSON: `{"scape":"<base58>","hatcher":"<base58>"}`)
 * into a lookup map keyed by partner id. Returns null if the env var is
 * missing or malformed — callers treat that as "no partners allowed" and 401
 * every inbound signed request.
 */
export function loadPartnerPubkeys(): Record<string, string> | null {
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

export type PartnerSignatureResult =
  | { ok: true; partnerId: string }
  | { ok: false; reason: string };

/**
 * Verify a partner-signed inbound request. `partnerId` selects the allowlist
 * entry (`PARTNER_PUBKEYS[partnerId]`); the request's
 * `X-<Partner>-Issuer-Pubkey` header MUST equal that entry. The signature is
 * ed25519(sha256(rawBody)). All decoding failures map to a single generic
 * reason so callers can return an opaque 401.
 */
export function verifyPartnerSignature(
  partnerId: string,
  args: {
    pubkeyHeader: string | null;
    signatureHeader: string | null;
    rawBody: string;
  },
): PartnerSignatureResult {
  if (!args.pubkeyHeader || !args.signatureHeader) {
    return { ok: false, reason: 'missing_signature' };
  }
  const allowlist = loadPartnerPubkeys();
  if (!allowlist) return { ok: false, reason: 'no_partner_allowlist' };

  // The presented pubkey must match the allowlist entry for THIS partner.
  const expectedPubkey = allowlist[partnerId];
  if (!expectedPubkey || args.pubkeyHeader !== expectedPubkey) {
    return { ok: false, reason: 'unknown_partner' };
  }

  // Digest MUST be computed over the exact raw body bytes the partner signed;
  // verifying against a re-parsed-then-re-stringified JSON would fail as soon
  // as key order or whitespace differed.
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
  return { ok: true, partnerId };
}

/**
 * Freshness window for partner-signed GETs. A GET carries no body to sign, so
 * the signed bytes are a CANONICAL CHALLENGE derived from method + path +
 * timestamp. The signature alone can't prevent replay (the same bytes verify
 * forever), so the timestamp must fall inside this window — past requests
 * expire and clock-skew-from-the-future requests are rejected. 5 min matches
 * Hatcher's `authNonceExpirySecs:300` (plan §1) so both sides agree on skew.
 */
export const PARTNER_GET_SIGNATURE_WINDOW_MS = 5 * 60_000;

/**
 * The CANONICAL CHALLENGE a partner must sign for a GET. Newline-joined,
 * fixed field order, no JSON/whitespace ambiguity, so the partner can
 * reproduce it byte-for-byte:
 *
 *   clawville-partner-get\n<METHOD>\n<PATH>\n<UNIX_MS>
 *
 *   - METHOD  uppercased HTTP method (always `GET`).
 *   - PATH    the request path INCLUDING the leading slash, EXCLUDING the
 *             scheme/host AND the query string (e.g.
 *             `/api/partner/hatcher/agents/abc/stats`). The server uses Hono's
 *             `c.req.path`, which is the decoded path with NO query string, so
 *             the partner MUST sign the same path-only value — do not append
 *             `?foo=bar` to the signed material even if the URL carries a query.
 *   - UNIX_MS the millisecond unix timestamp the partner also sends in the
 *             `X-Hatcher-Timestamp` header (decimal digits, no fraction).
 *
 * The domain-separator prefix (`clawville-partner-get`) prevents a GET
 * signature from ever being replayed against a body-signed (POST/PATCH/DELETE)
 * verifier and vice-versa.
 */
export function partnerGetChallenge(args: {
  method: string;
  path: string;
  tsMillis: string;
}): string {
  return `clawville-partner-get\n${args.method.toUpperCase()}\n${args.path}\n${args.tsMillis}`;
}

/**
 * Verify a partner-signed GET. Same ed25519 key + `PARTNER_PUBKEYS[partnerId]`
 * allowlist as the body-signed path, but the signed material is
 * `sha256(partnerGetChallenge(...))` instead of `sha256(rawBody)` and a
 * freshness window gates replay. All failures collapse to a generic reason so
 * callers return an opaque 401.
 */
export function verifyPartnerGetSignature(
  partnerId: string,
  args: {
    method: string;
    path: string;
    tsHeader: string | null;
    pubkeyHeader: string | null;
    sigHeader: string | null;
    nowMs?: number;
  },
): PartnerSignatureResult {
  if (!args.pubkeyHeader || !args.sigHeader || !args.tsHeader) {
    return { ok: false, reason: 'missing_signature' };
  }

  // Timestamp must be a plain integer of milliseconds inside the freshness
  // window. Reject NaN, fractional, negative, stale (past) and early (future)
  // timestamps. `Number.parseInt` would silently accept `"123abc"`, so guard
  // with a strict digits-only test first.
  if (!/^\d{1,15}$/.test(args.tsHeader)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const tsMs = Number(args.tsHeader);
  const now = args.nowMs ?? Date.now();
  if (Math.abs(now - tsMs) > PARTNER_GET_SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const allowlist = loadPartnerPubkeys();
  if (!allowlist) return { ok: false, reason: 'no_partner_allowlist' };
  const expectedPubkey = allowlist[partnerId];
  if (!expectedPubkey || args.pubkeyHeader !== expectedPubkey) {
    return { ok: false, reason: 'unknown_partner' };
  }

  const challenge = partnerGetChallenge({
    method: args.method,
    path: args.path,
    tsMillis: args.tsHeader,
  });
  const digest = createHash('sha256').update(challenge).digest();
  let sigBytes: Uint8Array;
  let pubBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(args.sigHeader);
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
  return { ok: true, partnerId };
}
