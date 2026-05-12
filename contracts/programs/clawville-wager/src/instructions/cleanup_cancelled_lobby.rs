use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::WagerError;
use crate::events::LobbyCleanedUp;
use crate::state::{Lobby, LobbyState};

/// Sweep a Cancelled SOL (or free) lobby's vault residual after the grace
/// period elapses.
///
/// Split rule (CRITICAL — do NOT change without re-reading the rug-cancel
/// audit finding):
///   * `creator_share = min(vault_total, rent_floor)` — the original ~0.0009
///     SOL rent the creator paid for the `space=0` vault PDA returns to the
///     creator.
///   * `treasury_share = vault_total - creator_share` — every lamport that
///     came from a player deposit goes to the gambling treasury, NOT the
///     creator. This removes the cancel-and-wait rug-cancel incentive: a
///     creator could otherwise open a high-wager lobby, pull in deposits,
///     cancel, wait 7 days, and pocket the entire pot via this instruction.
///     With the split, the creator only ever recovers the rent they paid in.
///
/// Player PDAs of joiners who never claimed a refund are intentionally left
/// untouched — their rent belongs to them.
///
/// We zero `joined_count` BEFORE any CPI so any racing caller sees the
/// post-cleanup state, and so off-chain indexers can detect "post-cleanup"
/// state by joined_count==0 + Cancelled.
///
/// Treasury transfer happens BEFORE the creator transfer as defense in depth:
/// if the vault were ever a non-zero-space account, draining the creator
/// share first could push the vault below rent-exempt and cause the second
/// transfer to fail. With `space=0` this can't actually happen, but the order
/// is preserved for safety against future refactors.
#[derive(Accounts)]
pub struct CleanupCancelledLobbySol<'info> {
    #[account(
        mut,
        seeds = [b"lobby", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
        constraint = lobby.creator == creator.key() @ WagerError::Unauthorized,
    )]
    pub lobby: Account<'info, Lobby>,

    #[account(
        mut,
        seeds = [b"vault", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: validated by constraint against lobby.treasury_snapshot. Receives
    /// all unclaimed player deposits.
    #[account(
        mut,
        constraint = treasury.key() == lobby.treasury_snapshot @ WagerError::AccountMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_sol(ctx: Context<CleanupCancelledLobbySol>) -> Result<()> {
    let lobby = &mut ctx.accounts.lobby;
    require!(lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Cancelled as u8,
        WagerError::InvalidLobbyState
    );

    let now = Clock::get()?.unix_timestamp;
    let earliest = lobby
        .cancelled_at
        .checked_add(Lobby::GRACE_SECONDS)
        .ok_or(WagerError::MathOverflow)?;
    require!(now >= earliest, WagerError::GracePeriodNotElapsed);

    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;
    let creator_key = ctx.accounts.creator.key();
    let treasury_key = ctx.accounts.treasury.key();

    // Effects-first: zero joined_count BEFORE any CPI so any concurrent /
    // racing callers see the post-cleanup state.
    lobby.joined_count = 0;

    // Split: creator gets back only their original space=0 rent; everything
    // else came from player deposits and goes to the treasury.
    let total = ctx.accounts.vault.to_account_info().lamports();
    let rent_floor = Rent::get()?.minimum_balance(0);
    let creator_share = total.min(rent_floor);
    let treasury_share = total.saturating_sub(creator_share);

    let lobby_id_bytes = lobby_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
    let signer_seeds_arr = [signer_seeds];

    // Treasury first (defense in depth — see struct doc comment).
    if treasury_share > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
            &signer_seeds_arr,
        );
        sol_transfer(cpi_ctx, treasury_share)?;
    }

    if creator_share > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.creator.to_account_info(),
            },
            &signer_seeds_arr,
        );
        sol_transfer(cpi_ctx, creator_share)?;
    }

    emit!(LobbyCleanedUp {
        lobby_id,
        creator: creator_key,
        treasury: treasury_key,
        creator_lamports: creator_share,
        treasury_lamports: treasury_share,
        treasury_tokens: 0,
    });

    Ok(())
}

/// Sweep a Cancelled SPL lobby's residual after the grace period elapses.
///
/// Split rule (mirrors the SOL variant):
///   * All remaining vault tokens → `treasury_token_account` (NOT the
///     creator). These are unclaimed player deposits; the rug-cancel rule
///     applies identically to SPL lobbies.
///   * Vault ATA close → creator (the creator paid the ATA rent at
///     create-time via `init_if_needed` in `create_lobby_spl`).
///   * SOL vault residual (just the `space=0` PDA rent) → creator. SPL
///     lobbies never deposit player SOL into this vault.
///
/// `treasury_token_account` is `init_if_needed` with the creator as payer so
/// cleanup never bricks because the treasury hasn't pre-created the ATA.
///
/// The vault ATA must still exist — if every joiner already refunded, the
/// last-refund path inside `claim_refund_spl` already closed it and zeroed
/// the residual; calling this is unnecessary. (Anchor's
/// `Account<'info, TokenAccount>` deserialization will fail with a clear
/// error if the ATA was already closed.)
#[derive(Accounts)]
pub struct CleanupCancelledLobbySpl<'info> {
    #[account(
        mut,
        seeds = [b"lobby", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.bump,
        constraint = lobby.creator == creator.key() @ WagerError::Unauthorized,
    )]
    pub lobby: Account<'info, Lobby>,

    #[account(
        mut,
        seeds = [b"vault", lobby.lobby_id.to_le_bytes().as_ref()],
        bump = lobby.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub wager_mint_account: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = wager_mint_account,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: validated by constraint against lobby.treasury_snapshot. Receives
    /// all unclaimed wager tokens (via `treasury_token_account`).
    #[account(
        constraint = treasury.key() == lobby.treasury_snapshot @ WagerError::AccountMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// Treasury's ATA receives all unclaimed wager tokens. `init_if_needed`
    /// so cleanup never bricks because treasury hasn't pre-created the ATA.
    /// Payer is the creator since they're the one calling cleanup.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = wager_mint_account,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler_spl(ctx: Context<CleanupCancelledLobbySpl>) -> Result<()> {
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
        ctx.accounts.vault_token_account.mint,
        lobby.wager_mint,
        WagerError::WagerMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.treasury_token_account.mint,
        lobby.wager_mint,
        WagerError::WagerMintMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let earliest = lobby
        .cancelled_at
        .checked_add(Lobby::GRACE_SECONDS)
        .ok_or(WagerError::MathOverflow)?;
    require!(now >= earliest, WagerError::GracePeriodNotElapsed);

    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;
    let creator_key = ctx.accounts.creator.key();
    let treasury_key = ctx.accounts.treasury.key();
    let residual_tokens = ctx.accounts.vault_token_account.amount;

    // Effects-first: zero joined_count BEFORE any CPI.
    lobby.joined_count = 0;

    let lobby_id_bytes = lobby_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
    let signer_seeds_arr = [signer_seeds];

    // All unclaimed player deposits → treasury (NOT the creator).
    if residual_tokens > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &signer_seeds_arr,
        );
        token::transfer(cpi_ctx, residual_tokens)?;
    }

    // Close the vault ATA → rent returns to creator (they paid for it).
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

    // Drain SOL vault residual → creator. In SPL lobbies this is just the
    // ~0.0009 SOL space=0 PDA rent (no player SOL deposits ever land here).
    let residual_lamports = ctx.accounts.vault.to_account_info().lamports();
    if residual_lamports > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.creator.to_account_info(),
            },
            &signer_seeds_arr,
        );
        sol_transfer(cpi_ctx, residual_lamports)?;
    }

    emit!(LobbyCleanedUp {
        lobby_id,
        creator: creator_key,
        treasury: treasury_key,
        creator_lamports: residual_lamports,
        treasury_lamports: 0,
        treasury_tokens: residual_tokens,
    });

    Ok(())
}
