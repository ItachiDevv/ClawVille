use anchor_lang::prelude::*;

#[event]
pub struct LobbyCreated {
    pub lobby_id: u64,
    pub creator: Pubkey,
    pub wager_amount: u64,
    pub wager_mint: Pubkey,
    pub max_players: u8,
    pub treasury_snapshot: Pubkey,
    pub rake_bps_snapshot: u16,
}

#[event]
pub struct LobbyJoined {
    pub lobby_id: u64,
    pub player: Pubkey,
    pub joined_count: u8,
}

#[event]
pub struct LobbyLocked {
    pub lobby_id: u64,
    pub joined_count: u8,
}

#[event]
pub struct LobbyCancelled {
    pub lobby_id: u64,
    pub by: Pubkey,
}

#[event]
pub struct LobbyRefunded {
    pub lobby_id: u64,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LobbySettled {
    pub lobby_id: u64,
    pub winner: Pubkey,
    pub payout: u64,
    pub rake: u64,
    pub treasury: Pubkey,
}

#[event]
pub struct LoserPlayerClosed {
    pub lobby_id: u64,
    pub player: Pubkey,
}

#[event]
pub struct LobbyCleanedUp {
    pub lobby_id: u64,
    pub creator: Pubkey,
    pub treasury: Pubkey,
    /// Lamports returned to creator (rent recovery only).
    pub creator_lamports: u64,
    /// Unclaimed SOL deposits routed to treasury (SOL variant only; 0 for SPL).
    pub treasury_lamports: u64,
    /// Unclaimed token deposits routed to treasury (SPL variant only; 0 for SOL).
    pub treasury_tokens: u64,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub gambling_treasury: Pubkey,
    pub rake_bps: u16,
    pub paused: bool,
}

#[event]
pub struct AdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}
