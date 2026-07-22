/**
 * Q2 Activity Portals — HUD atom barrel.
 *
 * Re-exports the reusable status / score / power-up components used by
 * `<BumperShellsHud>` (chunk #4) and `<ReefRaceHud>` (chunk #6).
 *
 * Chunk #11 adds the spectator-mode atoms:
 *   SpectatorCamSelector, SpectatorChatPanel, EmoteButton.
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
// Chunk #11 — spectator atoms
export { default as SpectatorCamSelector } from './SpectatorCamSelector';
export type { SpectatorCamMode, SpectatorCamSelectorProps } from './SpectatorCamSelector';
export { default as SpectatorChatPanel } from './SpectatorChatPanel';
export type { SpectatorChatPanelProps } from './SpectatorChatPanel';
export { default as EmoteButton } from './EmoteButton';
export type { EmoteButtonProps } from './EmoteButton';

// Chunk #8 — portal + lobby atoms
export { default as ActivityThumbnail } from './ActivityThumbnail';
export type {
  ActivityThumbnailProps,
  ActivityThumbnailSize,
} from './ActivityThumbnail';
export { default as QueueStatusBar } from './QueueStatusBar';
export type { QueueStatusBarProps } from './QueueStatusBar';
export { default as PartySlot } from './PartySlot';
export type { PartySlotProps, PartySlotMember } from './PartySlot';
