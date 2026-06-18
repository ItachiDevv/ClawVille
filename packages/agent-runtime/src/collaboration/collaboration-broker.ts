/**
 * CollaborationBroker — process-level event router for cross-building
 * agent consultation.
 *
 * Flow:
 *   1. chat.ts calls collaborateOnQuery() → calls broker.consult(...)
 *   2. Broker ensures target building runtime via BuildingRuntimeRegistry
 *   3. Broker emits CLAWVILLE_CONSULT_REQUEST on that runtime
 *   4. Broker calls runtime.useModel(TEXT_LARGE) with specialist prompt
 *      (routes through the OpenAI text provider at priority 95 → gpt-4o)
 *   5. Broker emits CLAWVILLE_CONSULT_COMPLETED on that runtime
 *   6. Broker also enqueues a CollaborationLogEntry for SSE broadcast
 *
 * The broker is a singleton created once at module load. API routes
 * and the npc-simulation drainer import the same instance.
 */

import { ModelType } from '@elizaos/core';
import { templates, type LocationTemplate } from '@clawville/agent-templates';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import { v4 as uuidv4 } from 'uuid';

import { BuildingRuntimeRegistry, type BuildingRuntimeRegistryConfig } from './building-runtime-registry';
import {
  CLAWVILLE_COLLABORATION_STARTED,
  CLAWVILLE_CONSULT_REQUEST,
  CLAWVILLE_CONSULT_COMPLETED,
  CLAWVILLE_COLLABORATION_COMPLETED,
} from './events';
import type {
  CollaborationLogEntry,
  ConsultationInsight,
  CollaborationStartedPayload,
  ConsultRequestPayload,
  ConsultCompletedPayload,
  CollaborationCompletedPayload,
} from './types';

const MAX_PENDING_ENTRIES = 200;

export interface CollaborateRequest {
  sourceBuildingId: string;
  experts: string[];
  question: string;
  sourceContext?: string;
  /** Timeout in ms for the Promise.race against all consultations */
  timeoutMs?: number;
}

export interface CollaborateResult {
  consulted: string[];
  insights: ConsultationInsight[];
  durationMs: number;
  requestId: string;
}

export class CollaborationBroker {
  private registry: BuildingRuntimeRegistry;
  private pendingLogEntries: CollaborationLogEntry[] = [];

  constructor(config: BuildingRuntimeRegistryConfig = {}) {
    this.registry = new BuildingRuntimeRegistry(config);
  }

  /**
   * Main entry point. Runs parallel consultations via the per-building
   * registry, emits v2 events, enqueues SSE log entries, and returns
   * the aggregated insights synchronously.
   */
  async collaborate(request: CollaborateRequest): Promise<CollaborateResult> {
    const start = Date.now();
    const requestId = uuidv4();
    const timeoutMs = request.timeoutMs ?? 6000;

    if (request.experts.length === 0) {
      return {
        consulted: [],
        insights: [],
        durationMs: Date.now() - start,
        requestId,
      };
    }

    // Emit COLLABORATION_STARTED on the source runtime (if warm)
    this.tryEmit(request.sourceBuildingId, CLAWVILLE_COLLABORATION_STARTED, {
      sourceBuildingId: request.sourceBuildingId,
      experts: request.experts,
      question: request.question,
      requestId,
      timestamp: Date.now(),
    } satisfies CollaborationStartedPayload);

    this.enqueueLogEntry({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'request',
      sourceBuildingId: request.sourceBuildingId,
      targetBuildingId: request.experts.join(', '),
      question: this.truncate(request.question, 80),
    });

    // Fire all consultations in parallel, each with its OWN timeout.
    // Per-consult timeouts preserve completed insights that finished before
    // the timeout fired — a global Promise.race around allSettled discards
    // ALL results the moment any one times out, which we do NOT want.
    const consultations = request.experts.map((targetBuildingId) =>
      this.consultOneWithTimeout(
        request.sourceBuildingId,
        targetBuildingId,
        request.question,
        request.sourceContext ?? '',
        requestId,
        timeoutMs,
      ),
    );

    const settled = await Promise.allSettled(consultations);

    const insights: ConsultationInsight[] = [];
    const consulted: string[] = [];

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        insights.push(result.value);
        consulted.push(result.value.buildingId);
      }
    }

    const durationMs = Date.now() - start;

    // Emit COLLABORATION_COMPLETED
    this.tryEmit(
      request.sourceBuildingId,
      CLAWVILLE_COLLABORATION_COMPLETED,
      {
        sourceBuildingId: request.sourceBuildingId,
        consulted,
        insights,
        durationMs,
        requestId,
        timestamp: Date.now(),
      } satisfies CollaborationCompletedPayload,
    );

    this.enqueueLogEntry({
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      type: 'merged',
      sourceBuildingId: request.sourceBuildingId,
      response: `${insights.length} insight${insights.length === 1 ? '' : 's'} from ${consulted.join(', ')}`,
      durationMs,
    });

    return { consulted, insights, durationMs, requestId };
  }

  /**
   * Drain pending SSE log entries. Called each tick by npc-simulation
   * to include in the broadcast snapshot. Entries are consumed — each
   * call returns and clears the queue.
   */
  drainLogEntries(): CollaborationLogEntry[] {
    if (this.pendingLogEntries.length === 0) return [];
    const drained = this.pendingLogEntries;
    this.pendingLogEntries = [];
    return drained;
  }

  /** Access the underlying registry (for observability / shutdown) */
  getRegistry(): BuildingRuntimeRegistry {
    return this.registry;
  }

  async shutdown(): Promise<void> {
    await this.registry.shutdown();
  }

  /* ===================== internals ===================== */

  /**
   * Wrap a single consultation with its own timeout. If it times out,
   * the in-flight promise is abandoned (can't be cancelled mid-LLM-call
   * in the current runtime) but the returned promise rejects so the
   * caller's allSettled completes without waiting for the slow consult.
   */
  private async consultOneWithTimeout(
    sourceBuildingId: string,
    targetBuildingId: string,
    question: string,
    sourceContext: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<ConsultationInsight | null> {
    return Promise.race([
      this.consultOne(sourceBuildingId, targetBuildingId, question, sourceContext, requestId),
      new Promise<ConsultationInsight | null>((_, reject) =>
        setTimeout(() => reject(new Error(`Consultation timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  private async consultOne(
    sourceBuildingId: string,
    targetBuildingId: string,
    question: string,
    sourceContext: string,
    requestId: string,
  ): Promise<ConsultationInsight | null> {
    const consultStart = Date.now();
    const template = templates[targetBuildingId];
    const theme = BUILDING_OPENCLAW_THEMES[targetBuildingId];

    if (!template || !theme) {
      this.enqueueLogEntry({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: 'error',
        sourceBuildingId,
        targetBuildingId,
        response: `Template or theme not found for ${targetBuildingId}`,
      });
      return null;
    }

    // Ensure the target runtime is warm
    const runtime = await this.registry.ensure(targetBuildingId);
    if (!runtime) {
      this.enqueueLogEntry({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: 'error',
        sourceBuildingId,
        targetBuildingId,
        response: `Failed to start runtime for ${targetBuildingId}`,
      });
      return null;
    }

    // Emit CONSULT_REQUEST on the target runtime
    this.tryEmitOn(runtime, CLAWVILLE_CONSULT_REQUEST, {
      sourceBuildingId,
      targetBuildingId,
      question,
      requestId,
      timestamp: Date.now(),
    } satisfies ConsultRequestPayload);

    try {
      const prompt = this.buildSpecialistPrompt(
        template,
        theme,
        question,
        sourceContext,
      );

      // Route through the runtime's model priority chain
      // (OpenAI text provider at 95 wins by default; TEXT_LARGE → gpt-4o)
      const underlying = (runtime as unknown as {
        runtime: { useModel: any } | null;
      }).runtime;

      if (!underlying || typeof underlying.useModel !== 'function') {
        throw new Error('Underlying runtime not initialized');
      }

      const rawResponse: string = await underlying.useModel(
        ModelType.TEXT_LARGE,
        {
          prompt,
          maxTokens: 400,
          temperature: 0.7,
          stopSequences: [],
        },
      );

      const text = (rawResponse ?? '').trim();
      const capped = text.length > 300 ? text.slice(0, 297) + '...' : text;

      const insight: ConsultationInsight = {
        buildingId: targetBuildingId,
        buildingName: template.name,
        response: capped,
      };

      this.tryEmitOn(runtime, CLAWVILLE_CONSULT_COMPLETED, {
        sourceBuildingId,
        targetBuildingId,
        requestId,
        insight,
        durationMs: Date.now() - consultStart,
        timestamp: Date.now(),
      } satisfies ConsultCompletedPayload);

      this.enqueueLogEntry({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: 'response',
        sourceBuildingId,
        targetBuildingId,
        response: this.truncate(capped, 200),
        durationMs: Date.now() - consultStart,
      });

      return insight;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[CollaborationBroker] Consultation ${sourceBuildingId} → ${targetBuildingId} failed:`,
        errMsg,
      );

      this.tryEmitOn(runtime, CLAWVILLE_CONSULT_COMPLETED, {
        sourceBuildingId,
        targetBuildingId,
        requestId,
        insight: null,
        durationMs: Date.now() - consultStart,
        error: errMsg,
        timestamp: Date.now(),
      } satisfies ConsultCompletedPayload);

      this.enqueueLogEntry({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type: 'error',
        sourceBuildingId,
        targetBuildingId,
        response: errMsg.slice(0, 200),
        durationMs: Date.now() - consultStart,
      });

      return null;
    }
  }

  private buildSpecialistPrompt(
    template: LocationTemplate,
    theme: (typeof BUILDING_OPENCLAW_THEMES)[string],
    question: string,
    sourceContext: string,
  ): string {
    const systemLines = [
      `You are ${template.name}, the specialist agent at the ${theme.label} in ClawVille.`,
      `Your expertise: ${theme.focus} (${theme.category}).`,
      `Personality: ${template.adjectives.join(', ')}.`,
      `Style: ${template.style.chat.join(' ')}`,
      ``,
      `Another building agent is consulting you because a visitor asked a question that touches your domain.`,
      `Give a brief, helpful insight from your area of expertise. Stay in character. Be concise — max 2-3 sentences.`,
      ``,
      sourceContext ? `Context from the requesting agent:\n${sourceContext}` : '',
      ``,
      `A visitor asked: "${question}"`,
      ``,
      `Please share your specialist insight on this topic.`,
    ];
    return systemLines.filter((l) => l !== undefined).join('\n');
  }

  private truncate(text: string, max: number): string {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  private enqueueLogEntry(entry: CollaborationLogEntry): void {
    this.pendingLogEntries.push(entry);
    // Cap the queue so unread backlog can't grow unbounded
    if (this.pendingLogEntries.length > MAX_PENDING_ENTRIES) {
      this.pendingLogEntries.splice(
        0,
        this.pendingLogEntries.length - MAX_PENDING_ENTRIES,
      );
    }
  }

  /** Emit an event on the source building's runtime (if warm). Never throws. */
  private tryEmit(
    buildingId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): void {
    const runtime = this.registry.get(buildingId);
    if (!runtime) return;
    this.tryEmitOn(runtime, eventName, payload);
  }

  private tryEmitOn(
    elizaRuntime: unknown,
    eventName: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      const inner = (elizaRuntime as { runtime?: { emitEvent?: any } }).runtime;
      if (inner && typeof inner.emitEvent === 'function') {
        // emitEvent is async but we fire-and-forget for telemetry
        Promise.resolve(
          inner.emitEvent(eventName, {
            runtime: inner,
            ...payload,
          }),
        ).catch((err) => {
          console.error(`[CollaborationBroker] emitEvent(${eventName}) failed:`, err);
        });
      }
    } catch {
      // Never let observability break the main flow
    }
  }
}

// Singleton instance — lazy-constructed on first access
let singleton: CollaborationBroker | null = null;

export function getCollaborationBroker(
  config?: BuildingRuntimeRegistryConfig,
): CollaborationBroker {
  if (!singleton) {
    singleton = new CollaborationBroker(
      config ?? {
        databaseUrl: process.env.DATABASE_URL,
        apiKeys: {
          // OpenAI = TEXT_SMALL/TEXT_LARGE generation + embeddings (sole backend).
          openai: process.env.OPENAI_API_KEY,
        },
      },
    );
  }
  return singleton;
}
