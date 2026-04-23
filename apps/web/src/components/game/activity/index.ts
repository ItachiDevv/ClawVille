/**
 * Q2 Activity Portals — HUD atom barrel.
 *
 * Re-exports the reusable status / score / power-up components used by
 * `<BumperShellsHud>` (chunk #4) and `<ReefRaceHud>` (chunk #6).
 */
export { default as HudTile } from './HudTile';
export type { HudTileProps, HudTileTone } from './HudTile';
export { default as HudPlacement } from './HudPlacement';
export type { HudPlacementProps } from './HudPlacement';
export { default as HudMiniLeaderboard } from './HudMiniLeaderboard';
export type { HudMiniLeaderboardProps } from './HudMiniLeaderboard';
export { default as PowerUpBar } from './PowerUpBar';
export type { PowerUpBarProps } from './PowerUpBar';
export {
  default as PowerUpIcon,
  rarityForPowerUp,
} from './PowerUpIcon';
export type { PowerUpIconProps, PowerUpRarity } from './PowerUpIcon';
export { default as RoundCountdown } from './RoundCountdown';
export type { RoundCountdownProps } from './RoundCountdown';
export { default as EliminatedOverlay } from './EliminatedOverlay';
export type { EliminatedOverlayProps } from './EliminatedOverlay';
export { default as PingIndicator } from './PingIndicator';
export type { PingIndicatorProps } from './PingIndicator';
