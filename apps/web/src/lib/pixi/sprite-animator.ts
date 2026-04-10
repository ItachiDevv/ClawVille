/**
 * SpriteAnimator — Pure state-machine animation engine applying 12 animation principles.
 * One instance per avatar/NPC. No PixiJS deps — outputs numeric transforms.
 */

import type { AvatarSpecies } from '@clawville/shared';
import type { AnimationState } from './avatar-sprites';

// ---- Species Personality Profiles ----

export interface SpeciesProfile {
  bobAmplitude: number;   // px
  freqMultiplier: number; // base walk frequency multiplier
  squashIntensity: number; // 0-1 how much squash/stretch
  breathAmplitude: number; // idle breathing scale oscillation
  weight: number;          // 0-1 affects anticipation/follow-through duration
  bounciness: number;      // 0-1 overshoot on stop
}

export const SPECIES_PROFILES: Record<string, SpeciesProfile> = {
  bunny:   { bobAmplitude: 6,   freqMultiplier: 1.4, squashIntensity: 0.9, breathAmplitude: 0.010, weight: 0.2, bounciness: 0.9 },
  cat:     { bobAmplitude: 4,   freqMultiplier: 1.0, squashIntensity: 0.6, breathAmplitude: 0.015, weight: 0.4, bounciness: 0.5 },
  fox:     { bobAmplitude: 4,   freqMultiplier: 1.1, squashIntensity: 0.7, breathAmplitude: 0.012, weight: 0.3, bounciness: 0.6 },
  dragon:  { bobAmplitude: 3,   freqMultiplier: 0.7, squashIntensity: 0.3, breathAmplitude: 0.025, weight: 0.9, bounciness: 0.2 },
  turtle:  { bobAmplitude: 1.5, freqMultiplier: 0.5, squashIntensity: 0.2, breathAmplitude: 0.030, weight: 1.0, bounciness: 0.1 },
  wolf:    { bobAmplitude: 4,   freqMultiplier: 0.9, squashIntensity: 0.5, breathAmplitude: 0.018, weight: 0.6, bounciness: 0.4 },
  owl:     { bobAmplitude: 3,   freqMultiplier: 0.8, squashIntensity: 0.4, breathAmplitude: 0.020, weight: 0.5, bounciness: 0.3 },
  phoenix: { bobAmplitude: 5,   freqMultiplier: 1.2, squashIntensity: 0.8, breathAmplitude: 0.008, weight: 0.3, bounciness: 0.7 },
};

const DEFAULT_PROFILE: SpeciesProfile = SPECIES_PROFILES.cat;

// ---- Particle Request Types ----

export type ParticleType = 'dust' | 'dust_burst' | 'heart' | 'zzz' | 'sweat' | 'music_note' | 'star';

export interface ParticleRequest {
  type: ParticleType;
  x: number;
  y: number;
  count: number;
}

// ---- Animator Input / Output ----

export interface AnimatorInput {
  direction: string;     // 'idle' | 'left' | 'right' | 'up' | 'down'
  speed: number;         // 0-1 normalized speed
  isMoving: boolean;
  isDead?: boolean;
  inCombat?: boolean;
  inConversation?: boolean;
  justRespawned?: boolean;
  mood?: 'neutral' | 'happy' | 'sleepy' | 'stressed';
  combatAction?: 'attack' | 'heavy' | 'block' | 'dodge' | 'combo' | 'special' | null;
  lastAttackAt?: number;
  lastHitAt?: number;
}

export interface AnimatorOutput {
  offsetX: number;
  offsetY: number;
  scaleX: number;       // multiply with base scale
  scaleY: number;       // multiply with base scale
  rotation: number;     // radians
  alpha: number;
  shadowScaleX: number;
  shadowScaleY: number;
  shadowAlpha: number;
  particles: ParticleRequest[];
  trailOpacity: number; // 0 = no trail, >0 = render ghosts
  blinkPhase: number;   // 0 = eyes open, 1 = fully closed
  suggestedAnimState: AnimationState;
}

// ---- Internal State ----

type LocomotionState = 'idle' | 'anticipation' | 'walking' | 'follow_through';

export class SpriteAnimator {
  private profile: SpeciesProfile;
  private species: string;
  private elapsed = 0;
  private idleTime = 0;

  // Locomotion state machine
  private locoState: LocomotionState = 'idle';
  private stateTime = 0;

  // Anticipation
  private anticipationDuration = 0.12; // 120ms

  // Follow-through
  private followThroughPhase = 0;
  private followThroughSpeed = 0; // speed at time of stopping

  // Direction change detection
  private lastDirection = 'idle';
  private directionChangeTime = -1;

  // Blink
  private nextBlinkAt = 0;
  private blinkTimer = -1;
  private blinkDuration = 0.12;

  // Death/Respawn
  private deathProgress = 0; // 0 = alive, 1 = fully dead
  private respawnProgress = -1; // -1 = not respawning

  // Zzz particle cooldown
  private lastZzzEmit = 0;

  // Particle output buffer
  private particleBuffer: ParticleRequest[] = [];

  // Position for particle emission
  private worldX = 0;
  private worldY = 0;

  constructor(species: string = 'cat') {
    this.species = species;
    this.profile = SPECIES_PROFILES[species] ?? DEFAULT_PROFILE;
    this.scheduleNextBlink();
  }

  setSpecies(species: string) {
    this.species = species;
    this.profile = SPECIES_PROFILES[species] ?? DEFAULT_PROFILE;
  }

  setWorldPosition(x: number, y: number) {
    this.worldX = x;
    this.worldY = y;
  }

  private scheduleNextBlink() {
    this.nextBlinkAt = this.elapsed + 3 + Math.random() * 2; // 3-5s
  }

  update(dt: number, input: AnimatorInput): AnimatorOutput {
    this.elapsed += dt;
    this.stateTime += dt;
    this.particleBuffer = [];

    const p = this.profile;
    const out: AnimatorOutput = {
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alpha: 1,
      shadowScaleX: 1,
      shadowScaleY: 1,
      shadowAlpha: 0.3,
      particles: this.particleBuffer,
      trailOpacity: 0,
      blinkPhase: 0,
      suggestedAnimState: 'idle',
    };

    // ---- Death animation ----
    if (input.isDead) {
      this.deathProgress = Math.min(1, this.deathProgress + dt / 0.8);
      out.rotation = this.deathProgress * (80 * Math.PI / 180);
      out.alpha = 1 - this.deathProgress;
      out.scaleY = 1 - this.deathProgress * 0.3;
      return out;
    } else if (this.deathProgress > 0) {
      // Was dead, now alive → respawn
      this.deathProgress = 0;
      this.respawnProgress = 0;
    }

    // ---- Respawn animation ----
    if (input.justRespawned || (this.respawnProgress >= 0 && this.respawnProgress < 1)) {
      if (this.respawnProgress < 0) this.respawnProgress = 0;
      this.respawnProgress = Math.min(1, this.respawnProgress + dt / 0.6);
      // Elastic overshoot: 0 → 1.2 → 1.0
      const t = this.respawnProgress;
      const elastic = t < 0.6
        ? (t / 0.6) * 1.2
        : 1.2 - 0.2 * ((t - 0.6) / 0.4);
      out.scaleX = elastic;
      out.scaleY = elastic;
      out.alpha = Math.min(1, t * 2);
      if (this.respawnProgress >= 1) {
        this.respawnProgress = -1;
        this.emitParticles('star', 4);
      }
      return out;
    }

    // ---- Direction change detection ----
    if (input.direction !== this.lastDirection && input.isMoving && this.lastDirection !== 'idle') {
      this.directionChangeTime = this.elapsed;
      this.emitParticles('dust_burst', 3);
    }
    this.lastDirection = input.direction;

    // ---- Locomotion state machine ----
    this.updateLocomotion(input);

    // ---- Apply animation based on state ----
    switch (this.locoState) {
      case 'idle':
        this.applyIdle(dt, input, out);
        break;
      case 'anticipation':
        this.applyAnticipation(out);
        break;
      case 'walking':
        this.applyWalking(input, out);
        break;
      case 'follow_through':
        this.applyFollowThrough(out);
        break;
    }

    // ---- Combat animation ----
    if (input.inCombat) {
      // Lean forward + high-frequency shake
      out.rotation += 0.15;
      out.offsetX += Math.sin(this.elapsed * 30 * Math.PI * 2) * 1.5;
      if (Math.random() < 0.1) this.emitParticles('sweat', 1);
    }

    // ---- Conversation lean ----
    if (input.inConversation && !input.inCombat) {
      out.rotation += Math.sin(this.elapsed * 0.8) * 0.03;
      if (Math.random() < 0.02) this.emitParticles('music_note', 1);
    }

    // ---- Direction change squash ----
    if (this.directionChangeTime > 0) {
      const since = this.elapsed - this.directionChangeTime;
      if (since < 0.15) {
        const t = since / 0.15;
        const squash = 1 - (1 - t) * 0.2 * p.squashIntensity;
        out.scaleX *= (2 - squash); // stretch X
        out.scaleY *= squash;       // squash Y
      }
    }

    // ---- Shadow follows height ----
    out.shadowScaleX = 1 + Math.abs(out.offsetY) * 0.005;
    out.shadowScaleY = 1 - Math.abs(out.offsetY) * 0.01;
    out.shadowAlpha = 0.3 - Math.abs(out.offsetY) * 0.01;

    // ---- Motion trail ----
    if (input.speed > 0.7 && this.locoState === 'walking') {
      out.trailOpacity = (input.speed - 0.7) / 0.3; // 0→1 over speed 0.7→1.0
    }

    // ---- Eye blink ----
    out.blinkPhase = this.updateBlink();

    // ---- Mood particles ----
    this.updateMoodParticles(input);

    // ---- Determine suggested sprite-sheet animation state ----
    out.suggestedAnimState = this.computeAnimState(input);

    return out;
  }

  private updateLocomotion(input: AnimatorInput) {
    switch (this.locoState) {
      case 'idle':
        if (input.isMoving) {
          this.locoState = 'anticipation';
          this.stateTime = 0;
          this.anticipationDuration = 0.08 + this.profile.weight * 0.08; // heavier = longer anticipation
        }
        break;

      case 'anticipation':
        if (!input.isMoving) {
          this.locoState = 'idle';
          this.stateTime = 0;
          this.idleTime = 0;
        } else if (this.stateTime >= this.anticipationDuration) {
          this.locoState = 'walking';
          this.stateTime = 0;
        }
        break;

      case 'walking':
        if (!input.isMoving) {
          this.locoState = 'follow_through';
          this.stateTime = 0;
          this.followThroughSpeed = input.speed;
          this.followThroughPhase = 0;
          this.idleTime = 0;
          this.emitParticles('dust', 2);
        }
        break;

      case 'follow_through':
        if (input.isMoving) {
          this.locoState = 'walking';
          this.stateTime = 0;
        } else {
          const duration = 0.3 + this.profile.bounciness * 0.3;
          if (this.stateTime >= duration) {
            this.locoState = 'idle';
            this.stateTime = 0;
          }
        }
        break;
    }
  }

  // ---- Idle: breathing + gentle bob ----
  private applyIdle(dt: number, input: AnimatorInput, out: AnimatorOutput) {
    this.idleTime += dt;
    const p = this.profile;

    // Breathing — gentle scale Y oscillation
    const breathFreq = 0.5 + (1 - p.weight) * 0.6; // lighter = faster breath
    const breathScale = Math.sin(this.elapsed * breathFreq * Math.PI * 2) * p.breathAmplitude;
    out.scaleY = 1 + breathScale;
    out.scaleX = 1 - breathScale * 0.5; // inverse for volume preservation

    // Gentle idle bob (smooth sine, not stepped)
    const idleBob = Math.sin(this.elapsed * 2 * Math.PI) * 1.5;
    out.offsetY = idleBob;
  }

  // ---- Anticipation: crouch before moving ----
  private applyAnticipation(out: AnimatorOutput) {
    const t = this.stateTime / this.anticipationDuration;
    const p = this.profile;
    // Squash down (crouch)
    const squash = 1 - t * 0.15 * p.squashIntensity;
    out.scaleY = squash;
    out.scaleX = 2 - squash; // stretch X to preserve volume
    out.offsetY = t * 2; // push down slightly
  }

  // ---- Walking: sine-based bob with squash/stretch ----
  private applyWalking(input: AnimatorInput, out: AnimatorOutput) {
    const p = this.profile;
    const baseFreq = 5; // cycles per second
    const freq = baseFreq * p.freqMultiplier * (0.8 + input.speed * 0.4);
    const amp = p.bobAmplitude * (0.6 + input.speed * 0.4);

    // Smooth sine bob
    const phase = this.elapsed * freq * Math.PI * 2;
    const bob = Math.sin(phase);
    out.offsetY = bob * amp;

    // Squash & stretch — inverse scale Y/X during bob
    const stretchAmount = p.squashIntensity * 0.12;
    out.scaleY = 1 - bob * stretchAmount;
    out.scaleX = 1 + bob * stretchAmount * 0.5;

    // Slight tilt during walk
    const tilt = Math.sin(phase * 0.5) * 0.04 * p.squashIntensity;
    out.rotation = tilt;

    // Footstep dust particles at bottom of bob cycle
    if (bob > 0.95 && Math.random() < 0.4) {
      this.emitParticles('dust', 1);
    }
  }

  // ---- Follow-through: damped sine overshoot when stopping ----
  private applyFollowThrough(out: AnimatorOutput) {
    const p = this.profile;
    const duration = 0.3 + p.bounciness * 0.3;
    const t = Math.min(this.stateTime / duration, 1);

    // Damped sine wave
    const damping = Math.exp(-t * 4);
    const freq = 8 + p.bounciness * 8;
    const bounce = Math.sin(t * freq) * damping * p.bounciness;

    out.offsetY = bounce * this.followThroughSpeed * p.bobAmplitude;
    out.scaleY = 1 + bounce * 0.08;
    out.scaleX = 1 - bounce * 0.04;

    // Add breathing as follow-through fades
    const breathBlend = t;
    const breathScale = Math.sin(this.elapsed * 0.8 * Math.PI * 2) * p.breathAmplitude;
    out.scaleY += breathScale * breathBlend;
  }

  // ---- Blink ----
  private updateBlink(): number {
    if (this.elapsed >= this.nextBlinkAt && this.blinkTimer < 0) {
      this.blinkTimer = 0;
    }
    if (this.blinkTimer >= 0) {
      this.blinkTimer += 1 / 60; // approximate dt
      const t = this.blinkTimer / this.blinkDuration;
      if (t >= 1) {
        this.blinkTimer = -1;
        this.scheduleNextBlink();
        return 0;
      }
      // Quick close, slower open
      return t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
    }
    return 0;
  }

  // ---- Mood-based particles ----
  private updateMoodParticles(input: AnimatorInput) {
    // Zzz particles after 8s idle
    if (this.locoState === 'idle' && this.idleTime > 8) {
      if (this.elapsed - this.lastZzzEmit > 2) {
        this.lastZzzEmit = this.elapsed;
        this.emitParticles('zzz', 1);
      }
    }

    // Mood-specific
    if (input.mood === 'happy' && Math.random() < 0.005) {
      this.emitParticles('heart', 1);
    }
  }

  private computeAnimState(input: AnimatorInput): AnimationState {
    const now = Date.now();

    // Death overrides everything
    if (input.isDead) return 'death';

    // Combat actions
    if (input.combatAction) {
      switch (input.combatAction) {
        case 'attack':
        case 'heavy':
        case 'combo':
          return 'attack';
        case 'special':
          return 'special';
        case 'block':
          return 'block';
        case 'dodge':
          return 'dodge';
      }
    }

    // Recently hit — show hurt for 400ms (lastHitAt is Date.now() timestamp)
    if (input.lastHitAt != null && input.lastHitAt > 0 && (now - input.lastHitAt) < 400) {
      return 'hurt';
    }

    // Movement → directional walk
    if (input.isMoving) {
      switch (input.direction) {
        case 'left': return 'walk-left';
        case 'right': return 'walk-right';
        case 'up': return 'walk-up';
        case 'down': return 'walk-down';
        default: return 'walk-down';
      }
    }

    return 'idle';
  }

  private emitParticles(type: ParticleType, count: number) {
    this.particleBuffer.push({
      type,
      x: this.worldX,
      y: this.worldY,
      count,
    });
  }
}
