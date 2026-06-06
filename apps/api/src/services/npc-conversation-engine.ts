import { templates } from '@clawville/agent-templates';
import { NPC_DEFINITIONS, type NpcDefinition } from '@clawville/shared';
import type { OpenClawClient } from './openclaw-client';

// LLM config — OpenAI is the SOLE text backend for NPC banter (Gemini text is
// billing-dead / 403; GEMINI_API_KEY is now embeddings-only, so calling Gemini
// here would just log 403 noise). NPC banter is casual chat, so no extended
// thinking — just a plain chat completion at high temperature.
const OPENAI_MODEL = process.env.OPENAI_SMALL_MODEL ?? 'gpt-4o-mini';
const LLM_TEMPERATURE = 0.9;
const OPENAI_MAX_TOKENS = 400;

interface ConversationMessage {
  npcId: string;
  npcName: string;
  text: string;
}

/**
 * Call the LLM for NPC banter. OpenAI is the SOLE backend — there is no Gemini
 * fallback (Gemini text is billing-dead / 403; GEMINI_API_KEY is embeddings-only
 * now, so a fallback would only emit 403 noise). Returns the trimmed text on
 * success, or an empty string on any failure. Never throws — callers use the
 * empty string to fall back to canned lines.
 */
async function callLlmForNpc(
  systemPrompt: string | null,
  userMessage: string,
): Promise<string> {
  // OpenAI only — no backoff gating, no secondary provider.
  return callOpenAIForNpc(systemPrompt, userMessage);
}

/**
 * Call OpenAI's chat completions endpoint — the sole NPC banter backend.
 * Uses OPENAI_SMALL_MODEL (default gpt-4o-mini) for cost efficiency.
 * Returns the trimmed text on success, or an empty string on any failure.
 */
async function callOpenAIForNpc(
  systemPrompt: string | null,
  userMessage: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[NPC Convo] OPENAI_API_KEY missing — no primary LLM available');
    return '';
  }

  try {
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userMessage });

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: LLM_TEMPERATURE,
        max_completion_tokens: OPENAI_MAX_TOKENS,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[NPC Convo] OpenAI ${res.status}: ${errText.slice(0, 200)}`);
      return '';
    }

    const data = (await res.json()) as any;
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (!text) return '';
    return text.trim();
  } catch (err) {
    console.error('[NPC Convo] OpenAI fetch failed:', err);
    return '';
  }
}

/**
 * Generate an NPC-to-NPC conversation via the LLM (OpenAI — sole backend).
 * Returns 2-4 messages of banter between two NPCs. On any LLM failure (missing
 * key, non-2xx response, empty output) falls back to canned lines — never
 * throws to the caller.
 */
export async function generateNpcConversation(
  npc1: NpcDefinition,
  npc2: NpcDefinition,
  arenaMode: boolean,
  _cryptoContext?: string,
): Promise<ConversationMessage[]> {
  const template1 = templates[npc1.buildingId];
  const template2 = templates[npc2.buildingId];

  const arenaContext = arenaMode
    ? '\nYou are in the ClawVille Arena where NPCs battle each other. You sometimes fight other NPCs. Reference combat, loot, rivalries, and battles naturally in conversation.'
    : '';

  const systemPrompt = `You are simulating a short conversation between two NPCs in ClawVille.

NPC 1: "${npc1.name}" — a ${npc1.species}. ${npc1.personality}
${template1 ? `Style: ${template1.style.chat.join(' ')}` : ''}

NPC 2: "${npc2.name}" — a ${npc2.species}. ${npc2.personality}
${template2 ? `Style: ${template2.style.chat.join(' ')}` : ''}
${arenaContext}

Generate a short, natural conversation between these two characters. 2-4 lines total.
Each line should be in the format: NAME: dialogue text
Keep responses short (1-2 sentences each). Be in character. Be playful and fun.`;

  const userMessage = `${npc1.name} and ${npc2.name} run into each other near ${npc1.name}'s area. Generate their conversation.`;

  const text = await callLlmForNpc(systemPrompt, userMessage);
  if (!text) {
    return getFallbackConversation(npc1, npc2);
  }
  return parseConversation(text, npc1, npc2);
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
 * For each OpenClaw participant, call their bot; for non-OpenClaw, call the LLM
 * (OpenAI — sole backend). LLM failures produce empty replies so the loop
 * degrades gracefully instead of throwing.
 */
export async function generateOpenClawConversation(
  npc1: NpcDefinition,
  npc2: NpcDefinition,
  client1: OpenClawClient | null,
  client2: OpenClawClient | null,
  arenaMode: boolean,
  _cryptoContext?: string,
  /**
   * Hatcher proxy-cognition hook (Phase A++, 2026-06-02). For a hatcher-proxy
   * client the reply may carry [ACTION: ...] tags; this callback (provided by
   * the sim) validates + executes the whitelisted actions against THIS npcId
   * and returns the cleaned (action-stripped) speech. Returns the raw reply
   * unchanged for non-proxy clients / when omitted.
   */
  processProxyReply?: (npcId: string, client: OpenClawClient, rawReply: string) => string,
): Promise<ConversationMessage[]> {
  const arenaContext = arenaMode
    ? ' You are in the ClawVille Arena where NPCs battle each other.'
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
          // Hatcher proxy-cognition: parse + execute [ACTION:] tags from the
          // reply and strip them so only clean speech remains. No-op for
          // non-proxy clients (the callback gates on protocol internally).
          if (reply && processProxyReply) {
            reply = processProxyReply(npc.id, client, reply);
          }
        } catch (err) {
          console.error(`[OpenClaw] Chat failed for ${npc.name}:`, err);
          reply = '';
        }
      } else {
        // Use the LLM (OpenAI, sole backend) for the non-OpenClaw participant. No
        // system instruction here — the original call shoved everything into
        // the user message as well, so we keep that shape identical for parity.
        reply = await callLlmForNpc(null, contextMsg);
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
