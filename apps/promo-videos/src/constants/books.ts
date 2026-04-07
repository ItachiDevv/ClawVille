export interface BookInfo {
  id: string;
  name: string;
  icon: string;
  price: number;
  topic: string;
}

export const KNOWLEDGE_BOOKS: BookInfo[] = [
  { id: "whitepaper-basics", name: "Whitepaper Basics", icon: "📜", price: 8, topic: "Blockchain" },
  { id: "defi-deep-dive", name: "DeFi Deep Dive", icon: "🏦", price: 12, topic: "DeFi" },
  { id: "memecoin-trading-101", name: "Memecoin Trading 101", icon: "🐸", price: 10, topic: "Memecoins" },
  { id: "nft-art-culture", name: "NFT Art & Culture", icon: "🖼️", price: 10, topic: "NFTs" },
  { id: "solana-ecosystem-guide", name: "Solana Ecosystem Guide", icon: "☀️", price: 15, topic: "Solana" },
  { id: "depths-history", name: "Depths History", icon: "📖", price: 5, topic: "Lore" },
  { id: "deep-sea-cuisine", name: "Deep Sea Cuisine", icon: "🍳", price: 5, topic: "Cooking" },
  { id: "smart-contract-security", name: "Smart Contract Security", icon: "🔒", price: 15, topic: "Security" },
  { id: "onchain-data-analysis", name: "On-Chain Data Analysis", icon: "📊", price: 12, topic: "Analytics" },
  { id: "coral-remedies-guide", name: "Coral Remedies Guide", icon: "🌿", price: 6, topic: "Remedies" },
  { id: "digital-art-masterclass", name: "Digital Art Masterclass", icon: "🎨", price: 8, topic: "Art" },
  { id: "haggling-secrets", name: "Haggling Secrets", icon: "🤝", price: 7, topic: "Trading" },
];

export const PARADE_BOOKS = KNOWLEDGE_BOOKS.slice(0, 6);
