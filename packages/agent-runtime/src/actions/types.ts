/**
 * ElizaOS Action types — defined locally to avoid importing from @elizaos/core.
 * These mirror the ElizaOS v2 Action interface used by the runtime.
 */

// ---------------------------------------------------------------------------
// Service injection
// ---------------------------------------------------------------------------

export interface ClawTokenServiceParams {
  avatarId: string;
  amount: number;
  reason: string;
  source: string;
  metadata: Record<string, any>;
}

/**
 * Covenant action-record input (2026-07-13). Mirrors the API-side
 * `CovenantActionInput` (apps/api covenant-action-recorder.ts) — typed loosely
 * here so agent-runtime never imports apps/api.
 */
export interface CovenantActionRecordParams {
  action: string;
  subjectType: 'avatar' | 'treasury' | 'system';
  subjectId: string;
  actorKind?: string | null;
  payload: Record<string, unknown>;
}

export interface ClawvilleServices {
  /** Credit ClawTokens to an avatar (returns new balance) */
  creditClawTokens: (params: ClawTokenServiceParams) => Promise<{ balanceAfter: number }>;
  /** Debit ClawTokens from an avatar (returns new balance) */
  debitClawTokens: (params: ClawTokenServiceParams) => Promise<{ balanceAfter: number }>;
  /** Drizzle query builder instance (injected from the API layer) */
  db: any;
  /**
   * Covenant action-record stream append (2026-07-13) — injected by the API's
   * `buildRuntimeServices`, pre-bound to the surface's actor kind. Pass the
   * enclosing drizzle `tx` to make the record atomic with the action's write.
   * OPTIONAL so bespoke service constructors (tests, older bridges) keep
   * compiling; handlers must guard for presence.
   */
  recordCovenantAction?: (
    params: CovenantActionRecordParams,
    tx?: any,
  ) => Promise<{ id: string | null; deduped: boolean }>;
}

export interface ClawvilleActionState {
  /** Avatar performing the action */
  avatarId: string;
  /** User who owns the avatar */
  userId: string;
  /** Injected service layer — the API populates this before calling the action */
  services: ClawvilleServices;
}

// ---------------------------------------------------------------------------
// Action result
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  text?: string;
  data?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Action interface (ElizaOS v2 compatible)
// ---------------------------------------------------------------------------

export interface ActionParameter {
  name: string;
  description: string;
  required: boolean;
  schema: { type: string; enum?: string[] };
}

export interface Action {
  name: string;
  description: string;
  similes?: string[];
  examples?: Array<Array<{ user: string; content: { text: string; action?: string } }>>;
  validate: (runtime: any, message: any, state?: any) => Promise<boolean>;
  handler: (
    runtime: any,
    message: any,
    state?: any,
    options?: any,
    callback?: any,
  ) => Promise<ActionResult>;
  parameters?: ActionParameter[];
  suppressPostActionContinuation?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type-guard: ensures state has the required ClawVille services injected. */
export function hasServices(state: any): state is ClawvilleActionState {
  return (
    state &&
    typeof state === 'object' &&
    typeof state.avatarId === 'string' &&
    typeof state.userId === 'string' &&
    state.services &&
    typeof state.services.creditClawTokens === 'function' &&
    typeof state.services.debitClawTokens === 'function' &&
    state.services.db != null
  );
}

/** Extract the text content from an ElizaOS message object. */
export function getMessageText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (message.content?.text) return message.content.text;
  return '';
}

/**
 * Extract a named parameter value from an ElizaOS message.
 * The runtime may populate `message.content.parameters` when it
 * successfully parses structured params from the user turn.
 */
export function getParam(message: any, name: string): string | undefined {
  if (!message) return undefined;
  const params =
    message.content?.parameters ??
    message.parameters ??
    message.content?.data?.parameters;
  if (params && typeof params === 'object') {
    return params[name] as string | undefined;
  }
  return undefined;
}

/** Extract a named parameter as an integer. Returns undefined if missing or non-numeric. */
export function getParamInt(message: any, name: string): number | undefined {
  const val = getParam(message, name);
  if (val === undefined) return undefined;
  const num = parseInt(val, 10);
  return isNaN(num) ? undefined : num;
}

/** Extract a named parameter as a float. Returns undefined if missing or non-numeric. */
export function getParamFloat(message: any, name: string): number | undefined {
  const val = getParam(message, name);
  if (val === undefined) return undefined;
  const num = parseFloat(val);
  return isNaN(num) ? undefined : num;
}

// ---------------------------------------------------------------------------
// Database import helper — all actions use dynamic import('@clawville/database')
// to avoid circular dependency between packages/agent-runtime and apps/api.
// This helper centralises the import + caches the module so it's only resolved
// once per process lifetime instead of on every handler call.
// ---------------------------------------------------------------------------

let _dbModule: any = null;

/**
 * Lazily import and cache `@clawville/database`. All action handlers
 * should use this instead of raw `await import('@clawville/database')`.
 */
export async function getDbModule(): Promise<any> {
  if (!_dbModule) {
    _dbModule = await import('@clawville/database');
  }
  return _dbModule;
}
