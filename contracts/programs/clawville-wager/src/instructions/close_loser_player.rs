use anchor_lang::prelude::*;

use crate::errors::WagerError;
use crate::events::LoserPlayerClosed;
use crate::state::{Lobby, LobbyState, Player};

/// After a lobby is settled, losing players' Player PDAs persist on-chain
/// holding ~0.002 SOL of rent each. This instruction lets each loser reclaim
/// their rent by closing their own Player PDA. Works for both SOL and SPL
/// lobbies — no token interaction.
#[derive(Accounts)]
pub struct CloseLoserPlayer<'info> {
    #[account(
        seeds = [b"lobby", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
    )]
    pub lobby: Account<'info, Lobby>,

    #[account(
        mut,
        close = player_signer,
        seeds = [b"player", lobby.lobby_id.to_le_bytes().as_ref(), player_signer.key().as_ref()],
        bump = player.bump,
        constraint = player.lobby_id == lobby.lobby_id @ WagerError::AccountMismatch,
        constraint = player.player == player_signer.key() @ WagerError::AccountMismatch,
        // Sanity: refunded players already had their PDA closed via claim_refund.
        constraint = !player.refunded @ WagerError::AlreadyRefunded,
    )]
    pub player: Account<'info, Player>,

    #[account(mut)]
    pub player_signer: Signer<'info>,
}

pub fn handler(ctx: Context<CloseLoserPlayer>) -> Result<()> {
    let lobby = &ctx.accounts.lobby;
    require!(
        lobby.state == LobbyState::Settled as u8,
        WagerError::InvalidLobbyState
    );
    // Winner cannot reclaim via this path — their Player PDA stays as proof
    // they collected (and they already received the payout).
    require!(
        ctx.accounts.player_signer.key() != lobby.winner,
        WagerError::WinnerCannotCloseAsLoser
    );

    emit!(LoserPlayerClosed {
        lobby_id: lobby.lobby_id,
        player: ctx.accounts.player_signer.key(),
    });

    // Anchor's `close = player_signer` constraint handles lamport drain + zero.
    Ok(())
}
