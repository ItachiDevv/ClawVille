import { Container, Graphics, Text } from 'pixi.js';
import { TILE_SIZE } from './tilemap-data';

/**
 * Draw a unique illustrated building for each location.
 * Returns a Container positioned at (0,0) — caller sets position.
 */
export function drawBuilding(
  id: string,
  tileWidth: number,
  tileHeight: number,
): Container {
  const w = tileWidth * TILE_SIZE;
  const h = tileHeight * TILE_SIZE;
  const c = new Container();

  switch (id) {
    case 'potion-shop':
      drawPotionShop(c, w, h);
      break;
    case 'auction-house':
      drawAuctionHouse(c, w, h);
      break;
    case 'book-shop':
      drawBookShop(c, w, h);
      break;
    case 'clothing-shop':
      drawClothingShop(c, w, h);
      break;
    case 'bazaar':
      drawBazaar(c, w, h);
      break;
    case 'petpet-shop':
      drawPetpetShop(c, w, h);
      break;
    case 'money-tree':
      drawMoneyTree(c, w, h);
      break;
    case 'rainbow-pool':
      drawRainbowPool(c, w, h);
      break;
    case 'wishing-well':
      drawWishingWell(c, w, h);
      break;
    case 'treasure-island':
      drawTreasureIsland(c, w, h);
      break;
    case 'clawvillen-flats':
      drawClawVillenFlats(c, w, h);
      break;
    case 'art-studio':
      drawArtStudio(c, w, h);
      break;
    case 'juice-shop':
      drawJuiceShop(c, w, h);
      break;
    case 'electronics-shop':
      drawElectronicsShop(c, w, h);
      break;
    case 'pharmacy':
      drawPharmacy(c, w, h);
      break;
    default:
      drawGenericBuilding(c, w, h);
  }

  return c;
}

// ---- Helpers ----

function shadow(g: Graphics, w: number, h: number) {
  g.ellipse(w / 2, h + 4, w / 2 + 4, 6);
  g.fill({ color: 0x000000, alpha: 0.18 });
}

function wall(g: Graphics, x: number, y: number, w: number, h: number, color: number) {
  g.roundRect(x, y, w, h, 4);
  g.fill(color);
  g.stroke({ color: darken(color, 0.25), width: 1.5 });
}

function roof(g: Graphics, x: number, y: number, w: number, h: number, color: number) {
  // Trapezoid roof with overhang
  const oh = 6; // overhang
  g.moveTo(x - oh, y + h);
  g.lineTo(x + oh, y);
  g.lineTo(x + w - oh, y);
  g.lineTo(x + w + oh, y + h);
  g.closePath();
  g.fill(color);
  g.stroke({ color: darken(color, 0.3), width: 1.5 });
}

function door(g: Graphics, cx: number, bottom: number, dw: number, dh: number, color: number = 0x5d4037) {
  // Arched door
  const x = cx - dw / 2;
  const y = bottom - dh;
  g.roundRect(x, y, dw, dh, dw / 2);
  g.fill(color);
  g.stroke({ color: darken(color, 0.3), width: 1 });
  // Doorknob
  g.circle(cx + dw / 4, bottom - dh / 3, 1.5);
  g.fill(0xffd54f);
}

function windowRect(g: Graphics, x: number, y: number, ww: number, wh: number) {
  g.roundRect(x, y, ww, wh, 2);
  g.fill(0xbbdefb);
  g.stroke({ color: 0x90a4ae, width: 1 });
  // Cross dividers
  g.moveTo(x + ww / 2, y);
  g.lineTo(x + ww / 2, y + wh);
  g.stroke({ color: 0x90a4ae, width: 0.8 });
  g.moveTo(x, y + wh / 2);
  g.lineTo(x + ww, y + wh / 2);
  g.stroke({ color: 0x90a4ae, width: 0.8 });
}

function sign(c: Container, text: string, x: number, y: number, bgColor: number = 0x6d4c41) {
  const g = new Graphics();
  const padding = 4;
  const textObj = new Text({
    text,
    style: { fontSize: 9, fill: 0xffffff, fontFamily: 'Arial', fontWeight: 'bold' },
  });
  textObj.anchor.set(0.5, 0.5);
  textObj.x = x;
  textObj.y = y;
  const tw = textObj.width + padding * 2;
  const th = textObj.height + padding;
  // Plaque
  g.roundRect(x - tw / 2, y - th / 2, tw, th, 3);
  g.fill(bgColor);
  g.stroke({ color: darken(bgColor, 0.3), width: 1 });
  // Hanging hooks
  g.moveTo(x - tw / 4, y - th / 2);
  g.lineTo(x - tw / 4, y - th / 2 - 4);
  g.stroke({ color: 0x5d4037, width: 1 });
  g.moveTo(x + tw / 4, y - th / 2);
  g.lineTo(x + tw / 4, y - th / 2 - 4);
  g.stroke({ color: 0x5d4037, width: 1 });
  c.addChild(g);
  c.addChild(textObj);
}

function darken(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount)) | 0;
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount)) | 0;
  const b = Math.max(0, (color & 0xff) * (1 - amount)) | 0;
  return (r << 16) | (g << 8) | b;
}

// ---- Per-building renderers ----

function drawPotionShop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Purple walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0x9c27b0);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x7b1fa2);
  // Windows
  windowRect(g, 10, h * 0.4, 14, 12);
  windowRect(g, w - 24, h * 0.4, 14, 12);
  door(g, w / 2, h, 16, 24, 0x4a148c);
  // Bubbling cauldron at door
  g.ellipse(w / 2 + 18, h - 6, 8, 5);
  g.fill(0x333333);
  // Green smoke wisps
  for (let i = 0; i < 3; i++) {
    g.circle(w / 2 + 16 + i * 4, h - 14 - i * 6, 3 - i * 0.5);
    g.fill({ color: 0x76ff03, alpha: 0.4 - i * 0.1 });
  }
  c.addChild(g);
  sign(c, 'Potion Shop', w / 2, h + 14, 0x6a1b9a);
}

function drawAuctionHouse(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Grand stone walls
  wall(g, 4, h * 0.25, w - 8, h * 0.75, 0xd7ccc8);
  // Columns
  for (const cx of [10, w - 14]) {
    g.rect(cx, h * 0.25, 4, h * 0.75);
    g.fill(0xefebe9);
    g.stroke({ color: 0xbcaaa4, width: 1 });
  }
  roof(g, 2, h * 0.08, w - 4, h * 0.22, 0xef5350);
  // Triangular pediment
  g.moveTo(8, h * 0.25);
  g.lineTo(w / 2, h * 0.08);
  g.lineTo(w - 8, h * 0.25);
  g.closePath();
  g.fill(0xefebe9);
  g.stroke({ color: 0xbcaaa4, width: 1 });
  windowRect(g, w / 2 - 16, h * 0.4, 12, 14);
  windowRect(g, w / 2 + 4, h * 0.4, 12, 14);
  door(g, w / 2, h, 20, 28, 0x5d4037);
  // Golden hammer emblem
  g.rect(w / 2 - 2, h * 0.12, 4, 12);
  g.fill(0xffd54f);
  g.circle(w / 2, h * 0.12, 5);
  g.fill(0xffd54f);
  c.addChild(g);
  sign(c, 'Auction House', w / 2, h + 14, 0x795548);
}

function drawBookShop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Warm brown wood walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0x8d6e63);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x5d4037);
  windowRect(g, 10, h * 0.38, 14, 14);
  windowRect(g, w - 24, h * 0.38, 14, 14);
  door(g, w / 2, h, 14, 22, 0x4e342e);
  // Stacked books in left window
  const bookColors = [0xef5350, 0x42a5f5, 0x66bb6a, 0xffca28];
  for (let i = 0; i < 4; i++) {
    g.rect(12, h * 0.42 + i * 3, 10, 2.5);
    g.fill(bookColors[i]);
  }
  // Lamp glow in right window
  g.circle(w - 17, h * 0.42, 4);
  g.fill({ color: 0xffeb3b, alpha: 0.5 });
  g.circle(w - 17, h * 0.42, 2);
  g.fill({ color: 0xfff9c4, alpha: 0.8 });
  c.addChild(g);
  sign(c, 'Book Shop', w / 2, h + 14, 0x5d4037);
}

function drawClothingShop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Pink/magenta walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xec407a);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0xc2185b);
  // Striped awning
  for (let i = 0; i < 6; i++) {
    const sx = 4 + i * ((w - 8) / 6);
    g.rect(sx, h * 0.28, (w - 8) / 6, 6);
    g.fill(i % 2 === 0 ? 0xf8bbd0 : 0xffffff);
  }
  windowRect(g, w / 2 - 18, h * 0.4, 14, 14);
  door(g, w / 2, h, 14, 22, 0x880e4f);
  // Mannequin silhouette in window
  g.circle(w / 2 - 11, h * 0.42, 3);
  g.fill(0xf48fb1);
  g.moveTo(w / 2 - 11, h * 0.45);
  g.lineTo(w / 2 - 14, h * 0.55);
  g.lineTo(w / 2 - 8, h * 0.55);
  g.closePath();
  g.fill(0xf48fb1);
  c.addChild(g);
  sign(c, 'Clothing Shop', w / 2, h + 14, 0xad1457);
}

function drawBazaar(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Multiple market stalls
  const stallColors = [0xef5350, 0xffa726, 0x66bb6a, 0x42a5f5];
  const stallW = (w - 12) / 2;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const sx = 4 + i * (stallW + 4);
      const sy = h * 0.2 + j * (h * 0.38);
      // Stall base
      g.roundRect(sx, sy + 10, stallW, h * 0.3, 3);
      g.fill(0xd7ccc8);
      g.stroke({ color: 0xbcaaa4, width: 1 });
      // Striped awning
      for (let k = 0; k < 4; k++) {
        g.rect(sx + k * (stallW / 4), sy, stallW / 4, 12);
        g.fill(k % 2 === 0 ? stallColors[i * 2 + j] : 0xffffff);
      }
    }
  }
  // Hanging goods
  g.circle(w / 4, h * 0.45, 4);
  g.fill(0xffca28);
  g.circle(w * 3 / 4, h * 0.45, 4);
  g.fill(0xef5350);
  c.addChild(g);
  sign(c, 'Bazaar', w / 2, h + 14, 0x795548);
}

function drawPetpetShop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xffe0b2);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x66bb6a);
  windowRect(g, 10, h * 0.4, w - 20, 16);
  door(g, w / 2, h, 14, 22, 0x5d4037);
  // Paw prints on door
  for (const [px, py] of [[w / 2 - 4, h - 18], [w / 2 + 2, h - 14]] as [number, number][]) {
    g.circle(px, py, 2);
    g.fill(0x8d6e63);
    g.circle(px - 2, py - 3, 1.2);
    g.fill(0x8d6e63);
    g.circle(px + 2, py - 3, 1.2);
    g.fill(0x8d6e63);
  }
  // Small creature silhouettes in window
  g.circle(16, h * 0.46, 4);
  g.fill({ color: 0xf48fb1, alpha: 0.6 });
  g.circle(w - 16, h * 0.46, 3);
  g.fill({ color: 0x81d4fa, alpha: 0.6 });
  c.addChild(g);
  sign(c, 'Petpet Shop', w / 2, h + 14, 0x4caf50);
}

function drawMoneyTree(c: Container, w: number, h: number) {
  const g = new Graphics();
  // Shadow under canopy
  g.ellipse(w / 2, h - 4, w / 2 + 8, 10);
  g.fill({ color: 0x000000, alpha: 0.12 });
  // Trunk
  g.roundRect(w / 2 - 8, h * 0.35, 16, h * 0.65, 4);
  g.fill(0x795548);
  g.stroke({ color: 0x5d4037, width: 2 });
  // Bark texture
  for (let i = 0; i < 4; i++) {
    g.moveTo(w / 2 - 4, h * 0.4 + i * 12);
    g.lineTo(w / 2 + 2, h * 0.45 + i * 12);
    g.stroke({ color: 0x5d4037, width: 0.8 });
  }
  // Leafy canopy — overlapping circles
  const canopyColors = [0x2e7d32, 0x388e3c, 0x43a047, 0x4caf50, 0x66bb6a];
  const offsets = [
    [0, -8], [-18, 4], [18, 4], [-10, -14], [10, -14],
    [0, -22], [-14, -6], [14, -6], [-6, 6], [6, 6],
  ];
  for (let i = 0; i < offsets.length; i++) {
    const [ox, oy] = offsets[i];
    g.circle(w / 2 + ox, h * 0.28 + oy, 14 + (i % 3) * 2);
    g.fill(canopyColors[i % canopyColors.length]);
  }
  // Golden coins scattered
  for (const [cx, cy] of [[w / 2 - 12, h - 8], [w / 2 + 8, h - 6], [w / 2 - 4, h - 2], [w / 2 + 14, h - 10]] as [number, number][]) {
    g.circle(cx, cy, 3);
    g.fill(0xffd54f);
    g.stroke({ color: 0xf9a825, width: 0.8 });
  }
  // Magical glow
  g.circle(w / 2, h * 0.25, 28);
  g.fill({ color: 0xffeb3b, alpha: 0.08 });
  c.addChild(g);
  sign(c, 'Money Tree', w / 2, h + 14, 0x2e7d32);
}

function drawRainbowPool(c: Container, w: number, h: number) {
  const g = new Graphics();
  // Pool base
  g.roundRect(4, h * 0.3, w - 8, h * 0.65, 12);
  g.fill(0x1e88e5);
  g.stroke({ color: 0x9e9e9e, width: 3 });
  // Pool edge stones
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const rx = w / 2 + Math.cos(angle) * (w / 2 - 6);
    const ry = h * 0.62 + Math.sin(angle) * (h * 0.28);
    g.circle(rx, ry, 5);
    g.fill(0xbdbdbd);
    g.stroke({ color: 0x9e9e9e, width: 1 });
  }
  // Water highlights
  g.ellipse(w / 2, h * 0.55, w / 3, h / 6);
  g.fill({ color: 0x64b5f6, alpha: 0.5 });
  // Rainbow arc
  const rainbowColors = [0xef5350, 0xff9800, 0xffeb3b, 0x4caf50, 0x2196f3, 0x9c27b0];
  for (let i = 0; i < rainbowColors.length; i++) {
    g.arc(w / 2, h * 0.35, 30 - i * 3, Math.PI, 0);
    g.stroke({ color: rainbowColors[i], width: 2.5 });
  }
  // Sparkles (diamond shapes)
  for (const [sx, sy] of [[w / 4, h * 0.2], [w * 3 / 4, h * 0.15], [w / 2, h * 0.08]] as [number, number][]) {
    g.moveTo(sx, sy - 3);
    g.lineTo(sx + 2, sy);
    g.lineTo(sx, sy + 3);
    g.lineTo(sx - 2, sy);
    g.closePath();
    g.fill({ color: 0xffffff, alpha: 0.8 });
  }
  c.addChild(g);
  sign(c, 'Rainbow Pool', w / 2, h + 14, 0x1565c0);
}

function drawWishingWell(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Circular stone well
  g.ellipse(w / 2, h * 0.65, w / 2 - 6, h * 0.2);
  g.fill(0x9e9e9e);
  g.stroke({ color: 0x757575, width: 2 });
  // Well wall
  g.rect(8, h * 0.45, w - 16, h * 0.22);
  g.fill(0xbdbdbd);
  g.stroke({ color: 0x9e9e9e, width: 1 });
  // Stone texture
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const bx = 10 + col * ((w - 20) / 3);
      const by = h * 0.47 + row * 10;
      g.roundRect(bx, by, (w - 24) / 3, 8, 2);
      g.stroke({ color: 0x9e9e9e, width: 0.6 });
    }
  }
  // Wooden roof supports
  g.rect(12, h * 0.15, 3, h * 0.35);
  g.fill(0x795548);
  g.rect(w - 15, h * 0.15, 3, h * 0.35);
  g.fill(0x795548);
  // Wooden roof
  g.moveTo(4, h * 0.2);
  g.lineTo(w / 2, h * 0.02);
  g.lineTo(w - 4, h * 0.2);
  g.closePath();
  g.fill(0x8d6e63);
  g.stroke({ color: 0x5d4037, width: 1.5 });
  // Rope + bucket
  g.moveTo(w / 2, h * 0.15);
  g.lineTo(w / 2, h * 0.55);
  g.stroke({ color: 0x8d6e63, width: 1.5 });
  g.roundRect(w / 2 - 4, h * 0.5, 8, 8, 2);
  g.fill(0x795548);
  // Coin splash
  g.circle(w / 2, h * 0.6, 2);
  g.fill({ color: 0xffd54f, alpha: 0.7 });
  c.addChild(g);
  sign(c, 'Wishing Well', w / 2, h + 14, 0x795548);
}

function drawTreasureIsland(c: Container, w: number, h: number) {
  const g = new Graphics();
  // Sandy base
  g.ellipse(w / 2, h * 0.75, w / 2 + 4, h * 0.3);
  g.fill(0xffe082);
  g.stroke({ color: 0xffca28, width: 1 });
  // Palm tree trunk
  g.moveTo(w * 0.3, h * 0.7);
  g.quadraticCurveTo(w * 0.25, h * 0.3, w * 0.35, h * 0.1);
  g.stroke({ color: 0x795548, width: 5 });
  // Palm leaves
  const leafColor = 0x2e7d32;
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
    const lx = w * 0.35 + Math.cos(angle) * 20;
    const ly = h * 0.08 + Math.sin(angle) * 10;
    g.moveTo(w * 0.35, h * 0.1);
    g.quadraticCurveTo(w * 0.35 + Math.cos(angle) * 10, h * 0.1 + Math.sin(angle) * 5, lx, ly);
    g.stroke({ color: leafColor, width: 3 });
  }
  // Treasure chest
  g.roundRect(w * 0.55, h * 0.55, 24, 16, 3);
  g.fill(0x8d6e63);
  g.stroke({ color: 0x5d4037, width: 1.5 });
  g.rect(w * 0.55, h * 0.55, 24, 3);
  g.fill(0xffd54f);
  // Gems peeking out
  g.circle(w * 0.6, h * 0.55, 3);
  g.fill(0xef5350);
  g.circle(w * 0.66, h * 0.54, 2.5);
  g.fill(0x42a5f5);
  g.circle(w * 0.72, h * 0.56, 2);
  g.fill(0x66bb6a);
  c.addChild(g);
  sign(c, 'Treasure Island', w / 2, h + 14, 0xf9a825);
}

function drawClawVillenFlats(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Multi-story apartment
  wall(g, 4, h * 0.15, w - 8, h * 0.85, 0xffccbc);
  roof(g, 4, h * 0.05, w - 8, h * 0.15, 0xef5350);
  // Multiple windows in grid
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 2; col++) {
      windowRect(g, 10 + col * (w / 2 - 10), h * 0.2 + row * (h * 0.2), 12, 10);
    }
  }
  door(g, w / 2, h, 16, 22, 0x5d4037);
  // Flower boxes under windows
  for (let col = 0; col < 2; col++) {
    const bx = 10 + col * (w / 2 - 10);
    g.rect(bx - 1, h * 0.31, 14, 4);
    g.fill(0x795548);
    // Flowers
    g.circle(bx + 3, h * 0.3, 2.5);
    g.fill(0xef5350);
    g.circle(bx + 7, h * 0.29, 2.5);
    g.fill(0xffca28);
    g.circle(bx + 11, h * 0.3, 2.5);
    g.fill(0xf48fb1);
  }
  c.addChild(g);
  sign(c, 'ClawVillen Flats', w / 2, h + 14, 0xbf360c);
}

function drawArtStudio(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Paint-splattered walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xfff3e0);
  // Paint splatters on wall
  const splatColors = [0xef5350, 0x42a5f5, 0xffca28, 0x66bb6a, 0x9c27b0];
  for (let i = 0; i < 8; i++) {
    g.circle(8 + Math.random() * (w - 16), h * 0.35 + Math.random() * (h * 0.55), 2 + Math.random() * 3);
    g.fill({ color: splatColors[i % splatColors.length], alpha: 0.5 });
  }
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x42a5f5);
  door(g, w / 2, h, 14, 22, 0x1565c0);
  // Easel visible through window
  windowRect(g, w - 24, h * 0.4, 14, 14);
  g.moveTo(w - 20, h * 0.42);
  g.lineTo(w - 17, h * 0.54);
  g.lineTo(w - 14, h * 0.42);
  g.stroke({ color: 0x795548, width: 1 });
  g.rect(w - 20, h * 0.42, 6, 8);
  g.fill({ color: 0xffffff, alpha: 0.6 });
  // Rainbow palette sign
  g.circle(w / 2, h * 0.2, 6);
  g.fill(0xffca28);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI + 0.3;
    g.circle(w / 2 + Math.cos(angle) * 4, h * 0.2 + Math.sin(angle) * 3, 1.5);
    g.fill(splatColors[i]);
  }
  c.addChild(g);
  sign(c, 'Art Studio', w / 2, h + 14, 0x1565c0);
}

function drawJuiceShop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Tropical orange walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xff9800);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0xe65100);
  windowRect(g, 10, h * 0.4, 14, 12);
  door(g, w / 2, h, 14, 22, 0xbf360c);
  // Fruit decorations — orange slice
  g.circle(w - 16, h * 0.45, 5);
  g.fill(0xffa726);
  g.stroke({ color: 0xff9800, width: 0.8 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI;
    g.moveTo(w - 16, h * 0.45);
    g.lineTo(w - 16 + Math.cos(a) * 4, h * 0.45 + Math.sin(a) * 4);
    g.stroke({ color: 0xffe0b2, width: 0.8 });
  }
  // Watermelon slice
  g.arc(w / 2 + 16, h * 0.35, 6, Math.PI, 0);
  g.fill(0x66bb6a);
  g.arc(w / 2 + 16, h * 0.35, 4, Math.PI, 0);
  g.fill(0xef5350);
  // Straw
  g.moveTo(w / 2 + 20, h * 0.3);
  g.lineTo(w / 2 + 22, h * 0.22);
  g.stroke({ color: 0xffca28, width: 1.5 });
  c.addChild(g);
  sign(c, 'Juice Shop', w / 2, h + 14, 0xe65100);
}

function drawElectronicsShop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Modern grey/blue walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0x78909c);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x37474f);
  windowRect(g, 10, h * 0.4, w - 20, 16);
  door(g, w / 2, h, 14, 22, 0x263238);
  // Circuit patterns on wall
  g.moveTo(8, h * 0.7);
  g.lineTo(16, h * 0.7);
  g.lineTo(16, h * 0.6);
  g.lineTo(24, h * 0.6);
  g.stroke({ color: 0x4fc3f7, width: 1 });
  g.moveTo(w - 8, h * 0.75);
  g.lineTo(w - 16, h * 0.75);
  g.lineTo(w - 16, h * 0.65);
  g.stroke({ color: 0x4fc3f7, width: 1 });
  // Antenna on roof
  g.moveTo(w / 2, h * 0.15);
  g.lineTo(w / 2, h * 0.02);
  g.stroke({ color: 0x546e7a, width: 2 });
  g.circle(w / 2, h * 0.02, 3);
  g.fill(0xef5350);
  // Screen glow in window
  g.roundRect(w / 2 - 8, h * 0.42, 16, 10, 2);
  g.fill({ color: 0x4fc3f7, alpha: 0.4 });
  c.addChild(g);
  sign(c, 'Electronics', w / 2, h + 14, 0x37474f);
}

function drawPharmacy(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // White + green walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xf5f5f5);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x4caf50);
  windowRect(g, 10, h * 0.4, 14, 12);
  door(g, w / 2, h, 14, 22, 0x2e7d32);
  // Green cross emblem
  const cx = w - 17;
  const cy = h * 0.45;
  g.rect(cx - 2, cy - 6, 4, 12);
  g.fill(0x4caf50);
  g.rect(cx - 6, cy - 2, 12, 4);
  g.fill(0x4caf50);
  // Medicine bottles in window
  for (let i = 0; i < 3; i++) {
    g.roundRect(12 + i * 4, h * 0.44, 3, 7, 1);
    g.fill([0x42a5f5, 0xef5350, 0xffca28][i]);
  }
  c.addChild(g);
  sign(c, 'Pharmacy', w / 2, h + 14, 0x2e7d32);
}

function drawGenericBuilding(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xd7ccc8);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x8d6e63);
  windowRect(g, 10, h * 0.4, 14, 12);
  door(g, w / 2, h, 14, 22, 0x5d4037);
  c.addChild(g);
  sign(c, 'Building', w / 2, h + 14, 0x795548);
}
