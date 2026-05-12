use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};

use crate::errors::WagerError;
use crate::events::LobbyCreated;
use crate::state::{Config, Lobby, LobbyState, Player};

/// SOL-denominated lobby (or free lobby with `wager_amount == 0`).
/// `wager_mint` is forced to `Pubkey::default()` — callers MUST use the SPL
/// variant if they want a non-zero SPL wager. Free lobbies always route here
/// regardless of any nominal mint preference.
#[derive(Accounts)]
#[instruction(lobby_id: u64, wager_amount: u64, max_players: u8)]
pub struct CreateLobbySol<'info> {
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

    /// SOL vault PDA. Always allocated even when `wager_amount == 0` to keep
    /// the account-set uniform across SOL instructions; rent residual returns
    /// to creator on settle/cancel. System-owned (no data, no allocation) —
    /// funded via lamport transfer in the handler. Pre-creating with
    /// `init + space=0` triggers an Anchor 0.31.1 macro codegen bug
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

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateLobbySol>,
    lobby_id: u64,
    wager_amount: u64,
    max_players: u8,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, WagerError::Paused);
    require!(
        max_players >= Lobby::MIN_PLAYERS && max_players <= Lobby::MAX_PLAYERS_LIMIT,
        WagerError::InvalidMaxPlayers
    );
    // Defensive: rake must be in-range at snapshot time. update_config also
    // enforces this; double-check so a future bug there can't poison lobbies.
    require!(
        config.rake_bps <= Config::MAX_RAKE_BPS,
        WagerError::RakeTooHigh
    );

    // Snapshot treasury + rake at create-time. Settle uses the snapshots, not
    // live config, so admin update_config can't redirect rake or change rake
    // mid-lobby for in-flight lobbies.
    let treasury_snapshot = config.gambling_treasury;
    let rake_bps_snapshot = config.rake_bps;

    // Effects-first: write lobby + player state before CPI.
    let now = Clock::get()?.unix_timestamp;
    let lobby = &mut ctx.accounts.lobby;
    lobby.lobby_id = lobby_id;
    lobby.creator = ctx.accounts.creator.key();
    lobby.wager_amount = wager_amount;
    lobby.wager_mint = Pubkey::default();
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
    let total_transfer = vault_rent
        .checked_add(wager_amount)
        .ok_or(WagerError::MathOverflow)?;
    if total_transfer > 0 {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SolTransfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        sol_transfer(cpi_ctx, total_transfer)?;
    }

    emit!(LobbyCreated {
        lobby_id,
        creator: ctx.accounts.creator.key(),
        wager_amount,
        wager_mint: Pubkey::default(),
        max_players,
        treasury_snapshot,
        rake_bps_snapshot,
    });

    Ok(())
}
