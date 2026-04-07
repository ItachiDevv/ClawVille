import { ANIMATION_STATES, type AnimationState } from './avatar-sprites';

export type PlayMode = 'loop' | 'once' | 'hold' | 'ping-pong';

export interface PlayOptions {
  mode?: PlayMode;       // override default mode from ANIMATION_STATES
  speed?: number;        // playback speed multiplier (default 1)
  onComplete?: () => void; // called when 'once' animation finishes
}

export class SpriteSheetPlayer {
  private currentState: AnimationState = 'idle';
  private frameIndex = 0;
  private elapsed = 0;
  private finished = false;
  private playMode: PlayMode = 'loop';
  private playSpeed = 1;
  private pingPongReverse = false;
  private onComplete: (() => void) | null = null;

  play(state: AnimationState, opts?: PlayOptions): void {
    // If same state and not finished, don't restart
    if (state === this.currentState && !this.finished) return;

    const anim = ANIMATION_STATES[state];
    this.currentState = state;
    this.frameIndex = 0;
    this.elapsed = 0;
    this.finished = false;
    this.pingPongReverse = false;
    this.playMode = opts?.mode ?? anim.mode;
    this.playSpeed = opts?.speed ?? 1;
    this.onComplete = opts?.onComplete ?? null;
  }

  update(dt: number): void {
    if (this.finished) return;

    const anim = ANIMATION_STATES[this.currentState];
    const frameCount = anim.end - anim.start + 1;
    const frameDuration = 1 / (anim.fps * this.playSpeed);

    this.elapsed += dt;

    if (this.elapsed >= frameDuration) {
      this.elapsed -= frameDuration;

      switch (this.playMode) {
        case 'loop':
          this.frameIndex = (this.frameIndex + 1) % frameCount;
          break;
        case 'once':
          if (this.frameIndex < frameCount - 1) {
            this.frameIndex++;
          } else {
            this.finished = true;
            this.onComplete?.();
          }
          break;
        case 'hold':
          // Stay on first frame (used for block - just shows the pose)
          break;
        case 'ping-pong':
          if (!this.pingPongReverse) {
            this.frameIndex++;
            if (this.frameIndex >= frameCount - 1) this.pingPongReverse = true;
          } else {
            this.frameIndex--;
            if (this.frameIndex <= 0) this.pingPongReverse = false;
          }
          break;
      }
    }
  }

  getCurrentFrameIndex(): number {
    const anim = ANIMATION_STATES[this.currentState];
    return anim.start + this.frameIndex;
  }

  getState(): AnimationState {
    return this.currentState;
  }

  isFinished(): boolean {
    return this.finished;
  }

  reset(): void {
    this.frameIndex = 0;
    this.elapsed = 0;
    this.finished = false;
    this.pingPongReverse = false;
  }
}
