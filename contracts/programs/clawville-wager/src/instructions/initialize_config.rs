use anchor_lang::prelude::*;

use crate::errors::WagerError;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeConfig>,
    rake_bps: u16,
    settlement_authority: Pubkey,
    gambling_treasury: Pubkey,
) -> Result<()> {
    require!(rake_bps <= Config::MAX_RAKE_BPS, WagerError::RakeTooHigh);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.settlement_authority = settlement_authority;
    config.gambling_treasury = gambling_treasury;
    config.rake_bps = rake_bps;
    config.paused = false;
    config.bump = ctx.bumps.config;

    Ok(())
}
