export { ElizaRuntime, createElizaRuntime } from './eliza-runtime';
export type { ElizaRuntimeConfig, ElizaMessage, ElizaRuntimeState } from './eliza-runtime';
export { createOpenClawProviderPlugin } from './plugins/openclaw-provider';
export type { OpenClawGatewayConfig } from './plugins/openclaw-provider';
export { loadLocationTemplate, mergeCustomizations } from './character-loader';

// ClawVille game plugin (Actions + Providers — Phase 1 deeper ElizaOS integration)
export { clawvillePlugin } from './plugins/clawville-plugin';
export type { ClawvillePlugin } from './plugins/clawville-plugin';
export { allActions } from './actions/index';
export { allProviders } from './providers/index';
export type { Action, ActionResult, ClawvilleActionState, ClawvilleServices } from './actions/types';
export type { Provider, ProviderResult } from './providers/types';

// Gemini text generation provider (Phase 3 — global default for text gen)
export { createGeminiTextPlugin, createGeminiProTextPlugin } from './plugins/gemini-text-provider';
export type { GeminiTextConfig } from './plugins/gemini-text-provider';

// Collaboration (Phase 3 — cross-building consultation)
export {
  CollaborationBroker,
  getCollaborationBroker,
} from './collaboration/collaboration-broker';
export type {
  CollaborateRequest,
  CollaborateResult,
} from './collaboration/collaboration-broker';
export {
  BuildingRuntimeRegistry,
  buildingAgentId,
} from './collaboration/building-runtime-registry';
export type { BuildingRuntimeRegistryConfig } from './collaboration/building-runtime-registry';
export {
  CLAWVILLE_COLLABORATION_STARTED,
  CLAWVILLE_CONSULT_REQUEST,
  CLAWVILLE_CONSULT_COMPLETED,
  CLAWVILLE_COLLABORATION_COMPLETED,
} from './collaboration/events';
export type {
  ConsultationInsight,
  CollaborationConsultRequest,
  CollaborationConsultResult,
  CollaborationLogEntry,
  CollaborationStartedPayload,
  ConsultRequestPayload,
  ConsultCompletedPayload,
  CollaborationCompletedPayload,
} from './collaboration/types';

// Simulation runtime (Phase 2 autonomy)
export { SimulationRuntime, createSimulationRuntime } from './simulation/simulation-runtime';
export type { SimulationRuntimeDeps } from './simulation/simulation-runtime';
export { AvatarStateStore } from './simulation/avatar-state-store';
export type {
  PetSimState,
  AvatarSimBroadcast,
  AvatarRegistrationInput,
} from './simulation/avatar-state-store';
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
