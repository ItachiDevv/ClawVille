/**
 * Custom event name constants for the ClawVille collaboration system.
 *
 * These are string event names (not EventType enum values) emitted via
 * runtime.emitEvent(name, payload). v2 supports both enum and custom
 * string events — custom string names are used for project-specific
 * cross-building coordination.
 */

export const CLAWVILLE_COLLABORATION_STARTED = 'CLAWVILLE_COLLABORATION_STARTED';
export const CLAWVILLE_CONSULT_REQUEST = 'CLAWVILLE_CONSULT_REQUEST';
export const CLAWVILLE_CONSULT_COMPLETED = 'CLAWVILLE_CONSULT_COMPLETED';
export const CLAWVILLE_COLLABORATION_COMPLETED = 'CLAWVILLE_COLLABORATION_COMPLETED';
