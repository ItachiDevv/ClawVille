/**
 * Process-local autonomy standby switch.
 *
 * Staging defaults to standby so unattended deploys do not continuously spend
 * inference. State is intentionally not persisted: every process restart
 * resolves the environment default again, which is the safe direction on
 * staging. Production defaults active unless an operator explicitly applies
 * the emergency brake for that process lifetime.
 */

export type AutonomyMode = 'active' | 'standby';

export interface AutonomyStandbyState {
  mode: AutonomyMode;
  armedUntil: number | null;
  defaultMode: AutonomyMode;
}

const MIN_ARM_MINUTES = 15;
const MAX_ARM_MINUTES = 480;
const DEFAULT_ARM_MINUTES = 120;

export function resolveAutonomyDefaultMode(
  standbyDefault: string | undefined,
  clawvilleEnv: string | undefined,
): AutonomyMode {
  if (standbyDefault === 'on') return 'standby';
  if (standbyDefault === 'off') return 'active';
  return clawvilleEnv === 'staging' ? 'standby' : 'active';
}

const defaultMode = resolveAutonomyDefaultMode(
  process.env.AUTONOMY_STANDBY_DEFAULT,
  process.env.CLAWVILLE_ENV,
);

let mode: AutonomyMode = defaultMode;
let armedUntil: number | null = null;

type ArmReason = `armed ${number}min` | 'kick auto-arm';

function logTransition(from: AutonomyMode, to: AutonomyMode, reason: string): void {
  console.log(`[AutonomyStandby] ${from} -> ${to} (reason: ${reason})`);
}

// Make the module-load default observable once without introducing a second
// mutable "initializing" state.
logTransition(defaultMode, defaultMode, 'default');

function expireIfNeeded(now: number = Date.now()): void {
  if (mode !== 'active' || armedUntil === null || now < armedUntil) return;
  const from = mode;
  mode = 'standby';
  armedUntil = null;
  logTransition(from, mode, 'expired');
}

export function getStandbyState(): AutonomyStandbyState {
  expireIfNeeded();
  return { mode, armedUntil, defaultMode };
}

export function isAutonomyActive(): boolean {
  expireIfNeeded();
  return mode === 'active';
}

function normalizeArmMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_ARM_MINUTES;
  return Math.min(MAX_ARM_MINUTES, Math.max(MIN_ARM_MINUTES, minutes));
}

/** Arm autonomy for a bounded window. The optional reason is driver-internal. */
export function armAutonomy(
  minutes: number = DEFAULT_ARM_MINUTES,
  internalReason?: 'kick auto-arm',
): AutonomyStandbyState {
  const normalizedMinutes = normalizeArmMinutes(minutes);
  const from = mode;
  const reason: ArmReason = internalReason ?? `armed ${normalizedMinutes}min`;
  // Production/default-active is deliberately unbounded. Pressing "arm" while
  // it is already in that unbounded state must not manufacture a deadline that
  // later flips production to standby without an explicit emergency brake.
  if (defaultMode === 'active' && mode === 'active' && armedUntil === null) {
    logTransition(from, mode, reason);
    return getStandbyState();
  }
  mode = 'active';
  armedUntil = Date.now() + normalizedMinutes * 60_000;
  logTransition(from, mode, reason);
  return getStandbyState();
}

export function enterStandby(): AutonomyStandbyState {
  const from = mode;
  mode = 'standby';
  armedUntil = null;
  if (from !== mode) logTransition(from, mode, 'manual');
  return getStandbyState();
}

/**
 * Test-only isolation seam. It can only restore the environment-resolved
 * module-load default and refuses to run in production, so it cannot become an
 * alternate operator bypass for the emergency brake.
 */
export const autonomyStandbyTestSeams = {
  restoreDefault(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('autonomyStandbyTestSeams is unavailable in production');
    }
    mode = defaultMode;
    armedUntil = null;
  },
};
