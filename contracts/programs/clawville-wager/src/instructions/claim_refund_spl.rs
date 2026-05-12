use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::WagerError;
use crate::events::LobbyRefunded;
use crate::state::{Lobby, LobbyState, Player};

/// Claim refund for an SPL lobby. Must NOT be called for SOL or free lobbies.
#[derive(Accounts)]
pub struct ClaimRefundSpl<'info> {
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
        mut,
        close = player_signer,
        seeds = [b"player", lobby.lobby_id.to_le_bytes().as_ref(), player_signer.key().as_ref()],
        bump = player.bump,
        constraint = player.lobby_id == lobby.lobby_id @ WagerError::AccountMismatch,
        constraint = !player.refunded @ WagerError::AlreadyRefunded,
    )]
    pub player: Account<'info, Player>,

    #[account(mut)]
    pub player_signer: Signer<'info>,

    /// CHECK: Must equal lobby.creator. Receives vault rent residual + vault
    /// ATA rent on the last refund.
    #[account(
        mut,
        constraint = creator.key() == lobby.creator @ WagerError::AccountMismatch,
    )]
    pub creator: UncheckedAccount<'info>,

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

pub fn handler(ctx: Context<ClaimRefundSpl>) -> Result<()> {
    let lobby = &mut ctx.accounts.lobby;
    require!(!lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Cancelled as u8,
        WagerError::InvalidLobbyState
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

    // Source of truth: the player's recorded deposit, not lobby.wager_amount.
    // See claim_refund_sol for rationale.
    let refund_amount = ctx.accounts.player.deposit_amount;
    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;
    let player_pubkey = ctx.accounts.player_signer.key();

    // Effects-first: mark refunded + decrement count BEFORE CPIs.
    ctx.accounts.player.refunded = true;
    let new_count = lobby
        .joined_count
        .checked_sub(1)
        .ok_or(WagerError::MathOverflow)?;
    lobby.joined_count = new_count;
    let is_last = new_count == 0;

    let lobby_id_bytes = lobby_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
    let signer_seeds_arr = [signer_seeds];

    // SPL invariant: deposit_amount > 0 because join_lobby_spl gates on it.
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        SplTransfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.player_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        &signer_seeds_arr,
    );
    token::transfer(cpi_ctx, refund_amount)?;

    if is_last {
        // Last refund: close the SPL vault ATA (returns rent to creator).
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_token_account.to_account_info(),
                destination: ctx.accounts.creator.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &signer_seeds_arr,
        );
        token::close_account(close_ctx)?;

        // Drain remaining SOL vault lamports → creator.
        let residual = ctx.accounts.vault.to_account_info().lamports();
        if residual > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.creator.to_account_info(),
                },
                &signer_seeds_arr,
            );
            sol_transfer(cpi_ctx, residual)?;
        }
    }

    emit!(LobbyRefunded {
        lobby_id,
        player: player_pubkey,
        amount: refund_amount,
    });

    Ok(())
}
