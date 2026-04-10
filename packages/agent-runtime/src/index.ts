export { ElizaRuntime, createElizaRuntime } from './eliza-runtime';
export type { ElizaRuntimeConfig, ElizaMessage, ElizaRuntimeState } from './eliza-runtime';
export { createOpenClawProviderPlugin } from './plugins/openclaw-provider';
export type { OpenClawGatewayConfig } from './plugins/openclaw-provider';
export { createUltrathinkProviderPlugin, ULTRATHINK_PRESETS } from './plugins/ultrathink-provider';
export type { UltrathinkConfig } from './plugins/ultrathink-provider';
export { loadLocationTemplate, mergeCustomizations } from './character-loader';

// Simulation runtime (Phase 2 autonomy)
export { SimulationRuntime, createSimulationRuntime } from './simulation/simulation-runtime';
export type { SimulationRuntimeDeps } from './simulation/simulation-runtime';
export { PetStateStore } from './simulation/pet-state-store';
export type {
  PetSimState,
  PetSimBroadcast,
  PetRegistrationInput,
} from './simulation/pet-state-store';
export {
  activateIdlePets,
  stepMovement,
  handleActivityTransition,
} from './simulation/movement';
export type { ActivityTransition } from './simulation/movement';
export type {
  PetDirection,
  NpcActivity,
  PathNode,
  PathfindFn,
  BuildingCenter,
  BuildingCenters,
  BuildingActivities,
  ActivityEmojis,
  PetDbHooks,
} from './simulation/types';
