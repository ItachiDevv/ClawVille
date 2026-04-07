export const FEATURE_SCENES = [
  {
    id: "world",
    title: "Explore The Depths",
    subtitle: "Walk through The Depths with WASD",
    badge: "World",
    badgeColor: "#66BB6A",
    imgSrc: "screenshots/feature/world-exploration.png",
    label: "WASD movement + camera + 15 buildings",
    duration: 8,
  },
  {
    id: "stats",
    title: "Your Lobster, Your Stats",
    subtitle: "Level up, earn ClawTokens, grow stronger",
    badge: "Lobster System",
    badgeColor: "#FFD700",
    imgSrc: "screenshots/feature/pet-stats.png",
    label: "Level, XP, ClawTokens, STR/DEF/SPD",
    duration: 7,
  },
  {
    id: "npcs",
    title: "A Living World",
    subtitle: "NPCs explore, chat, and remember you",
    badge: "AI Agents",
    badgeColor: "#42A5F5",
    imgSrc: "screenshots/feature/npc-activity.png",
    label: "Autonomous pathfinding + conversations",
    duration: 8,
  },
  {
    id: "chat",
    title: "Chat with AI Agents",
    subtitle: "Enter buildings and talk to unique characters",
    badge: "AI Chat",
    badgeColor: "#AB47BC",
    imgSrc: "screenshots/feature/building-chat.png",
    label: "Press E to enter + AI chat",
    duration: 8,
  },
  {
    id: "shop",
    title: "Learn & Earn",
    subtitle: "Buy knowledge books and teach your lobster Solana",
    badge: "Economy",
    badgeColor: "#FF9800",
    imgSrc: "screenshots/feature/shop-books.png",
    label: "Shop + knowledge books + ClawTokens",
    duration: 8,
  },
  {
    id: "arena",
    title: "Battle in the Arena",
    subtitle: "Real-time combat with blocks, dodges, and crits",
    badge: "Arena",
    badgeColor: "#EF5350",
    imgSrc: "screenshots/feature/arena-combat.png",
    label: "Combat FX + damage + HP bars + leaderboard",
    duration: 9,
  },
  {
    id: "daily",
    title: "Daily Rewards & Quests",
    subtitle: "Login streaks and quests for bonus tokens",
    badge: "Engagement",
    badgeColor: "#FF7043",
    imgSrc: "screenshots/feature/daily-rewards.png",
    label: "7-day calendar + quest tracker",
    duration: 7,
  },
  {
    id: "openclaw",
    title: "OpenClaw Integration",
    subtitle: "Connect your bot, train it, export skills",
    badge: "OpenClaw",
    badgeColor: "#26C6DA",
    imgSrc: "screenshots/feature/openclaw-connect.png",
    label: "Bot connection + training + SKILL.md export",
    duration: 8,
  },
] as const;

export const INTRO_DURATION = 3;
export const OUTRO_DURATION = 4;
export const TITLE_CARD_DURATION = 1.5;

// Total duration: INTRO + sum(scene durations) + OUTRO
// 3 + (8+7+8+8+8+9+7+8) + 4 = 70 seconds
export const TOTAL_DURATION = 70;
