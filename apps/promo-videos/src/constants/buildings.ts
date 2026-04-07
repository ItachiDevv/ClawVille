// Building crypto themes for video scripts — adapted for ClawVille
export const BUILDING_THEMES = [
  { icon: "🧪", name: "Alpha Lab", focus: "Token sniping" },
  { icon: "🎨", name: "NFT Gallery", focus: "Tensor & Magic Eden" },
  { icon: "📚", name: "Web3 Library", focus: "Blockchain fundamentals" },
  { icon: "👔", name: "Wallet Wardrobe", focus: "Seed phrases & security" },
  { icon: "🏪", name: "DEX Trading Floor", focus: "Jupiter aggregator" },
  { icon: "🐾", name: "Bot Workshop", focus: "Trading automation" },
  { icon: "🌳", name: "Airdrop Tree", focus: "Token farming" },
  { icon: "🌈", name: "Token Launchpad", focus: "Pump.fun & bonding curves" },
  { icon: "⛲", name: "Liquidity Pool", focus: "LP strategies" },
  { icon: "🏝️", name: "Whale Cove", focus: "On-chain forensics" },
  { icon: "🏢", name: "DAO HQ", focus: "Governance & Realms" },
  { icon: "🎭", name: "Meme Factory", focus: "Crypto Twitter culture" },
  { icon: "🧃", name: "Staking Smoothies", focus: "SOL validators" },
  { icon: "💻", name: "DeFi Terminal", focus: "Smart contracts" },
  { icon: "💊", name: "Risk Clinic", focus: "Position sizing" },
] as const;

export const LEARNING_STEPS = [
  { building: "Alpha Lab", knowledge: "Token sniping strategies" },
  { building: "DEX Floor", knowledge: "Jupiter routing" },
  { building: "Whale Cove", knowledge: "Wallet tracking" },
  { building: "Launchpad", knowledge: "Pump.fun mechanics" },
] as const;

export const EARN_METHODS = [
  { icon: "💬", label: "Chat with NPCs", reward: "+1 NT per message" },
  { icon: "🏠", label: "Explore buildings", reward: "+1 NT per visit" },
  { icon: "📅", label: "Daily login streak", reward: "Up to +100 NT" },
  { icon: "🤖", label: "Autonomous mode", reward: "Earns while you sleep" },
] as const;

export const PIPELINE_STEPS = [
  { icon: "🔌", label: "Connect", desc: "Plug in your bot" },
  { icon: "🗺️", label: "Explore", desc: "Visit 15 buildings" },
  { icon: "📖", label: "Learn", desc: "Gain crypto knowledge" },
  { icon: "⚔️", label: "Battle", desc: "Test in the arena" },
  { icon: "📤", label: "Export", desc: "Deploy to production" },
] as const;
