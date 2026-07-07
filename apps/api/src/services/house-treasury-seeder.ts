/**
 * HOUSE TREASURY — boot seeder (Tokenomics T0, 2026-07-07; idempotent).
 *
 * Provisions, on every API boot (idempotent — mirrors the audited
 * `cash-house-seeder.ts` pattern):
 *
 *   1. ONE system HOUSE-TREASURY avatar — `house-treasury@house.clawville.internal`,
 *      avatar name 'House Treasury', `isActive=false`, `isGuest=false`,
 *      `clawTokens=0` (+ `softBalance=0` mirrored so the
 *      `avatars_vclaw_balance_sum` CHECK holds — without it the column DEFAULT
 *      100 would break 0 = 100+0+0).
 *   2. ONE `treasury_subjects` registry row (`purpose='house-fees'` → avatarId),
 *      upserted via ON CONFLICT (purpose) DO NOTHING + re-find, so the treasury
 *      is a NAMED first-class subject, not "just another avatar".
 *
 * ── NO BANKROLL MINT — THE LOAD-BEARING DIFFERENCE FROM cash-house-seeder ────
 * The treasury is a pure revenue SINK. It starts at 0 CT and ONLY accumulates
 * the fee credits routed by T0 (cove rakes / baccarat commission / MTT rake /
 * cosmetic + book purchases / land sale + upgrade + rent). ZERO CT is ever
 * minted INTO it by this seeder, and in T0 it NEVER pays players (no faucet).
 * Contrast the cash-house bank, which deliberately mints a one-time bankroll.
 *
 * MONEY DISCIPLINE: this file performs NO ClawToken balance write at all. The
 * only writes are the system user row, the avatar row (created AT 0), and the
 * registry row. Fee credits happen at the fee sites via
 * `creditClawTokens({avatarId: <treasury>, ...}, tx)` composed into each
 * settlement/purchase transaction.
 *
 * FEE-SITE RESOLUTION CONTRACT:
 *   - `houseTreasuryAvatarId(): string` — sync accessor; THROWS before
 *     `ensure()` completes (boot-ordering bug surface, mirrors
 *     `cashHouseSeeder.houseBankAvatarId()`).
 *   - `getHouseTreasuryAvatarId(): Promise<string | null>` — what the FEE SITES
 *     call inside their settlement tx. Fast path: the cached id (no I/O).
 *     Cold/degraded path: lazily runs `ensure()` (self-healing if the boot seed
 *     failed or hasn't finished) and returns the id, or `null` after a loud
 *     console.error if provisioning is genuinely unavailable. Returning null —
 *     NOT throwing — is deliberate money-safety: a missing treasury must NEVER
 *     abort a player's settlement; the fee simply falls back to the pre-T0
 *     silent-burn behavior for that one settlement (strictly no worse than
 *     before T0, and self-heals on the next call).
 */

import { eq } from 'drizzle-orm';
import { db, users, avatars, treasurySubjects } from '@clawville/database';

// ── Stable naming (single source of truth — DO NOT change without a re-seed) ──

const HOUSE_DOMAIN = '@house.clawville.internal';
export const HOUSE_TREASURY_EMAIL = `house-treasury${HOUSE_DOMAIN}`;
export const HOUSE_TREASURY_AVATAR_NAME = 'House Treasury';
/** The `treasury_subjects.purpose` key for the T0 fee-sink singleton. */
export const HOUSE_TREASURY_PURPOSE = 'house-fees';

/**
 * The `users` CHECK `users_has_auth_method` requires (email + password_hash) OR
 * identity_fingerprint. The treasury user never logs in, so it gets a
 * deterministic, unusable scrypt-shaped placeholder password to satisfy the
 * constraint — obvious at a glance that it is disabled (same pattern as
 * cash-house-seeder).
 */
function disabledPasswordHash(tag: string): string {
  return `$house$disabled$${tag}-${Buffer.from(tag).toString('base64')}`;
}

class HouseTreasurySeederService {
  private treasuryAvatarId: string | null = null;
  private ensured = false;
  private ensuringPromise: Promise<void> | null = null;

  /**
   * Idempotent boot provision. Safe to call on every restart. Concurrent
   * callers await the same in-flight promise (race-safe in-process); cross-pod
   * races are absorbed by the unique constraints + ON CONFLICT/re-find below.
   */
  async ensure(): Promise<void> {
    if (this.ensured) return;
    if (this.ensuringPromise) return this.ensuringPromise;
    this.ensuringPromise = this.runEnsure();
    try {
      await this.ensuringPromise;
    } finally {
      this.ensuringPromise = null;
    }
  }

  private async runEnsure(): Promise<void> {
    // 1. System user (find-first, insert on miss; a cross-pod 23505 loser
    //    re-finds the winner's row).
    let userId: string;
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, HOUSE_TREASURY_EMAIL),
    });
    if (existingUser) {
      userId = existingUser.id;
    } else {
      try {
        const [created] = await db
          .insert(users)
          .values({
            email: HOUSE_TREASURY_EMAIL,
            passwordHash: disabledPasswordHash(`treasury-${HOUSE_TREASURY_EMAIL}`),
            name: 'House Treasury Owner',
            emailVerified: true,
          })
          .returning({ id: users.id });
        userId = created.id;
      } catch (err) {
        // Unique-email race with a concurrently-booting pod — re-find the winner.
        const winner = await db.query.users.findFirst({
          where: eq(users.email, HOUSE_TREASURY_EMAIL),
        });
        if (!winner) throw err;
        userId = winner.id;
      }
    }

    // 2. The treasury avatar (one per user — avatars.userId is unique).
    //    clawTokens: 0 with softBalance MIRRORED to 0 (CHECK avatars_vclaw_
    //    balance_sum: claw_tokens = soft + bought + earned; the column defaults
    //    are 100/100 so BOTH must be set explicitly). NO bankroll mint — ever.
    let avatarId: string;
    const existingAvatar = await db.query.avatars.findFirst({
      where: eq(avatars.userId, userId),
    });
    if (existingAvatar) {
      avatarId = existingAvatar.id;
    } else {
      try {
        const [avatar] = await db
          .insert(avatars)
          .values({
            userId,
            name: HOUSE_TREASURY_AVATAR_NAME,
            species: 'turtle',
            color: 'green',
            gender: 'male',
            archetype: 'brave-adventurer',
            personality: {
              habitat: 'The Vault',
              hobby: 'Counting routed fees',
              greeting: 'The house keeps its books.',
            },
            stats: { strength: 5, defence: 5, movement: 5 },
            clawTokens: 0, // pure sink — starts empty, only fee credits land here
            softBalance: 0, // MUST mirror clawTokens (avatars_vclaw_balance_sum)
            isActive: false, // never visible in the NPC simulation
            isGuest: false,
            agentCategory: 'openclaw',
            modelKey: 'lobster',
            harness: 'milady',
          })
          .returning({ id: avatars.id });
        avatarId = avatar.id;
      } catch (err) {
        // Unique avatars.userId race — re-find the winner.
        const winner = await db.query.avatars.findFirst({
          where: eq(avatars.userId, userId),
        });
        if (!winner) throw err;
        avatarId = winner.id;
      }
    }

    // 3. The registry row that NAMES the subject. ON CONFLICT (purpose) DO
    //    NOTHING + re-find: cross-pod safe, and a pre-existing row WINS (we
    //    never repoint an established treasury at a different avatar).
    await db
      .insert(treasurySubjects)
      .values({
        purpose: HOUSE_TREASURY_PURPOSE,
        avatarId,
        notes:
          'T0 house-fee sink — receives every routed fee credit (cove rakes, baccarat ' +
          'commission, MTT rake, cosmetics/books, land sale/upgrade/rent). Never funded, ' +
          'never pays players.',
      })
      .onConflictDoNothing({ target: treasurySubjects.purpose });
    const registered = await db.query.treasurySubjects.findFirst({
      where: eq(treasurySubjects.purpose, HOUSE_TREASURY_PURPOSE),
    });
    if (!registered) {
      throw new Error(
        '[house-treasury-seeder] treasury_subjects row missing after upsert — is migration 0007 applied?',
      );
    }
    // The REGISTRY row is authoritative for which avatar is the treasury (a
    // prior boot may have bound a different avatar row; honor it).
    this.treasuryAvatarId = registered.avatarId;
    this.ensured = true;

    console.log(
      `[house-treasury-seeder] ensured treasury avatar ${this.treasuryAvatarId} (purpose='${HOUSE_TREASURY_PURPOSE}', no bankroll — pure fee sink)`,
    );
  }

  /** The treasury avatarId. THROWS if `ensure()` has not completed. */
  houseTreasuryAvatarId(): string {
    if (!this.treasuryAvatarId) {
      throw new Error(
        '[house-treasury-seeder] houseTreasuryAvatarId() before ensure() — boot ordering bug',
      );
    }
    return this.treasuryAvatarId;
  }

  /**
   * Fee-site resolver — see the header contract. Never throws; returns null
   * (after a LOUD error log) when the treasury is unavailable so the calling
   * settlement can proceed with the pre-T0 burn behavior for that one fee.
   */
  async getHouseTreasuryAvatarId(): Promise<string | null> {
    if (this.treasuryAvatarId) return this.treasuryAvatarId;
    try {
      await this.ensure();
      return this.treasuryAvatarId;
    } catch (err) {
      console.error(
        '[house-treasury-seeder] treasury unavailable — this fee will BURN (pre-T0 behavior); will retry on next fee:',
        err,
      );
      return null;
    }
  }

  /** Test hook — wipe in-memory state. */
  __resetForTest(opts?: { treasuryAvatarId?: string }): void {
    this.treasuryAvatarId = opts?.treasuryAvatarId ?? null;
    this.ensured = !!opts;
    this.ensuringPromise = null;
  }
}

export const houseTreasurySeeder = new HouseTreasurySeederService();

/** Sync accessor (throws before ensure) — summary/route use. */
export function houseTreasuryAvatarId(): string {
  return houseTreasurySeeder.houseTreasuryAvatarId();
}

/** Fee-site resolver (self-healing, never throws) — settlement-tx use. */
export function getHouseTreasuryAvatarId(): Promise<string | null> {
  return houseTreasurySeeder.getHouseTreasuryAvatarId();
}
