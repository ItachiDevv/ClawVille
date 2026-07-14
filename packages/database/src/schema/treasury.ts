import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  pgEnum,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { avatars } from './avatars';

/**
 * Treasury wallet purposes — expand as new use cases appear.
 *
 * - `x402-merchant`: receives USDC payments from x402-gated endpoints
 *   (Phase 4 prep; activation deferred)
 * - `fee-collector`: generic fee sink if we add on-chain fees later
 * - `escrow`: holds funds between two parties during a transaction
 * - `wager-settlement-authority`: settlement-authority signing key for the
 *   `clawville_wager` Anchor program (devnet program id
 *   `HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG`). Singleton across the
 *   whole API host — the API loads it on cold boot via
 *   `wager-program-client.ts` and uses it to call `lock_lobby` /
 *   `settle_lobby_*` / authority-cancel. The private key never leaves the
 *   API process. Devnet uses the deployer pubkey
 *   `G5WgvGYK5mLxQbVUmNhFKeWwEhT235p2HjKmkbpMbMWy`; production must rotate
 *   via the program's `update_config` instruction and re-seed this row
 *   with the new keypair before pointing prod traffic at it.
 * - `clv-swap` (Tokenomics C3, 2026-07-07): the DEDICATED CLV buy-side swap
 *   wallet the (Codex-review-gated) live swap executor would fund clips from.
 *   Provisioned as ONE row by `scripts/generate-clv-swap-wallet.ts` (AES-256-GCM
 *   at rest, same scheme as every treasury row). The dry-run executor only ever
 *   READS the pubkey (`getClvSwapWalletPubkey()` in
 *   `apps/api/src/services/clv-swap-executor.ts`) — it NEVER decrypts the
 *   secret; live signing is a Codex-gated seam.
 * - `earned-backing` (Tokenomics E2/E3, 2026-07-14): holds the real USDC
 *   backing redeemable EARNED vCLAW. It never receives agent-pay rail ④ funds;
 *   those payments go to the recipient and their EARNED lot is `none`.
 *
 * Postgres enum add: extending this list requires
 * `ALTER TYPE treasury_purpose ADD VALUE IF NOT EXISTS '<value>'` — shipped in
 * the numbered migrations (e.g. `0014_clv_swap_queue.sql` for 'clv-swap');
 * NEVER via db:push.
 */
export const treasuryPurposeEnum = pgEnum('treasury_purpose', [
  'x402-merchant',
  'fee-collector',
  'escrow',
  'wager-settlement-authority',
  'clv-swap',
  'earned-backing',
]);

/**
 * Treasury wallets — process-owned Solana keypairs whose secret keys
 * are encrypted at rest using the same AES-256-GCM scheme as
 * vanityKeypairs (VANITY_ENCRYPTION_KEY env var).
 *
 * Generation happens via scripts/generate-treasury-keypair.ts.
 * Secret keys MUST NEVER be printed, logged, or read back by humans.
 */
export const treasuryWallets = pgTable(
  'treasury_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: treasuryPurposeEnum('purpose').notNull(),
    /** Base58 Solana public key */
    publicKey: varchar('public_key', { length: 64 }).notNull().unique(),
    /** AES-256-GCM encrypted secret key bytes, base64-encoded */
    encryptedSecretKey: text('encrypted_secret_key').notNull(),
    /** AES-256-GCM IV, base64-encoded */
    encryptionIv: varchar('encryption_iv', { length: 32 }).notNull(),
    /** AES-256-GCM auth tag, base64-encoded */
    encryptionTag: varchar('encryption_tag', { length: 32 }).notNull(),
    /** Freeform notes — e.g. "Phase 4 prep, production merchant wallet" */
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    purposeIdx: index('treasury_purpose_idx').on(t.purpose),
    /**
     * E2/E3 v1 deliberately supports one backing custody wallet. Rotation is
     * an explicit, proof-backed drain/migration; callers never pick an
     * arbitrary first/newest row from multiple wallets.
     */
    earnedBackingSingleton: uniqueIndex('treasury_wallets_earned_backing_singleton')
      .on(t.purpose)
      .where(sql`purpose = 'earned-backing'`),
  }),
);

/**
 * TREASURY SUBJECTS (Tokenomics T0, 2026-07-07) — first-class registry naming
 * the singleton HOUSE-TREASURY avatar(s).
 *
 * The ClawToken ledger can only hold a balance on an `avatars` row (every
 * `claw_token_transactions` row requires `avatar_id`, and the
 * `avatars_vclaw_balance_sum` CHECK lives there), so the house treasury IS a
 * system avatar — this table is the durable, queryable NAME for it, so it is a
 * first-class subject rather than "just another avatar".
 *
 *   - `purpose` — UNIQUE role key. T0 ships the singleton `'house-fees'`: the
 *     pure revenue SINK every routed fee credits (cove rakes, baccarat
 *     commission, MTT rake, cosmetics/book purchases, land sale/upgrade/rent).
 *     It starts at 0 CT, is NEVER minted a bankroll, and NEVER pays players.
 *   - `avatarId` — FK to the balance-bearing system avatar. ON DELETE RESTRICT:
 *     the treasury avatar must never be cascade-deleted out from under the
 *     registry (deleting it would orphan the accumulated revenue).
 *
 * Provisioned idempotently on boot by
 * `apps/api/src/services/house-treasury-seeder.ts` (mirrors the audited
 * cash-house-seeder pattern). Distinct from `treasuryWallets` above (Solana
 * keypair custody) — this table names in-game CT ledger subjects.
 */
export const treasurySubjects = pgTable('treasury_subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Unique role key, e.g. 'house-fees' (T0 singleton). */
  purpose: text('purpose').notNull().unique(),
  /** The balance-bearing system avatar this subject's CT lives on. */
  avatarId: uuid('avatar_id')
    .notNull()
    .references(() => avatars.id, { onDelete: 'restrict' }),
  /** Freeform operator notes. */
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- ClawToken audit ledger ---

/**
 * Source of a ClawToken transaction — used for observability and
 * replay-to-chain migrations.
 */
export const clawTokenSourceEnum = pgEnum('claw_token_source', [
  'api',              // user-initiated via REST route
  'simulation',       // autonomous avatar action (Phase 2 bridge)
  'quest',            // quest reward
  'bounty',           // bounty reward
  'exchange',         // exchange listing escrow / release / refund (2026-05-18)
  'daily_login',      // daily login streak
  'admin',            // manual admin grant
  'x402',             // future: real USDC top-up via x402 (deferred)
  'system',           // fallback for internal adjustments
]);

/**
 * vCLAW PROVENANCE TAG (Tokenomics F1, 2026-06-27) — the CASHABILITY taxonomy.
 *
 * Distinct from `claw_token_source` above (which is a FAUCET-ORIGIN observability
 * label). Provenance answers the only question that matters for the cash-out path:
 * "can this balance ever leave the economy as real money?"
 *
 *   - `soft`   — play money: quests, daily login, cove/play winnings, faucet, AND
 *                EVERY internal peer-transfer receipt (see the chokepoint rule).
 *                Spendable in-world, NEVER cashable.
 *   - `bought` — on-ramp purchases (fiat/SOL/USDC/CLV at the one-way store price).
 *                You bought spend power, not a withdrawal right. NEVER cashable
 *                (V-Bucks semantics). Carries a `usd_basis`.
 *   - `earned` — agent labor paid by a REAL external customer (USDC via SAP/x402),
 *                credited in FULL. Only house-backed + verified + vested +
 *                non-clawed EARNED is redeemable; unbacked EARNED is spend-only.
 *                Carries a `usd_basis`.
 *
 * THE CHOKEPOINT INVARIANT (plan §3.1): `earned` is written in EXACTLY ONE code
 * path — `claw-token-ledger.mintEarned()`. Every other credit path produces
 * `soft` or `bought` only; `transferClawTokens` always credits the receiver
 * `soft`. This makes "buy → fake-sell to my alt → cash out" impossible by
 * construction: internal recirculation can never become cashable.
 *
 * GATED DARK: E3 redemption remains default-OFF behind legal/solvency gates.
 * These tags drive the backing audit + claw-back + vesting wall.
 */
export const clawTokenProvenanceEnum = pgEnum('claw_token_provenance', [
  'soft',
  'bought',
  'earned',
]);

/**
 * Append-only audit ledger for every ClawToken credit/debit.
 *
 * avatars.clawTokens remains the authoritative balance column; this table
 * is the auditable history. Every write to avatars.clawTokens MUST go
 * through creditClawTokens() / debitClawTokens() in
 * apps/api/src/services/claw-token-ledger.ts, which atomically
 * UPDATEs the balance AND INSERTs a row here in the same transaction.
 *
 * When we eventually tokenize ClawTokens (Phase 5+), we replay this
 * ledger to establish opening on-chain balances.
 */
export const clawTokenTransactions = pgTable(
  'claw_token_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    /** Signed integer: positive = credit, negative = debit */
    amount: integer('amount').notNull(),
    /** Snapshot of avatars.clawTokens AFTER this transaction applied */
    balanceAfter: integer('balance_after').notNull(),
    /** Short human-readable reason: 'buy_book', 'autonomous_visit', etc. */
    reason: text('reason').notNull(),
    /** High-level source category */
    source: clawTokenSourceEnum('source').notNull(),
    /**
     * vCLAW PROVENANCE TAG (Tokenomics F1, 2026-06-27) — the cashability tag for
     * THIS row's delta. Credits stamp the tag minted (`soft`/`bought`/`earned`);
     * debits stamp the tag BURNED (a multi-tag spend emits one row per tag so the
     * audit trail shows exactly which cashable/non-cashable balance was consumed —
     * see `claw-token-ledger.ts` allocator). Nullable for backfilled pre-F1 rows
     * (historical ledger rows have no provenance). `earned` is written ONLY by
     * `mintEarned()`; see `clawTokenProvenanceEnum`.
     */
    provenance: clawTokenProvenanceEnum('provenance'),
    /**
     * USD basis (Tokenomics F1) — the real-dollar value behind this row. Set for
     * `bought` receipts (dollars paid at the on-ramp) and `earned` mints (the full
     * USDC a real customer paid), NULL otherwise. numeric(20,6) = µUSD precision,
     * room for any plausible amount. The cashable claim is denominated by THIS, set
     * by the payer — never a house rate (backing, not a peg; plan §3.2).
     */
    usdBasis: numeric('usd_basis', { precision: 20, scale: 6 }),
    /**
     * Anti-abuse fingerprint scaffolding (Tokenomics F1, plan §6). `mintEarned`
     * ACCEPTS + STORES these (salted sha256 of browser fp / IP-/24 prefix, supplied
     * by the caller). ENFORCEMENT (per-pair caps / cooldown) is a LATER feature —
     * F1 only lands the columns + the single write site that records them. Nullable.
     */
    fpHash: text('fp_hash'),
    ipPrefixHash: text('ip_prefix_hash'),
    /** Reason-specific payload (bookId, buildingId, questId, txHash, etc.) */
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    avatarIdx: index('claw_token_tx_avatar_idx').on(t.avatarId, t.createdAt),
    userIdx: index('claw_token_tx_user_idx').on(t.userId, t.createdAt),
    sourceIdx: index('claw_token_tx_source_idx').on(t.source, t.createdAt),
    // F1 — audit-by-cashability: scan all `earned` mints / all `bought` receipts.
    provenanceIdx: index('claw_token_tx_provenance_idx').on(t.provenance, t.createdAt),
  }),
);

// Suppress unused-import warning if callers don't use the users relation
void users;
