export interface LocationTemplate {
  name: string;
  description: string;
  bio: string[];
  lore: string[];
  knowledge: string[];
  topics: string[];
  adjectives: string[];
  messageExamples: Array<Array<{ user: string; content: { text: string } }>>;
  style: {
    all: string[];
    chat: string[];
    post: string[];
  };
  settings?: Record<string, unknown>;
}

// Import all location templates
import { cronAutomation } from './locations/cron-automation';
import { apiIntegrations } from './locations/api-integrations';
import { memoryRag } from './locations/memory-rag';
import { codeDevelopment } from './locations/code-development';
import { messagingChannels } from './locations/messaging-channels';
import { mcpToolUse } from './locations/mcp-tool-use';
import { visualCreation } from './locations/visual-creation';
import { appPublishing } from './locations/app-publishing';
import { agentSecurity } from './locations/agent-security';
import { deploymentOps } from './locations/deployment-ops';
import { townGuide } from './locations/town-guide';

// Re-export all location templates
export { cronAutomation } from './locations/cron-automation';
export { apiIntegrations } from './locations/api-integrations';
export { memoryRag } from './locations/memory-rag';
export { codeDevelopment } from './locations/code-development';
export { messagingChannels } from './locations/messaging-channels';
export { mcpToolUse } from './locations/mcp-tool-use';
export { visualCreation } from './locations/visual-creation';
export { appPublishing } from './locations/app-publishing';
export { agentSecurity } from './locations/agent-security';
export { deploymentOps } from './locations/deployment-ops';
export { townGuide } from './locations/town-guide';

// System agents are world-scoped NPCs that aren't tied to a building (unlike
// the 10 LOCATION_TEMPLATES residents). Each gets a `platform_agents` row with
// `type='system-agent'` and a `customization.slug` field identifying which
// template to use. Seeded on boot via `ensureSystemAgents()` in
// apps/api/src/services/system-npc-seeder.ts. To add a new system agent
// (e.g. an arena host, a quest giver), write a template and register the slug
// here — the seeder loop handles the rest.
export const SYSTEM_AGENT_TEMPLATES: Record<string, LocationTemplate> = {
  'town-guide': townGuide,
};

// Legacy export name (kept for backwards compatibility)
export const templates: Record<string, LocationTemplate> = {
  'cron-automation': cronAutomation,
  'api-integrations': apiIntegrations,
  'memory-rag': memoryRag,
  'code-development': codeDevelopment,
  'messaging-channels': messagingChannels,
  'mcp-tool-use': mcpToolUse,
  'visual-creation': visualCreation,
  'app-publishing': appPublishing,
  'agent-security': agentSecurity,
  'deployment-ops': deploymentOps,
};

// Map building IDs to templates
export const LOCATION_TEMPLATES: Record<string, LocationTemplate> = {
  'cron-automation': cronAutomation,
  'api-integrations': apiIntegrations,
  'memory-rag': memoryRag,
  'code-development': codeDevelopment,
  'messaging-channels': messagingChannels,
  'mcp-tool-use': mcpToolUse,
  'visual-creation': visualCreation,
  'app-publishing': appPublishing,
  'agent-security': agentSecurity,
  'deployment-ops': deploymentOps,
};
