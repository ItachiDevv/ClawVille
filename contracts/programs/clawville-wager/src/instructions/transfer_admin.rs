use anchor_lang::prelude::*;

use crate::errors::WagerError;
use crate::events::AdminTransferred;
use crate::state::Config;

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ WagerError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

// One-step admin transfer. Two-step (propose+accept) would be safer against
// fat-finger transfers to wrong/uncontrolled keys; documented gap for v1.
pub fn handler(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
    let old_admin = ctx.accounts.config.admin;
    ctx.accounts.config.admin = new_admin;

    emit!(AdminTransferred {
        old_admin,
        new_admin,
    });

    Ok(())
}
