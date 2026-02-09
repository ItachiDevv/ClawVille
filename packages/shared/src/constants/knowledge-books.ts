export interface KnowledgeBook {
  id: string;
  name: string;
  description: string;
  icon: string;
  price: number;
  building: string; // which shop sells it
  knowledgeEntries: string[];
}

export const KNOWLEDGE_BOOKS: KnowledgeBook[] = [
  // Crypto books (Book Shop)
  {
    id: 'whitepaper-basics',
    name: 'Whitepaper Basics',
    description: 'The fundamentals of Bitcoin, consensus mechanisms, and blockchain architecture.',
    icon: '📜',
    price: 8,
    building: 'book-shop',
    knowledgeEntries: [
      'Bitcoin was created by Satoshi Nakamoto and introduced proof-of-work consensus where miners compete to validate transactions.',
      'Proof-of-stake is an alternative consensus mechanism where validators lock up tokens as collateral instead of spending energy on mining.',
      'A blockchain is an append-only ledger of blocks linked by cryptographic hashes, making it tamper-resistant.',
      'Decentralization means no single entity controls the network — nodes around the world independently verify transactions.',
    ],
  },
  {
    id: 'defi-deep-dive',
    name: 'DeFi Deep Dive',
    description: 'Automated market makers, liquidity pools, yield farming, and impermanent loss explained.',
    icon: '🏦',
    price: 12,
    building: 'book-shop',
    knowledgeEntries: [
      'AMMs (Automated Market Makers) use mathematical formulas like x*y=k to enable token swaps without order books.',
      'Liquidity providers deposit token pairs into pools and earn trading fees, but face impermanent loss when prices diverge.',
      'Yield farming involves moving capital between DeFi protocols to maximize returns through token rewards and fees.',
      'Impermanent loss occurs when the price ratio of pooled tokens changes — the bigger the divergence, the larger the loss compared to holding.',
    ],
  },
  {
    id: 'memecoin-trading-101',
    name: 'Memecoin Trading 101',
    description: 'Degen culture, FOMO/FUD dynamics, rug pull detection, and community token meta.',
    icon: '🐸',
    price: 10,
    building: 'book-shop',
    knowledgeEntries: [
      'Memecoins derive value from community hype and meme culture — they can pump 100x but also dump to zero.',
      'FOMO (Fear Of Missing Out) drives buying frenzies, while FUD (Fear, Uncertainty, Doubt) triggers panic selling.',
      'Rug pull red flags: anonymous teams, locked liquidity that can be unlocked early, honeypot contracts that prevent selling.',
      'Degen culture embraces high-risk trading — "aping in" means buying without research, "diamond hands" means holding through drops.',
    ],
  },
  {
    id: 'nft-art-culture',
    name: 'NFT Art & Culture',
    description: 'Generative art, PFP collections, royalties, and the on-chain art movement.',
    icon: '🖼️',
    price: 10,
    building: 'book-shop',
    knowledgeEntries: [
      'NFTs are non-fungible tokens that prove ownership of unique digital items like art, music, and collectibles.',
      'PFP (Profile Picture) collections like CryptoPunks and Bored Apes became status symbols and community identifiers.',
      'Generative art uses algorithms to create unique outputs — each mint produces a one-of-a-kind piece from the same code.',
      'On-chain metadata means the art data is stored directly on the blockchain, making it permanent and truly decentralized.',
    ],
  },
  {
    id: 'solana-ecosystem-guide',
    name: 'Solana Ecosystem Guide',
    description: 'SPL tokens, Jupiter, Raydium, Tensor, and the Solana DeFi landscape.',
    icon: '☀️',
    price: 15,
    building: 'book-shop',
    knowledgeEntries: [
      'Solana uses proof-of-history combined with proof-of-stake for high throughput — transactions confirm in under a second.',
      'SPL tokens are the Solana equivalent of ERC-20 tokens on Ethereum, created using the Token Program.',
      'Jupiter is the leading Solana DEX aggregator — it finds the best swap routes across multiple liquidity sources.',
      'Raydium is a major Solana AMM that provides liquidity and trading, while Tensor dominates Solana NFT trading.',
      'Compressed NFTs on Solana use state compression to mint millions of NFTs for a fraction of the cost.',
    ],
  },
  // General books (Book Shop)
  {
    id: 'neopia-history',
    name: 'Neopia History',
    description: 'Ancient lore, legendary heroes, and the deep history of Neopia Central.',
    icon: '📖',
    price: 5,
    building: 'book-shop',
    knowledgeEntries: [
      'Neopia Central is the heart of the Neopian world — a bustling hub where pets gather to shop, play, and socialize.',
      'The Money Tree has stood for centuries, a symbol of generosity where Neopians leave gifts for those in need.',
      'The Rainbow Pool is a magical place where paint brushes can transform a pet\'s appearance into dazzling new colors.',
      'Dr. Sloth once tried to conquer Neopia with his army of mutant Grundos, but was defeated by brave Neopets.',
    ],
  },
  {
    id: 'exotic-cooking',
    name: 'Cooking with Exotic Fruits',
    description: 'Recipes and lore about rare Neopian fruits and magical cuisine.',
    icon: '🍳',
    price: 5,
    building: 'book-shop',
    knowledgeEntries: [
      'Juppie fruits come in many varieties and are the staple ingredient of Neopian cuisine — from soups to smoothies.',
      'Faerie foods have magical properties — eating a Light Faerie Cake might make you glow for a whole day.',
      'The best chefs in Neopia combine exotic ingredients like Tigersquash and Zeenana to create powerful healing dishes.',
    ],
  },
  // Tech books (Electronics Shop)
  {
    id: 'smart-contract-security',
    name: 'Smart Contract Security',
    description: 'Common vulnerabilities, auditing basics, and how to spot unsafe code.',
    icon: '🔒',
    price: 15,
    building: 'electronics-shop',
    knowledgeEntries: [
      'Reentrancy attacks occur when a contract calls an external contract before updating its own state, allowing repeated withdrawals.',
      'Flash loan attacks exploit DeFi protocols by borrowing huge amounts without collateral within a single transaction.',
      'Smart contract auditing involves reviewing code for vulnerabilities — firms like Trail of Bits and OpenZeppelin specialize in this.',
      'Common security patterns: checks-effects-interactions, reentrancy guards, access control modifiers, and timelocks on admin functions.',
    ],
  },
  {
    id: 'onchain-data-analysis',
    name: 'On-Chain Data Analysis',
    description: 'Reading block explorers, whale tracking, and token distribution analysis.',
    icon: '📊',
    price: 12,
    building: 'electronics-shop',
    knowledgeEntries: [
      'Block explorers like Solscan and Etherscan let you inspect every transaction, token transfer, and contract interaction.',
      'Whale tracking monitors large wallet movements — sudden big transfers to exchanges often signal upcoming sells.',
      'Token distribution analysis reveals how concentrated ownership is — if top 10 wallets hold 80%, it\'s a centralization risk.',
      'On-chain analytics platforms like Dune, Nansen, and Flipside help visualize blockchain data with custom dashboards.',
    ],
  },
  // Pharmacy books
  {
    id: 'healing-herbs-guide',
    name: 'Healing Herbs Guide',
    description: 'Medicinal plants of Neopia and their restorative properties.',
    icon: '🌿',
    price: 6,
    building: 'pharmacy',
    knowledgeEntries: [
      'Neopian healing herbs include Bomberry essence for headaches and Tchea leaf tea for calming nerves.',
      'The Pharmacy stocks remedies for common Neopian ailments like Neoflu, Bloaty Feet, and Watery Eyes.',
      'Rare healing potions are brewed from combinations of herbs — Cooling Balm requires mint, aloe, and a splash of Rainbow Pool water.',
    ],
  },
  // Art books
  {
    id: 'digital-art-masterclass',
    name: 'Digital Art Masterclass',
    description: 'Techniques for creating stunning pixel art and generative visuals.',
    icon: '🎨',
    price: 8,
    building: 'art-studio',
    knowledgeEntries: [
      'Pixel art uses a limited canvas and palette to create detailed sprites — every pixel matters in conveying form and emotion.',
      'Color theory in pixel art: use hue-shifting in shadows (shift toward blue/purple) rather than just darkening for more vibrant results.',
      'Generative art combines code and creativity — artists write algorithms that produce unique outputs with each execution.',
    ],
  },
  // Bazaar books
  {
    id: 'haggling-secrets',
    name: 'Haggling Secrets',
    description: 'Master the art of negotiation and trading in markets.',
    icon: '🤝',
    price: 7,
    building: 'bazaar',
    knowledgeEntries: [
      'The best traders always know the fair market value before entering a negotiation — knowledge is leverage.',
      'In crypto trading, limit orders let you set your price instead of accepting whatever the market offers with market orders.',
      'Dollar-cost averaging means buying a fixed amount regularly regardless of price — it smooths out volatility over time.',
    ],
  },
];

export const BOOK_IDS = KNOWLEDGE_BOOKS.map((b) => b.id);

/** Get books available at a specific building */
export function getBooksForBuilding(buildingId: string): KnowledgeBook[] {
  return KNOWLEDGE_BOOKS.filter((b) => b.building === buildingId);
}

/** Get a specific book by ID */
export function getBookById(bookId: string): KnowledgeBook | undefined {
  return KNOWLEDGE_BOOKS.find((b) => b.id === bookId);
}
