/**
 * Pool-based particle renderer for PixiJS.
 * Consumes ParticleRequest[] from SpriteAnimator and renders particles.
 */

import { Container, Graphics, Text } from 'pixi.js';
export type ParticleType = 'dust' | 'dust_burst' | 'heart' | 'zzz' | 'sweat' | 'music_note' | 'star';

export interface ParticleRequest {
  type: ParticleType;
  x: number;
  y: number;
  count: number;
}

const MAX_PARTICLES = 60;

interface Particle {
  gfx: Graphics | Text;
  type: ParticleType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  active: boolean;
  scale: number;
  rotation: number;
  rotationSpeed: number;
}

// Particle behavior config
const PARTICLE_CONFIG: Record<ParticleType, {
  lifetime: number;
  speed: number;
  gravity: number;
  color: number;
  size: number;
  text?: string;
}> = {
  dust:       { lifetime: 0.5, speed: 15,  gravity: -5,   color: 0xb8946a, size: 3 },
  dust_burst: { lifetime: 0.4, speed: 40,  gravity: -10,  color: 0xc4a67a, size: 4 },
  heart:      { lifetime: 1.5, speed: 20,  gravity: -30,  color: 0xff6b8a, size: 6, text: '♥' },
  zzz:        { lifetime: 2.0, speed: 8,   gravity: -20,  color: 0xaabbff, size: 8, text: 'z' },
  sweat:      { lifetime: 0.8, speed: 25,  gravity: 40,   color: 0x88ccff, size: 3 },
  music_note: { lifetime: 1.2, speed: 15,  gravity: -25,  color: 0xffdd44, size: 8, text: '♪' },
  star:       { lifetime: 0.8, speed: 50,  gravity: -15,  color: 0xffee44, size: 5, text: '✦' },
};

export class ParticleRenderer {
  private container: Container;
  private pool: Particle[] = [];

  constructor(parent: Container) {
    this.container = new Container();
    this.container.label = 'particles';
    parent.addChild(this.container);
  }

  /** Spawn particles from animator requests */
  emit(requests: ParticleRequest[]) {
    for (const req of requests) {
      const config = PARTICLE_CONFIG[req.type];
      for (let i = 0; i < req.count; i++) {
        this.spawnOne(req.type, config, req.x, req.y);
      }
    }
  }

  private spawnOne(
    type: ParticleType,
    config: typeof PARTICLE_CONFIG[ParticleType],
    x: number,
    y: number,
  ) {
    let particle = this.pool.find((p) => !p.active);

    if (!particle) {
      if (this.pool.length >= MAX_PARTICLES) {
        // Recycle oldest
        particle = this.pool[0];
        particle.gfx.visible = false;
      } else {
        const gfx = config.text
          ? new Text({ text: config.text, style: { fontSize: config.size * 2, fill: config.color } })
          : new Graphics();
        particle = {
          gfx,
          type,
          x: 0, y: 0,
          vx: 0, vy: 0,
          life: 0, maxLife: 0,
          active: false,
          scale: 1,
          rotation: 0,
          rotationSpeed: 0,
        };
        this.container.addChild(gfx);
        this.pool.push(particle);
      }
    }

    // Initialize particle
    const angle = Math.random() * Math.PI * 2;
    const speed = config.speed * (0.5 + Math.random() * 0.5);

    particle.type = type;
    particle.x = x + (Math.random() - 0.5) * 10;
    particle.y = y + (type === 'dust' || type === 'dust_burst' ? 4 : -20) + (Math.random() - 0.5) * 6;
    particle.vx = Math.cos(angle) * speed;
    particle.vy = Math.sin(angle) * speed;
    // For dust, bias downward; for rising particles, bias upward
    if (type === 'dust' || type === 'dust_burst') {
      particle.vy = Math.abs(particle.vy) * -0.3;
      particle.vx *= 0.8;
    }
    particle.life = 0;
    particle.maxLife = config.lifetime;
    particle.active = true;
    particle.scale = 1;
    particle.rotation = 0;
    particle.rotationSpeed = (Math.random() - 0.5) * 3;

    // Re-draw graphics if not text
    if (particle.gfx instanceof Graphics) {
      (particle.gfx as Graphics).clear();
      (particle.gfx as Graphics).circle(0, 0, config.size * (0.5 + Math.random() * 0.5));
      (particle.gfx as Graphics).fill({ color: config.color, alpha: 0.8 });
    } else {
      (particle.gfx as Text).text = config.text ?? '';
      (particle.gfx as Text).style.fill = config.color;
      (particle.gfx as Text).style.fontSize = config.size * 2;
    }

    particle.gfx.visible = true;
    particle.gfx.alpha = 1;
  }

  /** Update all active particles. Call each frame. */
  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        p.gfx.visible = false;
        continue;
      }

      const config = PARTICLE_CONFIG[p.type];
      p.vy += config.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.rotationSpeed * dt;

      const lifeRatio = p.life / p.maxLife;

      // Fade out
      p.gfx.alpha = 1 - lifeRatio;
      p.gfx.x = p.x;
      p.gfx.y = p.y;
      p.gfx.rotation = p.rotation;

      // Scale: grow slightly then shrink
      const scaleCurve = lifeRatio < 0.3
        ? 1 + lifeRatio * 0.5
        : 1.15 - (lifeRatio - 0.3) * 0.5;
      p.gfx.scale.set(Math.max(0.1, scaleCurve));
    }
  }

  destroy() {
    for (const p of this.pool) {
      p.gfx.destroy();
    }
    this.pool = [];
    this.container.destroy();
  }
}
