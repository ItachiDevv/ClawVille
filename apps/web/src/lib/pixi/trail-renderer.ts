/**
 * Ghost afterimage trail renderer for fast-moving sprites.
 * Max 5 ghosts at decreasing opacity, 200ms lifetime each.
 */

import { Container, Sprite, type Texture } from 'pixi.js';

const MAX_GHOSTS = 5;
const GHOST_LIFETIME = 0.2; // seconds
const SPAWN_INTERVAL = 0.04; // seconds between ghosts at full speed

interface Ghost {
  sprite: Sprite;
  life: number;
  active: boolean;
}

export class TrailRenderer {
  private container: Container;
  private ghosts: Ghost[] = [];
  private spawnTimer = 0;

  constructor(parent: Container) {
    this.container = new Container();
    this.container.label = 'trail';
    parent.addChild(this.container);
  }

  /**
   * Update the trail. Call each frame.
   * @param dt Delta time in seconds
   * @param trailOpacity 0 = no trail, >0 = spawn ghosts
   * @param texture Current sprite texture
   * @param x World X
   * @param y World Y
   * @param scaleX Current sprite scaleX
   * @param scaleY Current sprite scaleY
   * @param tint Current sprite tint
   */
  update(
    dt: number,
    trailOpacity: number,
    texture: Texture | null,
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    tint: number = 0xffffff,
  ) {
    // Update existing ghosts
    for (const ghost of this.ghosts) {
      if (!ghost.active) continue;
      ghost.life += dt;
      if (ghost.life >= GHOST_LIFETIME) {
        ghost.active = false;
        ghost.sprite.visible = false;
        continue;
      }
      const t = ghost.life / GHOST_LIFETIME;
      ghost.sprite.alpha = (1 - t) * 0.4;
    }

    // Spawn new ghosts when trail is active
    if (trailOpacity > 0 && texture) {
      this.spawnTimer += dt;
      if (this.spawnTimer >= SPAWN_INTERVAL) {
        this.spawnTimer = 0;
        this.spawnGhost(texture, x, y, scaleX, scaleY, tint, trailOpacity);
      }
    } else {
      this.spawnTimer = 0;
    }
  }

  private spawnGhost(
    texture: Texture,
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    tint: number,
    opacity: number,
  ) {
    let ghost = this.ghosts.find((g) => !g.active);

    if (!ghost) {
      if (this.ghosts.length >= MAX_GHOSTS) {
        // Recycle oldest
        ghost = this.ghosts[0];
      } else {
        const sprite = new Sprite();
        sprite.anchor.set(0.5, 0.85);
        ghost = { sprite, life: 0, active: false };
        this.container.addChild(sprite);
        this.ghosts.push(ghost);
      }
    }

    ghost.sprite.texture = texture;
    ghost.sprite.x = x;
    ghost.sprite.y = y;
    ghost.sprite.scale.set(scaleX, scaleY);
    ghost.sprite.tint = tint;
    ghost.sprite.alpha = 0.4 * opacity;
    ghost.sprite.visible = true;
    ghost.life = 0;
    ghost.active = true;
  }

  destroy() {
    for (const ghost of this.ghosts) {
      ghost.sprite.destroy();
    }
    this.ghosts = [];
    this.container.destroy();
  }
}
