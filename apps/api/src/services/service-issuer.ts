/**
 * Phase 5.1 — ClawVille service issuer signing.
 *
 * ClawVille publishes a single ed25519 keypair that represents the
 * service itself (not any user). Outbound calls to partner worlds
 * (e.g. 'scape's /hosted-session/issue) are signed with this key so the
 * partner can verify authenticity against our published public key at
 * `/.well-known/clawville-issuer.json`.
 *
 * The public key is served at that URL by Hono (see apps/api/src/index.ts).
 * The private key lives in the CLAWVILLE_SERVICE_ISSUER_SK env var (base58).
 *
 * In production the private key ultimately lives in Cloudflare Secrets
 * Store; the CLAWVILLE_SERVICE_ISSUER_SK env var can either hold the
 * secret directly (simple) or — once the Cloudflare Worker fetch pattern
 * lands — hold a reference that resolves at boot. For Wave 1a we keep
 * the direct-env form; Wave 1b portal endpoints call `signPayload()` for
 * every outbound partner request.
 *
 * Signing primitive: ed25519 via tweetnacl. Body is canonicalised JSON,
 * then hashed to sha256 before signing — matches the scheme described in
 * plan §5.3:
 *
 *     digest = sha256(body)
 *     sig    = ed25519.sign(digest, CLAWVILLE_SERVICE_ISSUER_SK)
 *
 * Note: partner verify code can choose either
 *   a) sign/verify the raw body directly, or
 *   b) sign/verify the sha256(body) pre-hash
 * We pick (b) so "what we sign" is a fixed 32-byte input regardless of
 * payload size — simpler to reason about, matches stripe/github patterns.
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export interface SignedPayload {
  /** Canonical JSON string we signed. Send this as the HTTP body. */
  body: string;
  /** Base58-encoded ed25519 signature (64 bytes). */
  signature: string;
  /** Base58-encoded ed25519 public key (32 bytes). Partner verifies against this. */
  pubkey: string;
}

/**
 * Deterministic JSON.stringify — keys sorted, no whitespace. Two
 * ClawVille instances signing the same payload MUST produce the same
 * bytes, or signatures won't verify across deploys. We keep this
 * self-contained rather than pulling in fast-stable-stringify (which
 * @solana/web3.js already depends on) because the dependency graph
 * here is sensitive.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function loadIssuerSecret(): Uint8Array {
  const raw = process.env.CLAWVILLE_SERVICE_ISSUER_SK;
  if (!raw) {
    throw new Error(
      'CLAWVILLE_SERVICE_ISSUER_SK is not set. Run scripts/generate-service-issuer-keypair.ts '
      + 'and paste the values into Coolify env vars.',
    );
  }
  const decoded = bs58.decode(raw.trim());
  if (decoded.length !== 64) {
    throw new Error(
      `CLAWVILLE_SERVICE_ISSUER_SK must decode to 64 bytes (tweetnacl sign secretKey format); got ${decoded.length}`,
    );
  }
  return decoded;
}

function loadIssuerPubkey(): string {
  const pub = process.env.CLAWVILLE_SERVICE_ISSUER_PUBKEY;
  if (!pub) {
    throw new Error(
      'CLAWVILLE_SERVICE_ISSUER_PUBKEY is not set. Run scripts/generate-service-issuer-keypair.ts '
      + 'and paste the values into Coolify env vars.',
    );
  }
  return pub.trim();
}

/**
 * Published by `/.well-known/clawville-issuer.json`. Safe to cache + CDN.
 */
export function getPublishedIssuerInfo(): {
  publicKey: string;
  algorithm: 'ed25519';
  purposes: readonly string[];
} {
  return {
    publicKey: loadIssuerPubkey(),
    algorithm: 'ed25519',
    purposes: [
      'partner-portal-issue',
      'partner-portal-accept-link',
      // Hatcher partner #2 (Phase A — 2026-06-01): we sign outbound cognition
      // callbacks to the Hatcher per-agent proxy with this same key. Published
      // so Hatcher can verify the X-Clawville-Signature on our callbacks.
      'partner-cognition-callback',
      // Session-lifecycle webhook (2026-06-12): we sign the outbound
      // session.ended notification (TTL expiry / disconnect) with this same
      // key so the partner can verify it against this published pubkey.
      'partner-session-webhook',
    ],
  };
}

/**
 * Canonicalise + hash + sign a payload. Returns the exact `body` string
 * the caller must send (so the partner hashes the same bytes) along with
 * the base58 signature and the base58 pubkey.
 */
export function signPayload(body: object): SignedPayload {
  const sk = loadIssuerSecret();
  const canonical = canonicalJson(body);
  const digest = createHash('sha256').update(canonical).digest();
  const sig = nacl.sign.detached(new Uint8Array(digest), sk);
  return {
    body: canonical,
    signature: bs58.encode(sig),
    pubkey: loadIssuerPubkey(),
  };
}
