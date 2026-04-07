/**
 * Maps showcase video IDs to screen recording files.
 * Each entry: [filename in public/recordings/, startFromSeconds, playbackRate]
 */
export const SHOWCASE_RECORDINGS: Record<string, { file: string; start: number; rate: number; tint: number }> = {
  // App overview
  "ai-lobster-adventure":     { file: "game-world-exploration-npcs.mp4", start: 2, rate: 1, tint: 0.5 },
  "world-of-clawville":       { file: "game-explore-buildings.mp4", start: 1, rate: 1, tint: 0.45 },
  "learn-crypto-compete":     { file: "arena-combat-closeup.mp4", start: 1, rate: 1, tint: 0.45 },

  // OpenClaw world learning
  "openclaw-world":           { file: "game-openclaw-connect.mp4", start: 0, rate: 1, tint: 0.4 },
  "knowledge-discovery":      { file: "game-building-chat-learn.mp4", start: 1, rate: 1, tint: 0.45 },
  "bot-exploration":          { file: "game-world-exploration-npcs.mp4", start: 5, rate: 0.8, tint: 0.45 },

  // OpenClaw arena learning
  "openclaw-arena":           { file: "arena-battle-royale.mp4", start: 2, rate: 1, tint: 0.4 },
  "arena-bot-training":       { file: "arena-combat-closeup.mp4", start: 0, rate: 1, tint: 0.4 },
  "battle-and-learn":         { file: "arena-kills-respawns.mp4", start: 1, rate: 1, tint: 0.45 },

  // Spectator
  "watch-and-learn":          { file: "arena-overview-pan.mp4", start: 0, rate: 0.8, tint: 0.45 },
  "spectator-guide":          { file: "arena-overview-pan.mp4", start: 3, rate: 1, tint: 0.45 },
  "openclaw-spectator":       { file: "arena-battle-royale.mp4", start: 5, rate: 1, tint: 0.4 },

  // Game modes - world
  "explore-the-depths":       { file: "game-explore-buildings.mp4", start: 3, rate: 1, tint: 0.45 },
  "your-lobster-journey":     { file: "game-avatar-chat-shop.mp4", start: 1, rate: 1, tint: 0.45 },

  // Game modes - arena
  "arena-ultimate-test":      { file: "arena-battle-royale.mp4", start: 0, rate: 1, tint: 0.4 },
  "arena-strategy":           { file: "arena-combat-closeup.mp4", start: 3, rate: 0.8, tint: 0.45 },

  // OpenClaw connect
  "connect-30-seconds":       { file: "game-openclaw-connect.mp4", start: 2, rate: 1, tint: 0.4 },
  "zero-to-skill":            { file: "game-openclaw-skills.mp4", start: 0, rate: 1, tint: 0.45 },

  // Signup
  "anonymous-play":           { file: "game-world-exploration-npcs.mp4", start: 0, rate: 1, tint: 0.5 },
  "go-anonymous":             { file: "game-world-exploration-npcs.mp4", start: 8, rate: 1, tint: 0.5 },
  "create-account":           { file: "game-avatar-chat-shop.mp4", start: 3, rate: 1, tint: 0.5 },
  "account-benefits":         { file: "game-menu-skills-inventory.mp4", start: 0, rate: 1, tint: 0.45 },

  // Walkthroughs
  "complete-walkthrough":     { file: "game-world-exploration-npcs.mp4", start: 3, rate: 0.8, tint: 0.45 },
  "new-player-to-master":     { file: "game-explore-buildings.mp4", start: 5, rate: 1, tint: 0.45 },

  // Features
  "daily-rewards":            { file: "daily-rewards.mp4", start: 0, rate: 1, tint: 0.5 },
  "quest-system":             { file: "game-menu-skills-inventory.mp4", start: 2, rate: 1, tint: 0.45 },
  "clawtoken-economy":        { file: "shop-books.mp4", start: 0, rate: 1, tint: 0.45 },
  "lobster-personalities":    { file: "avatar-stats.mp4", start: 0, rate: 1, tint: 0.5 },
  "npc-memory":               { file: "npc-activity.mp4", start: 0, rate: 1, tint: 0.45 },
  "skill-marketplace":        { file: "game-openclaw-skills.mp4", start: 2, rate: 1, tint: 0.45 },
};
