/**
 * Eye blink overlay — two white dot Graphics at face height.
 * ScaleY modulated by blinkPhase from SpriteAnimator.
 */

import { Container, Graphics } from 'pixi.js';

export class BlinkOverlay {
  private container: Container;
  private leftEye: Graphics;
  private rightEye: Graphics;
  private eyeSpacing = 6; // px between eyes
  private eyeSize = 2.5;  // radius
  private eyeY = -4;      // offset from sprite anchor (negative = up toward face)

  constructor(parent: Container, spriteHeight: number) {
    this.container = new Container();
    this.container.label = 'blink';
    // Position eyes relative to face height (~35% from top of sprite)
    this.eyeY = -spriteHeight * 0.35;

    this.leftEye = new Graphics();
    this.leftEye.circle(0, 0, this.eyeSize);
    this.leftEye.fill({ color: 0xffffff, alpha: 0.9 });
    this.leftEye.x = -this.eyeSpacing;
    this.leftEye.y = this.eyeY;

    this.rightEye = new Graphics();
    this.rightEye.circle(0, 0, this.eyeSize);
    this.rightEye.fill({ color: 0xffffff, alpha: 0.9 });
    this.rightEye.x = this.eyeSpacing;
    this.rightEye.y = this.eyeY;

    this.container.addChild(this.leftEye);
    this.container.addChild(this.rightEye);
    parent.addChild(this.container);
  }

  /**
   * Update blink. blinkPhase: 0 = open, 1 = closed.
   */
  update(blinkPhase: number) {
    // Scale Y from 1 (open) to 0 (closed)
    const scaleY = 1 - blinkPhase;
    this.leftEye.scale.y = scaleY;
    this.rightEye.scale.y = scaleY;
    // Only show during blink to avoid visual clutter on small sprites
    this.container.visible = blinkPhase > 0.01;
  }

  /** Reposition to match flipped sprite direction */
  setDirection(facingLeft: boolean) {
    const sign = facingLeft ? 1 : -1;
    this.leftEye.x = -this.eyeSpacing * sign;
    this.rightEye.x = this.eyeSpacing * sign;
  }

  destroy() {
    this.leftEye.destroy();
    this.rightEye.destroy();
    this.container.destroy();
  }
}
