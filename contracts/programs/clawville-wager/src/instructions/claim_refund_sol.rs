use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};

use crate::errors::WagerError;
use crate::events::LobbyRefunded;
use crate::state::{Lobby, LobbyState, Player};

/// Claim refund for a SOL or free lobby. Must NOT be called for SPL lobbies.
#[derive(Accounts)]
pub struct ClaimRefundSol<'info> {
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

    /// CHECK: Must equal lobby.creator. Receives vault rent residual on the
    /// last refund.
    #[account(
        mut,
        constraint = creator.key() == lobby.creator @ WagerError::AccountMismatch,
    )]
    pub creator: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimRefundSol>) -> Result<()> {
    let lobby = &mut ctx.accounts.lobby;
    require!(lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Cancelled as u8,
        WagerError::InvalidLobbyState
    );

    // Source of truth: the player's recorded deposit, not lobby.wager_amount.
    // Defends against any future code path that mutates wager_amount post-join
    // and ensures every refund returns exactly what was deposited.
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

    if refund_amount > 0 {
        let lobby_id_bytes = lobby_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
        let signer_seeds_arr = [signer_seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.player_signer.to_account_info(),
            },
            &signer_seeds_arr,
        );
        sol_transfer(cpi_ctx, refund_amount)?;
    }

    if is_last {
        // Drain remaining lamports (rent) from SOL vault → creator. Vault is
        // system-owned with space=0, so we use system_program::transfer signed
        // by the vault PDA. Source can drain to 0 because vault has no data.
        let residual = ctx.accounts.vault.to_account_info().lamports();
        if residual > 0 {
            let lobby_id_bytes = lobby_id.to_le_bytes();
            let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
            let signer_seeds_arr = [signer_seeds];
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
