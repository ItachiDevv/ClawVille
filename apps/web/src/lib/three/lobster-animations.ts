import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LobsterRefs {
  body: THREE.Mesh | null;
  leftClaw: THREE.Group | null;
  rightClaw: THREE.Group | null;
  tailSegments: (THREE.Mesh | null)[];
  tailFan: THREE.Mesh | null;
  legs: (THREE.Mesh | null)[];
  eyeStalks: (THREE.Group | null)[];
  antennae: (THREE.Mesh | null)[];
}

export type AnimState =
  | 'idle'
  | 'walk'
  | 'attack'
  | 'heavy'
  | 'block'
  | 'dodge'
  | 'combo'
  | 'special'
  | 'death'
  | 'hurt'
  | 'conversation';

// How long each action plays before returning to base state
const ACTION_DURATIONS: Record<AnimState, number> = {
  idle: Infinity,
  walk: Infinity,
  attack: 0.5,
  heavy: 0.8,
  block: 0.6,
  dodge: 0.4,
  combo: 0.9,
  special: 1.0,
  death: 1.5,
  hurt: 0.3,
  conversation: Infinity,
};

// ---------------------------------------------------------------------------
// Easing functions
// ---------------------------------------------------------------------------

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t: number): number {
  return t * t * t;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutBounce(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

// ---------------------------------------------------------------------------
// LobsterAnimator
// ---------------------------------------------------------------------------

export class LobsterAnimator {
  private refs: LobsterRefs;
  private currentState: AnimState = 'idle';
  private actionStartTime = 0;
  private actionDone = true;
  private blendFactor = 0.12; // how fast to lerp toward target poses

  // Track stored base rotations/positions for reset
  private baseBodyY = 0;

  constructor(refs: LobsterRefs) {
    this.refs = refs;
  }

  /** Update refs when they change (e.g. after mount) */
  setRefs(refs: LobsterRefs) {
    this.refs = refs;
  }

  /** Start a timed action. Continuous states (idle/walk/conversation) are set via update(). */
  startAction(state: AnimState, elapsed: number) {
    if (state === this.currentState && !this.actionDone) return;
    this.currentState = state;
    this.actionStartTime = elapsed;
    this.actionDone = false;
  }

  /** Main update — call every frame */
  update(dt: number, elapsed: number, suggestedState: AnimState, direction: string) {
    const cdt = Math.min(dt, 0.1);

    // If a timed action is playing, check if it's done
    if (!this.actionDone) {
      const duration = ACTION_DURATIONS[this.currentState];
      if (duration !== Infinity && elapsed - this.actionStartTime >= duration) {
        this.actionDone = true;
      }
    }

    // If no timed action is active, use suggested state
    const state = this.actionDone ? suggestedState : this.currentState;
    const progress = ACTION_DURATIONS[state] !== Infinity
      ? clamp01((elapsed - this.actionStartTime) / ACTION_DURATIONS[state])
      : 0;

    switch (state) {
      case 'idle':
        this.animIdle(cdt, elapsed);
        break;
      case 'walk':
        this.animWalk(cdt, elapsed, direction);
        break;
      case 'attack':
        this.animAttack(cdt, elapsed, progress);
        break;
      case 'heavy':
        this.animHeavy(cdt, elapsed, progress);
        break;
      case 'block':
        this.animBlock(cdt, elapsed, progress);
        break;
      case 'dodge':
        this.animDodge(cdt, elapsed, progress, direction);
        break;
      case 'combo':
        this.animCombo(cdt, elapsed, progress);
        break;
      case 'special':
        this.animSpecial(cdt, elapsed, progress);
        break;
      case 'death':
        this.animDeath(cdt, elapsed, progress);
        break;
      case 'hurt':
        this.animHurt(cdt, elapsed, progress);
        break;
      case 'conversation':
        this.animConversation(cdt, elapsed);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Idle: gentle breathing
  // -----------------------------------------------------------------------
  private animIdle(dt: number, elapsed: number) {
    const { body, leftClaw, rightClaw, tailSegments, tailFan, legs, eyeStalks, antennae } = this.refs;
    const bf = this.blendFactor;

    // Body: subtle Y bob
    if (body) {
      const targetY = Math.sin(elapsed * 3) * 0.05;
      body.position.y = lerp(body.position.y, body.position.y + targetY - (body.position.y % 1), bf);
    }

    // Antennae: slow sway
    antennae.forEach((ant, i) => {
      if (!ant) return;
      const target = Math.sin(elapsed * 1.5 + i * Math.PI) * 0.15;
      ant.rotation.z = lerp(ant.rotation.z, ant.rotation.z > 0 ? 0.4 + target : -0.4 - target, bf);
    });

    // Claws: slight drift
    if (leftClaw) {
      const target = Math.sin(elapsed * 1.2) * 0.08;
      leftClaw.rotation.x = lerp(leftClaw.rotation.x, target, bf);
    }
    if (rightClaw) {
      const target = Math.sin(elapsed * 1.2 + 1) * 0.08;
      rightClaw.rotation.x = lerp(rightClaw.rotation.x, target, bf);
    }

    // Eye stalks: gentle tilt
    eyeStalks.forEach((eye, i) => {
      if (!eye) return;
      const target = Math.sin(elapsed * 1.0 + i * 2) * 0.06;
      eye.rotation.z = lerp(eye.rotation.z, target, bf);
    });

    // Tail: micro-wave
    tailSegments.forEach((seg, i) => {
      if (!seg) return;
      const target = Math.sin(elapsed * 2 + i * 0.8) * 0.04;
      seg.rotation.x = lerp(seg.rotation.x, target, bf);
    });
    if (tailFan) {
      const target = Math.sin(elapsed * 2 + 2) * 0.05;
      tailFan.rotation.x = lerp(tailFan.rotation.x, 0.4 + target, bf);
    }

    // Legs: subtle resting sway
    legs.forEach((leg, i) => {
      if (!leg) return;
      const side = i < 3 ? 1 : -1;
      const target = side * 0.5 + Math.sin(elapsed * 1.5 + i * 0.5) * 0.05;
      leg.rotation.z = lerp(leg.rotation.z, target, bf);
    });
  }

  // -----------------------------------------------------------------------
  // Walk: leg cycling + body bob + claw swing
  // -----------------------------------------------------------------------
  private animWalk(dt: number, elapsed: number, direction: string) {
    const { body, leftClaw, rightClaw, tailSegments, tailFan, legs, eyeStalks, antennae } = this.refs;
    const bf = this.blendFactor * 1.5; // faster blending for walk

    // Legs: alternating gait (3 pairs with phase offset)
    legs.forEach((leg, i) => {
      if (!leg) return;
      const side = i < 3 ? 1 : -1;
      const pair = i % 3;
      const phase = pair * (Math.PI * 2 / 3); // 120° offset
      const cycle = Math.sin(elapsed * 12 + phase) * 0.4;
      const target = side * 0.5 + cycle;
      leg.rotation.z = lerp(leg.rotation.z, target, bf);
    });

    // Claws: swing forward/back
    if (leftClaw) {
      const target = Math.sin(elapsed * 6) * 0.2;
      leftClaw.rotation.x = lerp(leftClaw.rotation.x, target, bf);
    }
    if (rightClaw) {
      const target = Math.sin(elapsed * 6 + Math.PI) * 0.2;
      rightClaw.rotation.x = lerp(rightClaw.rotation.x, target, bf);
    }

    // Tail: wave propagation
    tailSegments.forEach((seg, i) => {
      if (!seg) return;
      const target = Math.sin(elapsed * 8 + i * 0.6) * 0.1;
      seg.rotation.x = lerp(seg.rotation.x, target, bf);
    });
    if (tailFan) {
      const target = 0.4 + Math.sin(elapsed * 8 + 1.8) * 0.12;
      tailFan.rotation.x = lerp(tailFan.rotation.x, target, bf);
    }

    // Antennae: stream backward
    antennae.forEach((ant, i) => {
      if (!ant) return;
      const side = i === 0 ? 1 : -1;
      const target = side * (0.3 + Math.sin(elapsed * 4 + i) * 0.1);
      ant.rotation.z = lerp(ant.rotation.z, target, bf);
      ant.rotation.x = lerp(ant.rotation.x, -0.5 + Math.sin(elapsed * 3) * 0.05, bf);
    });

    // Eye stalks: slight forward lean
    eyeStalks.forEach((eye) => {
      if (!eye) return;
      eye.rotation.x = lerp(eye.rotation.x, -0.1, bf);
    });
  }

  // -----------------------------------------------------------------------
  // Attack: both claws snap forward
  // -----------------------------------------------------------------------
  private animAttack(dt: number, elapsed: number, progress: number) {
    const { leftClaw, rightClaw, tailSegments } = this.refs;

    // Phase: 0-0.3 = snap forward, 0.3-1.0 = return
    let clawAngle: number;
    if (progress < 0.3) {
      clawAngle = -0.8 * easeOutCubic(progress / 0.3);
    } else {
      clawAngle = -0.8 * (1 - easeInCubic((progress - 0.3) / 0.7));
    }

    if (leftClaw) leftClaw.rotation.x = clawAngle;
    if (rightClaw) rightClaw.rotation.x = clawAngle;

    // Tail counterbalance
    tailSegments.forEach((seg, i) => {
      if (!seg) return;
      seg.rotation.x = -clawAngle * 0.3 * (i + 1) / tailSegments.length;
    });
  }

  // -----------------------------------------------------------------------
  // Heavy: wind-up → slam → recover
  // -----------------------------------------------------------------------
  private animHeavy(dt: number, elapsed: number, progress: number) {
    const { leftClaw, rightClaw, body, tailSegments } = this.refs;

    let clawAngle: number;
    let bodyZ = 0;

    if (progress < 0.375) {
      // Wind-up (0-0.3s → 0-0.375 normalized)
      const t = easeInOutQuad(progress / 0.375);
      clawAngle = 1.0 * t;
      bodyZ = -0.3 * t;
    } else if (progress < 0.625) {
      // Slam (0.3-0.5s → 0.375-0.625)
      const t = easeOutCubic((progress - 0.375) / 0.25);
      clawAngle = 1.0 - 2.2 * t;
      bodyZ = -0.3 + 1.3 * t;
    } else {
      // Recovery (0.5-0.8s → 0.625-1.0)
      const t = easeInOutQuad((progress - 0.625) / 0.375);
      clawAngle = -1.2 * (1 - t);
      bodyZ = 1.0 * (1 - t);
    }

    if (leftClaw) leftClaw.rotation.x = clawAngle;
    if (rightClaw) rightClaw.rotation.x = clawAngle;
    if (body) body.position.z += bodyZ * 0.1; // subtle

    // Tail curl for balance
    tailSegments.forEach((seg, i) => {
      if (!seg) return;
      seg.rotation.x = -clawAngle * 0.2;
    });
  }

  // -----------------------------------------------------------------------
  // Block: claws fold inward, body hunkers
  // -----------------------------------------------------------------------
  private animBlock(dt: number, elapsed: number, progress: number) {
    const { leftClaw, rightClaw, body, tailSegments, legs } = this.refs;

    let blockT: number;
    if (progress < 0.67) {
      // Hold
      blockT = easeOutCubic(Math.min(1, progress / 0.2));
    } else {
      // Release
      blockT = 1 - easeInCubic((progress - 0.67) / 0.33);
    }

    if (leftClaw) {
      leftClaw.rotation.x = -0.5 * blockT;
      leftClaw.rotation.y = 0.4 * blockT;
    }
    if (rightClaw) {
      rightClaw.rotation.x = -0.5 * blockT;
      rightClaw.rotation.y = -0.4 * blockT;
    }

    // Tail curls under
    tailSegments.forEach((seg) => {
      if (!seg) return;
      seg.rotation.x = 0.3 * blockT;
    });

    // Legs spread for stability
    legs.forEach((leg, i) => {
      if (!leg) return;
      const side = i < 3 ? 1 : -1;
      leg.rotation.z = side * (0.5 + 0.2 * blockT);
    });
  }

  // -----------------------------------------------------------------------
  // Dodge: quick lateral shift + body tilt
  // -----------------------------------------------------------------------
  private animDodge(dt: number, elapsed: number, progress: number, direction: string) {
    const { body, leftClaw, rightClaw, tailSegments, legs } = this.refs;

    const dodgeDir = direction === 'left' ? -1 : 1;
    let dodgeT: number;
    if (progress < 0.625) {
      dodgeT = easeOutCubic(progress / 0.625);
    } else {
      dodgeT = 1 - easeOutCubic((progress - 0.625) / 0.375);
    }

    // Body lateral shift + tilt
    if (body) {
      body.rotation.z = dodgeDir * -0.5 * dodgeT;
    }

    // Claws tuck
    if (leftClaw) leftClaw.rotation.x = -0.3 * dodgeT;
    if (rightClaw) rightClaw.rotation.x = -0.3 * dodgeT;

    // Tail flick
    tailSegments.forEach((seg, i) => {
      if (!seg) return;
      seg.rotation.z = dodgeDir * 0.3 * dodgeT * Math.sin(progress * Math.PI * 4 + i);
    });

    // Legs tuck
    legs.forEach((leg, i) => {
      if (!leg) return;
      const side = i < 3 ? 1 : -1;
      leg.rotation.z = side * (0.5 + 0.3 * dodgeT);
    });
  }

  // -----------------------------------------------------------------------
  // Combo: 3 rapid alternating claw strikes
  // -----------------------------------------------------------------------
  private animCombo(dt: number, elapsed: number, progress: number) {
    const { leftClaw, rightClaw, body } = this.refs;

    // 3 strikes: 0-0.22 left, 0.22-0.44 right, 0.44-0.77 both, 0.77-1.0 recovery
    let leftAngle = 0;
    let rightAngle = 0;
    let bodyRock = 0;

    if (progress < 0.22) {
      const t = progress / 0.22;
      leftAngle = -0.7 * (t < 0.5 ? easeOutCubic(t * 2) : 1 - easeInCubic((t - 0.5) * 2));
      bodyRock = -0.1 * Math.sin(t * Math.PI);
    } else if (progress < 0.44) {
      const t = (progress - 0.22) / 0.22;
      rightAngle = -0.7 * (t < 0.5 ? easeOutCubic(t * 2) : 1 - easeInCubic((t - 0.5) * 2));
      bodyRock = 0.1 * Math.sin(t * Math.PI);
    } else if (progress < 0.77) {
      const t = (progress - 0.44) / 0.33;
      const strike = t < 0.4 ? easeOutCubic(t / 0.4) : 1 - easeInCubic((t - 0.4) / 0.6);
      leftAngle = -0.9 * strike;
      rightAngle = -0.9 * strike;
    } else {
      // Recovery
      const t = (progress - 0.77) / 0.23;
      leftAngle = 0;
      rightAngle = 0;
      bodyRock = 0;
    }

    if (leftClaw) leftClaw.rotation.x = leftAngle;
    if (rightClaw) rightClaw.rotation.x = rightAngle;
    if (body) body.rotation.y += bodyRock * 0.05;
  }

  // -----------------------------------------------------------------------
  // Special: rise up, spread, burst
  // -----------------------------------------------------------------------
  private animSpecial(dt: number, elapsed: number, progress: number) {
    const { body, leftClaw, rightClaw, tailSegments, tailFan, antennae, eyeStalks } = this.refs;

    let riseT: number;
    let spreadT: number;

    if (progress < 0.5) {
      // Rise + spread
      riseT = easeOutCubic(progress / 0.5);
      spreadT = riseT;
    } else if (progress < 0.7) {
      // Hold
      riseT = 1;
      spreadT = 1;
    } else {
      // Burst snap
      const t = easeOutCubic((progress - 0.7) / 0.3);
      riseT = 1 - t;
      spreadT = 1 - t;
    }

    // Claws spread wide
    if (leftClaw) {
      leftClaw.rotation.y = -1.0 * spreadT;
      leftClaw.rotation.x = -0.3 * spreadT;
    }
    if (rightClaw) {
      rightClaw.rotation.y = 1.0 * spreadT;
      rightClaw.rotation.x = -0.3 * spreadT;
    }

    // Antennae flare
    antennae.forEach((ant, i) => {
      if (!ant) return;
      const side = i === 0 ? 1 : -1;
      ant.rotation.z = side * (0.3 + 0.5 * spreadT);
      ant.rotation.x = -0.5 * spreadT;
    });

    // Tail fan out
    tailSegments.forEach((seg, i) => {
      if (!seg) return;
      seg.rotation.x = -0.2 * spreadT * (i + 1);
    });
    if (tailFan) {
      tailFan.rotation.x = 0.4 - 0.4 * spreadT;
    }

    // Eye stalks alert
    eyeStalks.forEach((eye) => {
      if (!eye) return;
      eye.rotation.x = -0.15 * spreadT;
    });
  }

  // -----------------------------------------------------------------------
  // Death: tip over, go limp
  // -----------------------------------------------------------------------
  private animDeath(dt: number, elapsed: number, progress: number) {
    const { body, leftClaw, rightClaw, tailSegments, tailFan, legs, eyeStalks, antennae } = this.refs;

    const fallT = easeOutBounce(Math.min(1, progress * 1.5));
    const limpT = easeOutCubic(progress);

    // Body tips sideways
    if (body) {
      body.rotation.z = (Math.PI / 2) * fallT;
    }

    // Claws drop open
    if (leftClaw) {
      leftClaw.rotation.x = 0.4 * limpT;
      leftClaw.rotation.z = -0.3 * limpT;
    }
    if (rightClaw) {
      rightClaw.rotation.x = 0.4 * limpT;
      rightClaw.rotation.z = 0.3 * limpT;
    }

    // Legs go limp (hang down)
    legs.forEach((leg, i) => {
      if (!leg) return;
      const side = i < 3 ? 1 : -1;
      leg.rotation.z = side * (0.5 + 0.8 * limpT);
    });

    // Tail straightens
    tailSegments.forEach((seg) => {
      if (!seg) return;
      seg.rotation.x = lerp(seg.rotation.x, 0, limpT * 0.5);
    });
    if (tailFan) {
      tailFan.rotation.x = lerp(tailFan.rotation.x, 0, limpT * 0.5);
    }

    // Eyes droop
    eyeStalks.forEach((eye) => {
      if (!eye) return;
      eye.rotation.x = 0.3 * limpT;
      eye.rotation.z = lerp(eye.rotation.z, 0, limpT);
    });

    // Antennae droop
    antennae.forEach((ant, i) => {
      if (!ant) return;
      ant.rotation.x = 0.4 * limpT;
    });
  }

  // -----------------------------------------------------------------------
  // Hurt: quick recoil
  // -----------------------------------------------------------------------
  private animHurt(dt: number, elapsed: number, progress: number) {
    const { body, leftClaw, rightClaw } = this.refs;

    const recoil = progress < 0.4
      ? easeOutCubic(progress / 0.4)
      : 1 - easeInCubic((progress - 0.4) / 0.6);

    if (body) {
      body.rotation.x = -0.2 * recoil;
    }
    if (leftClaw) leftClaw.rotation.x = 0.3 * recoil;
    if (rightClaw) rightClaw.rotation.x = 0.3 * recoil;
  }

  // -----------------------------------------------------------------------
  // Conversation: periodic claw gestures + attentive eyes
  // -----------------------------------------------------------------------
  private animConversation(dt: number, elapsed: number) {
    const { leftClaw, rightClaw, eyeStalks, antennae } = this.refs;
    const bf = this.blendFactor;

    // Periodic claw wave (every ~3s, alternating)
    const cycle = elapsed % 6;
    const isLeftWave = cycle < 3;
    const waveT = isLeftWave ? cycle / 3 : (cycle - 3) / 3;
    const wave = Math.sin(waveT * Math.PI * 2) * 0.3;

    if (leftClaw) {
      const target = isLeftWave ? wave : 0;
      leftClaw.rotation.x = lerp(leftClaw.rotation.x, target, bf);
      leftClaw.rotation.z = lerp(leftClaw.rotation.z, isLeftWave ? -0.15 * Math.abs(wave) : 0, bf);
    }
    if (rightClaw) {
      const target = !isLeftWave ? wave : 0;
      rightClaw.rotation.x = lerp(rightClaw.rotation.x, target, bf);
      rightClaw.rotation.z = lerp(rightClaw.rotation.z, !isLeftWave ? 0.15 * Math.abs(wave) : 0, bf);
    }

    // Eye stalks lean forward (attentive)
    eyeStalks.forEach((eye) => {
      if (!eye) return;
      eye.rotation.x = lerp(eye.rotation.x, -0.12, bf);
    });

    // Antennae perk up
    antennae.forEach((ant, i) => {
      if (!ant) return;
      const side = i === 0 ? 1 : -1;
      ant.rotation.x = lerp(ant.rotation.x, -0.55 + Math.sin(elapsed * 2 + i) * 0.05, bf);
      ant.rotation.z = lerp(ant.rotation.z, side * 0.35, bf);
    });

    // Run idle on body/legs/tail so they don't freeze
    this.animIdle(dt, elapsed);
  }
}

// ---------------------------------------------------------------------------
// Helper: determine AnimState from NPC data
// ---------------------------------------------------------------------------

export function resolveAnimState(opts: {
  isDead: boolean;
  inCombat: boolean;
  combatAction: string | null;
  direction: string;
  inConversation: boolean;
}): AnimState {
  if (opts.isDead) return 'death';
  if (opts.combatAction) {
    const map: Record<string, AnimState> = {
      attack: 'attack',
      heavy: 'heavy',
      block: 'block',
      dodge: 'dodge',
      combo: 'combo',
      special: 'special',
    };
    return map[opts.combatAction] ?? 'attack';
  }
  if (opts.inConversation) return 'conversation';
  if (opts.direction !== 'idle') return 'walk';
  return 'idle';
}
