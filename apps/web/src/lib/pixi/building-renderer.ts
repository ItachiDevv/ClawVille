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
    case 'cron-hub':
      drawCronHub(c, w, h);
      break;
    case 'webhook-gateway':
      drawWebhookGateway(c, w, h);
      break;
    case 'memory-vault':
      drawMemoryVault(c, w, h);
      break;
    case 'skill-forge':
      drawSkillForge(c, w, h);
      break;
    case 'channel-bridge':
      drawChannelBridge(c, w, h);
      break;
    case 'tool-workshop':
      drawToolWorkshop(c, w, h);
      break;
    case 'canvas-studio':
      drawCanvasStudio(c, w, h);
      break;
    case 'voice-tower':
      drawVoiceTower(c, w, h);
      break;
    case 'security-fortress':
      drawSecurityFortress(c, w, h);
      break;
    case 'config-citadel':
      drawConfigCitadel(c, w, h);
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

function drawCronHub(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Brown/gold clock-tower walls
  wall(g, 4, h * 0.2, w - 8, h * 0.8, 0x8d6e63);
  roof(g, 4, h * 0.05, w - 8, h * 0.2, 0xffa000);
  // Clock face on upper wall
  const clockCx = w / 2;
  const clockCy = h * 0.35;
  g.circle(clockCx, clockCy, 12);
  g.fill(0xfff8e1);
  g.stroke({ color: 0xffd54f, width: 2 });
  // Clock hands
  g.moveTo(clockCx, clockCy);
  g.lineTo(clockCx, clockCy - 8);
  g.stroke({ color: 0x5d4037, width: 1.5 });
  g.moveTo(clockCx, clockCy);
  g.lineTo(clockCx + 6, clockCy + 2);
  g.stroke({ color: 0x5d4037, width: 1 });
  // Hour marks
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    g.circle(clockCx + Math.cos(angle) * 10, clockCy + Math.sin(angle) * 10, 1);
    g.fill(0x795548);
  }
  // Gear motifs on walls
  for (const gx of [12, w - 16]) {
    g.circle(gx, h * 0.6, 5);
    g.stroke({ color: 0xffd54f, width: 1.2 });
    for (let t = 0; t < 6; t++) {
      const a = (t / 6) * Math.PI * 2;
      g.moveTo(gx + Math.cos(a) * 4, h * 0.6 + Math.sin(a) * 4);
      g.lineTo(gx + Math.cos(a) * 7, h * 0.6 + Math.sin(a) * 7);
      g.stroke({ color: 0xffd54f, width: 1 });
    }
  }
  // Pendulum below clock
  g.moveTo(clockCx, clockCy + 12);
  g.lineTo(clockCx - 3, h * 0.58);
  g.stroke({ color: 0x795548, width: 1 });
  g.circle(clockCx - 3, h * 0.58, 3);
  g.fill(0xffd54f);
  g.stroke({ color: 0xf9a825, width: 0.8 });
  windowRect(g, 10, h * 0.68, 12, 10);
  windowRect(g, w - 22, h * 0.68, 12, 10);
  door(g, w / 2, h, 14, 22, 0x4e342e);
  c.addChild(g);
  sign(c, 'Cron Hub', w / 2, h + 14, 0x795548);
}

function drawWebhookGateway(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Orange gateway walls
  wall(g, 4, h * 0.25, w - 8, h * 0.75, 0xfb8c00);
  roof(g, 4, h * 0.1, w - 8, h * 0.2, 0xe65100);
  // Gateway arch over door
  g.arc(w / 2, h * 0.65, 16, Math.PI, 0);
  g.stroke({ color: 0xffd54f, width: 3 });
  g.arc(w / 2, h * 0.65, 20, Math.PI, 0);
  g.stroke({ color: 0xffe082, width: 1.5 });
  // Signal lines radiating from top
  for (let i = 0; i < 5; i++) {
    const sx = 8 + i * ((w - 16) / 4);
    g.moveTo(sx, h * 0.28);
    g.lineTo(sx, h * 0.22);
    g.stroke({ color: 0xfff3e0, width: 1 });
    g.circle(sx, h * 0.21, 1.5);
    g.fill(0xfff3e0);
  }
  // Arrow decorations on walls
  for (const [ax, dir] of [[14, 1], [w - 14, -1]] as [number, number][]) {
    g.moveTo(ax - 4 * dir, h * 0.5);
    g.lineTo(ax + 4 * dir, h * 0.5);
    g.lineTo(ax + 2 * dir, h * 0.47);
    g.stroke({ color: 0xfff8e1, width: 1.5 });
    g.moveTo(ax + 4 * dir, h * 0.5);
    g.lineTo(ax + 2 * dir, h * 0.53);
    g.stroke({ color: 0xfff8e1, width: 1.5 });
  }
  windowRect(g, 10, h * 0.35, 12, 10);
  windowRect(g, w - 22, h * 0.35, 12, 10);
  door(g, w / 2, h, 16, 24, 0xbf360c);
  c.addChild(g);
  sign(c, 'Webhook Gateway', w / 2, h + 14, 0xe65100);
}

function drawMemoryVault(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Dark green vault walls
  wall(g, 4, h * 0.25, w - 8, h * 0.75, 0x2e7d32);
  roof(g, 4, h * 0.1, w - 8, h * 0.2, 0x1b5e20);
  // Heavy vault door (circular)
  const vaultCx = w / 2;
  const vaultBottom = h;
  g.circle(vaultCx, vaultBottom - 16, 14);
  g.fill(0x546e7a);
  g.stroke({ color: 0x37474f, width: 2 });
  // Vault handle (wheel)
  g.circle(vaultCx, vaultBottom - 16, 8);
  g.stroke({ color: 0x90a4ae, width: 1.5 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    g.moveTo(vaultCx, vaultBottom - 16);
    g.lineTo(vaultCx + Math.cos(a) * 7, vaultBottom - 16 + Math.sin(a) * 7);
    g.stroke({ color: 0x90a4ae, width: 1 });
  }
  // Brain/circuit motifs on walls
  g.moveTo(10, h * 0.5);
  g.lineTo(16, h * 0.5);
  g.lineTo(16, h * 0.42);
  g.lineTo(22, h * 0.42);
  g.stroke({ color: 0x81c784, width: 1 });
  g.circle(22, h * 0.42, 2);
  g.fill(0xa5d6a7);
  g.moveTo(w - 10, h * 0.48);
  g.lineTo(w - 16, h * 0.48);
  g.lineTo(w - 16, h * 0.55);
  g.lineTo(w - 22, h * 0.55);
  g.stroke({ color: 0x81c784, width: 1 });
  g.circle(w - 22, h * 0.55, 2);
  g.fill(0xa5d6a7);
  // Brain oval on upper wall
  g.ellipse(w / 2, h * 0.35, 8, 6);
  g.stroke({ color: 0xa5d6a7, width: 1.2 });
  g.moveTo(w / 2 - 4, h * 0.35);
  g.quadraticCurveTo(w / 2, h * 0.32, w / 2 + 4, h * 0.35);
  g.stroke({ color: 0xa5d6a7, width: 0.8 });
  windowRect(g, 10, h * 0.38, 10, 10);
  windowRect(g, w - 20, h * 0.38, 10, 10);
  c.addChild(g);
  sign(c, 'Memory Vault', w / 2, h + 14, 0x1b5e20);
}

function drawSkillForge(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Dark red/iron walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xb71c1c);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x4e342e);
  // Anvil shape at entrance
  const anvX = w / 2 + 18;
  const anvY = h - 8;
  g.moveTo(anvX - 8, anvY);
  g.lineTo(anvX - 6, anvY - 6);
  g.lineTo(anvX + 6, anvY - 6);
  g.lineTo(anvX + 8, anvY);
  g.closePath();
  g.fill(0x616161);
  g.stroke({ color: 0x424242, width: 1 });
  g.rect(anvX - 3, anvY - 10, 6, 4);
  g.fill(0x757575);
  // Flame decorations on walls
  for (const fx of [12, w - 16]) {
    // Flame shape (three overlapping teardrops)
    g.moveTo(fx, h * 0.55);
    g.quadraticCurveTo(fx - 4, h * 0.45, fx, h * 0.38);
    g.quadraticCurveTo(fx + 4, h * 0.45, fx, h * 0.55);
    g.fill({ color: 0xff6f00, alpha: 0.7 });
    g.moveTo(fx, h * 0.53);
    g.quadraticCurveTo(fx - 2, h * 0.46, fx, h * 0.42);
    g.quadraticCurveTo(fx + 2, h * 0.46, fx, h * 0.53);
    g.fill({ color: 0xffca28, alpha: 0.8 });
  }
  // Chimney with smoke
  g.rect(w - 18, h * 0.05, 8, h * 0.15);
  g.fill(0x5d4037);
  g.stroke({ color: 0x4e342e, width: 1 });
  for (let i = 0; i < 3; i++) {
    g.circle(w - 14 + i * 2, h * 0.02 - i * 5, 3 - i * 0.5);
    g.fill({ color: 0x9e9e9e, alpha: 0.3 - i * 0.08 });
  }
  door(g, w / 2, h, 16, 24, 0x3e2723);
  // Hammer and spark on door
  g.moveTo(w / 2 - 2, h - 20);
  g.lineTo(w / 2 - 2, h - 12);
  g.stroke({ color: 0x8d6e63, width: 2 });
  g.rect(w / 2 - 5, h - 22, 6, 4);
  g.fill(0x757575);
  c.addChild(g);
  sign(c, 'Skill Forge', w / 2, h + 14, 0x4e342e);
}

function drawChannelBridge(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Blue bridge-themed walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0x1565c0);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x0d47a1);
  // Bridge cable lines from roof peaks
  g.moveTo(4, h * 0.3);
  g.quadraticCurveTo(w / 2, h * 0.05, w - 4, h * 0.3);
  g.stroke({ color: 0x90caf9, width: 1.5 });
  // Vertical cable drops
  for (let i = 1; i < 5; i++) {
    const cx = 4 + i * ((w - 8) / 5);
    const topY = h * 0.15 + Math.sin((i / 5) * Math.PI) * (-h * 0.08);
    g.moveTo(cx, h * 0.3);
    g.lineTo(cx, topY + h * 0.12);
    g.stroke({ color: 0x90caf9, width: 0.8 });
  }
  // Multi-colored connection lines on wall
  const lineColors = [0xef5350, 0x66bb6a, 0xffca28, 0x9c27b0];
  for (let i = 0; i < 4; i++) {
    const ly = h * 0.5 + i * 6;
    g.moveTo(8, ly);
    g.lineTo(w / 2 - 10, ly);
    g.stroke({ color: lineColors[i], width: 1.2 });
    g.circle(w / 2 - 10, ly, 2);
    g.fill(lineColors[i]);
    g.moveTo(w / 2 + 10, ly);
    g.lineTo(w - 8, ly);
    g.stroke({ color: lineColors[i], width: 1.2 });
    g.circle(w / 2 + 10, ly, 2);
    g.fill(lineColors[i]);
  }
  windowRect(g, 10, h * 0.38, 12, 10);
  windowRect(g, w - 22, h * 0.38, 12, 10);
  door(g, w / 2, h, 14, 22, 0x0d47a1);
  c.addChild(g);
  sign(c, 'Channel Bridge', w / 2, h + 14, 0x0d47a1);
}

function drawToolWorkshop(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Purple/brown workshop shed walls
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0x6a1b9a);
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x5d4037);
  // Hanging tools on left wall
  // Wrench
  g.moveTo(12, h * 0.4);
  g.lineTo(12, h * 0.52);
  g.stroke({ color: 0xbdbdbd, width: 1.5 });
  g.circle(12, h * 0.39, 3);
  g.stroke({ color: 0xbdbdbd, width: 1 });
  // Hammer
  g.moveTo(20, h * 0.4);
  g.lineTo(20, h * 0.54);
  g.stroke({ color: 0x8d6e63, width: 1.5 });
  g.rect(17, h * 0.37, 6, 4);
  g.fill(0x757575);
  // Screwdriver
  g.moveTo(28, h * 0.4);
  g.lineTo(28, h * 0.55);
  g.stroke({ color: 0xffca28, width: 1.5 });
  g.moveTo(28, h * 0.55);
  g.lineTo(28, h * 0.58);
  g.stroke({ color: 0xbdbdbd, width: 1 });
  // Gear decorations on right wall
  for (const [gx, gy, gr] of [[w - 14, h * 0.45, 5], [w - 22, h * 0.52, 4]] as [number, number, number][]) {
    g.circle(gx, gy, gr);
    g.stroke({ color: 0xce93d8, width: 1 });
    for (let t = 0; t < 6; t++) {
      const a = (t / 6) * Math.PI * 2;
      g.moveTo(gx + Math.cos(a) * (gr - 1), gy + Math.sin(a) * (gr - 1));
      g.lineTo(gx + Math.cos(a) * (gr + 2), gy + Math.sin(a) * (gr + 2));
      g.stroke({ color: 0xce93d8, width: 0.8 });
    }
  }
  // Workbench at base
  g.rect(6, h * 0.82, w - 12, 4);
  g.fill(0x795548);
  g.stroke({ color: 0x5d4037, width: 1 });
  windowRect(g, w / 2 + 6, h * 0.38, 12, 12);
  door(g, w / 2, h, 14, 22, 0x4a148c);
  c.addChild(g);
  sign(c, 'Tool Workshop', w / 2, h + 14, 0x4a148c);
}

function drawCanvasStudio(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Light walls with color splashes
  wall(g, 4, h * 0.3, w - 8, h * 0.7, 0xfff3e0);
  // Paint splatters on wall
  const splatColors = [0xef5350, 0x42a5f5, 0xffca28, 0x66bb6a, 0x9c27b0, 0xff9800];
  for (let i = 0; i < 10; i++) {
    const sx = 8 + (i * 7 + 3) % (w - 16);
    const sy = h * 0.35 + (i * 11 + 5) % (h * 0.5);
    g.circle(sx, sy, 2 + (i % 3));
    g.fill({ color: splatColors[i % splatColors.length], alpha: 0.5 });
  }
  roof(g, 4, h * 0.15, w - 8, h * 0.2, 0x42a5f5);
  // Easel on left side
  g.moveTo(12, h * 0.5);
  g.lineTo(16, h * 0.72);
  g.stroke({ color: 0x795548, width: 1.5 });
  g.moveTo(20, h * 0.5);
  g.lineTo(16, h * 0.72);
  g.stroke({ color: 0x795548, width: 1.5 });
  g.moveTo(16, h * 0.5);
  g.lineTo(10, h * 0.68);
  g.stroke({ color: 0x795548, width: 1 });
  // Canvas on easel
  g.rect(11, h * 0.42, 10, 10);
  g.fill(0xffffff);
  g.stroke({ color: 0x795548, width: 0.8 });
  // Paint daubs on canvas
  g.circle(14, h * 0.45, 2);
  g.fill(0xef5350);
  g.circle(18, h * 0.47, 2);
  g.fill(0x42a5f5);
  g.circle(16, h * 0.49, 1.5);
  g.fill(0xffca28);
  // Rainbow palette emblem on upper wall
  g.circle(w / 2, h * 0.22, 6);
  g.fill(0xffca28);
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI + 0.3;
    g.circle(w / 2 + Math.cos(angle) * 4, h * 0.22 + Math.sin(angle) * 3, 1.5);
    g.fill(splatColors[i]);
  }
  windowRect(g, w - 24, h * 0.4, 14, 14);
  door(g, w / 2, h, 14, 22, 0x1565c0);
  c.addChild(g);
  sign(c, 'Canvas Studio', w / 2, h + 14, 0x1565c0);
}

function drawVoiceTower(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Grey/blue tower walls (taller feel)
  wall(g, 4, h * 0.2, w - 8, h * 0.8, 0x607d8b);
  roof(g, 4, h * 0.05, w - 8, h * 0.2, 0x37474f);
  // Radio tower antenna
  g.moveTo(w / 2, h * 0.05);
  g.lineTo(w / 2, h * -0.1);
  g.stroke({ color: 0x546e7a, width: 2.5 });
  g.circle(w / 2, h * -0.1, 3);
  g.fill(0xef5350);
  // Antenna cross-bars
  g.moveTo(w / 2 - 6, h * 0.0);
  g.lineTo(w / 2 + 6, h * 0.0);
  g.stroke({ color: 0x546e7a, width: 1 });
  g.moveTo(w / 2 - 4, h * -0.05);
  g.lineTo(w / 2 + 4, h * -0.05);
  g.stroke({ color: 0x546e7a, width: 1 });
  // Speaker cone on wall
  const spkCx = w / 2;
  const spkCy = h * 0.42;
  g.circle(spkCx, spkCy, 8);
  g.fill(0x455a64);
  g.stroke({ color: 0x37474f, width: 1.5 });
  g.circle(spkCx, spkCy, 4);
  g.fill(0x546e7a);
  g.circle(spkCx, spkCy, 1.5);
  g.fill(0x78909c);
  // Sound wave arcs emanating from speaker
  for (let i = 1; i <= 3; i++) {
    g.arc(spkCx + 10, spkCy, 4 + i * 4, -Math.PI / 3, Math.PI / 3);
    g.stroke({ color: 0x90caf9, width: 1.2, alpha: 0.7 - i * 0.15 });
  }
  windowRect(g, 10, h * 0.58, 12, 10);
  windowRect(g, w - 22, h * 0.58, 12, 10);
  door(g, w / 2, h, 14, 22, 0x263238);
  c.addChild(g);
  sign(c, 'Voice Tower', w / 2, h + 14, 0x37474f);
}

function drawSecurityFortress(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Stone grey castle walls
  wall(g, 4, h * 0.25, w - 8, h * 0.75, 0x78909c);
  // Battlements (crenellations) along top
  const bw = 6;
  const bh = 8;
  for (let i = 0; i < Math.floor((w - 8) / (bw * 2)); i++) {
    g.rect(4 + i * bw * 2, h * 0.25 - bh, bw, bh);
    g.fill(0x78909c);
    g.stroke({ color: darken(0x78909c, 0.25), width: 1 });
  }
  // Corner turrets
  for (const tx of [0, w - 12]) {
    g.rect(tx, h * 0.18, 12, h * 0.82);
    g.fill(0x607d8b);
    g.stroke({ color: 0x455a64, width: 1 });
    // Turret battlements
    g.rect(tx, h * 0.14, 5, 6);
    g.fill(0x607d8b);
    g.rect(tx + 7, h * 0.14, 5, 6);
    g.fill(0x607d8b);
  }
  // Shield emblem centered on wall
  const shX = w / 2;
  const shY = h * 0.42;
  g.moveTo(shX, shY - 8);
  g.lineTo(shX + 8, shY - 4);
  g.lineTo(shX + 8, shY + 4);
  g.lineTo(shX, shY + 10);
  g.lineTo(shX - 8, shY + 4);
  g.lineTo(shX - 8, shY - 4);
  g.closePath();
  g.fill(0xffd54f);
  g.stroke({ color: 0xf9a825, width: 1.5 });
  // Cross on shield
  g.rect(shX - 1, shY - 5, 2, 12);
  g.fill(0xe65100);
  g.rect(shX - 5, shY - 1, 10, 2);
  g.fill(0xe65100);
  // Heavy gate door (portcullis style)
  door(g, w / 2, h, 20, 28, 0x455a64);
  // Gate grid lines
  for (let i = 1; i < 3; i++) {
    g.moveTo(w / 2 - 8 + i * 6, h - 28);
    g.lineTo(w / 2 - 8 + i * 6, h);
    g.stroke({ color: 0x37474f, width: 0.8 });
  }
  for (let j = 1; j < 4; j++) {
    g.moveTo(w / 2 - 10, h - 28 + j * 7);
    g.lineTo(w / 2 + 10, h - 28 + j * 7);
    g.stroke({ color: 0x37474f, width: 0.8 });
  }
  windowRect(g, 16, h * 0.45, 10, 10);
  windowRect(g, w - 26, h * 0.45, 10, 10);
  c.addChild(g);
  sign(c, 'Security Fortress', w / 2, h + 14, 0x455a64);
}

function drawConfigCitadel(c: Container, w: number, h: number) {
  const g = new Graphics();
  shadow(g, w, h);
  // Grey/white command center walls
  wall(g, 4, h * 0.25, w - 8, h * 0.75, 0xeceff1);
  roof(g, 4, h * 0.1, w - 8, h * 0.2, 0x607d8b);
  // Antenna on roof
  g.moveTo(w / 2, h * 0.1);
  g.lineTo(w / 2, h * -0.05);
  g.stroke({ color: 0x78909c, width: 2 });
  g.circle(w / 2, h * -0.05, 2.5);
  g.fill(0xef5350);
  // Antenna prongs
  g.moveTo(w / 2 - 5, h * 0.0);
  g.lineTo(w / 2, h * -0.05);
  g.lineTo(w / 2 + 5, h * 0.0);
  g.stroke({ color: 0x78909c, width: 1 });
  // Gear emblem centered on upper wall
  const gearCx = w / 2;
  const gearCy = h * 0.38;
  g.circle(gearCx, gearCy, 8);
  g.fill(0x607d8b);
  g.stroke({ color: 0x455a64, width: 1.5 });
  for (let t = 0; t < 8; t++) {
    const a = (t / 8) * Math.PI * 2;
    g.moveTo(gearCx + Math.cos(a) * 6, gearCy + Math.sin(a) * 6);
    g.lineTo(gearCx + Math.cos(a) * 10, gearCy + Math.sin(a) * 10);
    g.stroke({ color: 0x455a64, width: 2 });
  }
  g.circle(gearCx, gearCy, 3);
  g.fill(0xeceff1);
  // Status LEDs on left wall
  const ledColors = [0x4caf50, 0x4caf50, 0xffca28, 0xef5350];
  for (let i = 0; i < 4; i++) {
    g.circle(12, h * 0.55 + i * 6, 2);
    g.fill(ledColors[i]);
    g.stroke({ color: darken(ledColors[i], 0.3), width: 0.5 });
    // LED glow
    g.circle(12, h * 0.55 + i * 6, 4);
    g.fill({ color: ledColors[i], alpha: 0.15 });
  }
  // Status bars on right wall
  for (let i = 0; i < 3; i++) {
    g.rect(w - 24, h * 0.55 + i * 7, 16, 3);
    g.fill(0xcfd8dc);
    g.stroke({ color: 0xb0bec5, width: 0.5 });
    const fillW = (16 * (0.4 + i * 0.25));
    g.rect(w - 24, h * 0.55 + i * 7, fillW, 3);
    g.fill(i === 2 ? 0xef5350 : 0x4caf50);
  }
  windowRect(g, 18, h * 0.42, 10, 10);
  windowRect(g, w - 28, h * 0.42, 10, 10);
  door(g, w / 2, h, 14, 22, 0x455a64);
  c.addChild(g);
  sign(c, 'Config Citadel', w / 2, h + 14, 0x455a64);
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
