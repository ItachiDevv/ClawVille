import type { AvatarSpecies } from '../types/avatar';

export interface NpcStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
}

export interface NpcDefinition {
  id: string;
  name: string;
  species: AvatarSpecies;
  color: number; // hex tint
  buildingId: string;
  patrolRadius: number;
  homeX: number;
  homeY: number;
  stats: NpcStats;
  personality: string; // short description for conversation engine
}

// Tile size = 32px; building zone centers computed from tilemap-data buildingZones
// Each building zone is defined as {x, y, width, height} in tile coords
// Center pixel = (x + width/2) * 32, (y + height/2) * 32
const TILE = 32;

function center(tileX: number, tileY: number, tileW: number, tileH: number) {
  return {
    homeX: (tileX + tileW / 2) * TILE,
    homeY: (tileY + tileH / 2) * TILE,
  };
}

// Building zone tile coords from tilemap-data.ts
const BUILDING_TILE_ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  'potion-shop':      { x: 3,  y: 2,  w: 4, h: 3 },
  'auction-house':    { x: 9,  y: 1,  w: 4, h: 3 },
  'book-shop':        { x: 16, y: 1,  w: 3, h: 3 },
  'clothing-shop':    { x: 23, y: 1,  w: 3, h: 3 },
  'bazaar':           { x: 2,  y: 8,  w: 4, h: 3 },
  'petpet-shop':      { x: 7,  y: 10, w: 3, h: 3 },
  'money-tree':       { x: 14, y: 7,  w: 4, h: 4 },
  'rainbow-pool':     { x: 20, y: 8,  w: 4, h: 3 },
  'wishing-well':     { x: 27, y: 6,  w: 3, h: 3 },
  'treasure-island':  { x: 32, y: 3,  w: 4, h: 3 },
  'clawvillen-flats':    { x: 2,  y: 16, w: 4, h: 3 },
  'art-studio':       { x: 9,  y: 18, w: 3, h: 3 },
  'juice-shop':       { x: 17, y: 17, w: 3, h: 3 },
  'electronics-shop': { x: 25, y: 16, w: 3, h: 3 },
  'pharmacy':         { x: 32, y: 17, w: 3, h: 3 },
};

/** Map of building ID to {homeX, homeY} for NPC definitions */
const NPC_HOME_POSITIONS: Record<string, { homeX: number; homeY: number }> = Object.fromEntries(
  Object.entries(BUILDING_TILE_ZONES).map(([id, z]) => [id, center(z.x, z.y, z.w, z.h)])
);

/** Map of building ID to center pixel coordinates */
export const NPC_BUILDING_CENTERS: Record<string, { x: number; y: number }> = Object.fromEntries(
  Object.entries(NPC_HOME_POSITIONS).map(([id, p]) => [id, { x: p.homeX, y: p.homeY }])
);

export const NPC_DEFINITIONS: NpcDefinition[] = [
  {
    id: 'potion-shop',
    name: 'Kauvara',
    species: 'cat',
    color: 0x9c27b0,
    buildingId: 'potion-shop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['potion-shop'],
    stats: { hp: 100, attack: 15, defense: 12, speed: 14 },
    personality: 'A mysterious potion master who speaks in riddles and loves magical ingredients.',
  },
  {
    id: 'auction-house',
    name: 'Xander',
    species: 'fox',
    color: 0xff9800,
    buildingId: 'auction-house',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['auction-house'],
    stats: { hp: 90, attack: 18, defense: 8, speed: 16 },
    personality: 'A fast-talking auctioneer who loves making deals and bragging about rare finds.',
  },
  {
    id: 'book-shop',
    name: 'Linae',
    species: 'owl',
    color: 0x795548,
    buildingId: 'book-shop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['book-shop'],
    stats: { hp: 85, attack: 10, defense: 10, speed: 12 },
    personality: 'A quiet, bookish scholar who quotes literature and loves knowledge.',
  },
  {
    id: 'clothing-shop',
    name: 'Prigpants',
    species: 'bunny',
    color: 0xe91e63,
    buildingId: 'clothing-shop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['clothing-shop'],
    stats: { hp: 80, attack: 8, defense: 8, speed: 20 },
    personality: 'A fashionable and dramatic designer who judges others by their style.',
  },
  {
    id: 'bazaar',
    name: 'Nabile',
    species: 'fox',
    color: 0xf44336,
    buildingId: 'bazaar',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['bazaar'],
    stats: { hp: 95, attack: 16, defense: 10, speed: 15 },
    personality: 'A streetwise merchant with a sly wit and a hidden heart of gold.',
  },
  {
    id: 'petpet-shop',
    name: 'Fancypants',
    species: 'bunny',
    color: 0x4caf50,
    buildingId: 'petpet-shop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['petpet-shop'],
    stats: { hp: 80, attack: 9, defense: 9, speed: 18 },
    personality: 'An enthusiastic animal lover who gushes about every creature they meet.',
  },
  {
    id: 'money-tree',
    name: 'The Spirit',
    species: 'turtle',
    color: 0x4caf50,
    buildingId: 'money-tree',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['money-tree'],
    stats: { hp: 120, attack: 12, defense: 18, speed: 6 },
    personality: 'An ancient, wise spirit who speaks slowly and values generosity above all.',
  },
  {
    id: 'rainbow-pool',
    name: 'Aethia',
    species: 'phoenix',
    color: 0x2196f3,
    buildingId: 'rainbow-pool',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['rainbow-pool'],
    stats: { hp: 110, attack: 20, defense: 14, speed: 10 },
    personality: 'A fierce battle faerie and warrior who respects strength and courage.',
  },
  {
    id: 'wishing-well',
    name: 'Oracle',
    species: 'owl',
    color: 0x9c27b0,
    buildingId: 'wishing-well',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['wishing-well'],
    stats: { hp: 90, attack: 14, defense: 12, speed: 11 },
    personality: 'A cryptic fortune-teller who speaks in prophecies and half-truths.',
  },
  {
    id: 'treasure-island',
    name: "Cap'n Rourke",
    species: 'wolf',
    color: 0x9e9e9e,
    buildingId: 'treasure-island',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['treasure-island'],
    stats: { hp: 105, attack: 22, defense: 10, speed: 13 },
    personality: 'A grizzled pirate captain who tells tall tales and guards treasure fiercely.',
  },
  {
    id: 'clawvillen-flats',
    name: 'Janitor Jim',
    species: 'turtle',
    color: 0x9e9e9e,
    buildingId: 'clawvillen-flats',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['clawvillen-flats'],
    stats: { hp: 100, attack: 10, defense: 16, speed: 8 },
    personality: 'A grumpy but lovable janitor who complains about messes and tells old stories.',
  },
  {
    id: 'art-studio',
    name: 'Artsy',
    species: 'cat',
    color: 0xffeb3b,
    buildingId: 'art-studio',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['art-studio'],
    stats: { hp: 85, attack: 12, defense: 8, speed: 15 },
    personality: 'An eccentric artist who sees beauty everywhere and speaks passionately about colors.',
  },
  {
    id: 'juice-shop',
    name: 'Smoothie Sam',
    species: 'bunny',
    color: 0xff9800,
    buildingId: 'juice-shop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['juice-shop'],
    stats: { hp: 80, attack: 11, defense: 7, speed: 19 },
    personality: 'A hyperactive juice vendor who talks a mile a minute and loves tropical fruits.',
  },
  {
    id: 'electronics-shop',
    name: 'Zapper',
    species: 'dragon',
    color: 0x00bcd4,
    buildingId: 'electronics-shop',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['electronics-shop'],
    stats: { hp: 100, attack: 17, defense: 11, speed: 12 },
    personality: 'A tech-obsessed inventor who speaks in jargon and is always tinkering.',
  },
  {
    id: 'pharmacy',
    name: 'Doc Gelert',
    species: 'wolf',
    color: 0xf44336,
    buildingId: 'pharmacy',
    patrolRadius: 128,
    ...NPC_HOME_POSITIONS['pharmacy'],
    stats: { hp: 95, attack: 13, defense: 15, speed: 9 },
    personality: 'A caring doctor who frets about everyone\'s health and offers unsolicited advice.',
  },
];

export const NPC_IDS = NPC_DEFINITIONS.map((n) => n.id);
