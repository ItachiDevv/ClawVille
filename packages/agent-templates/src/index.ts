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
import { cronHub } from './locations/cron-hub';
import { webhookGateway } from './locations/webhook-gateway';
import { memoryVault } from './locations/memory-vault';
import { skillForge } from './locations/skill-forge';
import { channelBridge } from './locations/channel-bridge';
import { toolWorkshop } from './locations/tool-workshop';
import { canvasStudio } from './locations/canvas-studio';
import { voiceTower } from './locations/voice-tower';
import { securityFortress } from './locations/security-fortress';
import { configCitadel } from './locations/config-citadel';

// Re-export all location templates
export { cronHub } from './locations/cron-hub';
export { webhookGateway } from './locations/webhook-gateway';
export { memoryVault } from './locations/memory-vault';
export { skillForge } from './locations/skill-forge';
export { channelBridge } from './locations/channel-bridge';
export { toolWorkshop } from './locations/tool-workshop';
export { canvasStudio } from './locations/canvas-studio';
export { voiceTower } from './locations/voice-tower';
export { securityFortress } from './locations/security-fortress';
export { configCitadel } from './locations/config-citadel';

// Legacy export name (kept for backwards compatibility)
export const templates: Record<string, LocationTemplate> = {
  'cron-hub': cronHub,
  'webhook-gateway': webhookGateway,
  'memory-vault': memoryVault,
  'skill-forge': skillForge,
  'channel-bridge': channelBridge,
  'tool-workshop': toolWorkshop,
  'canvas-studio': canvasStudio,
  'voice-tower': voiceTower,
  'security-fortress': securityFortress,
  'config-citadel': configCitadel,
};

// Map building IDs to templates
export const LOCATION_TEMPLATES: Record<string, LocationTemplate> = {
  'cron-hub': cronHub,
  'webhook-gateway': webhookGateway,
  'memory-vault': memoryVault,
  'skill-forge': skillForge,
  'channel-bridge': channelBridge,
  'tool-workshop': toolWorkshop,
  'canvas-studio': canvasStudio,
  'voice-tower': voiceTower,
  'security-fortress': securityFortress,
  'config-citadel': configCitadel,
};
