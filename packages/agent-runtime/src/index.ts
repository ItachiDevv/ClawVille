export { ElizaRuntime, createElizaRuntime } from './eliza-runtime';
export type { ElizaRuntimeConfig, ElizaMessage, ElizaRuntimeState } from './eliza-runtime';

// Phase 6 — per-user character room scoping
export { characterRoomId, CHARACTER_ROOM_NAMESPACE } from './room-scoping';
export { createOpenClawProviderPlugin } from './plugins/openclaw-provider';
export type { OpenClawGatewayConfig } from './plugins/openclaw-provider';
export { loadLocationTemplate, loadCharacter, mergeCustomizations } from './character-loader';

// Character exporter (Phase 3 — "take my agent home" bundle builder)
// The function is pure: given an Avatar row + resolved model metadata +
// target harness, it returns the ElizaOS Character JSON. No DB reads,
// no async, no runtime start. The skill-pack builder that
// accompanies it lives in the API route (needs DB access).
export { buildCharacterExport } from './character-exporter';
export type {
  CharacterExportOptions,
  AvatarExportInput,
  SkillPackEntry,
} from './character-exporter';

// ElizaOS Project export — standard entry point for `elizaos start`
export { default as project, project as clawvilleProject } from './project';

// ElizaOS Characters — proper Character objects for all 10 locations + default avatar
export {
  CHARACTERS,
  defaultAvatarCharacter,
  garyCronAutomation,
  relayApiIntegrations,
  mnemaMemoryRag,
  forgemasterCodeDevelopment,
  bridgetMessagingChannels,
  tinkererMcpToolUse,
  pixelVisualCreation,
  echoAppPublishing,
  sentinelAgentSecurity,
  archonDeploymentOps,
} from './characters';

// ClawVille game plugin (Actions + Providers — Phase 1 deeper ElizaOS integration)
export { clawvillePlugin } from './plugins/clawville-plugin';
export type { ClawvillePlugin } from './plugins/clawville-plugin';
export { allActions } from './actions/index';
export { allProviders } from './providers/index';
export type { Action, ActionResult, ClawvilleActionState, ClawvilleServices } from './actions/types';
export type { Provider, ProviderResult } from './providers/types';

// Embedding utility (Phase 2 — standalone embedText for knowledge RAG).
// Now backed by OpenAI text-embedding-3-small (1536-dim) after the
// Gemini→OpenAI migration — same names, OpenAI internally.
export { embedText, embedTexts } from './plugins/embed-text';
export type { EmbedTextOptions } from './plugins/embed-text';

// OpenAI embedding provider (ElizaOS TEXT_EMBEDDING, 1536-dim — replaced the
// Gemini text-embedding-004 768-dim provider). The Gemini embedding provider
// file is kept (dead-but-present) for easy revert but was never index-exported.
export { createOpenAIEmbeddingPlugin } from './plugins/openai-embedding-provider';
export type { OpenAIEmbeddingConfig } from './plugins/openai-embedding-provider';

// Gemini text generation provider (Phase 3 — DEAD-but-present; Gemini billing
// killed 2026-06, kept exported so legacy importers don't break)
export { createGeminiTextPlugin, createGeminiProTextPlugin } from './plugins/gemini-text-provider';
export type { GeminiTextConfig } from './plugins/gemini-text-provider';

// OpenAI text generation provider (global default for text gen — replaced
// Gemini after its billing died. Embeddings still go through Gemini.)
export { createOpenAITextPlugin, createOpenAIProTextPlugin } from './plugins/openai-text-provider';
export type { OpenAITextConfig } from './plugins/openai-text-provider';

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
  AvatarSimState,
  AvatarSimBroadcast,
  AvatarRegistrationInput,
} from './simulation/avatar-state-store';
export {
  activateIdleAvatars,
  stepMovement,
  handleActivityTransition,
} from './simulation/movement';
export type { ActivityTransition } from './simulation/movement';
export type {
  AvatarDirection,
  NpcActivity,
  PathNode,
  PathfindFn,
  BuildingCenter,
  BuildingCenters,
  BuildingActivities,
  ActivityEmojis,
  AvatarDbHooks,
} from './simulation/types';
