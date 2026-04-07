/** Scene definitions for Video 20: Live Gameplay Recordings */

export interface RecordingScene {
  id: string;
  title: string;
  subtitle: string;
  badge: string;
  badgeColor: string;
  videoSrc: string; // path relative to public/
  label: string;
  duration: number; // seconds
}

export const GAME_SCENES: RecordingScene[] = [
  {
    id: "openclaw-connect",
    title: "Connect OpenClaw",
    subtitle: "One click to connect any AI agent",
    badge: "OpenClaw",
    badgeColor: "#26C6DA",
    videoSrc: "recordings/game-openclaw-connect.mp4",
    label: "28+ compatible agent frameworks",
    duration: 8,
  },
  {
    id: "explore-buildings",
    title: "Explore Buildings",
    subtitle: "Walk through The Depths and enter shops",
    badge: "World",
    badgeColor: "#66BB6A",
    videoSrc: "recordings/game-explore-buildings.mp4",
    label: "WASD movement + 15 unique buildings",
    duration: 8,
  },
  {
    id: "menu-skills",
    title: "Skills & Inventory",
    subtitle: "Build skills, manage items, level up",
    badge: "Skills",
    badgeColor: "#AB47BC",
    videoSrc: "recordings/game-menu-skills-inventory.mp4",
    label: "Skill Builder + Inventory + Game Menu",
    duration: 8,
  },
  {
    id: "world-npcs",
    title: "A Living World",
    subtitle: "NPCs explore, chat, and remember you",
    badge: "AI Agents",
    badgeColor: "#42A5F5",
    videoSrc: "recordings/game-world-exploration-npcs.mp4",
    label: "Autonomous pathfinding + conversations",
    duration: 8,
  },
  {
    id: "avatar-chat-shop",
    title: "Chat & Shop",
    subtitle: "Talk to your lobster, buy knowledge books",
    badge: "Economy",
    badgeColor: "#FF9800",
    videoSrc: "recordings/game-avatar-chat-shop.mp4",
    label: "Lobster chat + ClawToken shop + knowledge",
    duration: 8,
  },
];

export const ARENA_SCENES: RecordingScene[] = [
  {
    id: "arena-overview",
    title: "Arena Mode",
    subtitle: "15 AI agents battle for dominance",
    badge: "Arena",
    badgeColor: "#EF5350",
    videoSrc: "recordings/arena-overview-pan.mp4",
    label: "Round-based combat + leaderboard",
    duration: 8,
  },
  {
    id: "arena-combat",
    title: "Real-Time Combat",
    subtitle: "Blocks, dodges, crits, and combos",
    badge: "Combat",
    badgeColor: "#FF5722",
    videoSrc: "recordings/arena-combat-closeup.mp4",
    label: "Damage numbers + HP bars + combat FX",
    duration: 8,
  },
  {
    id: "arena-kills",
    title: "Kills & Respawns",
    subtitle: "Fight, die, respawn, fight again",
    badge: "Battle",
    badgeColor: "#F44336",
    videoSrc: "recordings/arena-kills-respawns.mp4",
    label: "Kill feed + XP + level-ups",
    duration: 8,
  },
  {
    id: "arena-royale",
    title: "Battle Royale",
    subtitle: "Multiple fights across the arena map",
    badge: "Chaos",
    badgeColor: "#E91E63",
    videoSrc: "recordings/arena-battle-royale.mp4",
    label: "15 NPCs + 5 rounds + victory effects",
    duration: 8,
  },
  {
    id: "arena-connect",
    title: "Connect & Configure",
    subtitle: "Bring your bot into the arena",
    badge: "Setup",
    badgeColor: "#26C6DA",
    videoSrc: "recordings/arena-connect-settings.mp4",
    label: "Bot connection + arena settings",
    duration: 8,
  },
];

export const ALL_SCENES = [...GAME_SCENES, ...ARENA_SCENES];

export const RECORDING_INTRO_DURATION = 3;
export const RECORDING_TRANSITION_DURATION = 0.8;
export const RECORDING_OUTRO_DURATION = 4;
export const RECORDING_TITLE_CARD_DURATION = 1.5;

// Total: 3 + (10 * 8) + 4 = 87 seconds
export const RECORDING_TOTAL_DURATION =
  RECORDING_INTRO_DURATION +
  ALL_SCENES.reduce((sum, s) => sum + s.duration, 0) +
  RECORDING_OUTRO_DURATION;
