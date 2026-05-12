use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};

use crate::errors::WagerError;
use crate::events::LobbySettled;
use crate::state::{Config, Lobby, LobbyState, Player};

/// Settle a SOL or free lobby. Must NOT be called for SPL lobbies.
#[derive(Accounts)]
#[instruction(winner: Pubkey)]
pub struct SettleLobbySol<'info> {
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

    /// Winner's Player PDA — proves the winner joined and is not refunded.
    #[account(
        seeds = [b"player", lobby.lobby_id.to_le_bytes().as_ref(), winner.as_ref()],
        bump = winner_player.bump,
        constraint = winner_player.lobby_id == lobby.lobby_id @ WagerError::WinnerNotJoined,
        constraint = winner_player.player == winner @ WagerError::WinnerNotJoined,
        constraint = !winner_player.refunded @ WagerError::AlreadyRefunded,
    )]
    pub winner_player: Account<'info, Player>,

    #[account(mut)]
    pub settlement_authority: Signer<'info>,

    /// CHECK: Receives SOL payout. Must equal `winner` arg.
    #[account(
        mut,
        constraint = winner_account.key() == winner @ WagerError::AccountMismatch,
    )]
    pub winner_account: UncheckedAccount<'info>,

    /// CHECK: Receives rake. Must equal lobby.treasury_snapshot (NOT live config),
    /// preventing admin from rerouting rake on in-flight lobbies via update_config.
    #[account(
        mut,
        constraint = treasury.key() == lobby.treasury_snapshot @ WagerError::AccountMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Lobby creator — receives vault rent residual on close.
    #[account(
        mut,
        constraint = creator.key() == lobby.creator @ WagerError::AccountMismatch,
    )]
    pub creator: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleLobbySol>, winner: Pubkey) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(
        ctx.accounts.settlement_authority.key(),
        config.settlement_authority,
        WagerError::Unauthorized
    );

    let lobby = &mut ctx.accounts.lobby;
    require!(lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Locked as u8,
        WagerError::InvalidLobbyState
    );

    let wager_amount = lobby.wager_amount;
    let joined_count = lobby.joined_count;
    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;
    // Snapshot — not live config — so admin can't move rake mid-lobby.
    let rake_bps = lobby.rake_bps_snapshot as u64;
    let treasury_pubkey = lobby.treasury_snapshot;

    // Effects-first: terminal-state mutation BEFORE any CPI.
    lobby.state = LobbyState::Settled as u8;
    lobby.winner = winner;
    // joined_count preserved post-settle so off-chain cleanup workflows can
    // iterate the original roster size when calling close_loser_player.

    let mut payout: u64 = 0;
    let mut rake: u64 = 0;

    if wager_amount > 0 {
        let pot = wager_amount
            .checked_mul(joined_count as u64)
            .ok_or(WagerError::MathOverflow)?;
        rake = pot
            .checked_mul(rake_bps)
            .ok_or(WagerError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(WagerError::MathOverflow)?;
        payout = pot.checked_sub(rake).ok_or(WagerError::MathOverflow)?;

        let lobby_id_bytes = lobby_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
        let signer_seeds_arr = [signer_seeds];

        if rake > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
                &signer_seeds_arr,
            );
            sol_transfer(cpi_ctx, rake)?;
        }
        if payout > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_account.to_account_info(),
                },
                &signer_seeds_arr,
            );
            sol_transfer(cpi_ctx, payout)?;
        }
    }

    // Drain remaining lamports (rent) from SOL vault → creator.
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

    emit!(LobbySettled {
        lobby_id,
        winner,
        payout,
        rake,
        treasury: treasury_pubkey,
    });

    Ok(())
}
