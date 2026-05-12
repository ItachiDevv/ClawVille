use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::WagerError;
use crate::events::LobbyJoined;
use crate::state::{Config, Lobby, LobbyState, Player};

/// Join an SPL lobby. Must NOT be called for SOL or free lobbies.
#[derive(Accounts)]
pub struct JoinLobbySpl<'info> {
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

    pub wager_mint_account: Account<'info, Mint>,

    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = wager_mint_account,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<JoinLobbySpl>) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, WagerError::Paused);

    let lobby = &mut ctx.accounts.lobby;
    require!(!lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Open as u8,
        WagerError::InvalidLobbyState
    );
    require!(
        lobby.joined_count < lobby.max_players,
        WagerError::LobbyFull
    );

    require_keys_eq!(
        ctx.accounts.wager_mint_account.key(),
        lobby.wager_mint,
        WagerError::WagerMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.player_token_account.mint,
        lobby.wager_mint,
        WagerError::WagerMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.vault_token_account.mint,
        lobby.wager_mint,
        WagerError::WagerMintMismatch
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

    // Note: SPL lobby invariant guarantees wager_amount > 0 (set at create time).
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SplTransfer {
            from: ctx.accounts.player_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.player_signer.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, wager_amount)?;

    emit!(LobbyJoined {
        lobby_id: lobby.lobby_id,
        player: ctx.accounts.player_signer.key(),
        joined_count: new_count,
    });

    Ok(())
}
