/**
 * Shared types for the collaboration system — broker payloads, event
 * payloads, and SSE broadcast entries.
 *
 * These are kept in the agent-runtime package (rather than @clawville/shared)
 * because they're tightly coupled to the broker/registry lifecycle.
 */

export interface ConsultationInsight {
  buildingId: string;
  buildingName: string;
  response: string;
}

export interface CollaborationConsultRequest {
  sourceBuildingId: string;
  targetBuildingId: string;
  question: string;
  sourceContext?: string;
  requestId: string;
}

export interface CollaborationConsultResult {
  sourceBuildingId: string;
  targetBuildingId: string;
  requestId: string;
  insight: ConsultationInsight | null;
  durationMs: number;
  error?: string;
}

/**
 * SSE broadcast entry — shape the web client renders in the thought log.
 * Timestamp is ISO string for JSON-serializability.
 */
export interface CollaborationLogEntry {
  id: string;
  timestamp: string;
  type: 'request' | 'response' | 'merged' | 'error';
  sourceBuildingId?: string;
  targetBuildingId?: string;
  /** Truncated to ~80 chars for display */
  question?: string;
  /** Truncated to ~200 chars for display */
  response?: string;
  durationMs?: number;
}

export interface CollaborationStartedPayload {
  sourceBuildingId: string;
  experts: string[];
  question: string;
  requestId: string;
  timestamp: number;
}

export interface ConsultRequestPayload {
  sourceBuildingId: string;
  targetBuildingId: string;
  question: string;
  requestId: string;
  timestamp: number;
}

export interface ConsultCompletedPayload {
  sourceBuildingId: string;
  targetBuildingId: string;
  requestId: string;
  insight: ConsultationInsight | null;
  durationMs: number;
  error?: string;
  timestamp: number;
}

export interface CollaborationCompletedPayload {
  sourceBuildingId: string;
  consulted: string[];
  insights: ConsultationInsight[];
  durationMs: number;
  requestId: string;
  timestamp: number;
}
