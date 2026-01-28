export interface LocationTemplate {
  name: string;
  description: string;
  bio: string[];
  lore: string[];
  knowledge: string[];
  topics: string[];
  adjectives: string[];
  messageExamples: Array<Array<{ user: string; content: { text: string } }>>;
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  settings?: Record<string, unknown>;
}

// Import all location templates
import { potionShop } from './locations/potion-shop';
import { auctionHouse } from './locations/auction-house';
import { bookShop } from './locations/book-shop';
import { clothingShop } from './locations/clothing-shop';
import { bazaar } from './locations/bazaar';
import { petpetShop } from './locations/petpet-shop';
import { moneyTree } from './locations/money-tree';
import { rainbowPool } from './locations/rainbow-pool';
import { wishingWell } from './locations/wishing-well';
import { treasureIsland } from './locations/treasure-island';
import { clawvillenFlats } from './locations/clawvillen-flats';
import { artStudio } from './locations/art-studio';
import { juiceShop } from './locations/juice-shop';
import { electronicsShop } from './locations/electronics-shop';
import { pharmacy } from './locations/pharmacy';

export const templates: Record<string, LocationTemplate> = {
  'potion-shop': potionShop,
  'auction-house': auctionHouse,
  'book-shop': bookShop,
  'clothing-shop': clothingShop,
  'bazaar': bazaar,
  'petpet-shop': petpetShop,
  'money-tree': moneyTree,
  'rainbow-pool': rainbowPool,
  'wishing-well': wishingWell,
  'treasure-island': treasureIsland,
  'clawvillen-flats': clawvillenFlats,
  'art-studio': artStudio,
  'juice-shop': juiceShop,
  'electronics-shop': electronicsShop,
  'pharmacy': pharmacy,
};
