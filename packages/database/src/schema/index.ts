import { relations } from 'drizzle-orm';

export * from './users';
export * from './avatars';
export * from './locations';
export * from './location-agents';
export * from './agents';
export * from './inventory';
export * from './claws';
export * from './memories';
export * from './research';
export * from './token-launch';
export * from './treasury';
// Tokenomics T0 (2026-07-07) — CLV price-oracle snapshot history (durable TWAP
// seed + admin read). READ-ONLY price feed; never a ClawToken balance table.
export * from './token-market';
export * from './quests';
export * from './agent-configs';
export * from './bounties';
export * from './building-skills';
// Partner #2 (Hatcher) Phase C — scoped, revocable read-token table for partner
// integrations. Hash-not-plaintext, show-once mint. See `partner-api-keys.ts`.
export * from './partner-api-keys';
export * from './wallets';
// Custodial wallet WITHDRAW (2026-07-08, DARK behind WALLET_WITHDRAW_ENABLED) —
// exactly-once on-chain withdrawal ledger (SOL/USDC/CLV out of the custodial
// avatar wallet). Migration 0021. NEVER a ClawToken table.
export * from './withdrawals';
export * from './agent-session-tickets';
// Email-driven auth (password reset + soft email verification). One row per
// issued token; raw token never stored — only sha256(token).
export * from './auth-tokens';
export * from './events';
export * from './event-write-failures';
export * from './pending-account-links';
// Q2 Activity Portals — schemas ship ahead of backend routes. Migration
// (db:push) is a founder-review step; files compile today so downstream
// packages can type-check against them.
export * from './activities';
export * from './activity-rooms';
export * from './activity-room-participants';
export * from './activity-results';
export * from './activity-queue-entries';
export * from './activity-parties';
export * from './activity-replays';
export * from './activity-seasons';
// Reef Race Phase 4 — per-avatar personal-best lap + ghost replay.
export * from './reef-race-personal-bests';
export * from './support-tickets';
// Q3 plan §2.6 — idempotency for client-side tutorial quest token credits.
export * from './tutorial-quest-claims';
// Q3 plan §4 — cosmetic engine (cosmetic_skus + cosmetic_variants + avatar_skins).
export * from './cosmetics';
export * from './cosmetic-bonus';
// Q3 plan §gamification dashboard — phase status (mutable via dashboard MCP).
export * from './dashboard-phases';
// 2026-05-18 — Exchange: peer items/services board (NEED/OFFER). Needs +
// one_shot/repeatable offers. Subscriptions deferred.
export * from './exchange';
// Wager lobbies + escrow — mirrors deployed `clawville_wager` Anchor program.
// On-chain is authoritative for money; these tables back FE discovery / FE
// polling / event timelines / leaderboard hooks. See `wager.ts` header.
export * from './wager';
// Phase 6.1 slice 3 — cove slot sessions + spin audit trail. ClawTokens
// fun-money tier today; SOL/USDC route paths return 501 until 6.2 custody.
export * from './cove';
// Phase 6.7.0 — unified cross-game history table for Cove casino. Parallel
// write to per-game tables (slot_spins etc.); one row per atomic gameplay
// unit. Verifier replay surface for slots / blackjack / Hold'em / baccarat.
export * from './cove-events';
// Phase 6.4.1 — cove blackjack shoes + hands. Two-table commit-reveal
// pattern mirroring cove (slot_sessions/slot_spins). One shoe = one
// commit-reveal seed pair (75% penetration reshuffle = new shoe row);
// one hand = one cove_game_events row. ClawTokens tier today; currency
// seam reserved for the SOL/USDC tier.
export * from './blackjack';
// Phase 6.5.1 — cove No-Limit Texas Hold'em tables + hands. Two-table
// commit-reveal pattern mirroring blackjack. Each hand shuffles a FRESH
// 52-card deck from the HMAC stream (nonce=handIndex), so there is no shared
// shoe / cursor drift. One hand = one cove_game_events row (gameType='holdem').
// ClawTokens tier today; currency seam reserved for the SOL/USDC tier.
export * from './holdem';
// Special Events (2026-06-16) — the GENERIC, REUSABLE PARENT table for any
// one-time event (special_events + special_event_signups). The poker tournament
// is a DEPENDENCY SUBTABLE that hangs off it: the FK points UP
// (poker_tournaments.special_event_id → special_events.id), so special_events
// stays reusable across future event types. MUST be exported BEFORE './poker'
// so poker.ts can import specialEvents. See `special-events.ts`. (The single
// `export * from './poker'` lives below, after baccarat.)
export * from './special-events';
// Phase 6.6.1 — cove Baccarat (Punto Banco) shoes + coups. Two-table
// commit-reveal pattern mirroring blackjack (8-deck shared no-replacement shoe;
// ~75% penetration reshuffle = new shoe row). Punto Banco has NO player
// decisions, so each coup is dealt + resolved atomically — one coup = one
// cove_game_events row (gameType='baccarat'). ClawTokens tier today; currency
// seam reserved for the SOL/USDC tier.
export * from './baccarat';
// Poker MTT (multi-table Texas Hold'em tournament) — poker_tournaments / _entrants
// / _tables / _blind_schedules / _hands / _tournament_results. Tournament chips are
// NOT CT (only buy-in debit + prize credit cross the ledger). Distinct from the
// vs-bots `holdem` tables above. Registered here so drizzle-kit sees the schema.
export * from './poker';
// Poker CASH (ring) games (P1, 2026-06-20) — poker_cash_tables / _seats / _hands /
// _ledger_events. SEPARATE product from the MTT tournament above: FIXED blinds,
// chips==CT 1:1, sit-down DEBIT / leave CASH-OUT CREDIT (the ledger crosses on every
// sit/leave, NOT just buy-in+prize). RAKE=0 in P1 (rake columns reserved). PURELY
// ADDITIVE — four net-new tables; the migration is idempotent CREATE … IF NOT EXISTS
// (apply by hand, NOT db:push). See `poker-cash.ts` header.
export * from './poker-cash';
// Land Economy Phase 0 (2026-06-15) — converged land/property + services +
// CT-on-ramp tables (land_parcels/structures/upgrades/transactions +
// service_listings/service_purchases + partner_storefronts + ct_topups).
// PURELY ADDITIVE — new tables only, db:push is a clean CREATE. Ownership binds
// to avatars.id (the human+agent parity seam). See `.claude/plans/land-economy/`.
export * from './land';
// SAP Option C — on-chain USDC escrow gate settlement ledger (2026-06-22).
// sap_escrow_settlements / sap_escrow_approvals: the backend at-most-once-settle
// + depositor-approval guard for the verify-before-release USDC rail. PURELY
// ADDITIVE — two net-new tables + one enum, db:push is a clean CREATE (apply by
// hand, NOT db:push). Gated OFF at route/service layer. See `sap-escrow.ts`.
export * from './sap-escrow';
// Tokenomics C3 (2026-07-07) — CLV buy-queue seam (clv_buy_queue +
// clv_buy_status). Records swap INTENT only; the executor is DRY-RUN gated
// (CLV_SWAP_EXECUTE=true refuses to boot). Migration 0014 (idempotent, by hand).
export * from './swap';
// Tokenomics C2 (2026-07-07) — MoonPay TEST-MODE card rail webhook idempotency
// ledger (moonpay_events; UNIQUE external_tx_id = the replay guard). Records
// USDC arrivals only — no CT movement, no custodial auto-sign (Codex-gated
// seam). Migration 0015 (idempotent, by hand).
export * from './moonpay';
// Tokenomics C — checkout stage (2026-07-07) — generic x402 checkout ledger
// (x402_checkouts + checkout_item_kind/checkout_status). Copies ct_topups'
// exactly-once shape (partial-UNIQUE tx_signature + (avatar_id, idem_key));
// price_vclaw is the QUOTE unit only — the buyer pays USDC underneath, no
// internal vCLAW debit. Migration 0016 (idempotent, by hand — NEVER db:push).
export * from './checkout';
// General custodial avatar-to-avatar USDC payments through PayAI. Durable
// claim/capture/fulfill machine; migration 0028 (additive + idempotent).
export * from './agent-payments';
// Tokenomics C — marketplace stage / C4 (2026-07-07) — P2P marketplace v1
// (market_listings + market_deed_locks + market_settlements). Settlement is
// FLAG-GATED OFF (MARKETPLACE_SETTLE_ENABLED); seller CLV payouts + the 4.44%
// rake + the deed transfer are QUEUED Codex-gated INTENTS, never live sends.
// LEDGER-ONLY: nothing here touches avatars.clawTokens. Migration 0017
// (idempotent, by hand — NEVER db:push).
export * from './market';

import { users, sessions } from './users';
import { npcMemories, activityLog } from './memories';
import { avatars } from './avatars';
import { agents, agentLogs } from './agents';
import { locationAgents } from './location-agents';
import { avatarInventory } from './inventory';
import { agentBots } from './claws';
import { vanityKeypairs, tokenLaunches } from './token-launch';
import { clawTokenTransactions } from './treasury';
import { quests, questSubmissions, questRewards } from './quests';
import { agentConfigs } from './agent-configs';
import { bounties, bountyRewards, bountyAttempts, bountyReputation } from './bounties';
import {
  landParcels,
  landStructures,
  landUpgrades,
  landTransactions,
  serviceListings,
  servicePurchases,
  partnerStorefronts,
  ctTopups,
} from './land';
import { sapEscrowSettlements, sapEscrowApprovals } from './sap-escrow';

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  avatars: many(avatars),
  agents: many(agents),
  locationAgents: many(locationAgents),
  agentConfigs: many(agentConfigs),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const avatarsRelations = relations(avatars, ({ one, many }) => ({
  user: one(users, {
    fields: [avatars.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [avatars.platformAgentId],
    references: [agents.id],
  }),
  inventory: many(avatarInventory),
  agentConfigs: many(agentConfigs),
}));

export const avatarInventoryRelations = relations(avatarInventory, ({ one }) => ({
  avatar: one(avatars, {
    fields: [avatarInventory.avatarId],
    references: [avatars.id],
  }),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  user: one(users, {
    fields: [agents.userId],
    references: [users.id],
  }),
  logs: many(agentLogs),
}));

export const agentLogsRelations = relations(agentLogs, ({ one }) => ({
  agent: one(agents, {
    fields: [agentLogs.agentId],
    references: [agents.id],
  }),
}));

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  avatar: one(avatars, {
    fields: [activityLog.avatarId],
    references: [avatars.id],
  }),
}));

export const locationAgentsRelations = relations(locationAgents, ({ one }) => ({
  user: one(users, {
    fields: [locationAgents.userId],
    references: [users.id],
  }),
  agent: one(agents, {
    fields: [locationAgents.platformAgentId],
    references: [agents.id],
  }),
}));

export const agentBotsRelations = relations(agentBots, ({ one }) => ({
  user: one(users, {
    fields: [agentBots.userId],
    references: [users.id],
  }),
}));

export const vanityKeypairsRelations = relations(vanityKeypairs, ({ one }) => ({
  reservedByUser: one(users, {
    fields: [vanityKeypairs.reservedBy],
    references: [users.id],
  }),
}));

export const tokenLaunchesRelations = relations(tokenLaunches, ({ one }) => ({
  user: one(users, {
    fields: [tokenLaunches.userId],
    references: [users.id],
  }),
  avatar: one(avatars, {
    fields: [tokenLaunches.avatarId],
    references: [avatars.id],
  }),
  vanityKeypair: one(vanityKeypairs, {
    fields: [tokenLaunches.vanityKeypairId],
    references: [vanityKeypairs.id],
  }),
}));

export const questsRelations = relations(quests, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [quests.createdBy],
    references: [users.id],
  }),
  submissions: many(questSubmissions),
  rewards: many(questRewards),
}));

export const questSubmissionsRelations = relations(questSubmissions, ({ one }) => ({
  quest: one(quests, {
    fields: [questSubmissions.questId],
    references: [quests.id],
  }),
  avatar: one(avatars, {
    fields: [questSubmissions.avatarId],
    references: [avatars.id],
  }),
  reviewedByUser: one(users, {
    fields: [questSubmissions.reviewedBy],
    references: [users.id],
  }),
}));

export const questRewardsRelations = relations(questRewards, ({ one }) => ({
  submission: one(questSubmissions, {
    fields: [questRewards.submissionId],
    references: [questSubmissions.id],
  }),
  avatar: one(avatars, {
    fields: [questRewards.avatarId],
    references: [avatars.id],
  }),
  quest: one(quests, {
    fields: [questRewards.questId],
    references: [quests.id],
  }),
}));

export const agentConfigsRelations = relations(agentConfigs, ({ one }) => ({
  user: one(users, { fields: [agentConfigs.userId], references: [users.id] }),
  avatar: one(avatars, { fields: [agentConfigs.avatarId], references: [avatars.id] }),
}));

export const bountiesRelations = relations(bounties, ({ one, many }) => ({
  creator: one(avatars, { fields: [bounties.creatorId], references: [avatars.id] }),
  rewards: many(bountyRewards),
  attempts: many(bountyAttempts),
}));

export const bountyRewardsRelations = relations(bountyRewards, ({ one }) => ({
  bounty: one(bounties, { fields: [bountyRewards.bountyId], references: [bounties.id] }),
  agentConfig: one(agentConfigs, { fields: [bountyRewards.agentConfigId], references: [agentConfigs.id] }),
}));

export const bountyAttemptsRelations = relations(bountyAttempts, ({ one }) => ({
  bounty: one(bounties, { fields: [bountyAttempts.bountyId], references: [bounties.id] }),
  hunter: one(avatars, { fields: [bountyAttempts.hunterId], references: [avatars.id] }),
}));

export const bountyReputationRelations = relations(bountyReputation, ({ one }) => ({
  avatar: one(avatars, { fields: [bountyReputation.avatarId], references: [avatars.id] }),
}));

export const clawTokenTransactionsRelations = relations(clawTokenTransactions, ({ one }) => ({
  avatar: one(avatars, { fields: [clawTokenTransactions.avatarId], references: [avatars.id] }),
}));

// ── Land Economy (Phase 0) ──────────────────────────────────────────────────

export const landParcelsRelations = relations(landParcels, ({ one, many }) => ({
  owner: one(avatars, {
    fields: [landParcels.ownerAvatarId],
    references: [avatars.id],
  }),
  structure: one(landStructures, {
    fields: [landParcels.id],
    references: [landStructures.parcelId],
  }),
  transactions: many(landTransactions),
}));

export const landStructuresRelations = relations(landStructures, ({ one, many }) => ({
  parcel: one(landParcels, {
    fields: [landStructures.parcelId],
    references: [landParcels.id],
  }),
  owner: one(avatars, {
    fields: [landStructures.ownerAvatarId],
    references: [avatars.id],
  }),
  upgrades: many(landUpgrades),
  serviceListings: many(serviceListings),
}));

export const landUpgradesRelations = relations(landUpgrades, ({ one }) => ({
  structure: one(landStructures, {
    fields: [landUpgrades.structureId],
    references: [landStructures.id],
  }),
  byAvatar: one(avatars, {
    fields: [landUpgrades.byAvatarId],
    references: [avatars.id],
  }),
}));

export const landTransactionsRelations = relations(landTransactions, ({ one }) => ({
  parcel: one(landParcels, {
    fields: [landTransactions.parcelId],
    references: [landParcels.id],
  }),
  structure: one(landStructures, {
    fields: [landTransactions.structureId],
    references: [landStructures.id],
  }),
  avatar: one(avatars, {
    fields: [landTransactions.avatarId],
    references: [avatars.id],
  }),
}));

export const serviceListingsRelations = relations(serviceListings, ({ one, many }) => ({
  structure: one(landStructures, {
    fields: [serviceListings.structureId],
    references: [landStructures.id],
  }),
  owner: one(avatars, {
    fields: [serviceListings.ownerAvatarId],
    references: [avatars.id],
  }),
  purchases: many(servicePurchases),
}));

export const servicePurchasesRelations = relations(servicePurchases, ({ one }) => ({
  listing: one(serviceListings, {
    fields: [servicePurchases.listingId],
    references: [serviceListings.id],
  }),
  buyer: one(avatars, {
    fields: [servicePurchases.buyerAvatarId],
    references: [avatars.id],
    relationName: 'servicePurchaseBuyer',
  }),
  seller: one(avatars, {
    fields: [servicePurchases.sellerAvatarId],
    references: [avatars.id],
    relationName: 'servicePurchaseSeller',
  }),
  landTransaction: one(landTransactions, {
    fields: [servicePurchases.landTransactionId],
    references: [landTransactions.id],
  }),
}));

export const partnerStorefrontsRelations = relations(partnerStorefronts, ({ one }) => ({
  parcel: one(landParcels, {
    fields: [partnerStorefronts.parcelId],
    references: [landParcels.id],
  }),
}));

export const ctTopupsRelations = relations(ctTopups, ({ one }) => ({
  avatar: one(avatars, {
    fields: [ctTopups.avatarId],
    references: [avatars.id],
  }),
}));

// ── SAP Option C escrow gate (settlement ledger) ─────────────────────────────

export const sapEscrowSettlementsRelations = relations(sapEscrowSettlements, ({ one }) => ({
  depositor: one(avatars, {
    fields: [sapEscrowSettlements.depositorAvatarId],
    references: [avatars.id],
    relationName: 'sapEscrowDepositor',
  }),
  worker: one(avatars, {
    fields: [sapEscrowSettlements.workerAvatarId],
    references: [avatars.id],
    relationName: 'sapEscrowWorker',
  }),
}));

export const sapEscrowApprovalsRelations = relations(sapEscrowApprovals, ({ one }) => ({
  approver: one(avatars, {
    fields: [sapEscrowApprovals.approverAvatarId],
    references: [avatars.id],
    relationName: 'sapEscrowApprovalApprover',
  }),
  worker: one(avatars, {
    fields: [sapEscrowApprovals.workerAvatarId],
    references: [avatars.id],
    relationName: 'sapEscrowApprovalWorker',
  }),
}));
