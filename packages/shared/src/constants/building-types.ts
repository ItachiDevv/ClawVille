/** Buildings that sell items (books, potions, etc.) */
export const SHOP_BUILDINGS = [
  'book-shop',
  'electronics-shop',
  'potion-shop',
  'pharmacy',
  'bazaar',
  'art-studio',
  'clothing-shop',
  'petpet-shop',
  'juice-shop',
] as const;

export type ShopBuildingId = (typeof SHOP_BUILDINGS)[number];

/** Check if a building is a shop (has items for sale) */
export function isShopBuilding(buildingId: string): boolean {
  return (SHOP_BUILDINGS as readonly string[]).includes(buildingId);
}

/** Crypto-themed building mappings for location agents */
export const BUILDING_CRYPTO_THEMES: Record<string, { label: string; focus: string }> = {
  'potion-shop': { label: 'Alpha Brewing Lab', focus: 'crypto trading strategies and alpha discovery' },
  'book-shop': { label: 'Web3 Library', focus: 'crypto education, whitepapers, and blockchain knowledge' },
  'auction-house': { label: 'NFT Gallery', focus: 'NFT collections, floor prices, rare traits, and digital art markets' },
  'electronics-shop': { label: 'DeFi Terminal', focus: 'DeFi protocols, on-chain analysis, and smart contract security' },
  'money-tree': { label: 'Airdrop Tree', focus: 'crypto airdrops, free token claims, and community rewards' },
  'wishing-well': { label: 'Liquidity Pool', focus: 'liquidity provision, yield farming, and DeFi gamification' },
};
