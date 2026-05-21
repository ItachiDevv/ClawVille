/**
 * Mock data mirroring the production engine's reel strips + symbol assets.
 * Lets the playground prototype against the SAME data shapes the real engine
 * emits, so a working rig can be lifted into apps/web with zero contract
 * changes.
 *
 * NOTE: this is a STATIC SNAPSHOT — when the production strips change, copy
 * the new CLASSIC_REEL_STRIPS array verbatim here. Drift between this file
 * and packages/shared/.../slot-paytables.ts is OK for visual iteration but
 * will cause winning-line evaluations to diverge if you wire mock spin
 * logic.
 */

export const REEL_COUNT   = 5;
export const VISIBLE_ROWS = 3;
export const STRIP_LEN    = 84;

/** Symbol IDs — match production. */
export const SYMBOL_IDS = {
  CLAW:       0,
  ROBOT:      1,
  ELIZA:      2,
  SQUIRREL:   3,
  MILADY:     4,
  BAR:        5,
  SEVEN:      6,
  CLAWBSTER:  7,  // WILD
  BAR_2X:     8,
  BAR_3X:     9,
  ELIZA_COIN: 10, // SCATTER
} as const;

export interface SlotSymbolAsset {
  id:          number;
  imagePath:   string;
  displayName: string;
  themeColor:  string;
}

/** Asset registry — mirrors apps/web's CLASSIC_SLOT_SYMBOL_ASSETS. */
export const SYMBOL_ASSETS: SlotSymbolAsset[] = [
  { id: 0,  imagePath: '/symbols/claw.png',       displayName: 'Claw',       themeColor: '#d62828' },
  { id: 1,  imagePath: '/symbols/robot.png',      displayName: 'Robot',      themeColor: '#fbbf24' },
  { id: 2,  imagePath: '/symbols/eliza.png',      displayName: 'Eliza',      themeColor: '#ff8c42' },
  { id: 3,  imagePath: '/symbols/squirrel.png',   displayName: 'Squirrel',   themeColor: '#ff6b35' },
  { id: 4,  imagePath: '/symbols/milady.png',     displayName: 'Milady',     themeColor: '#ec4899' },
  { id: 5,  imagePath: '/symbols/s5.svg',         displayName: 'BAR',        themeColor: '#d62828' },
  { id: 6,  imagePath: '/symbols/s6.svg',         displayName: 'Seven',      themeColor: '#ff3838' },
  { id: 7,  imagePath: '/symbols/clawbster.png',  displayName: 'Clawbster',  themeColor: '#d65950' },
  { id: 8,  imagePath: '/symbols/s8.svg',         displayName: 'BAR×2',      themeColor: '#c0223a' },
  { id: 9,  imagePath: '/symbols/s9.svg',         displayName: 'BAR×3',      themeColor: '#a01828' },
  { id: 10, imagePath: '/symbols/eliza-coin.png', displayName: 'Eliza Coin', themeColor: '#3b82f6' },
];

/** 5 reels × 84 strip positions — copied verbatim from production. */
export const CLASSIC_REEL_STRIPS: number[][] = [
  [0,0,4,2,0,3,1,1,5,2,1,3,1,2,0,2,1,0,3,2,1,3,3,2,0,6,2,1,0,0,1,0,1,0,1,0,0,4,2,0,2,4,7,1,1,2,4,1,3,1,1,4,0,1,3,3,4,2,8,0,1,0,4,2,3,3,3,0,1,2,1,1,3,3,3,9,0,1,0,1,0,2,0,0],
  [2,3,0,1,0,3,1,0,6,0,1,0,0,2,0,0,3,3,0,2,1,4,1,0,3,7,0,1,3,1,1,4,2,0,1,0,2,1,4,2,0,1,8,0,2,3,3,1,3,1,0,2,2,1,3,2,3,0,9,4,2,0,4,1,3,0,1,1,4,0,0,1,2,3,0,5,1,1,4,3,1,1,2,2],
  [4,2,0,3,1,0,0,4,7,4,0,1,0,0,0,3,0,2,3,0,2,0,3,2,0,8,4,0,1,1,3,3,2,2,1,0,2,1,3,2,3,0,9,2,4,0,2,1,1,1,1,2,1,3,1,1,0,2,5,2,0,2,0,4,1,1,0,1,1,1,3,1,4,3,1,6,3,0,3,1,3,1,0,0],
  [1,0,0,3,1,0,0,3,8,2,0,0,4,2,1,1,0,4,0,1,2,1,3,3,3,9,1,0,1,3,1,0,1,3,0,4,2,2,1,0,3,3,5,0,1,4,2,1,2,1,0,1,4,3,1,2,0,0,6,0,3,4,1,0,2,3,2,3,2,0,1,1,0,3,2,7,1,4,1,2,0,0,2,1],
  [0,4,0,2,3,4,1,4,9,0,2,0,4,0,0,1,1,1,3,2,1,1,3,4,3,5,1,1,3,4,2,3,1,1,3,2,1,3,2,2,0,2,6,3,0,1,2,0,0,1,1,1,3,0,1,0,2,1,7,1,1,1,2,2,0,0,3,0,0,1,4,1,0,3,0,8,2,0,3,0,2,0,0,3],
];

/** Pick a deterministic "winning" 3-row window per reel for fake spin results. */
export function mockSpinResult(seed: number = Date.now()): { reels: number[][] } {
  const rng = (i: number) => {
    const x = Math.sin(seed * 9301 + i * 49297) * 233280;
    return Math.abs(x - Math.floor(x));
  };
  const reels: number[][] = [];
  for (let r = 0; r < REEL_COUNT; r++) {
    const L = STRIP_LEN;
    const p = Math.floor(rng(r) * L);
    const strip = CLASSIC_REEL_STRIPS[r];
    reels.push([
      strip[(p - 1 + L) % L],
      strip[p],
      strip[(p + 1) % L],
    ]);
  }
  return { reels };
}
