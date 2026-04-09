import Anthropic from '@anthropic-ai/sdk';
import { templates } from '@legacyapp/agent-templates';
import {
  EXPERTISE_KEYWORDS,
  BUILDING_OPENCLAW_THEMES,
  type ConsultationInsight,
  type CollaborationRequest,
  type CollaborationResult,
} from '@legacyapp/shared';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Detect which buildings have expertise relevant to the user's message.
 * Counts keyword matches per building, excludes the source, returns top N.
 */
export function detectRelevantExperts(
  message: string,
  sourceBuildingId: string,
  maxExperts = 2,
): string[] {
  const lower = message.toLowerCase();

  const scored: Array<{ buildingId: string; count: number }> = [];

  for (const [buildingId, keywords] of Object.entries(EXPERTISE_KEYWORDS)) {
    if (buildingId === sourceBuildingId) continue;

    let count = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) count++;
    }

    if (count > 0) {
      scored.push({ buildingId, count });
    }
  }

  scored.sort((a, b) => b.count - a.count);
  return scored.slice(0, maxExperts).map((s) => s.buildingId);
}

/**
 * Quick check: does the message touch another building's domain?
 */
export function shouldCollaborate(
  message: string,
  sourceBuildingId: string,
): boolean {
  return detectRelevantExperts(message, sourceBuildingId, 1).length > 0;
}

/**
 * Consult a single specialist building agent for its perspective.
 * Uses extended thinking (budget 2048) with Haiku for fast, focused responses.
 * Returns null on any error — never throws.
 */
async function consultSpecialist(
  buildingId: string,
  userQuestion: string,
  sourceContext: string,
): Promise<ConsultationInsight | null> {
  try {
    const template = templates[buildingId];
    const theme = BUILDING_OPENCLAW_THEMES[buildingId];

    if (!template || !theme) return null;

    const systemPrompt = `You are ${template.name}, the specialist agent at the ${theme.label} in ClawVille.
Your expertise: ${theme.focus} (${theme.category}).
Personality: ${template.adjectives.join(', ')}.
Style: ${template.style.chat.join(' ')}

Another building agent is consulting you because a visitor asked a question that touches your domain.
Give a brief, helpful insight from your area of expertise. Stay in character. Be concise — max 2-3 sentences.

Context from the requesting agent:
${sourceContext}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2348,
      thinking: {
        type: 'enabled',
        budget_tokens: 2048,
      },
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `A visitor asked: "${userQuestion}"\n\nPlease share your specialist insight on this topic.`,
        },
      ],
    });

    // Extract the text block, skipping thinking blocks
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        text = block.text;
        break;
      }
    }

    if (!text) return null;

    // Cap response at 300 characters
    const capped = text.length > 300 ? text.slice(0, 297) + '...' : text;

    return {
      buildingId,
      buildingName: template.name,
      response: capped,
    };
  } catch (error) {
    console.error(`[Collaboration] Error consulting ${buildingId}:`, error);
    return null;
  }
}

/**
 * Main entry point: detect relevant experts, consult them in parallel,
 * and return combined context for the source agent to incorporate.
 */
export async function collaborateOnQuery(
  request: CollaborationRequest,
): Promise<CollaborationResult> {
  const start = Date.now();
  const {
    message,
    sourceBuildingId,
    dynamicContext = '',
    maxExperts = 2,
    timeoutMs = 4000,
  } = request;

  const experts = detectRelevantExperts(message, sourceBuildingId, maxExperts);

  if (experts.length === 0) {
    return {
      consulted: [],
      insights: [],
      combinedContext: '',
      durationMs: Date.now() - start,
    };
  }

  console.log(`[Collaboration] ${sourceBuildingId} consulting: ${experts.join(', ')}`);

  const consultations = experts.map((id) =>
    consultSpecialist(id, message, dynamicContext),
  );

  // Race between all consultations settling and the timeout
  const settled = await Promise.race([
    Promise.allSettled(consultations),
    new Promise<PromiseSettledResult<ConsultationInsight | null>[]>((resolve) =>
      setTimeout(
        () => resolve(consultations.map(() => ({ status: 'rejected' as const, reason: 'timeout' }))),
        timeoutMs,
      ),
    ),
  ]);

  const insights: ConsultationInsight[] = [];
  const consulted: string[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      insights.push(result.value);
      consulted.push(result.value.buildingId);
    }
  }

  let combinedContext = '';
  if (insights.length > 0) {
    const lines = insights.map(
      (i) => `${i.buildingName} (${i.buildingId}): ${i.response}`,
    );
    combinedContext = `[Collaborative Insights from Fellow Agents]\n${lines.join('\n\n')}\n\nUse these insights from your fellow agents to give a more complete answer. Credit them naturally.`;
  }

  return {
    consulted,
    insights,
    combinedContext,
    durationMs: Date.now() - start,
  };
}
