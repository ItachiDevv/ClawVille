import { Texture, Rectangle } from 'pixi.js';
import { SPRITE_FRAME_WIDTH, SPRITE_FRAME_HEIGHT, SPRITE_SHEET_COLS, SPRITE_SHEET_ROWS } from './avatar-sprites';

export class TextureFrameCache {
  private cache = new Map<string, Texture[]>();
  private static instance: TextureFrameCache | null = null;

  static getInstance(): TextureFrameCache {
    if (!TextureFrameCache.instance) {
      TextureFrameCache.instance = new TextureFrameCache();
    }
    return TextureFrameCache.instance;
  }

  /**
   * Slice a sprite sheet texture into individual frame textures.
   * Results are cached by key (typically species name).
   */
  getFrames(key: string, baseTexture: Texture): Texture[] {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const frames: Texture[] = [];
    const totalFrames = SPRITE_SHEET_COLS * SPRITE_SHEET_ROWS;

    for (let i = 0; i < totalFrames; i++) {
      const col = i % SPRITE_SHEET_COLS;
      const row = Math.floor(i / SPRITE_SHEET_COLS);
      const rect = new Rectangle(
        col * SPRITE_FRAME_WIDTH,
        row * SPRITE_FRAME_HEIGHT,
        SPRITE_FRAME_WIDTH,
        SPRITE_FRAME_HEIGHT
      );
      const frame = new Texture({ source: baseTexture.source, frame: rect });
      frames.push(frame);
    }

    this.cache.set(key, frames);
    return frames;
  }

  hasFrames(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }
}
