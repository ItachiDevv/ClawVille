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
// Backed by OpenAI text-embedding-3-small (1536-dim).
export { embedText, embedTexts } from './plugins/embed-text';
export type { EmbedTextOptions } from './plugins/embed-text';

// OpenAI embedding provider (ElizaOS TEXT_EMBEDDING, 1536-dim — the sole
// embedding backend).
export { createOpenAIEmbeddingPlugin } from './plugins/openai-embedding-provider';
export type { OpenAIEmbeddingConfig } from './plugins/openai-embedding-provider';

// OpenAI text generation provider (global default for text gen — the sole
// text backend below the OpenClaw gateway override). Delegates to the InferenceRouter.
export { createOpenAITextPlugin, createOpenAIProTextPlugin } from './plugins/openai-text-provider';
export type { OpenAITextConfig } from './plugins/openai-text-provider';

// Inference router — the single text-gen router (named endpoints + per-consumer
// routes + health-based failover). Replaces the old global OPENAI_BASE_URL hack.
export {
  InferenceRouter,
} from './inference/inference-router';
export type {
  InferenceRoute,
  InferenceSize,
  InferenceEndpoint,
  InferenceMessage,
  GenerateArgs,
  GenerateResult,
  BreakerConfig,
  RouteTable,
  EndpointStats,
} from './inference/inference-router';
export {
  getInferenceRouter,
  buildInferenceRouterFromEnv,
  buildEndpointsFromEnv,
  buildRouteTableFromEnv,
  describeInferenceConfig,
  resolveInferenceRoute,
  __resetInferenceRouter,
} from './inference/inference-config';

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
// P3 slice 2 — directive→building resolver (pure; id + display-name matching).
export { resolveDirectiveBuildingId } from './simulation/directive-resolver';
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
