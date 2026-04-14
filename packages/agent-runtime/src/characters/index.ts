/**
 * ClawVille Characters — Proper ElizaOS Character objects
 *
 * Converts the location templates into full ElizaOS `Character` objects
 * that can be used with `elizaos start --character`, the Project export,
 * or loaded directly into an AgentRuntime.
 *
 * Each character is a SpongeBob NPC who teaches OpenClaw agent development
 * concepts at their assigned building.
 */

import { createCharacter, type Character, type CharacterInput } from '@elizaos/core';
import {
  cronHub,
  webhookGateway,
  memoryVault,
  skillForge,
  channelBridge,
  toolWorkshop,
  canvasStudio,
  voiceTower,
  securityFortress,
  configCitadel,
  type LocationTemplate,
} from '@clawville/agent-templates';

// Re-export for backward compat
export type { LocationTemplate } from '@clawville/agent-templates';

// ---------------------------------------------------------------------------
// Template → Character converter
// ---------------------------------------------------------------------------

function templateToCharacter(
  locationId: string,
  template: LocationTemplate,
): Character {
  const input: CharacterInput & { name: string } = {
    name: template.name,
    username: locationId,
    system: `You are ${template.name}. ${template.description}`,
    // Merge lore into bio — ElizaOS v2 CharacterInput doesn't have a separate lore field
    // Merge knowledge into bio too — ElizaOS v2 treats knowledge strings as file paths,
    // not inline text. By putting them in bio, they become part of the character context.
    bio: [...template.bio, ...template.lore, ...template.knowledge],
    knowledge: [],
    topics: template.topics,
    adjectives: template.adjectives,
    messageExamples: template.messageExamples.map((conversation) =>
      conversation.map((msg) => ({
        name: msg.user.startsWith('{{') ? 'User' : msg.user,
        content: { text: msg.content.text },
      })),
    ),
    postExamples: [],
    style: template.style,
    plugins: ['@elizaos/plugin-sql'],
    settings: {
      ...(template.settings || {}),
    } as any,
  };

  return createCharacter(input);
}

// ---------------------------------------------------------------------------
// Individual character exports
// ---------------------------------------------------------------------------

export const garyCronHub = templateToCharacter('cron-hub', cronHub);
export const relayWebhookGateway = templateToCharacter('webhook-gateway', webhookGateway);
export const mnemaMemoryVault = templateToCharacter('memory-vault', memoryVault);
export const forgemasterSkillForge = templateToCharacter('skill-forge', skillForge);
export const bridgetChannelBridge = templateToCharacter('channel-bridge', channelBridge);
export const tinkererToolWorkshop = templateToCharacter('tool-workshop', toolWorkshop);
export const pixelCanvasStudio = templateToCharacter('canvas-studio', canvasStudio);
export const echoVoiceTower = templateToCharacter('voice-tower', voiceTower);
export const sentinelSecurityFortress = templateToCharacter('security-fortress', securityFortress);
export const archonConfigCitadel = templateToCharacter('config-citadel', configCitadel);

// ---------------------------------------------------------------------------
// Character map — keyed by building/location ID
// ---------------------------------------------------------------------------

export const CHARACTERS: Record<string, Character> = {
  'cron-hub': garyCronHub,
  'webhook-gateway': relayWebhookGateway,
  'memory-vault': mnemaMemoryVault,
  'skill-forge': forgemasterSkillForge,
  'channel-bridge': bridgetChannelBridge,
  'tool-workshop': tinkererToolWorkshop,
  'canvas-studio': pixelCanvasStudio,
  'voice-tower': echoVoiceTower,
  'security-fortress': sentinelSecurityFortress,
  'config-citadel': archonConfigCitadel,
};

// ---------------------------------------------------------------------------
// Default avatar/player agent character
// ---------------------------------------------------------------------------

export const defaultPetCharacter = createCharacter({
  name: 'ClawVille Agent',
  username: 'clawville-agent',
  system: 'You are a friendly agent companion in the world of ClawVille. You chat with your owner, explore buildings, learn skills from NPCs, and help your owner navigate the OpenClaw ecosystem.',
  bio: [
    'A curious agent exploring the underwater world of ClawVille.',
    'Loves learning new skills from the SpongeBob NPCs at each building.',
    'Always eager to help their owner understand OpenClaw agent development.',
    'Hatched from a digital egg in the depths of ClawVille.',
    'Every skill learned makes them stronger and more capable.',
    'ClawVille is an underwater world where agents learn OpenClaw development skills.',
    'Each building teaches different aspects: cron jobs, webhooks, memory, skills, channels, tools, canvas, voice, security, and configuration.',
    'ClawTokens are earned by chatting with NPCs and completing quests.',
  ],
  knowledge: [],
  topics: ['OpenClaw', 'agent development', 'ClawVille exploration', 'skill learning'],
  adjectives: ['curious', 'friendly', 'eager', 'helpful'],
  messageExamples: [
    [
      { name: 'User', content: { text: 'What should we do today?' } },
      { name: 'ClawVille Agent', content: { text: "Let's visit the Skill Forge! Forgemaster Kai can teach us about building marketplace skills. Plus we'll earn some ClawTokens along the way." } },
    ],
  ],
  postExamples: [],
  style: {
    all: ['Be enthusiastic about learning and exploring.', 'Reference specific buildings and NPCs by name.'],
    chat: ['Keep responses concise and action-oriented.'],
    post: [],
  },
  plugins: ['@elizaos/plugin-sql'],
  settings: {} as any,
} as CharacterInput & { name: string });
