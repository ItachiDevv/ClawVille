//! ClawVille generic wager escrow + lobby program.
//!
//! Conventions:
//! - PDA seeds use `to_le_bytes()` for u64 (lobby_id) consistently across all
//!   instructions. Never `to_be_bytes` or `as_ref()` on the bare u64.
//! - All u64 arithmetic uses `checked_*` to avoid silent overflow.
//! - Effects-then-interactions: state mutations happen BEFORE any CPI in
//!   settle_lobby and claim_refund to defend against logic errors.
//! - SOL vs SPL is dispatched at the INSTRUCTION level — separate
//!   create_lobby_sol/spl, join_lobby_sol/spl, settle_lobby_sol/spl, and
//!   claim_refund_sol/spl variants. Anchor 0.31 cannot codegen the
//!   `Option<Account<TokenAccount>>` pattern (which would have allowed a single
//!   set of instructions to handle both variants), so each variant ships as a
//!   dedicated handler with its own account schema. `init_if_needed` itself is
//!   still used inside the SPL variants for the vault / winner / treasury ATAs.
//!   Free lobbies (wager_amount == 0) ALWAYS use the _sol variants — their
//!   `wager_mint` is `Pubkey::default()`.
//! - Each variant validates `lobby.is_sol()` against the variant being called
//!   and returns `WrongTokenVariant` on mismatch.
//! - Free lobbies still allocate a vault PDA for uniformity; the ~0.0009 SOL
//!   rent returns to the creator on settle/cancel. Trade-off chosen for code
//!   simplicity over micro-savings.
//! - `treasury_snapshot` and `rake_bps_snapshot` are captured into the Lobby
//!   at create-time. Settle uses the snapshots — admin `update_config` only
//!   affects NEW lobbies, not in-flight ones.
//! - Settlement authority is the game-server referee that declares winners
//!   after each match. By joining a lobby you are trusting the ClawVille
//!   operator to call match outcomes honestly — same trust model as a dealer
//!   at a poker night. The 10% rake cap only limits the treasury take;
//!   operator integrity gates the pot itself. A compromised (or colluding)
//!   settlement_authority that joins a lobby — directly or via a sock-puppet
//!   joiner — can drain ~90% of every pot by declaring its own key the
//!   winner. Use a multisig + cold-storage backup for the settlement key in
//!   production, and rotate via update_config on any suspicion of compromise.
//! - Anchor events are emitted at the END of every state-mutating handler so
//!   indexers can avoid scanning account state.

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use instructions::*;

declare_id!("HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG");

#[program]
pub mod clawville_wager {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        rake_bps: u16,
        settlement_authority: Pubkey,
        gambling_treasury: Pubkey,
    ) -> Result<()> {
        instructions::initialize_config::handler(
            ctx,
            rake_bps,
            settlement_authority,
            gambling_treasury,
        )
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_settlement_authority: Option<Pubkey>,
        new_treasury: Option<Pubkey>,
        new_rake_bps: Option<u16>,
        new_paused: Option<bool>,
    ) -> Result<()> {
        instructions::update_config::handler(
            ctx,
            new_settlement_authority,
            new_treasury,
            new_rake_bps,
            new_paused,
        )
    }

    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::transfer_admin::handler(ctx, new_admin)
    }

    /// Create a SOL-denominated or free lobby.
    pub fn create_lobby_sol(
        ctx: Context<CreateLobbySol>,
        lobby_id: u64,
        wager_amount: u64,
        max_players: u8,
    ) -> Result<()> {
        instructions::create_lobby_sol::handler(ctx, lobby_id, wager_amount, max_players)
    }

    /// Create an SPL-denominated lobby. Requires wager_amount > 0 and a real mint.
    pub fn create_lobby_spl(
        ctx: Context<CreateLobbySpl>,
        lobby_id: u64,
        wager_amount: u64,
        wager_mint: Pubkey,
        max_players: u8,
    ) -> Result<()> {
        instructions::create_lobby_spl::handler(
            ctx,
            lobby_id,
            wager_amount,
            wager_mint,
            max_players,
        )
    }

    pub fn join_lobby_sol(ctx: Context<JoinLobbySol>) -> Result<()> {
        instructions::join_lobby_sol::handler(ctx)
    }

    pub fn join_lobby_spl(ctx: Context<JoinLobbySpl>) -> Result<()> {
        instructions::join_lobby_spl::handler(ctx)
    }

    pub fn lock_lobby(ctx: Context<LockLobby>) -> Result<()> {
        instructions::lock_lobby::handler(ctx)
    }

    pub fn cancel_lobby(ctx: Context<CancelLobby>) -> Result<()> {
        instructions::cancel_lobby::handler(ctx)
    }

    pub fn claim_refund_sol(ctx: Context<ClaimRefundSol>) -> Result<()> {
        instructions::claim_refund_sol::handler(ctx)
    }

    pub fn claim_refund_spl(ctx: Context<ClaimRefundSpl>) -> Result<()> {
        instructions::claim_refund_spl::handler(ctx)
    }

    pub fn settle_lobby_sol(ctx: Context<SettleLobbySol>, winner: Pubkey) -> Result<()> {
        instructions::settle_lobby_sol::handler(ctx, winner)
    }

    pub fn settle_lobby_spl(ctx: Context<SettleLobbySpl>, winner: Pubkey) -> Result<()> {
        instructions::settle_lobby_spl::handler(ctx, winner)
    }

    /// Loser reclaims rent from their Player PDA after a lobby is settled.
    pub fn close_loser_player(ctx: Context<CloseLoserPlayer>) -> Result<()> {
        instructions::close_loser_player::handler(ctx)
    }

    /// Creator-only sweep of a Cancelled SOL lobby's vault residual after the
    /// grace period elapses (`Lobby::GRACE_SECONDS`).
    ///
    /// SPLIT RULE — DO NOT regress to "all-to-creator":
    /// The vault residual is split into two portions. The creator recovers
    /// ONLY the original `space=0` PDA rent they paid at create-time
    /// (~0.0009 SOL). Every additional lamport in the vault came from a
    /// player deposit that was never refund-claimed; those go to the
    /// `gambling_treasury` snapshotted at create-time, NOT the creator. This
    /// removes a rug-cancel incentive: without the split, a creator could
    /// open a high-wager lobby, attract deposits, cancel, wait 7 days, and
    /// pocket the entire pot via this instruction. With the split the
    /// creator only recovers their own rent — same economic position they'd
    /// be in if no players had joined at all.
    ///
    /// Abandoned Player PDAs are intentionally untouched — their rent stays
    /// with the players who never claimed a refund.
    pub fn cleanup_cancelled_lobby_sol(ctx: Context<CleanupCancelledLobbySol>) -> Result<()> {
        instructions::cleanup_cancelled_lobby::handler_sol(ctx)
    }

    /// Creator-only sweep of a Cancelled SPL lobby's vault token residual +
    /// vault ATA close + SOL vault rent, after the grace period elapses.
    ///
    /// SPLIT RULE — mirrors the SOL variant: all unclaimed wager TOKENS are
    /// routed to the treasury's ATA (not the creator). The creator only
    /// recovers (a) the SOL rent on the `space=0` vault PDA and (b) the SOL
    /// rent on the vault ATA via close. The token deposits themselves
    /// belong to the abandoned-deposit treasury bucket — same anti-rug
    /// rationale as the SOL variant.
    pub fn cleanup_cancelled_lobby_spl(ctx: Context<CleanupCancelledLobbySpl>) -> Result<()> {
        instructions::cleanup_cancelled_lobby::handler_spl(ctx)
    }
}
