/**
 * ERC-8004-ready agent registration file (off-chain tier).
 *
 * Public, unauthenticated emission of the ERC-8004 *registration-file
 * format* for a single ClawVille agent, keyed on its stable
 * `users.identity_fingerprint` (the SHA-256 hex of `{identityType}:{key}`
 * minted at first connect — see `services/identity-service.ts`).
 *
 *   GET /.well-known/agents/:fingerprint/agent-registration.json
 *
 * IMPORTANT — honesty / anti-scaffolding contract (CLAUDE.md "no
 * scaffolding theater", plan §11 + §12):
 *
 *   This is the OFF-CHAIN tier. We emit the ERC-8004 registration-file
 *   *shape* (https://eips.ethereum.org/EIPS/eip-8004#registration-v1) and
 *   self-sign it with our existing service-issuer key, but the agent is
 *   NOT minted on any chain. `registrations` is therefore ALWAYS `[]`.
 *   We NEVER fabricate an `agentId` or `agentRegistry` — doing so would
 *   claim on-chain anchoring we do not have. The clean upgrade path
 *   (register the hosted file's URI on BSC, backfill `registrations`) is
 *   documented in plan §12 and deliberately deferred.
 *
 *   User-facing / doc copy MUST say "ERC-8004 registration-file format
 *   (self-signed, not yet on-chain-anchored)" — never "ERC-8004
 *   registered" / "on-chain".
 *
 * SECURITY — THIS DOCUMENT IS PUBLIC (no auth). It contains ONLY public
 * values: the ed25519 identity *public* key, the custodial Solana
 * *public* key, the public fingerprint, and public x402 config. It MUST
 * NEVER include `identity_encrypted_sk`, `identity_dek_wrapped`,
 * `identity_iv`, `identity_tag`, any DEK, any wallet secret key, the
 * password hash, or the email. The SELECT below is column-pinned to
 * public fields, and the emitted object is built field-by-field — both
 * are deliberate so a future edit can't widen the surface by accident.
 */

import { Hono } from 'hono';
import { createHash } from 'crypto';
import bs58 from 'bs58';
import { db, users, avatars, eq, and } from '@clawville/database';
import { loadX402Config } from '../services/x402-config';
import { signPayload } from '../services/service-issuer';
import { getWalletAddress } from '../services/wallet-service';

export const agentRegistrationRoutes = new Hono();

/** Solana mainnet CAIP-2 reference (genesis hash prefix) — matches x402-config default. */
const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** Public ClawVille web origin for the `web` service endpoint. */
function clawvilleWebOrigin(): string {
  // CORS_ORIGIN can be a comma-separated list; the first entry is the
  // canonical frontend. Fall back to the production domain.
  const raw = process.env.CORS_ORIGIN?.split(',')[0]?.trim();
  if (raw && /^https?:\/\//.test(raw)) return raw.replace(/\/+$/, '');
  return 'https://clawville.world';
}

/**
 * Encode a base58 ed25519 public key as a `did:key` (multibase base58btc
 * of the multicodec-prefixed raw key).
 *
 *   did:key:z<base58btc(0xed01 || raw32)>
 *
 * `0xed 0x01` is the unsigned-varint multicodec for `ed25519-pub`; the
 * leading `z` is the multibase base58btc prefix. Returns null if the
 * stored pubkey doesn't decode to exactly 32 bytes (defensive — every
 * key we mint via `nacl.sign.keyPair()` does).
 */
function ed25519PubkeyToDidKey(identityPubkeyBase58: string): string | null {
  let raw: Uint8Array;
  try {
    raw = bs58.decode(identityPubkeyBase58.trim());
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed; // ed25519-pub multicodec, low byte
  prefixed[1] = 0x01; // varint high byte
  prefixed.set(raw, 2);
  return `did:key:z${bs58.encode(prefixed)}`;
}

type RegistrationService =
  | { name: 'web'; endpoint: string }
  | { name: 'DID'; endpoint: string; version: 'v1' }
  | { name: 'wallet'; endpoint: string; version: 'v1' };

interface AgentRegistrationFile {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image?: string;
  services: RegistrationService[];
  x402Support: boolean;
  active: boolean;
  /**
   * ALWAYS [] in the off-chain tier. NEVER populate with a fabricated
   * agentId/agentRegistry — see file header.
   */
  registrations: never[];
  /** ClawVille namespaced extension (NOT an ERC-8004 field). */
  clawvilleIdentityFingerprint: string;
}

agentRegistrationRoutes.get('/:fingerprint/agent-registration.json', async (c) => {
  const fingerprint = c.req.param('fingerprint').trim().toLowerCase();

  // `identity_fingerprint` is a 64-char lowercase SHA-256 hex. Reject
  // anything that can't be one BEFORE hitting the DB — also keeps the
  // 404 opaque for malformed probes.
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    return c.json({ error: 'not_found' }, 404);
  }

  // Column-pinned SELECT — public fields ONLY. Do NOT add identity_*
  // secret columns, email, or password_hash here. (See file header.)
  const user = await db.query.users.findFirst({
    where: eq(users.identityFingerprint, fingerprint),
    columns: {
      id: true,
      name: true,
      username: true,
      identityPubkey: true,
      identityFingerprint: true,
    },
  });

  // Opaque 404 for unknown fingerprints OR users that never bootstrapped
  // an ed25519 identity (no pubkey → no DID → nothing meaningful to emit).
  if (!user || !user.identityPubkey || !user.identityFingerprint) {
    return c.json({ error: 'not_found' }, 404);
  }

  const didKey = ed25519PubkeyToDidKey(user.identityPubkey);
  if (!didKey) {
    // Stored pubkey is malformed — treat as not-found rather than emit a
    // broken DID. Should never happen for keys we minted.
    return c.json({ error: 'not_found' }, 404);
  }

  // Resolve the human-facing avatar (one per user) for display name +
  // thumbnail + a cheap `active` signal. Public columns only.
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, user.id), eq(avatars.isActive, true)),
    columns: {
      id: true,
      name: true,
      avatarUrl: true,
      avatarType: true,
      agentCategory: true,
      isActive: true,
    },
  });

  // Custodial Solana wallet (public key only). Prefer the human avatar's
  // wallet (the one provisioned at avatar-create / first-connect). Both
  // `getWalletAddress` reads use the mirror column — O(1), no secret
  // material ever loaded.
  let walletPubkey: string | null = null;
  if (avatar) {
    walletPubkey = await getWalletAddress('avatar', avatar.id);
  }

  const displayName =
    avatar?.name?.trim() ||
    user.name?.trim() ||
    (user.username ? `@${user.username}` : '') ||
    'ClawVille Agent';

  // Description — tier + connect orientation. Honest copy: this is the
  // off-chain ERC-8004 format tier, not an on-chain registration.
  const tier = avatar ? `${avatar.agentCategory} agent` : 'agent';
  const description =
    `${displayName} — a ${tier} in ClawVille. ` +
    'ERC-8004 registration-file format (self-signed, not yet on-chain-anchored). ' +
    'Connect at https://clawville.world via the agent gateway (POST /api/agent/connect).';

  const services: RegistrationService[] = [
    { name: 'web', endpoint: `${clawvilleWebOrigin()}/agent/${user.identityFingerprint}` },
    { name: 'DID', endpoint: didKey, version: 'v1' },
  ];
  if (walletPubkey) {
    services.push({
      name: 'wallet',
      endpoint: `${SOLANA_MAINNET_CAIP2}:${walletPubkey}`,
      version: 'v1',
    });
  }

  const registration: AgentRegistrationFile = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: displayName,
    description,
    services,
    // = loadX402Config().enabled (gate currently OFF). Public boolean.
    x402Support: loadX402Config().enabled,
    // Cheap `active` signal: the avatar row's isActive flag. No live
    // session lookup — agents that never created an avatar still emit
    // active:true (they're registered, just not human-fronted).
    active: avatar ? avatar.isActive : true,
    // OFF-CHAIN TIER INVARIANT — never fabricate an on-chain agentId.
    registrations: [],
    clawvilleIdentityFingerprint: user.identityFingerprint,
  };

  // Only attach `image` when we actually have a URL — ERC-8004 omits the
  // field rather than carrying an empty string. Only VRM/explicit URLs
  // are meaningful; species-keyed GLB avatars have a null avatarUrl.
  const image = avatar?.avatarUrl?.trim();
  if (image) {
    registration.image = image;
  }

  // OPTIONAL — ClawVille extension, NOT an ERC-8004 requirement.
  //
  // ERC-8004 defines no signature on the registration file itself
  // (on-chain integrity comes from the file <-> token binding, which we
  // don't have in the off-chain tier). To let verifiers confirm
  // *ClawVille issued this document* we counter-sign the registration
  // object with the existing service-issuer ed25519 key (the same key
  // published at /.well-known/clawville-issuer.json). This is a
  // ClawVille-namespaced extension field — a non-standard add-on, not
  // part of the ERC-8004 schema. signPayload() canonicalises + sha256s
  // before signing (see service-issuer.ts); a verifier re-canonicalises
  // the `registration` object below (everything except this field) and
  // checks the signature against our published issuer pubkey.
  let attestation:
    | { algorithm: 'ed25519'; pubkey: string; signature: string; canonicalBody: string }
    | undefined;
  try {
    const signed = signPayload(registration);
    attestation = {
      algorithm: 'ed25519',
      pubkey: signed.pubkey,
      signature: signed.signature,
      canonicalBody: signed.body,
    };
  } catch {
    // Issuer key not configured (env missing) — emit the registration
    // file WITHOUT the optional attestation rather than 503. The
    // ERC-8004 file is valid on its own; the attestation is a bonus.
    attestation = undefined;
  }

  // Public, CDN-cacheable.
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Content-Type', 'application/json; charset=utf-8');
  return c.json(
    attestation
      ? { ...registration, 'x-clawville-attestation': attestation }
      : registration,
  );
});
