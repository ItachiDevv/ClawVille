use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub gambling_treasury: Pubkey,
    pub rake_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const MAX_RAKE_BPS: u16 = 1000;
}

#[account]
#[derive(InitSpace)]
pub struct Lobby {
    pub lobby_id: u64,
    pub creator: Pubkey,
    pub wager_amount: u64,
    pub wager_mint: Pubkey, // Pubkey::default() = SOL
    pub max_players: u8,
    pub joined_count: u8,
    pub state: u8, // LobbyState
    pub winner: Pubkey,
    pub vault_bump: u8,
    pub bump: u8,
    pub created_at: i64,
    pub locked_at: i64,
    /// Treasury captured at create time. Settle uses THIS, not the live config,
    /// so admin cannot redirect rake on in-flight lobbies via update_config.
    pub treasury_snapshot: Pubkey,
    /// Rake captured at create time. Same rationale as treasury_snapshot —
    /// admin update_config affects only NEW lobbies.
    pub rake_bps_snapshot: u16,
    /// Unix timestamp of when this lobby transitioned to Cancelled. Zero on
    /// any non-cancelled lobby. Drives the grace-period gate in
    /// `cleanup_cancelled_lobby_*` so abandoned-refund residuals can be swept
    /// after `Lobby::GRACE_SECONDS` have elapsed.
    pub cancelled_at: i64,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LobbyState {
    Open = 0,
    Locked = 1,
    Settled = 2,
    Cancelled = 3,
}

impl Lobby {
    pub const MIN_PLAYERS: u8 = 2;
    pub const MAX_PLAYERS_LIMIT: u8 = 16;
    /// Time the creator must wait after a lobby is Cancelled before sweeping
    /// the vault residual via `cleanup_cancelled_lobby_*`. Gives joined
    /// players a generous window to claim refunds before residual moves.
    pub const GRACE_SECONDS: i64 = 7 * 24 * 60 * 60;

    pub fn is_sol(&self) -> bool {
        self.wager_mint == Pubkey::default()
    }

    pub fn is_free(&self) -> bool {
        self.wager_amount == 0
    }
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub lobby_id: u64,
    pub player: Pubkey,
    pub deposit_amount: u64,
    pub refunded: bool,
    pub bump: u8,
}
