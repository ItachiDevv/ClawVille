// Data arrays for showcase promo videos

export const SIGNUP_STEPS = [
  { emoji: "\u{1F3AE}", label: "Choose a Species", desc: "Pick from 8 unique lobsters" },
  { emoji: "\u{1F3A8}", label: "Select Archetype", desc: "14 personality types" },
  { emoji: "\u{2728}", label: "Name Your Lobster", desc: "Give them an identity" },
  { emoji: "\u{1F680}", label: "Enter the Depths", desc: "Start exploring instantly" },
] as const;

export const ANON_BENEFITS = [
  { emoji: "\u{26A1}", label: "Instant Access", desc: "No signup required" },
  { emoji: "\u{1F440}", label: "Spectate Battles", desc: "Watch arena fights live" },
  { emoji: "\u{1F512}", label: "Privacy First", desc: "No data collected" },
  { emoji: "\u{1F5FA}\u{FE0F}", label: "Explore Freely", desc: "Walk the full ocean" },
] as const;

export const ACCOUNT_BENEFITS = [
  { emoji: "\u{1F99E}", label: "Persistent Lobster", desc: "Your lobster saves across sessions" },
  { emoji: "\u{1F4B0}", label: "Earn ClawTokens", desc: "Build your token balance" },
  { emoji: "\u{1F4E4}", label: "Publish Skills", desc: "Export to SKILL.md format" },
  { emoji: "\u{1F3EA}", label: "Marketplace", desc: "Buy and sell knowledge" },
  { emoji: "\u{1F4C5}", label: "Daily Rewards", desc: "Streak bonuses every day" },
] as const;

export const QUEST_TYPES = [
  { icon: "\u{1F4DA}", label: "Learn 3 Skills", reward: "+50 CT", progress: 0.6 },
  { icon: "\u{2694}\u{FE0F}", label: "Win 5 Battles", reward: "+100 CT", progress: 0.4 },
  { icon: "\u{1F3D8}\u{FE0F}", label: "Visit All Buildings", reward: "+75 CT", progress: 0.8 },
  { icon: "\u{1F4AC}", label: "Chat with 10 NPCs", reward: "+30 CT", progress: 0.3 },
] as const;

export const ARENA_SETTINGS = [
  { label: "Difficulty", value: "Hard", icon: "\u{1F3AF}" },
  { label: "Round Timer", value: "60s", icon: "\u{23F1}\u{FE0F}" },
  { label: "Bot Level", value: "Lv.12", icon: "\u{1F916}" },
  { label: "Rewards", value: "2x", icon: "\u{1F48E}" },
] as const;

export const MARKETPLACE_ITEMS = [
  { name: "DeFi Masterclass", author: "CryptoOwl", votes: 342, price: 25 },
  { name: "MEV Protection 101", author: "AlphaFox", votes: 187, price: 15 },
  { name: "NFT Trading Strats", author: "ArtDragon", votes: 256, price: 20 },
] as const;

export const DAILY_REWARD_DAYS = [
  { day: 1, reward: "+10 CT", icon: "\u{1F381}" },
  { day: 2, reward: "+15 CT", icon: "\u{1F381}" },
  { day: 3, reward: "+20 CT", icon: "\u{1F381}" },
  { day: 4, reward: "+25 CT", icon: "\u{1F381}" },
  { day: 5, reward: "+30 CT", icon: "\u{1F381}" },
  { day: 6, reward: "+40 CT", icon: "\u{1F381}" },
  { day: 7, reward: "\u{1F3C6} +100 CT", icon: "\u{1F3C6}" },
] as const;

export const PET_PERSONALITY_SAMPLES = [
  { archetype: "Brave Adventurer", quote: "Let's explore that trench!", tone: "enthusiastic" },
  { archetype: "Curious Scholar", quote: "Fascinating blockchain architecture...", tone: "intellectual" },
  { archetype: "Mischievous Trickster", quote: "Hehe, watch this trick!", tone: "playful" },
  { archetype: "Gentle Healer", quote: "I'll help you feel better~", tone: "warm" },
] as const;

export const NPC_MEMORY_EXAMPLES = [
  { npc: "Librarian", memory: "Remembers your last book topic", icon: "\u{1F4DA}" },
  { npc: "Trader", memory: "Recalls your trading history", icon: "\u{1F4B9}" },
  { npc: "Blacksmith", memory: "Knows your preferred gear", icon: "\u{2692}\u{FE0F}" },
] as const;

export const SKILL_MARKETPLACE_FEATURES = [
  { label: "Browse Skills", desc: "Filter by topic, rating, price", icon: "\u{1F50D}" },
  { label: "Publish Yours", desc: "Export lobster knowledge as SKILL.md", icon: "\u{1F4E4}" },
  { label: "Community Votes", desc: "Upvote the best skills", icon: "\u{1F44D}" },
] as const;

// Showcase video metadata for Root.tsx registration
export const SHOWCASE_VIDEOS = [
  { id: "showcase-ai-lobster-adventure", dur: 18 },
  { id: "showcase-world-of-clawville", dur: 20 },
  { id: "showcase-learn-crypto-compete", dur: 20 },
  { id: "showcase-openclaw-world", dur: 18 },
  { id: "showcase-knowledge-discovery", dur: 18 },
  { id: "showcase-bot-exploration", dur: 17 },
  { id: "showcase-openclaw-arena", dur: 18 },
  { id: "showcase-arena-bot-training", dur: 18 },
  { id: "showcase-battle-and-learn", dur: 17 },
  { id: "showcase-watch-and-learn", dur: 17 },
  { id: "showcase-spectator-guide", dur: 18 },
  { id: "showcase-openclaw-spectator", dur: 17 },
  { id: "showcase-explore-the-depths", dur: 20 },
  { id: "showcase-your-lobster-journey", dur: 18 },
  { id: "showcase-arena-ultimate-test", dur: 18 },
  { id: "showcase-arena-strategy", dur: 16 },
  { id: "showcase-connect-30-seconds", dur: 15 },
  { id: "showcase-zero-to-skill", dur: 20 },
  { id: "showcase-anonymous-play", dur: 16 },
  { id: "showcase-go-anonymous", dur: 15 },
  { id: "showcase-create-account", dur: 18 },
  { id: "showcase-account-benefits", dur: 16 },
  { id: "showcase-complete-walkthrough", dur: 20 },
  { id: "showcase-new-player-to-master", dur: 18 },
  { id: "showcase-daily-rewards", dur: 16 },
  { id: "showcase-quest-system", dur: 17 },
  { id: "showcase-clawtoken-economy", dur: 18 },
  { id: "showcase-lobster-personalities", dur: 18 },
  { id: "showcase-npc-memory", dur: 18 },
  { id: "showcase-skill-marketplace", dur: 18 },
] as const;
