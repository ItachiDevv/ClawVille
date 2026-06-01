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
