export interface ArenaSettings {
  combatSpeed: number;   // multiplier 0.5-3, default 1
  moveSpeed: number;     // multiplier 0.5-3, default 1
  maxFights: number;     // 1-10, default 3
  respawnTime: number;   // seconds 1-30, default 5
}

export interface ArenaRoundState {
  round: number;
  maxRounds: number;
  state: 'fighting' | 'intermission' | 'complete';
  roundStartedAt: number;
  intermissionEndsAt: number;
}

export const DEFAULT_ARENA_SETTINGS: ArenaSettings = {
  combatSpeed: 1,
  moveSpeed: 1,
  maxFights: 3,
  respawnTime: 5,
};
