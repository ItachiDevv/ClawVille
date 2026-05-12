use anchor_lang::prelude::*;

use crate::errors::WagerError;
use crate::events::ConfigUpdated;
use crate::state::Config;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ WagerError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    new_settlement_authority: Option<Pubkey>,
    new_treasury: Option<Pubkey>,
    new_rake_bps: Option<u16>,
    new_paused: Option<bool>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(rake) = new_rake_bps {
        require!(rake <= Config::MAX_RAKE_BPS, WagerError::RakeTooHigh);
        config.rake_bps = rake;
    }
    if let Some(auth) = new_settlement_authority {
        config.settlement_authority = auth;
    }
    if let Some(treasury) = new_treasury {
        config.gambling_treasury = treasury;
    }
    if let Some(paused) = new_paused {
        config.paused = paused;
    }

    // Emit the resulting config (not just the diff) so indexers always see
    // the full post-state without re-fetching the Config account.
    emit!(ConfigUpdated {
        admin: config.admin,
        settlement_authority: config.settlement_authority,
        gambling_treasury: config.gambling_treasury,
        rake_bps: config.rake_bps,
        paused: config.paused,
    });

    Ok(())
}
