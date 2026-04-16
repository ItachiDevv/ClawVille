export { ElizaRuntime, createElizaRuntime } from './eliza-runtime';
export type { ElizaRuntimeConfig, ElizaMessage, ElizaRuntimeState } from './eliza-runtime';
export { createOpenClawProviderPlugin } from './plugins/openclaw-provider';
export type { OpenClawGatewayConfig } from './plugins/openclaw-provider';
export { loadLocationTemplate, loadCharacter, mergeCustomizations } from './character-loader';

// Character exporter (Phase 3 — "take my agent home" bundle builder)
// The function is pure: given a Pet row + resolved model metadata +
// target harness, it returns the ElizaOS Character JSON. No DB reads,
// no async, no runtime start. The skill-pack builder that
// accompanies it lives in the API route (needs DB access).
export { buildCharacterExport } from './character-exporter';
export type {
  CharacterExportOptions,
  PetExportInput,
  SkillPackEntry,
} from './character-exporter';

// ElizaOS Project export — standard entry point for `elizaos start`
export { default as project, project as clawvilleProject } from './project';

// ElizaOS Characters — proper Character objects for all 10 locations + pet
export {
  CHARACTERS,
  defaultPetCharacter,
  garyCronHub,
  relayWebhookGateway,
  mnemaMemoryVault,
  forgemasterSkillForge,
  bridgetChannelBridge,
  tinkererToolWorkshop,
  pixelCanvasStudio,
  echoVoiceTower,
  sentinelSecurityFortress,
  archonConfigCitadel,
} from './characters';

// ClawVille game plugin (Actions + Providers — Phase 1 deeper ElizaOS integration)
export { clawvillePlugin } from './plugins/clawville-plugin';
export type { ClawvillePlugin } from './plugins/clawville-plugin';
export { allActions } from './actions/index';
export { allProviders } from './providers/index';
export type { Action, ActionResult, ClawvilleActionState, ClawvilleServices } from './actions/types';
export type { Provider, ProviderResult } from './providers/types';

// Embedding utility (Phase 2 — standalone embedText for knowledge RAG)
export { embedText, embedTexts } from './plugins/embed-text';
export type { EmbedTextOptions } from './plugins/embed-text';

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
