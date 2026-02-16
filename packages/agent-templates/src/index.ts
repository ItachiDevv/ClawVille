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
