use anchor_lang::prelude::*;

#[error_code]
pub enum WagerError {
    #[msg("Rake bps exceeds maximum (1000 = 10%)")]
    RakeTooHigh,
    #[msg("Program is paused")]
    Paused,
    #[msg("Lobby is not in the required state")]
    InvalidLobbyState,
    #[msg("Lobby is full")]
    LobbyFull,
    #[msg("Not enough players to lock")]
    NotEnoughPlayers,
    #[msg("max_players must be between 2 and 16")]
    InvalidMaxPlayers,
    #[msg("Caller is not authorized")]
    Unauthorized,
    #[msg("Wager mint mismatch")]
    WagerMintMismatch,
    #[msg("Winner did not join this lobby")]
    WinnerNotJoined,
    #[msg("Already refunded")]
    AlreadyRefunded,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Provided account does not match recorded value")]
    AccountMismatch,
    #[msg("Wrong instruction variant for this lobby (SOL/SPL mismatch)")]
    WrongTokenVariant,
    #[msg("Player is the winner; cannot close as loser")]
    WinnerCannotCloseAsLoser,
    #[msg("Cancellation grace period has not yet elapsed")]
    GracePeriodNotElapsed,
}
