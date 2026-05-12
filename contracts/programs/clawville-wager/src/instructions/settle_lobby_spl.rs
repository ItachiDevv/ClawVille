use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::WagerError;
use crate::events::LobbySettled;
use crate::state::{Config, Lobby, LobbyState, Player};

/// Settle an SPL lobby. Must NOT be called for SOL or free lobbies.
#[derive(Accounts)]
#[instruction(winner: Pubkey)]
pub struct SettleLobbySpl<'info> {
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
        seeds = [b"player", lobby.lobby_id.to_le_bytes().as_ref(), winner.as_ref()],
        bump = winner_player.bump,
        constraint = winner_player.lobby_id == lobby.lobby_id @ WagerError::WinnerNotJoined,
        constraint = winner_player.player == winner @ WagerError::WinnerNotJoined,
        constraint = !winner_player.refunded @ WagerError::AlreadyRefunded,
    )]
    pub winner_player: Account<'info, Player>,

    #[account(mut)]
    pub settlement_authority: Signer<'info>,

    /// CHECK: Receives SPL payout. Must equal `winner` arg.
    #[account(
        mut,
        constraint = winner_account.key() == winner @ WagerError::AccountMismatch,
    )]
    pub winner_account: UncheckedAccount<'info>,

    /// CHECK: Receives rake. Must equal lobby.treasury_snapshot — admin can't
    /// reroute rake on in-flight lobbies.
    #[account(
        mut,
        constraint = treasury.key() == lobby.treasury_snapshot @ WagerError::AccountMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Lobby creator — receives vault rent residual + vault ATA rent.
    #[account(
        mut,
        constraint = creator.key() == lobby.creator @ WagerError::AccountMismatch,
    )]
    pub creator: UncheckedAccount<'info>,

    pub wager_mint_account: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = wager_mint_account,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// Winner's ATA, init_if_needed so settlement never fails because the
    /// winner forgot to set up an ATA. Payer = settlement authority.
    /// Boxed to keep try_accounts stack frame under the 4KiB BPF limit.
    #[account(
        init_if_needed,
        payer = settlement_authority,
        associated_token::mint = wager_mint_account,
        associated_token::authority = winner_account,
    )]
    pub winner_token_account: Box<Account<'info, TokenAccount>>,

    /// Treasury's ATA, init_if_needed for the same reason. Boxed.
    #[account(
        init_if_needed,
        payer = settlement_authority,
        associated_token::mint = wager_mint_account,
        associated_token::authority = treasury,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleLobbySpl>, winner: Pubkey) -> Result<()> {
    let config = &ctx.accounts.config;
    require_keys_eq!(
        ctx.accounts.settlement_authority.key(),
        config.settlement_authority,
        WagerError::Unauthorized
    );

    let lobby = &mut ctx.accounts.lobby;
    require!(!lobby.is_sol(), WagerError::WrongTokenVariant);
    require!(
        lobby.state == LobbyState::Locked as u8,
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
        ctx.accounts.winner_token_account.mint,
        lobby.wager_mint,
        WagerError::WagerMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.treasury_token_account.mint,
        lobby.wager_mint,
        WagerError::WagerMintMismatch
    );

    let wager_amount = lobby.wager_amount;
    let joined_count = lobby.joined_count;
    let lobby_id = lobby.lobby_id;
    let vault_bump = lobby.vault_bump;
    let rake_bps = lobby.rake_bps_snapshot as u64;
    let treasury_pubkey = lobby.treasury_snapshot;

    // Effects-first: terminal-state mutation BEFORE any CPI.
    lobby.state = LobbyState::Settled as u8;
    lobby.winner = winner;
    // joined_count preserved post-settle so off-chain cleanup workflows can
    // iterate the original roster size when calling close_loser_player.

    // SPL invariant: wager_amount > 0 (enforced at create time).
    let pot = wager_amount
        .checked_mul(joined_count as u64)
        .ok_or(WagerError::MathOverflow)?;
    let rake = pot
        .checked_mul(rake_bps)
        .ok_or(WagerError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(WagerError::MathOverflow)?;
    let payout = pot.checked_sub(rake).ok_or(WagerError::MathOverflow)?;

    let lobby_id_bytes = lobby_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[b"vault", lobby_id_bytes.as_ref(), &[vault_bump]];
    let signer_seeds_arr = [signer_seeds];

    if rake > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &signer_seeds_arr,
        );
        token::transfer(cpi_ctx, rake)?;
    }
    if payout > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.winner_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &signer_seeds_arr,
        );
        token::transfer(cpi_ctx, payout)?;
    }

    // Close vault ATA, return its rent to creator.
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

    // Drain remaining lamports (rent) from SOL vault → creator.
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

    emit!(LobbySettled {
        lobby_id,
        winner,
        payout,
        rake,
        treasury: treasury_pubkey,
    });

    Ok(())
}
