use anchor_lang::prelude::*;

use crate::errors::WagerError;
use crate::events::LobbyLocked;
use crate::state::{Config, Lobby, LobbyState};

#[derive(Accounts)]
pub struct LockLobby<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"lobby", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
    )]
    pub lobby: Account<'info, Lobby>,

    pub settlement_authority: Signer<'info>,
}

pub fn handler(ctx: Context<LockLobby>) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(
        ctx.accounts.settlement_authority.key(),
        config.settlement_authority,
        WagerError::Unauthorized
    );

    // Intentionally does NOT check config.paused — admins must be able to lock and settle
    // in-flight lobbies during a pause to drain pending games before any maintenance.
    let lobby = &mut ctx.accounts.lobby;
    require!(
        lobby.state == LobbyState::Open as u8,
        WagerError::InvalidLobbyState
    );
    require!(
        lobby.joined_count >= Lobby::MIN_PLAYERS,
        WagerError::NotEnoughPlayers
    );

    lobby.state = LobbyState::Locked as u8;
    lobby.locked_at = Clock::get()?.unix_timestamp;

    emit!(LobbyLocked {
        lobby_id: lobby.lobby_id,
        joined_count: lobby.joined_count,
    });

    Ok(())
}
