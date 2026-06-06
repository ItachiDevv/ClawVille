/**
 * BuildingRuntimeRegistry — lazy-started per-building shared runtimes.
 *
 * Each of the 10 ClawVille buildings gets ONE shared ElizaRuntime that
 * handles collaboration consultations across all users. This is distinct
 * from the per-user-per-location agent runtimes managed by
 * AgentOrchestrator — those are ephemeral user-owned runtimes, these are
 * permanent "building specialist" runtimes that act as knowledge oracles.
 *
 * Lazy lifecycle:
 *   - ensure(buildingId) starts the runtime on first call (lazy)
 *   - Idle runtimes are stopped after 10 minutes of inactivity
 *   - get(buildingId) returns null if runtime isn't started (non-awaiting)
 *
 * Each building runtime loads its location template, builds a character
 * via createCharacter(), and uses the default OpenAI text provider
 * (priority 95) for all consultations (embeddings still via Gemini).
 *
 * Memory budget: 10 shared runtimes at ~30-50MB each = ~500MB worst case.
 * Typical runtime activity will only warm 3-4 buildings per session.
 */

import type { UUID } from '@elizaos/core';
import { v5 as uuidv5 } from 'uuid';

import { ElizaRuntime, createElizaRuntime } from '../eliza-runtime';

// Deterministic agent IDs so the same building always has the same UUID
// across process restarts (important for DB persistence in v2).
const BUILDING_NAMESPACE = 'b7e5c9f1-0a3d-4e7b-9c2f-8d1e6a4b5c7d';

export function buildingAgentId(buildingId: string): UUID {
  return uuidv5(`clawville-building-${buildingId}`, BUILDING_NAMESPACE) as UUID;
}

interface BuildingRuntimeEntry {
  runtime: ElizaRuntime;
  buildingId: string;
  startedAt: Date;
  lastActivity: Date;
}

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per user decision
const INACTIVITY_CHECK_INTERVAL_MS = 60 * 1000; // check every minute

export interface BuildingRuntimeRegistryConfig {
  databaseUrl?: string;
  apiKeys?: {
    /** Gemini API key for embeddings (text generation moved to OpenAI). */
    gemini?: string;
    /** OpenAI API key for TEXT_SMALL/TEXT_LARGE generation. */
    openai?: string;
  };
}

export class BuildingRuntimeRegistry {
  private runtimes: Map<string, BuildingRuntimeEntry> = new Map();
  private startingPromises: Map<string, Promise<ElizaRuntime | null>> = new Map();
  private inactivityInterval: ReturnType<typeof setInterval> | null = null;
  private config: BuildingRuntimeRegistryConfig;
  private shuttingDown = false;

  constructor(config: BuildingRuntimeRegistryConfig = {}) {
    this.config = config;

    this.inactivityInterval = setInterval(() => {
      this.stopInactive().catch((err) =>
        console.error('[BuildingRegistry] stopInactive failed:', err),
      );
    }, INACTIVITY_CHECK_INTERVAL_MS);

    // Let Node exit cleanly even if shutdown() isn't called explicitly
    if (typeof (this.inactivityInterval as any).unref === 'function') {
      (this.inactivityInterval as any).unref();
    }
  }

  /**
   * Ensure a building runtime is warm. Lazy-starts if needed, returns
   * the warm runtime or null on startup failure.
   */
  async ensure(buildingId: string): Promise<ElizaRuntime | null> {
    // Refuse new cold-starts during shutdown — prevents zombie runtimes
    if (this.shuttingDown) return null;

    // Already warm — bump activity and return
    const existing = this.runtimes.get(buildingId);
    if (existing) {
      existing.lastActivity = new Date();
      return existing.runtime;
    }

    // In-flight startup — wait for it to finish
    const inFlight = this.startingPromises.get(buildingId);
    if (inFlight) {
      return inFlight;
    }

    // Cold start
    const startPromise = this.start(buildingId);
    this.startingPromises.set(buildingId, startPromise);
    try {
      return await startPromise;
    } finally {
      this.startingPromises.delete(buildingId);
    }
  }

  /**
   * Non-awaiting accessor — returns the warm runtime if present, else null.
   * Useful for observability / status checks without triggering a warm-up.
   */
  get(buildingId: string): ElizaRuntime | null {
    const entry = this.runtimes.get(buildingId);
    if (!entry) return null;
    entry.lastActivity = new Date();
    return entry.runtime;
  }

  /** Return the list of warm building IDs (for observability) */
  listWarm(): string[] {
    return Array.from(this.runtimes.keys());
  }

  /**
   * Explicit stop for one building — called by shutdown or idle cleanup.
   */
  async stop(buildingId: string): Promise<void> {
    const entry = this.runtimes.get(buildingId);
    if (!entry) return;

    try {
      await entry.runtime.stop();
      console.log(`[BuildingRegistry] Stopped ${buildingId}`);
    } catch (err) {
      console.error(`[BuildingRegistry] Stop failed for ${buildingId}:`, err);
    } finally {
      this.runtimes.delete(buildingId);
    }
  }

  /**
   * Stop all warm runtimes and clear the cleanup interval.
   * Call on API server shutdown.
   *
   * Awaits any in-flight cold-starts before stopping, so we don't leave
   * zombie runtimes behind when a cold-start resolves after shutdown.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.inactivityInterval) {
      clearInterval(this.inactivityInterval);
      this.inactivityInterval = null;
    }

    // Wait for any in-flight cold-starts to resolve so they land in
    // this.runtimes (or fail) before we iterate.
    if (this.startingPromises.size > 0) {
      await Promise.allSettled(Array.from(this.startingPromises.values()));
    }

    const stops: Promise<void>[] = [];
    for (const buildingId of this.runtimes.keys()) {
      stops.push(this.stop(buildingId));
    }
    await Promise.allSettled(stops);
  }

  private async start(buildingId: string): Promise<ElizaRuntime | null> {
    console.log(`[BuildingRegistry] Cold-starting ${buildingId}`);

    try {
      const agentId = buildingAgentId(buildingId);

      const runtime = createElizaRuntime({
        agentId,
        agentType: 'location-agent',
        agentConfig: { locationId: buildingId },
        databaseUrl: this.config.databaseUrl,
        apiKeys: this.config.apiKeys,
      });

      await runtime.start();

      // If shutdown fired while we were starting, immediately stop the
      // newly-warm runtime instead of leaving it orphaned
      if (this.shuttingDown) {
        console.log(`[BuildingRegistry] Cold-start completed during shutdown, stopping ${buildingId}`);
        await runtime.stop().catch(() => {});
        return null;
      }

      this.runtimes.set(buildingId, {
        runtime,
        buildingId,
        startedAt: new Date(),
        lastActivity: new Date(),
      });

      console.log(`[BuildingRegistry] Warm: ${buildingId}`);
      return runtime;
    } catch (err) {
      console.error(`[BuildingRegistry] Failed to start ${buildingId}:`, err);
      return null;
    }
  }

  private async stopInactive(): Promise<void> {
    const now = Date.now();
    const toStop: string[] = [];

    for (const [buildingId, entry] of this.runtimes) {
      if (now - entry.lastActivity.getTime() > INACTIVITY_TIMEOUT_MS) {
        toStop.push(buildingId);
      }
    }

    for (const buildingId of toStop) {
      console.log(`[BuildingRegistry] Idle cleanup: ${buildingId}`);
      await this.stop(buildingId);
    }
  }
}
