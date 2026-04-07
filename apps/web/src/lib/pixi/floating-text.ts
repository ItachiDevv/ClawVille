import { Container, Text } from 'pixi.js';

interface FloatingEntry {
  text: Text;
  vx: number; // horizontal drift px/s
  age: number;
}

const MAX_ACTIVE = 10;
const LIFETIME = 1.5; // seconds
const RISE_SPEED = 40; // px/s upward

export class FloatingTextManager {
  private entries: FloatingEntry[] = [];

  /** Spawn a floating text at world coordinates */
  spawn(
    worldContainer: Container,
    x: number,
    y: number,
    message: string,
    color: number = 0xffd700,
    fontSize: number = 14,
  ) {
    // Enforce max limit — remove oldest
    if (this.entries.length >= MAX_ACTIVE) {
      const oldest = this.entries.shift()!;
      oldest.text.parent?.removeChild(oldest.text);
      oldest.text.destroy();
    }

    const text = new Text({
      text: message,
      style: {
        fontSize,
        fill: color,
        fontFamily: 'Arial',
        fontWeight: 'bold',
        dropShadow: { distance: 1, color: 0x000000, alpha: 0.8 },
      },
    });
    text.anchor.set(0.5, 1);
    text.x = x;
    text.y = y - 20; // Start above the spawn point
    text.alpha = 1;

    worldContainer.addChild(text);

    this.entries.push({
      text,
      vx: (Math.random() - 0.5) * 20, // slight horizontal drift
      age: 0,
    });
  }

  /** Call each frame with delta time in seconds */
  update(dt: number) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      entry.age += dt;

      if (entry.age >= LIFETIME) {
        entry.text.parent?.removeChild(entry.text);
        entry.text.destroy();
        this.entries.splice(i, 1);
        continue;
      }

      const progress = entry.age / LIFETIME;
      entry.text.y -= RISE_SPEED * dt;
      entry.text.x += entry.vx * dt;
      entry.text.alpha = 1 - progress;
      // Slight scale-up at start then shrink
      const scale = progress < 0.2 ? 0.8 + progress * 1 : 1.0 - (progress - 0.2) * 0.3;
      entry.text.scale.set(Math.max(0.5, scale));
    }
  }

  destroy() {
    for (const entry of this.entries) {
      entry.text.parent?.removeChild(entry.text);
      entry.text.destroy();
    }
    this.entries = [];
  }
}
