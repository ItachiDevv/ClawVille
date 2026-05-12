use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};

use crate::errors::WagerError;
use crate::events::LobbyJoined;
use crate::state::{Config, Lobby, LobbyState, Player};

/// Join a SOL or free lobby. Must NOT be called for SPL lobbies.
#[derive(Accounts)]
pub struct JoinLobbySol<'info> {
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

    #[account(
        mut,
        seeds = [b"vault", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// init (NOT init_if_needed) so a second join attempt by the same player
    /// fails with account-already-exists, preventing silent double-join.
    #[account(
        init,
        payer = player_signer,
        space = 8 + Player::INIT_SPACE,
        seeds = [b"player", lobby.lobby_id.to_le_bytes().as_ref(), player_signer.key().as_ref()],
        bump,
    )]
    pub player: Account<'info, Player>,

    #[account(mut)]
    pub player_signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<JoinLobbySol>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, WagerError::Paused);

    let lobby = &mut ctx.accounts.lobby;
    require!(lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Open as u8,
        WagerError::InvalidLobbyState
    );
    require!(
        lobby.joined_count < lobby.max_players,
        WagerError::LobbyFull
    );

    let wager_amount = lobby.wager_amount;

    // Effects-first: write player + bump count BEFORE CPIs.
    let new_count = lobby
        .joined_count
        .checked_add(1)
        .ok_or(WagerError::MathOverflow)?;
    lobby.joined_count = new_count;

    let player = &mut ctx.accounts.player;
    player.lobby_id = lobby.lobby_id;
    player.player = ctx.accounts.player_signer.key();
    player.deposit_amount = wager_amount;
    player.refunded = false;
    player.bump = ctx.bumps.player;

    if wager_amount > 0 {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.player_signer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        sol_transfer(cpi_ctx, wager_amount)?;
    }

    emit!(LobbyJoined {
        lobby_id: lobby.lobby_id,
        player: ctx.accounts.player_signer.key(),
        joined_count: new_count,
    });

    Ok(())
}
