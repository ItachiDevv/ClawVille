import type { AlertErrorParams } from './alert-error';

const DEFAULT_BREAKER_THRESHOLD = 5;
const MIN_BREAKER_THRESHOLD = 1;
const DEFAULT_BREAKER_COOLDOWN_MS = 600_000;
const MIN_BREAKER_COOLDOWN_MS = 10_000;
const PAYAI_BREAKER_KEY = 'payai';

export type PayAiCircuitPhase = 'closed' | 'open' | 'half_open';

export interface PayAiCircuitState {
  phase: PayAiCircuitPhase;
  consecutiveFailures: number;
  openedAtMs: number | null;
  alertedForOutage: boolean;
}

export interface PayAiCircuitPermit {
  readonly key: typeof PAYAI_BREAKER_KEY;
  readonly probe: boolean;
  active: boolean;
}

const facilitatorCircuits = new Map<string, PayAiCircuitState>();

function resolveBreakerInt(
  raw: string | undefined,
  fallback: number,
  floor: number,
): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= floor ? parsed : fallback;
}

export function resolveAgentPayBreakerThreshold(
  raw: string | undefined = process.env.AGENT_PAY_BREAKER_THRESHOLD,
): number {
  return resolveBreakerInt(raw, DEFAULT_BREAKER_THRESHOLD, MIN_BREAKER_THRESHOLD);
}

export function resolveAgentPayBreakerCooldownMs(
  raw: string | undefined = process.env.AGENT_PAY_BREAKER_COOLDOWN_MS,
): number {
  return resolveBreakerInt(raw, DEFAULT_BREAKER_COOLDOWN_MS, MIN_BREAKER_COOLDOWN_MS);
}

function circuitState(): PayAiCircuitState {
  let state = facilitatorCircuits.get(PAYAI_BREAKER_KEY);
  if (!state) {
    state = {
      phase: 'closed',
      consecutiveFailures: 0,
      openedAtMs: null,
      alertedForOutage: false,
    };
    facilitatorCircuits.set(PAYAI_BREAKER_KEY, state);
  }
  return state;
}

export function readPayAiCircuitState(): Readonly<PayAiCircuitState> {
  return { ...circuitState() };
}

function logCircuitTransition(
  from: PayAiCircuitPhase,
  to: PayAiCircuitPhase,
  state: PayAiCircuitState,
): void {
  console.warn(`[agent-pay-breaker] ${from} -> ${to}`, {
    facilitator: PAYAI_BREAKER_KEY,
    consecutiveFailures: state.consecutiveFailures,
  });
}

function sendCircuitAlert(
  state: PayAiCircuitState,
  alert: (params: AlertErrorParams) => Promise<void>,
): void {
  if (state.alertedForOutage) return;
  state.alertedForOutage = true;
  void Promise.resolve()
    .then(() => alert({
      severity: 'critical',
      source: 'agent-pay-breaker',
      message: 'PayAI facilitator circuit opened for new agent payments',
      context: {
        consecutiveFailures: state.consecutiveFailures,
        cooldownMs: resolveAgentPayBreakerCooldownMs(),
      },
    }))
    .catch(() => {});
}

export function acquirePayAiCircuitPermit(
  nowMs: number,
): PayAiCircuitPermit | null {
  const state = circuitState();
  if (state.phase === 'closed') {
    return { key: PAYAI_BREAKER_KEY, probe: false, active: true };
  }
  if (state.phase === 'half_open') return null;

  const openedAtMs = state.openedAtMs ?? nowMs;
  if (nowMs - openedAtMs < resolveAgentPayBreakerCooldownMs()) return null;

  const from = state.phase;
  state.phase = 'half_open';
  logCircuitTransition(from, state.phase, state);
  return { key: PAYAI_BREAKER_KEY, probe: true, active: true };
}

export function recordPayAiCircuitAvailable(
  permit: PayAiCircuitPermit,
): void {
  if (!permit.active) return;
  permit.active = false;
  const state = circuitState();
  const from = state.phase;
  state.phase = 'closed';
  state.consecutiveFailures = 0;
  state.openedAtMs = null;
  state.alertedForOutage = false;
  if (from !== state.phase) logCircuitTransition(from, state.phase, state);
}

export function recordPayAiCircuitFailure(
  permit: PayAiCircuitPermit,
  nowMs: number,
  alert: (params: AlertErrorParams) => Promise<void>,
): void {
  if (!permit.active) return;
  permit.active = false;
  const state = circuitState();
  state.consecutiveFailures += 1;

  if (state.phase === 'half_open') {
    const from = state.phase;
    state.phase = 'open';
    state.openedAtMs = nowMs;
    logCircuitTransition(from, state.phase, state);
    sendCircuitAlert(state, alert);
    return;
  }

  if (
    state.phase === 'closed'
    && state.consecutiveFailures >= resolveAgentPayBreakerThreshold()
  ) {
    const from = state.phase;
    state.phase = 'open';
    state.openedAtMs = nowMs;
    logCircuitTransition(from, state.phase, state);
    sendCircuitAlert(state, alert);
  }
}

export function releasePayAiCircuitPermitWithoutObservation(
  permit: PayAiCircuitPermit,
  nowMs: number,
): void {
  if (!permit.active) return;
  permit.active = false;
  if (!permit.probe) return;
  const state = circuitState();
  if (state.phase !== 'half_open') return;
  const from = state.phase;
  state.phase = 'open';
  // An unobserved half-open probe provides no availability evidence. Restart
  // the cooldown so another caller cannot immediately burn a second probe.
  state.openedAtMs = nowMs;
  logCircuitTransition(from, state.phase, state);
}

/** Test seam: production state intentionally lives for the process lifetime. */
export function resetPayAiFacilitatorCircuitForTests(): void {
  facilitatorCircuits.clear();
}
