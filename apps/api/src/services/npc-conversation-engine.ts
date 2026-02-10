import Anthropic from '@anthropic-ai/sdk';
import { templates } from '@elizapets/agent-templates';
import { NPC_DEFINITIONS, type NpcDefinition } from '@elizapets/shared';
import type { OpenClawClient } from './openclaw-client';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface ConversationMessage {
  npcId: string;
  npcName: string;
  text: string;
}

/**
 * Generate an NPC-to-NPC conversation using direct Anthropic Haiku calls.
 * Returns 2-4 messages of banter between two NPCs.
 */
export async function generateNpcConversation(
  npc1: NpcDefinition,
  npc2: NpcDefinition,
  arenaMode: boolean
): Promise<ConversationMessage[]> {
  const template1 = templates[npc1.buildingId];
  const template2 = templates[npc2.buildingId];

  const arenaContext = arenaMode
    ? '\nYou are in the ElizaPets Arena where NPCs battle each other. You sometimes fight other NPCs. Reference combat, loot, rivalries, and battles naturally in conversation.'
    : '';

  const systemPrompt = `You are simulating a short conversation between two NPCs in Neopia Central.

NPC 1: "${npc1.name}" — a ${npc1.species}. ${npc1.personality}
${template1 ? `Style: ${template1.style.chat.join(' ')}` : ''}

NPC 2: "${npc2.name}" — a ${npc2.species}. ${npc2.personality}
${template2 ? `Style: ${template2.style.chat.join(' ')}` : ''}
${arenaContext}

Generate a short, natural conversation between these two characters. 2-4 lines total.
Each line should be in the format: NAME: dialogue text
Keep responses short (1-2 sentences each). Be in character. Be playful and fun.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `${npc1.name} and ${npc2.name} run into each other near ${npc1.name}'s area. Generate their conversation.`,
        },
      ],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    return parseConversation(text, npc1, npc2);
  } catch (error) {
    console.error('NPC conversation generation failed:', error);
    return getFallbackConversation(npc1, npc2);
  }
}

function parseConversation(
  text: string,
  npc1: NpcDefinition,
  npc2: NpcDefinition
): ConversationMessage[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const messages: ConversationMessage[] = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const speaker = line.slice(0, colonIdx).trim();
    const dialogue = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!dialogue) continue;

    // Match speaker to NPC
    let matchedNpc: NpcDefinition | null = null;
    if (speaker.toLowerCase().includes(npc1.name.toLowerCase().split(' ')[0])) {
      matchedNpc = npc1;
    } else if (speaker.toLowerCase().includes(npc2.name.toLowerCase().split(' ')[0])) {
      matchedNpc = npc2;
    } else {
      // Alternate between NPCs if we can't match
      matchedNpc = messages.length % 2 === 0 ? npc1 : npc2;
    }

    messages.push({
      npcId: matchedNpc.id,
      npcName: matchedNpc.name,
      text: dialogue.slice(0, 120), // Cap length for bubble display
    });

    if (messages.length >= 4) break;
  }

  if (messages.length === 0) {
    return getFallbackConversation(npc1, npc2);
  }

  return messages;
}

/**
 * Generate a conversation where one or both participants are OpenClaw-controlled.
 * For each OpenClaw participant, call their bot; for non-OpenClaw, call Claude Haiku.
 */
export async function generateOpenClawConversation(
  npc1: NpcDefinition,
  npc2: NpcDefinition,
  client1: OpenClawClient | null,
  client2: OpenClawClient | null,
  arenaMode: boolean
): Promise<ConversationMessage[]> {
  const arenaContext = arenaMode
    ? ' You are in the ElizaPets Arena where NPCs battle each other.'
    : '';

  const messages: ConversationMessage[] = [];
  const participants = [
    { npc: npc1, client: client1, other: npc2 },
    { npc: npc2, client: client2, other: npc1 },
  ];

  try {
    // Generate 2-4 alternating lines
    const numTurns = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numTurns; i++) {
      const { npc, client, other } = participants[i % 2];

      const contextMsg = `You are ${npc.name}, a ${npc.species}. ${npc.personality}${arenaContext}
You just ran into ${other.name} (a ${other.species}). ${other.personality}
${messages.length > 0 ? `Previous dialogue:\n${messages.map((m) => `${m.npcName}: ${m.text}`).join('\n')}` : 'Start the conversation.'}
Reply as ${npc.name} with a single short sentence (1-2 sentences max). Stay in character. Do NOT include your name prefix.`;

      let reply: string;
      if (client) {
        try {
          reply = await client.chat([{ role: 'user', content: contextMsg }]);
        } catch (err) {
          console.error(`[OpenClaw] Chat failed for ${npc.name}:`, err);
          reply = '';
        }
      } else {
        // Use Claude Haiku for non-OpenClaw participant
        try {
          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 80,
            messages: [{ role: 'user', content: contextMsg }],
          });
          reply = response.content[0]?.type === 'text' ? response.content[0].text : '';
        } catch {
          reply = '';
        }
      }

      // Clean up — remove name prefix if the model added it
      reply = reply
        .replace(new RegExp(`^${npc.name}\\s*:\\s*`, 'i'), '')
        .replace(/^["']|["']$/g, '')
        .trim();

      if (reply) {
        messages.push({
          npcId: npc.id,
          npcName: npc.name,
          text: reply.slice(0, 120),
        });
      }
    }
  } catch (err) {
    console.error('[OpenClaw] Conversation generation failed:', err);
  }

  if (messages.length === 0) {
    return getFallbackConversation(npc1, npc2);
  }

  return messages;
}

const FALLBACK_GREETINGS = [
  'Hey there! How\'s business?',
  'Oh, it\'s you! What brings you around?',
  'Nice day for a stroll, huh?',
  'Haven\'t seen you in a while!',
];

const FALLBACK_RESPONSES = [
  'Can\'t complain! The shop\'s been busy.',
  'Just taking a break. It\'s hectic today!',
  'Indeed! The weather\'s perfect.',
  'I\'ve been around, just busy as usual!',
];

function getFallbackConversation(
  npc1: NpcDefinition,
  npc2: NpcDefinition
): ConversationMessage[] {
  const greetIdx = Math.floor(Math.random() * FALLBACK_GREETINGS.length);
  const respIdx = Math.floor(Math.random() * FALLBACK_RESPONSES.length);
  return [
    { npcId: npc1.id, npcName: npc1.name, text: FALLBACK_GREETINGS[greetIdx] },
    { npcId: npc2.id, npcName: npc2.name, text: FALLBACK_RESPONSES[respIdx] },
  ];
}
