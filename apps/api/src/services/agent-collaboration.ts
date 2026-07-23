/**
 * Agent collaboration service (Phase 3)
 *
 * Thin wrapper over the CollaborationBroker in @clawville/agent-runtime.
 * Keeps the public API of collaborateOnQuery() + shouldCollaborate()
 * + detectRelevantExperts() identical so apps/api/src/routes/chat.ts
 * doesn't need to change.
 *
 * The broker handles:
 *   - Per-building runtime lazy startup via BuildingRuntimeRegistry
 *   - 10-minute idle cleanup
 *   - OpenAI text-gen routing via the priority chain
 *   - v2 event emission (CLAWVILLE_CONSULT_*)
 *   - SSE log queue drainage
 *
 * No Anthropic SDK import here — all calls route through the runtime.
 */

import {
  getCollaborationBroker,
  type CollaborateRequest,
} from '@clawville/agent-runtime';
import {
  EXPERTISE_KEYWORDS,
  type CollaborationRequest,
  type CollaborationResult,
} from '@clawville/shared';
import { logEvent } from './event-logger';

export type CollaborationInitiator =
  | { kind: 'agent'; agentId: string }
  | { kind: 'human'; userId: string; avatarId: string };

/**
 * Attribution belongs to the API call path, not the shared broker contract.
 * Agent and human subjects are deliberately disjoint because the leaderboard
 * scores them through separate agent_id and avatar_id legs.
 */
export type AttributedCollaborationRequest = CollaborationRequest & {
  initiator?: CollaborationInitiator;
};

/**
 * Detect which buildings have expertise relevant to the user's message.
 * Counts keyword matches per building, excludes the source, returns top N.
 *
 * Pure function — no runtime / network access. Used synchronously in the
 * chat request handler to decide whether to trigger collaboration.
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

/** Quick check: does the message touch another building's domain? */
export function shouldCollaborate(
  message: string,
  sourceBuildingId: string,
): boolean {
  return detectRelevantExperts(message, sourceBuildingId, 1).length > 0;
}

/**
 * Main entry point: detect relevant experts, consult them via the broker,
 * and return combined context for the source agent to incorporate.
 */
export async function collaborateOnQuery(
  request: AttributedCollaborationRequest,
): Promise<CollaborationResult> {
  const start = Date.now();
  const {
    message,
    sourceBuildingId,
    dynamicContext = '',
    maxExperts = 2,
    timeoutMs = 6000,
    initiator,
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

  const broker = getCollaborationBroker();
  const brokerRequest: CollaborateRequest = {
    sourceBuildingId,
    experts,
    question: message,
    sourceContext: dynamicContext,
    timeoutMs,
  };

  const result = await broker.collaborate(brokerRequest);

  // Agent↔Agent collaboration telemetry — Brand Identity §3 axis #1.
  // One event per consulted expert so the dashboard can surface both the
  // source→target pairs and the raw collaboration volume.
  for (const insight of result.insights) {
    const subject = initiator?.kind === 'agent'
      ? { agentId: initiator.agentId, avatarId: null, userId: null }
      : initiator?.kind === 'human'
        ? { agentId: null, avatarId: initiator.avatarId, userId: initiator.userId }
        : { agentId: null, avatarId: null, userId: null };

    void logEvent({
      eventType: 'agent.collaboration.turn',
      ...subject,
      buildingId: sourceBuildingId,
      payload: {
        sourceBuildingId,
        targetBuildingId: insight.buildingId,
        targetBuildingName: insight.buildingName,
        questionLength: message.length,
        answered: Boolean(insight.response),
        kind: 'cross-building-consultation',
        ...(!initiator ? { unattributed: true } : {}),
      },
    });
  }

  let combinedContext = '';
  if (result.insights.length > 0) {
    const lines = result.insights.map(
      (i) => `${i.buildingName} (${i.buildingId}): ${i.response}`,
    );
    combinedContext = `[Collaborative Insights from Fellow Agents]\n${lines.join('\n\n')}\n\nUse these insights from your fellow agents to give a more complete answer. Credit them naturally.`;
  }

  return {
    consulted: result.consulted,
    insights: result.insights,
    combinedContext,
    durationMs: Date.now() - start,
  };
}
