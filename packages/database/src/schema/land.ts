/**
 * Land Economy — Phase 0 schema (converged tables).
 *
 * The money-load-bearing foundation for the ClawVille land/property + services
 * economy. Every later phase (buy parcel → place structure → upgrade → run a
 * peer service → buy CT with USDC) builds on these tables. PURELY ADDITIVE:
 * new enums + new tables only, NO change to any existing table, so `db:push`
 * is a clean CREATE (no destructive ALTER/DROP).
 *
 * Naming + conflict resolutions follow `.claude/plans/land-economy/ROADMAP.md §6`:
 *   - C1: services + on-ramp surface uses the PAYMENTS naming as canonical —
 *     `service_listings`, `service_purchases`, `partner_storefronts`, `ct_topups`.
 *     The land-domain audit spine (`land_parcels`, `land_structures`,
 *     `land_upgrades`, `land_transactions`) is the backend shape. ALL live here.
 *   - C5: tier enum is LOWERCASE `['starter','c','b','a','founder']` — matches
 *     the frozen `LandTier` type in `@clawville/shared` `land-tiers.ts`.
 *   - C6: `parcel_code` (UNIQUE) is the single stable key, format
 *     `parcel-<tier>-<NN>` (== `parcelCode(tier, i)` == `LAND_PARCELS[].id` ==
 *     `stores/land.ts` render key). No mapping layer.
 *   - C8: v1 treasury model is a BURN-sink — the buyer is debited, CT leaves
 *     circulation, recorded in `land_transactions`. The ledger only credits
 *     avatars and there is no treasury avatar, so there is NO treasury-avatar
 *     credit. `credit_ledger_tx_id` is RESERVED for a future treasury-credit
 *     model; no v1 route writes it.
 *
 * Ownership binds to `avatars.id` — which is what BOTH a human (Lucia session)
 * AND a connected/hosted agent (`requireAuthOrAgentSession` → bound avatar)
 * resolve to. That is the Rule-E5 parity seam: a write route reads
 * `identity.avatarId` and sets `owner_avatar_id` / `buyer_avatar_id` /
 * `seller_avatar_id` from it — no human-XOR-guest, no agent-locked-out path.
 *
 * RESERVED-INERT columns (designed now so turning them on is a route/cron
 * change, never a migration):
 *   - Founder on-chain NFT: `nft_mint_address` / `nft_owner_pubkey` /
 *     `nft_minted_at` (gated by custody legal review — FEATURE_GATE
 *     founder_onchain_nft). NO v1 code writes these.
 *   - Recurring CT sinks: `land_parcels.last_tax_paid_at` / `upkeep_due_at`,
 *     `service_listings.platform_fee_bps` (=0). v1 has ONE-TIME sinks only
 *     (buy + upgrade) per DESIGN decision #10; recurring tax/upkeep/rake are
 *     the deferred economy-health pass.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { avatars } from './avatars';
import { users } from './users';

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS (lowercase — Postgres pgEnum convention, §6.C5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Land tier taxonomy. LOWERCASE to match the frozen `LandTier` TS type in
 * `@clawville/shared` (`land-tiers.ts`) and the `parcelCode()` format. UI/agent
 * text renders via `tierLabel()` — raw enum casing is never shown.
 *
 *   starter — onboarding floor (1st free per player; abundant; never sells out)
 *   c       — outer ward, abundant, cheap standard homes/shops
 *   b       — inner ward, limited, better location
 *   a       — town crest, scarce, near spawn, premium/prestige
 *   founder — Founders' Row, very scarce, town-square adjacent, on-chain NFT
 *             (INERT in v1 — buy returns 501; mint columns reserved)
 */
export const landTierEnum = pgEnum('land_tier', ['starter', 'c', 'b', 'a', 'founder']);

/** Parcel lifecycle. `available` = for sale (owner_avatar_id IS NULL). */
export const landParcelStatusEnum = pgEnum('land_parcel_status', [
  'available', // in the primary-sale pool, unowned
  'owned', // held by an avatar
  'reserved', // soft mid-purchase hold (the row-lock in the buy route is the real guard)
  'retired', // pulled from supply (admin)
]);

/** A placed structure is a HOME (utility hub) or a SHOP (runs paid services). */
export const landStructureTypeEnum = pgEnum('land_structure_type', ['home', 'shop']);

/**
 * Land-domain audit-spine reason taxonomy (`land_transactions.kind`). Mirrors
 * the typed-reason discipline of `claw_token_transactions.reason`. DEFERRED
 * values are reserved so adding them later is not a migration.
 */
export const landTransactionKindEnum = pgEnum('land_transaction_kind', [
  'parcel_purchase', // primary-sale buy (v1 burn-sink — buyer debited)
  'structure_placement', // free placement (amount_ct = 0 in v1)
  'structure_upgrade', // CT upgrade-tier sink
  'service_sale', // peer CT service buy — full transfer to seller (no rake v1)
  'rent_payment', // LIVE (2026-06-24): rent acquire + each weekly rent-sweep charge (CT sink)
  'eviction', // LIVE (2026-06-24): rent lapsed past grace -> parcel returned to pool, structure archived
  // ── Phase B tenure model (2026-07-07) ──
  'land_deposit_escrow', // B1 starter claim — refundable deposit debited INTO escrow (NOT revenue)
  'land_deposit_topup', // B1 top-up — adds to the escrow remainder
  'land_deposit_refund', // B1 voluntary release — escrow remainder credited back to the claimant
  // ── Tokenomics C checkout stage (2026-07-07, migration 0016) ──
  'land_deposit_prepay_usdc', // USDC x402 checkout funds the escrow remainder — NO avatar debit; backed by the recorded settlement (usd_basis in metadata). See rent-prepay fulfiller.
  'hold_claim', // B2 c/b/a/founder claim — CLV hold proven, no CT debit (amount_ct = 0)
  // ── DEFERRED (reserved; no v1 write path) ──
  'parcel_resale', // NEXT milestone (P2P resale)
  'property_tax', // economy-health pass (recurring sink)
  'upkeep', // economy-health pass (recurring sink)
  'service_rake', // economy-health pass (house rake)
]);

/**
 * Parcel TENURE — HOW the parcel is held (orthogonal to `status`, which is pool
 * membership). NULL on an `available`/unsold parcel.
 *   rented  — held via the weekly-rent path; evictable on lapse (rent_paid_through/grace_until live)
 *   owned   — LEGACY buy-outright (Phase B migrates these to grandfathered 'hold';
 *             the buy route is disabled — `tenure_model_active`)
 *   starter — LEGACY free first-claim parcel (pre-Phase-B); never rents, never evicts.
 *             New starter claims use 'deposit'.
 *   deposit — Phase B1 starter deposit-escrow: refundable deposit held on the row
 *             (`deposit_remaining_ct`); weekly rent draws FROM the escrow → treasury;
 *             exhaustion → grace → lapse (remainder forfeits)
 *   hold    — Phase B2 hold-to-keep (c/b/a/founder): CLV balance ≥ stacked
 *             thresholds required; weekly CT upkeep debits the holder → treasury;
 *             CLV-below OR insufficient CT → grace → lapse
 */
export const landTenureEnum = pgEnum('land_tenure', [
  'rented',
  'owned',
  'starter',
  'deposit',
  'hold',
]);

/**
 * Which SUBJECT's CLV backs a B2 hold parcel — decides how the sweeper re-checks
 * the hold: 'user' → the human's linked self-custody wallet
 * (`users.linked_wallet_pubkey`); 'agent' → the agent's custodial wallet
 * (`avatars.wallet_address`). NULL on non-hold rows AND on grandfathered holds
 * (which are never CLV-checked).
 */
export const landHoldSubjectEnum = pgEnum('land_hold_subject', ['user', 'agent']);

/**
 * Structure lifecycle. `active` = live + rendered. `archived` = soft-deleted by an
 * eviction (the parcel returned to the pool but the build is preserved); a re-rent/
 * buy by the SAME avatar restores it, a re-lease to a DIFFERENT avatar purges it.
 * Archived structures are excluded from every owned/structure read + the renderer.
 */
export const landStructureStatusEnum = pgEnum('land_structure_status', ['active', 'archived']);

/** Service listing kind. `peer` = CT (v1). `partner` = USDC via x402 (gated). */
export const serviceListingKindEnum = pgEnum('service_listing_kind', ['peer', 'partner']);

/** Service listing lifecycle. */
export const serviceListingStatusEnum = pgEnum('service_listing_status', [
  'active',
  'paused',
  'delisted',
]);

/** Vetted-partner storefront lifecycle (INERT in v1 — CT-only core loop). */
export const partnerStorefrontStatusEnum = pgEnum('partner_storefront_status', [
  'pending',
  'active',
  'suspended',
]);

/** CT top-up on-ramp rail. Only `x402` is wired in Phase 4; `stripe`/`clv` reserved. */
export const ctTopupRailEnum = pgEnum('ct_topup_rail', ['x402', 'stripe', 'clv']);

/**
 * CT top-up settlement state — the DURABLE, cross-process, resumable machine
 * (mirrors x402_checkouts after the Codex money-path review). pending → settling
 * (DB-backed claim BEFORE the facilitator) → settling+tx_signature (CAPTURE: the
 * signature is persisted in its OWN committed UPDATE the instant the facilitator
 * settles, BEFORE the CT credit — a credit failure can never lose it and
 * re-settle real USDC) → settled (credit ran). A stale settling claim with no
 * signature → reconcile (money-state unknown, NEVER auto-retried). CHECK
 * `ct_topups_settled_has_signature`: a settled row ALWAYS carries the signature.
 */
export const ctTopupStatusEnum = pgEnum('ct_topup_status', [
  'pending', // 402 quote issued, awaiting signed payment
  'settling', // CLAIMED for settlement; facilitator call in-flight (tx_signature NULL) or CAPTURED awaiting/​resuming the credit (tx_signature set)
  'settled', // facilitator settled the tx AND CT credited; tx_signature ALWAYS present (CHECK)
  'failed', // verify/settle definitively rejected (no money moved)
  'reconcile', // money-state UNKNOWN (stale settling w/o signature) OR a settled tx-sig owned by another top-up — needs chain reconciliation, NEVER auto-retried
]);

// ─────────────────────────────────────────────────────────────────────────────
// land_parcels — fixed concentric supply (DB-authoritative ownership)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One pre-seeded row per parcel. Supply is fixed (Phase 1 seed enumerates every
 * parcel from the world-planner's placement formula). `price_ct` is STAMPED
 * per-row at seed from the tier ladder — NEVER read from a ladder at buy time,
 * so a ladder retune can never silently reprice an already-listed parcel
 * (ROADMAP R11). The buy route reads `land_parcels.price_ct` only.
 */
export const landParcels = pgTable(
  'land_parcels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Stable, frozen key — `parcel-<tier>-<NN>` (== `parcelCode(tier,i)` in
     * `@clawville/shared`). UNIQUE → lets the seed be idempotent
     * (`ON CONFLICT (parcel_code) DO NOTHING`) and is the render key.
     */
    parcelCode: varchar('parcel_code', { length: 32 }).notNull().unique(),
    tier: landTierEnum('tier').notNull(),
    status: landParcelStatusEnum('status').notNull().default('available'),

    // ── world-grid placement (authoritative; world-planner's seed fills these) ──
    /** Tile coords on the grown world grid. `uniqueIndex(grid_x, grid_y)` = one parcel per cell. */
    gridX: integer('grid_x').notNull(),
    gridY: integer('grid_y').notNull(),

    /**
     * Server-authoritative primary-sale price in CT, STAMPED per-row at seed.
     * Nullable — Founder tier is auction/USDC-only (priceCt NULL → buy 501 in
     * v1). The buy route asserts NON-NULL before debiting.
     */
    priceCt: integer('price_ct'),

    // ── ownership (null = for sale) ──
    ownerAvatarId: uuid('owner_avatar_id').references(() => avatars.id, {
      onDelete: 'set null',
    }),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }),

    // ── tenure (builder-economics, 2026-06-24) ──
    /**
     * HOW the parcel is held. NULL = available/unsold. Set on acquire
     * ('owned' = buy outright, 'rented' = weekly rent, 'starter' = free claim);
     * cleared to NULL on eviction (parcel returns to the available pool).
     */
    tenure: landTenureEnum('tenure'),
    /**
     * Weekly rent in CT, STAMPED per-row at seed/migration from `LAND_RENT_LADDER`
     * (same per-tier interpolation as price_ct). The rent route reads THIS, never
     * the ladder. NULL for starter/founder (not rentable). Stays stamped across an
     * eviction (it is the listing rent, not a per-tenancy value).
     */
    rentCtWeekly: integer('rent_ct_weekly'),
    /**
     * For a `rented` parcel: the instant the current paid period ends. The rent
     * sweeper charges the next week when `now() >= rent_paid_through`. NULL for
     * owned/starter/available.
     */
    rentPaidThrough: timestamp('rent_paid_through', { withTimezone: true }),
    /**
     * Set to `now() + RENT_GRACE_DAYS` when a weekly charge fails (insufficient
     * CT). While set, perks + shop listings are paused. If still set and elapsed
     * at the next sweep, the parcel is evicted. Cleared on a successful charge.
     */
    graceUntil: timestamp('grace_until', { withTimezone: true }),

    // ── Phase B tenure model (2026-07-07) — deposit-escrow + hold-to-keep ──
    /**
     * B1: the ORIGINAL claim deposit (units) debited into escrow at claim time.
     * Immutable for the life of the tenancy (top-ups grow `deposit_remaining_ct`,
     * not this). NULL on non-deposit rows.
     */
    depositCt: integer('deposit_ct'),
    /**
     * B1: the LIVE escrow remainder (units).
     *
     * ═══ ESCROW-CONSERVATION INVARIANT (money-load-bearing) ═══
     * The CT counted here traces to a claimant avatar debit OR a recorded USDC
     * settlement (the Tokenomics-C extension, 2026-07-07 — see below) and
     * exists NOWHERE in any avatar balance while escrowed — this column is the
     * sole record of it. Every mutation preserves:
     *
     *   deposit_remaining_ct = (claim deposit + Σ top-ups + Σ USDC prepays)
     *                          − Σ weekly draws − refund − forfeit   ≥ 0
     *
     * so, over a tenancy's life:
     *   Σ draws + refund + forfeit == claim + Σ top-ups + Σ USDC prepays.
     * Draws/forfeits CREDIT the house treasury (balanced by the claim/top-up
     * debits — net supply change is always ≤ 0, i.e. the escrow can never MINT);
     * the refund credits the claimant. The `land_parcels_deposit_remaining_nonneg`
     * CHECK is the DB backstop; `decideDepositSweep` (land-rent-sweeper) is the
     * single draw-math authority; unit tests prove exact conservation.
     * Cleared to NULL on lapse/release (after the forfeit/refund books it).
     *
     * ── Tokenomics-C EXTENSION (LAND-DOMAIN, CODEX-review-gated; 2026-07-07):
     * a `land_deposit_prepay_usdc` row (rent-prepay checkout fulfiller,
     * `apps/api/src/services/checkout-fulfillers/rent-prepay.ts`) grows the
     * remainder with NO avatar debit — the backing is the settled x402 USDC
     * payment recorded on the SAME-tx `x402_checkouts` row + stamped as
     * `usd_basis` in the land_transactions metadata. A later draw of that CT
     * into the treasury is therefore a BACKED emission (real dollars entered),
     * and a refund/forfeit of it conserves exactly like a debited top-up. Any
     * escrow credit WITHOUT (an avatar debit XOR a settled-USDC usd_basis) is
     * a conservation bug.
     */
    depositRemainingCt: integer('deposit_remaining_ct'),
    /**
     * B2: the CLV hold threshold STAMPED at claim time from
     * `LAND_HOLD_THRESHOLDS_CLV` — in CLV **uiAmount** (human token count),
     * despite the `_ct` suffix the land columns share. The sweeper re-checks
     * SUM(hold_threshold_ct) across the owner's non-grandfathered hold parcels
     * against the subject's live CLV balance. NULL on non-hold rows.
     */
    holdThresholdCt: integer('hold_threshold_ct'),
    /** B2: which subject's CLV backs this hold (see `landHoldSubjectEnum`). */
    holdSubject: landHoldSubjectEnum('hold_subject'),
    /**
     * TRUE on a legacy buy-outright parcel migrated to 'hold' by
     * migrate-land-tenure-phaseB.ts: it pays weekly upkeep but is NEVER
     * CLV-checked (it predates the hold requirement) and is EXCLUDED from the
     * stacked-threshold sums. Always false on fresh Phase-B claims.
     */
    grandfathered: boolean('grandfathered').notNull().default(false),

    // ── RESERVED-INERT: Founder on-chain NFT linkage (custody-gated, no v1 write) ──
    /** base58 Solana mint address — populated only when a Founder parcel is minted. */
    nftMintAddress: varchar('nft_mint_address', { length: 64 }),
    /** base58 pubkey of the avatar custodial wallet holding the NFT. */
    nftOwnerPubkey: varchar('nft_owner_pubkey', { length: 64 }),
    nftMintedAt: timestamp('nft_minted_at', { withTimezone: true }),

    // ── RESERVED: recurring-sink hooks (DEFERRED economy-health pass, no v1 write) ──
    /** property-tax cadence anchor; a future `land-tax-sweeper` cron debits the owner. */
    lastTaxPaidAt: timestamp('last_tax_paid_at', { withTimezone: true }),
    /** upkeep cadence anchor; unpaid upkeep decays a perk level (future). */
    upkeepDueAt: timestamp('upkeep_due_at', { withTimezone: true }),
    /** house rake on parcel-level activity in bps; 0 = no rake (v1). */
    rakeBps: integer('rake_bps').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    /** Primary-sale browse: filter by tier + status. */
    tierStatusIdx: index('land_parcels_tier_status_idx').on(t.tier, t.status),
    /** GET /owned + "all my parcels" + ownership-cap COUNT. */
    ownerIdx: index('land_parcels_owner_idx').on(t.ownerAvatarId),
    /** One parcel per world cell — supply integrity (ROADMAP R11). */
    gridUnique: uniqueIndex('land_parcels_grid_unique').on(t.gridX, t.gridY),
    /**
     * Tenure sweeper hot path (Phase B, 2026-07-07 — supersedes
     * `land_parcels_rent_sweep_idx`): rented + deposit + hold parcels are the
     * only ones ever due. Partial index on the due-date keeps the periodic
     * charge/grace/evict scan off the full table. Migration 0013 drops the old
     * rented-only index and creates this one.
     */
    tenureSweepIdx: index('land_parcels_tenure_sweep_idx')
      .on(t.rentPaidThrough)
      .where(sql`tenure IN ('rented', 'deposit', 'hold')`),
    /**
     * DB backstop for the escrow-conservation invariant — a draw/refund bug can
     * never book more OUT of the escrow than was paid IN (see the
     * `depositRemainingCt` column doc).
     */
    depositRemainingNonNeg: check(
      'land_parcels_deposit_remaining_nonneg',
      sql`${t.depositRemainingCt} IS NULL OR ${t.depositRemainingCt} >= 0`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// land_structures — placed home/shop (one per parcel in v1)
// ─────────────────────────────────────────────────────────────────────────────

export const landStructures = pgTable(
  'land_structures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One structure per parcel in v1 → UNIQUE. */
    parcelId: uuid('parcel_id')
      .notNull()
      .unique()
      .references(() => landParcels.id, { onDelete: 'cascade' }),
    /**
     * Denormalized owner — kept in sync with `land_parcels.owner_avatar_id`
     * inside the txn that mutates either. Cheap "all my structures" +
     * leaderboard queries without a join.
     */
    ownerAvatarId: uuid('owner_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    structureType: landStructureTypeEnum('structure_type').notNull(),
    /**
     * Catalog key into `STRUCTURE_CATALOG` (`@clawville/shared`
     * `land-economy.ts`). Binds to a GLB in Phase 2; the backend validates the
     * key against the allowlist for the structure type. Catalog placement only
     * — NOT a free-form mesh (DESIGN decision #8).
     */
    catalogKey: varchar('catalog_key', { length: 64 }).notNull(),
    /**
     * Player-selected render shell. Nullable during the rolling P1 deploy;
     * every read must explicitly fall back to `coastal-cottage` until the
     * deferred NOT NULL hardening migration has shipped.
     */
    shellKey: text('shell_key'),
    /**
     * Player-selected vertex-colour preset. Nullable during the rolling P1
     * deploy; reads explicitly fall back to `classic`.
     */
    paletteKey: text('palette_key'),
    /** Upgrade level 1..5 (Lv1 → Lv5). Drives perk magnitude + prestige + visual tier. */
    level: integer('level').notNull().default(1),
    /**
     * Lifecycle (builder-economics, 2026-06-24). `active` = live + rendered.
     * `archived` = soft-deleted by an eviction; restored on same-avatar re-acquire,
     * purged on re-lease to a different avatar. Excluded from owned/structure reads.
     */
    status: landStructureStatusEnum('status').notNull().default('active'),
    /**
     * RESERVED (no-op v1): decay level for the deferred upkeep/tax pass. 0 =
     * pristine. Future unpaid upkeep dims the render without re-architecture.
     */
    decayLevel: integer('decay_level').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index('land_structures_owner_idx').on(t.ownerAvatarId),
    typeIdx: index('land_structures_type_idx').on(t.structureType),
    /** Level is a server-clamped 1..5 — DB guard against a corrupt write. */
    levelRange: check('land_structure_level_range', sql`${t.level} BETWEEN 1 AND 5`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// land_structure_pieces — decorative snap-grid kit pieces (P3 stage A)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render-agnostic decorative kit placements (P3 stage A). `piece_key` is
 * validated against the shared catalog by the API; stage B alone maps it to
 * authored assets. There is intentionally no collider/pathfinding state.
 */
export const landStructurePieces = pgTable(
  'land_structure_pieces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parcelId: uuid('parcel_id')
      .notNull()
      .references(() => landParcels.id, { onDelete: 'cascade' }),
    /** Denormalized for audit/read convenience; parcel ownership stays authoritative. */
    ownerAvatarId: uuid('owner_avatar_id')
      .notNull()
      .references(() => avatars.id),
    pieceKey: text('piece_key').notNull(),
    gridX: integer('grid_x').notNull(),
    gridY: integer('grid_y').notNull(),
    /** Integer 0..7, each unit representing 45 degrees. */
    rotationStep: integer('rotation_step').notNull(),
    /** One-based vertical tier; the structure level further limits the usable maximum. */
    stackLevel: integer('stack_level').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    parcelIdx: index('land_structure_pieces_parcel_idx').on(t.parcelId),
    cellStackUnique: uniqueIndex('land_structure_pieces_cell_stack_unique').on(
      t.parcelId,
      t.gridX,
      t.gridY,
      t.stackLevel,
    ),
    gridXRange: check('land_structure_pieces_grid_x_range', sql`${t.gridX} BETWEEN 0 AND 15`),
    gridYRange: check('land_structure_pieces_grid_y_range', sql`${t.gridY} BETWEEN 0 AND 15`),
    rotationRange: check(
      'land_structure_pieces_rotation_step_range',
      sql`${t.rotationStep} BETWEEN 0 AND 7`,
    ),
    stackRange: check(
      'land_structure_pieces_stack_level_range',
      sql`${t.stackLevel} BETWEEN 1 AND 3`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// land_upgrades — append-only audit of each Lv→Lv upgrade
// ─────────────────────────────────────────────────────────────────────────────

export const landUpgrades = pgTable(
  'land_upgrades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    structureId: uuid('structure_id')
      .notNull()
      .references(() => landStructures.id, { onDelete: 'cascade' }),
    fromLevel: integer('from_level').notNull(),
    toLevel: integer('to_level').notNull(),
    costCt: integer('cost_ct').notNull(),
    byAvatarId: uuid('by_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** Cross-ref to the canonical CT ledger debit row (audit). */
    ledgerTxId: uuid('ledger_tx_id'),
    /**
     * Idempotency — client-supplied; the partial-unique index prevents a retry
     * from double-charging an upgrade. Null keys (system) don't collide.
     */
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    structureIdx: index('land_upgrades_structure_idx').on(t.structureId, t.createdAt),
    idemUnique: uniqueIndex('land_upgrades_idem_unique')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// land_transactions — land-domain audit spine (parcel/structure moves)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parallel to the canonical `claw_token_transactions` (still the source of
 * truth for balances via the ledger). This table captures the LAND-domain
 * shape (which parcel/structure, buyer→seller, kind) so we don't reverse-
 * engineer it from ledger reasons.
 *
 * NO idempotency key BY DESIGN. Parcel-buy single-charge safety is the
 * `land_parcels.status='owned'` ownership flip under `SELECT … FOR UPDATE` —
 * a replayed buy sees `owned` and 409s (one parcel, one owner = the natural
 * idempotency key). `claim-starter` idempotency is the "avatar already owns a
 * starter" check. Replayable money paths that AREN'T self-idempotent carry
 * their own key: `land_upgrades`, `service_purchases`, `ct_topups`. So the
 * Phase-1 buy route must NOT look for a `land_transactions` idempotency key.
 */
export const landTransactions = pgTable(
  'land_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: landTransactionKindEnum('kind').notNull(),
    parcelId: uuid('parcel_id').references(() => landParcels.id, { onDelete: 'set null' }),
    structureId: uuid('structure_id').references(() => landStructures.id, {
      onDelete: 'set null',
    }),
    /** Payer/debited (primary-sale buyer, upgrader). */
    avatarId: uuid('avatar_id').references(() => avatars.id, { onDelete: 'set null' }),
    amountCt: integer('amount_ct').notNull(),
    /** Cross-ref to the canonical ledger debit row (source of truth for balance). */
    debitLedgerTxId: uuid('debit_ledger_tx_id'),
    /**
     * RESERVED (§6.C8 burn-sink): v1 primary sale debits the buyer and CT
     * leaves circulation — there is NO treasury-avatar credit. This column is
     * for a FUTURE treasury-credit model only; no v1 route writes it.
     */
    creditLedgerTxId: uuid('credit_ledger_tx_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    parcelIdx: index('land_tx_parcel_idx').on(t.parcelId, t.createdAt),
    avatarIdx: index('land_tx_avatar_idx').on(t.avatarId, t.createdAt),
    kindIdx: index('land_tx_kind_idx').on(t.kind, t.createdAt),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// service_listings — owner shop services (payments naming, §6.C1)
// ─────────────────────────────────────────────────────────────────────────────

export const serviceListings = pgTable(
  'service_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The shop structure this service runs from (must be a `shop` the lister owns). */
    structureId: uuid('structure_id')
      .notNull()
      .references(() => landStructures.id, { onDelete: 'cascade' }),
    /**
     * Seller is an AVATAR (human OR agent — both resolve to one avatar).
     * Denormalized for the hot buy-path owner lookup; the list route asserts it
     * equals the parcel owner at write time.
     */
    ownerAvatarId: uuid('owner_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    /** 'peer' = CT (v1) | 'partner' = USDC via x402 (Phase 5, gated). */
    kind: serviceListingKindEnum('kind').notNull().default('peer'),
    title: varchar('title', { length: 120 }).notNull(),
    description: text('description'),
    /** Price in CT (peer tier). Server-authoritative; the buy route reads this, never the body. */
    priceCt: integer('price_ct').notNull(),
    status: serviceListingStatusEnum('status').notNull().default('active'),
    /**
     * RESERVED (=0 in v1): house platform fee in bps. v1 is a FULL transfer to
     * seller (no rake — DESIGN decision #9). Flipping >0 routes a cut to the
     * treasury sink — a one-line route change, not a migration.
     */
    platformFeeBps: integer('platform_fee_bps').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    structureIdx: index('service_listings_structure_idx').on(t.structureId),
    ownerIdx: index('service_listings_owner_idx').on(t.ownerAvatarId),
    statusIdx: index('service_listings_status_idx').on(t.status),
    /** CT price must be non-negative — DB guard against a corrupt write. */
    priceNonNeg: check('service_listings_price_non_negative', sql`${t.priceCt} >= 0`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// service_purchases — per-purchase row (one per settled service buy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Designed so settlement = `transferClawTokens(buyer → seller)` full, no rake
 * (v1). Idempotency-keyed so a retry replays the cached purchase instead of
 * double-charging. The `land.service.sold` leaderboard credit (SELLER, weight
 * 40) is emitted from the buy route after this row commits.
 */
export const servicePurchases = pgTable(
  'service_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => serviceListings.id, { onDelete: 'cascade' }),
    /** Buyer is a ledger subject (human OR agent → one avatar). NEVER a guest. */
    buyerAvatarId: uuid('buyer_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    sellerAvatarId: uuid('seller_avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    priceCt: integer('price_ct').notNull(),
    /** Cross-ref to the land-domain audit row for this sale. */
    landTransactionId: uuid('land_transaction_id').references(() => landTransactions.id, {
      onDelete: 'set null',
    }),
    /**
     * Idempotency — UNIQUE (partial). A retried buy with the same key trips the
     * index and the route serves the cached result (no double transfer).
     */
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    listingIdx: index('service_purchases_listing_idx').on(t.listingId, t.createdAt),
    buyerIdx: index('service_purchases_buyer_idx').on(t.buyerAvatarId, t.createdAt),
    sellerIdx: index('service_purchases_seller_idx').on(t.sellerAvatarId, t.createdAt),
    idemUnique: uniqueIndex('service_purchases_idem_unique')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// partner_storefronts — vetted-partner tier (INERT in v1, payments shape §6.C1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vetted companies (Hatcher + future brands) selling REAL services on prime
 * land for USDC. RESERVED so the Phase 5 partner path is a row insert, not a
 * migration. `fulfillment_enabled` flips true ONLY via an admin route after a
 * custody/KYC/age safety review — never via the partner key. No v1 route writes
 * this table.
 */
export const partnerStorefronts = pgTable(
  'partner_storefronts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Matches the `PARTNER_PUBKEYS` key (e.g. 'hatcher'). */
    partnerId: varchar('partner_id', { length: 64 }).notNull(),
    slug: varchar('slug', { length: 64 }).notNull().unique(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    /** The prime parcel this storefront occupies (A-tier / town-square adjacent). */
    parcelId: uuid('parcel_id').references(() => landParcels.id, { onDelete: 'set null' }),
    /** USDC payout destination — partner's own Solana pubkey (base58, validated at write). */
    payoutPubkey: varchar('payout_pubkey', { length: 64 }).notNull(),
    status: partnerStorefrontStatusEnum('status').notNull().default('pending'),
    /** RESERVED (=0 v1): platform fee in bps. Plumbing reserved, value 0. */
    platformFeeBps: integer('platform_fee_bps').notNull().default(0),
    /** Safety gate — false until a custody/KYC/age review clears (admin-only flip). */
    fulfillmentEnabled: boolean('fulfillment_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    partnerIdx: index('partner_storefronts_partner_idx').on(t.partnerId),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// ct_topups — the SINGLE buy-CT surface (§6.C2; converges shop-q3 multi-rail)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row per top-up. PayAI USDC/SOL via x402 is the first rail (Phase 4);
 * Stripe fiat + CLV+25% are follow-on rails on the SAME table (deferred). The
 * credited avatar = `subject.avatarId` (human cookie OR agent session → its
 * bound avatar) — an agent tops up its OWN CT through the same route.
 *
 * The `tx_signature` UNIQUE index is the SINGLE highest-risk invariant of the
 * on-ramp (ROADMAP R2): a settled payment can credit CT EXACTLY ONCE. PayAI's
 * lib provides no idempotency — WE enforce it: INSERT here + `creditClawTokens`
 * in one transaction; a duplicate settle (same sig) trips this index → serve
 * the cached credit, never double-credit.
 */
export const ctTopups = pgTable(
  'ct_topups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    avatarId: uuid('avatar_id')
      .notNull()
      .references(() => avatars.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Only 'x402' is wired in Phase 4; 'stripe'/'clv' reserved. */
    rail: ctTopupRailEnum('rail').notNull(),
    amountCt: integer('amount_ct').notNull(),
    /**
     * Settled Solana tx signature from the facilitator. UNIQUE — the double-
     * credit guard (ROADMAP §2-R2). Nullable while status='pending' (quote
     * issued, not yet settled); set on settle. The unique index ignores NULLs
     * so many pending quotes don't collide.
     */
    txSignature: text('tx_signature'),
    /** USD basis logged at receipt for accounting (numeric, nullable until settle). */
    usdBasisAtReceipt: numeric('usd_basis_at_receipt'),
    status: ctTopupStatusEnum('status').notNull().default('pending'),
    /**
     * The CLAIM token of the process that flipped this row pending→settling
     * (a fresh uuid per claim). Only the holder may CAPTURE/release it; a stale
     * claim is reconciled, never stolen. NULL unless status='settling'.
     * (Durable settle machine — Codex money-path review.)
     */
    settlingId: uuid('settling_id'),
    /** When the current settling claim started — drives stale-claim detection. */
    settlingStartedAt: timestamp('settling_started_at', { withTimezone: true }),
    /** Client-supplied idempotency on the settle call (per-avatar). */
    idempotencyKey: varchar('idempotency_key', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    avatarIdx: index('ct_topups_avatar_idx').on(t.avatarId, t.createdAt),
    /** Double-credit guard — a settled tx sig credits CT exactly once. Partial: ignores pending NULLs. */
    txSigUnique: uniqueIndex('ct_topups_txsig_unique')
      .on(t.txSignature)
      .where(sql`tx_signature IS NOT NULL`),
    /** Per-avatar settle idempotency. */
    idemUnique: uniqueIndex('ct_topups_idem_unique')
      .on(t.avatarId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    /**
     * A `settled` row ALWAYS carries the tx signature (Codex money-path review):
     * the money proof can never be absent on a credited top-up, so a settled row
     * can never be replayed as a credit without a signature.
     */
    settledHasSignature: check(
      'ct_topups_settled_has_signature',
      sql`${t.status} <> 'settled' OR ${t.txSignature} IS NOT NULL`,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types
// ─────────────────────────────────────────────────────────────────────────────

export type LandParcel = typeof landParcels.$inferSelect;
export type NewLandParcel = typeof landParcels.$inferInsert;
export type LandStructure = typeof landStructures.$inferSelect;
export type NewLandStructure = typeof landStructures.$inferInsert;
export type LandUpgrade = typeof landUpgrades.$inferSelect;
export type NewLandUpgrade = typeof landUpgrades.$inferInsert;
export type LandTransaction = typeof landTransactions.$inferSelect;
export type NewLandTransaction = typeof landTransactions.$inferInsert;
export type ServiceListing = typeof serviceListings.$inferSelect;
export type NewServiceListing = typeof serviceListings.$inferInsert;
export type ServicePurchase = typeof servicePurchases.$inferSelect;
export type NewServicePurchase = typeof servicePurchases.$inferInsert;
export type PartnerStorefront = typeof partnerStorefronts.$inferSelect;
export type NewPartnerStorefront = typeof partnerStorefronts.$inferInsert;
export type CtTopup = typeof ctTopups.$inferSelect;
export type NewCtTopup = typeof ctTopups.$inferInsert;
