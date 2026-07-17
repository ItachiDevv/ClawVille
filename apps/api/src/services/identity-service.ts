/**
 * Phase 5 — identity bootstrap for agent-first onboarding.
 *
 * Converts the `{identityType, identityKey}` the agent presents on
 * `/api/agent/connect` or `/api/agent/join` into a stable `users` row.
 * The identity is hashed (SHA-256 over `${type}:${key}`) and stored on
 * `users.identity_fingerprint`, which is UNIQUE — so two concurrent
 * connects with the same identity race-safely resolve to the same user.
 *
 * Race-condition story (spec §10 audit note): both callers may observe
 * "user not found" before inserting. The first INSERT wins; the second
 * hits a 23505 unique violation. We catch that, re-read the row, and
 * return it. No distributed lock, no advisory lock — Postgres's own
 * UNIQUE constraint is the serializer.
 */

import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { db, users, eq, and, isNull, sql } from '@clawville/database';
import type { AgentIdentityType } from '@clawville/shared';
import { encryptSecretKeyEnveloped } from './keypair-vault';
import { canonicalizePublicAgentIdentityType } from './agent-session-config';

/**
 * Stable hash of `{type}:{key}` as hex SHA-256 (64 chars). The colon
 * separator means `milady:abc` and `miladyabc:` can never collide even
 * if an agent sends a weird `type` with a trailing colon.
 */
export function identityFingerprint(identityType: string, identityKey: string): string {
  return createHash('sha256')
    .update(`${identityType}:${identityKey}`)
    .digest('hex');
}

export interface IdentityUser {
  id: string;
  email: string | null;
  name: string | null;
  identityFingerprint: string | null;
  isNewUser: boolean;
}

type IdentityUserRow = Omit<IdentityUser, 'isNewUser'>;

export interface IdentityResolutionStore {
  findByFingerprint(fingerprint: string): Promise<IdentityUserRow | undefined>;
  tryHealLegacyFingerprint(
    legacyFingerprints: readonly string[],
    newFingerprint: string,
  ): Promise<IdentityUserRow | undefined>;
  insert(input: {
    name: string;
    identityFingerprint: string;
  }): Promise<IdentityUserRow>;
}

export interface IdentityHealTransactionStore {
  findByFingerprint(fingerprint: string): Promise<IdentityUserRow | undefined>;
  updateFingerprintIfMatches(input: {
    userId: string;
    legacyFingerprint: string;
    newFingerprint: string;
  }): Promise<IdentityUserRow | undefined>;
}

const SUPPORTED_IDENTITY_TYPES = new Set(['milady', 'hermes', 'openclaw', 'custom']);
const LEGACY_IDENTITY_TYPES = ['nanoclaw', 'anonymous', 'ironclaw'] as const;

function identityResult(row: IdentityUserRow, isNewUser: boolean): IdentityUser {
  return { ...row, isNewUser };
}

/**
 * Transaction-local legacy fingerprint repair. The guarded update is the
 * concurrency authority: when it affects zero rows, another reconnect healed
 * first, so this request re-reads and returns that winner under the new digest.
 */
export async function healLegacyFingerprintInTransaction(
  legacyFingerprints: readonly string[],
  newFingerprint: string,
  store: IdentityHealTransactionStore,
): Promise<IdentityUserRow | undefined> {
  for (const legacyFingerprint of legacyFingerprints) {
    const legacy = await store.findByFingerprint(legacyFingerprint);
    if (!legacy) continue;

    const healed = await store.updateFingerprintIfMatches({
      userId: legacy.id,
      legacyFingerprint,
      newFingerprint,
    });
    if (healed) return healed;

    const winner = await store.findByFingerprint(newFingerprint);
    if (!winner) {
      throw new Error('Identity fingerprint heal race: winner row not found');
    }
    return winner;
  }
  return undefined;
}

const databaseIdentityStore: IdentityResolutionStore = {
  async findByFingerprint(fingerprint) {
    return db.query.users.findFirst({
      where: eq(users.identityFingerprint, fingerprint),
      columns: {
        id: true,
        email: true,
        name: true,
        identityFingerprint: true,
      },
    });
  },

  async tryHealLegacyFingerprint(legacyFingerprints, newFingerprint) {
    return db.transaction(async (tx) => {
      const columns = {
        id: true,
        email: true,
        name: true,
        identityFingerprint: true,
      } as const;
      return healLegacyFingerprintInTransaction(legacyFingerprints, newFingerprint, {
        findByFingerprint(fingerprint) {
          return tx.query.users.findFirst({
            where: eq(users.identityFingerprint, fingerprint),
            columns,
          });
        },
        async updateFingerprintIfMatches(input) {
          const [healed] = await tx
            .update(users)
            .set({ identityFingerprint: input.newFingerprint, updatedAt: new Date() })
            .where(and(
              eq(users.id, input.userId),
              eq(users.identityFingerprint, input.legacyFingerprint),
            ))
            .returning({
              id: users.id,
              email: users.email,
              name: users.name,
              identityFingerprint: users.identityFingerprint,
            });
          return healed;
        },
      });
    });
  },

  async insert(input) {
    const [inserted] = await db
      .insert(users)
      .values({
        email: null,
        passwordHash: null,
        name: input.name,
        identityFingerprint: input.identityFingerprint,
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        identityFingerprint: users.identityFingerprint,
      });
    return inserted;
  },
};

export interface PublicOnboardingIdentityResolution {
  identityType: AgentIdentityType;
  user: IdentityUser;
}

/**
 * The identity coordinator shared verbatim by public `/connect` and `/join`.
 * Callers must reject reserved partner labels before entering this function.
 * Every accepted presented label is canonicalized exactly once, and that same
 * canonical type feeds the fingerprint resolver, so route response, ticket,
 * account lookup/heal, and persisted identity can never disagree.
 */
export async function resolvePublicOnboardingIdentityWithStore(
  presentedIdentityType: string,
  identityKey: string,
  store: IdentityResolutionStore,
): Promise<PublicOnboardingIdentityResolution> {
  const identityType = canonicalizePublicAgentIdentityType(presentedIdentityType);
  const user = await resolveOrCreateUserByIdentityWithStore(identityType, identityKey, store);
  return { identityType, user };
}

/** Production database wrapper for the shared public-onboarding coordinator. */
export async function resolvePublicOnboardingIdentity(
  presentedIdentityType: string,
  identityKey: string,
): Promise<PublicOnboardingIdentityResolution> {
  return resolvePublicOnboardingIdentityWithStore(
    presentedIdentityType,
    identityKey,
    databaseIdentityStore,
  );
}

/**
 * Resolve the user row for an agent identity, creating a minimal row
 * if one doesn't exist yet. Never returns null — any DB failure that
 * isn't a handled-race throws.
 *
 * The created user row has:
 *   - `email = null`, `password_hash = null` — the CHECK constraint
 *     `users_has_auth_method` is satisfied via `identity_fingerprint`.
 *   - `name` defaulted to a human-readable slice of the identity key so
 *     Milady/OpenClaw agents show up in admin listings with something
 *     meaningful even before the human adds recovery credentials.
 *
 * Postgres error code 23505 = unique_violation. If two requests race
 * into the "not found → insert" window, the loser catches 23505 and
 * re-reads. The re-read is authoritative because the winner has
 * already committed by the time the loser's insert errors.
 */
export async function resolveOrCreateUserByIdentity(
  identityType: string,
  identityKey: string,
): Promise<IdentityUser> {
  return resolveOrCreateUserByIdentityWithStore(
    identityType,
    identityKey,
    databaseIdentityStore,
  );
}

/** Test seam for the fingerprint resolver; production callers use the wrapper above. */
export async function resolveOrCreateUserByIdentityWithStore(
  identityType: string,
  identityKey: string,
  store: IdentityResolutionStore,
): Promise<IdentityUser> {
  const fingerprint = identityFingerprint(identityType, identityKey);

  // 1. Try to find an existing row by fingerprint.
  const existing = await store.findByFingerprint(fingerprint);
  if (existing) {
    return identityResult(existing, false);
  }

  // Probe retired derivations only for the four supported public identities
  // and only after the new derivation misses. This heals credential continuity;
  // it does not make a retired type name valid on the wire.
  if (SUPPORTED_IDENTITY_TYPES.has(identityType)) {
    const healed = await store.tryHealLegacyFingerprint(
      LEGACY_IDENTITY_TYPES.map((legacyType) => identityFingerprint(legacyType, identityKey)),
      fingerprint,
    );
    if (healed) return identityResult(healed, false);
  }

  // 2. Not found — try to insert. Friendly default name: `Agent <first-12-of-key>`.
  //    The key might itself be a UUID or a long hash, so slicing keeps
  //    admin surfaces readable without leaking the full identity.
  //    12-char slice (bumped from 8 on 2026-04-23 per audit HIGH #3)
  //    reduces cross-user display-name collision in admin lists: 8 hex
  //    chars gives birthday-paradox collisions around 65k users, 12
  //    pushes that to ~16M.
  const displayName = `Agent ${identityKey.slice(0, 12)}`;

  try {
    const inserted = await store.insert({
      name: displayName,
      identityFingerprint: fingerprint,
    });
    return identityResult(inserted, true);
  } catch (err: unknown) {
    // 3. Race-loser path — the concurrent caller beat us to the insert.
    //    Catch the unique-violation and re-read. Any other error is a
    //    real failure and rethrows.
    const code =
      (err as { code?: string; cause?: { code?: string } } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;

    if (code !== '23505') throw err;

    const raced = await store.findByFingerprint(fingerprint);
    if (!raced) {
      // Exceptionally unlikely — either the DB is lying or the
      // concurrent INSERT rolled back after we saw it. Surface loudly.
      throw new Error('Identity fingerprint race: row vanished after 23505');
    }
    return identityResult(raced, false);
  }
}

// ---------------------------------------------------------------------------
// Phase 5.1 — ed25519 identity keypair bootstrap
// ---------------------------------------------------------------------------
// First-time `/api/agent/connect` for a user whose `identity_pubkey` is
// still NULL generates an ed25519 keypair, envelope-encrypts the secret
// via Cloudflare, and writes all five identity_* columns in a single
// conditional UPDATE. The conditional guard `WHERE identity_pubkey IS
// NULL` is the atomicity primitive — two concurrent /connect calls will
// race on the UPDATE; one's WHERE clause matches 0 rows.
//
// Race-loser path: returns the winner's pubkey with isFirstTime=false
// AND needsHumanReauth=true so the agent knows NOT to overwrite its
// config (which already has an older identity secret) and the human
// gets prompted to start a fresh connect-token flow.
//
// See plan §5.2 and §9.1.
// ---------------------------------------------------------------------------

export interface GeneratedIdentity {
  /** Base58 ed25519 public key. Always present. */
  publicKey: string;
  /**
   * Base58 ed25519 secret key (64-byte tweetnacl sign secretKey format).
   * ONLY populated when isFirstTime=true — the caller returns this ONCE
   * in the agent response and the server never re-exposes it.
   */
  secretKey: string;
  /** True when this call wrote the keypair. False for race-losers. */
  isFirstTime: boolean;
  /**
   * Race-loser signal — the user already had a pubkey and our generated
   * secret was discarded. Caller must NOT overwrite the agent's config;
   * instead it prompts the human to re-auth via the connect-token flow.
   */
  needsHumanReauth: boolean;
}

/**
 * Generate and persist an ed25519 identity keypair for a user.
 *
 *   - If users.identity_pubkey IS NULL → generate + write, return
 *     { secretKey, isFirstTime: true, needsHumanReauth: false }.
 *   - If users.identity_pubkey IS NOT NULL → discard the generated
 *     secret, return { secretKey: '', isFirstTime: false,
 *     needsHumanReauth: true, publicKey: <the existing pubkey> }.
 *
 * The atomicity contract is that concurrent calls never both succeed.
 * Implementation uses a single conditional UPDATE with RETURNING so we
 * don't need an advisory lock or a SELECT-then-UPDATE window.
 */
export async function generateIdentityKeypairForUser(
  userId: string,
): Promise<GeneratedIdentity> {
  // 1. Fast-path check: if the user already has a pubkey, skip the
  //    expensive keypair generation + Worker round-trip entirely.
  const existing = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { identityPubkey: true },
  });
  if (!existing) {
    throw new Error(`generateIdentityKeypairForUser: user ${userId} not found`);
  }
  if (existing.identityPubkey) {
    return {
      publicKey: existing.identityPubkey,
      secretKey: '',
      isFirstTime: false,
      needsHumanReauth: false,
    };
  }

  // 2. Generate a fresh ed25519 keypair.
  const kp = nacl.sign.keyPair();
  const publicKeyBase58 = bs58.encode(kp.publicKey);
  const secretKeyBase58 = bs58.encode(kp.secretKey);

  // 3. Envelope-encrypt the secret. Failure here is fatal because
  //    continuing would persist plaintext (unacceptable) or store a
  //    row the read path couldn't decrypt.
  const enc = await encryptSecretKeyEnveloped(kp.secretKey);

  // 4. Atomic conditional UPDATE. `affectedRows === 1` ⇔ we won the
  //    race (the NULL guard matched); === 0 ⇔ a concurrent caller
  //    beat us to it.
  const updated = await db
    .update(users)
    .set({
      identityPubkey: publicKeyBase58,
      identityEncryptedSk: enc.encryptedSecretKey,
      identityIv: enc.encryptionIv,
      identityTag: enc.encryptionTag,
      identityDekWrapped: enc.dekWrapped,
      identityEncryptionVersion: enc.encryptionVersion,
      updatedAt: new Date(),
    })
    .where(and(eq(users.id, userId), isNull(users.identityPubkey)))
    .returning({ identityPubkey: users.identityPubkey });

  if (updated.length === 1) {
    return {
      publicKey: publicKeyBase58,
      secretKey: secretKeyBase58,
      isFirstTime: true,
      needsHumanReauth: false,
    };
  }

  // 5. Race-loser — re-read the winner's pubkey so the caller can
  //    surface it to the agent. The generated secret is discarded.
  const raced = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { identityPubkey: true },
  });
  if (!raced?.identityPubkey) {
    // Shouldn't happen — either the UPDATE succeeded (handled above) or
    // the WHERE missed because a concurrent caller wrote the pubkey.
    // If we see neither, surface loudly so we can investigate.
    throw new Error(
      `Identity race: update affected 0 rows but identity_pubkey is NULL for user ${userId}`,
    );
  }
  return {
    publicKey: raced.identityPubkey,
    secretKey: '',
    isFirstTime: false,
    needsHumanReauth: true,
  };
}
