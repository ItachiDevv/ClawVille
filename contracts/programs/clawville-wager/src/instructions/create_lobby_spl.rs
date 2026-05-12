use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::WagerError;
use crate::events::LobbyCreated;
use crate::state::{Config, Lobby, LobbyState, Player};

/// SPL-denominated lobby. Requires `wager_amount > 0` and a non-default mint.
/// Free or SOL lobbies must use `create_lobby_sol`.
#[derive(Accounts)]
#[instruction(lobby_id: u64, wager_amount: u64, wager_mint: Pubkey, max_players: u8)]
pub struct CreateLobbySpl<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = creator,
        space = 8 + Lobby::INIT_SPACE,
        seeds = [b"lobby", &lobby_id.to_le_bytes()[..]],
        bump,
    )]
    pub lobby: Account<'info, Lobby>,

    /// SOL vault PDA. Authority for the vault ATA. System-owned (no data, no
    /// allocation) — funded via lamport transfer in the handler. Pre-creating
    /// with `init + space=0` triggers an Anchor 0.31.1 macro codegen bug
    /// (E0425 "cannot find crate `try_from_unchecked`") so we self-fund
    /// rent here instead. Address is the deterministic PDA from seeds.
    #[account(
        mut,
        seeds = [b"vault", &lobby_id.to_le_bytes()[..]],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + Player::INIT_SPACE,
        seeds = [b"player", &lobby_id.to_le_bytes()[..], creator.key().as_ref()],
        bump,
    )]
    pub creator_player: Account<'info, Player>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub wager_mint_account: Account<'info, Mint>,

    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// Vault's associated token account; init_if_needed because the same vault
    /// PDA is being created above and its ATA must be allocated atomically.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = wager_mint_account,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateLobbySpl>,
    lobby_id: u64,
    wager_amount: u64,
    wager_mint: Pubkey,
    max_players: u8,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, WagerError::Paused);
    require!(
        max_players >= Lobby::MIN_PLAYERS && max_players <= Lobby::MAX_PLAYERS_LIMIT,
        WagerError::InvalidMaxPlayers
    );
    require!(
        config.rake_bps <= Config::MAX_RAKE_BPS,
        WagerError::RakeTooHigh
    );

    // SPL variant guarantees: real mint + non-zero amount. Free / SOL lobbies
    // must route through create_lobby_sol.
    require!(
        wager_mint != Pubkey::default(),
        WagerError::WrongTokenVariant
    );
    require!(wager_amount > 0, WagerError::WrongTokenVariant);

    require_keys_eq!(
        ctx.accounts.wager_mint_account.key(),
        wager_mint,
        WagerError::WagerMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.creator_token_account.mint,
        wager_mint,
        WagerError::WagerMintMismatch
    );
    require_keys_eq!(
        ctx.accounts.vault_token_account.mint,
        wager_mint,
        WagerError::WagerMintMismatch
    );

    let treasury_snapshot = config.gambling_treasury;
    let rake_bps_snapshot = config.rake_bps;

    // Effects-first: write lobby + player state before CPI.
    let now = Clock::get()?.unix_timestamp;
    let lobby = &mut ctx.accounts.lobby;
    lobby.lobby_id = lobby_id;
    lobby.creator = ctx.accounts.creator.key();
    lobby.wager_amount = wager_amount;
    lobby.wager_mint = wager_mint;
    lobby.max_players = max_players;
    lobby.joined_count = 1;
    lobby.state = LobbyState::Open as u8;
    lobby.winner = Pubkey::default();
    lobby.vault_bump = ctx.bumps.vault;
    lobby.bump = ctx.bumps.lobby;
    lobby.created_at = now;
    lobby.locked_at = 0;
    lobby.treasury_snapshot = treasury_snapshot;
    lobby.rake_bps_snapshot = rake_bps_snapshot;
    lobby.cancelled_at = 0;

    let creator_player = &mut ctx.accounts.creator_player;
    creator_player.lobby_id = lobby_id;
    creator_player.player = ctx.accounts.creator.key();
    creator_player.deposit_amount = wager_amount;
    creator_player.refunded = false;
    creator_player.bump = ctx.bumps.creator_player;

    // Self-fund the vault PDA with rent-exempt lamports (system-owned,
    // space=0). On settle/cancel we drain remaining lamports back to creator.
    // See struct doc for why we don't use `init` here.
    let vault_rent = Rent::get()?.minimum_balance(0);
    if vault_rent > 0 {
        let fund_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(fund_ctx, vault_rent)?;
    }

    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        SplTransfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        },
    );
    token::transfer(cpi_ctx, wager_amount)?;

    emit!(LobbyCreated {
        lobby_id,
        creator: ctx.accounts.creator.key(),
        wager_amount,
        wager_mint,
        max_players,
        treasury_snapshot,
        rake_bps_snapshot,
    });

    Ok(())
}
