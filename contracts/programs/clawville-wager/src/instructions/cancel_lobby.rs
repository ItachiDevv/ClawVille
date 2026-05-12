use anchor_lang::prelude::*;

use crate::errors::WagerError;
use crate::events::LobbyCancelled;
use crate::state::{Config, Lobby, LobbyState};

#[derive(Accounts)]
pub struct CancelLobby<'info> {
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

    pub signer: Signer<'info>,
}

pub fn handler(ctx: Context<CancelLobby>) -> Result<()> {
    // Note: pause check intentionally omitted — operators must be able to
    // drain in-flight lobbies during pause. Mirrors lock_lobby's stance.
    let lobby = &mut ctx.accounts.lobby;
    let signer_key = ctx.accounts.signer.key();
    let is_creator = signer_key == lobby.creator;
    let is_authority = signer_key == ctx.accounts.config.settlement_authority;

    let current = lobby.state;
    let allowed = if is_authority {
        current == LobbyState::Open as u8 || current == LobbyState::Locked as u8
    } else if is_creator {
        current == LobbyState::Open as u8
    } else {
        return err!(WagerError::Unauthorized);
    };
    require!(allowed, WagerError::InvalidLobbyState);

    lobby.state = LobbyState::Cancelled as u8;
    lobby.cancelled_at = Clock::get()?.unix_timestamp;

    emit!(LobbyCancelled {
        lobby_id: lobby.lobby_id,
        by: signer_key,
    });

    Ok(())
}
