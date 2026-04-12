/**
 * ElizaOS Action types — defined locally to avoid importing from @elizaos/core.
 * These mirror the ElizaOS v2 Action interface used by the runtime.
 */

// ---------------------------------------------------------------------------
// Service injection
// ---------------------------------------------------------------------------

export interface ClawTokenServiceParams {
  petId: string;
  amount: number;
  reason: string;
  source: string;
  metadata: Record<string, any>;
}

export interface ClawvilleServices {
  /** Credit ClawTokens to a pet (returns new balance) */
  creditClawTokens: (params: ClawTokenServiceParams) => Promise<{ balanceAfter: number }>;
  /** Debit ClawTokens from a pet (returns new balance) */
  debitClawTokens: (params: ClawTokenServiceParams) => Promise<{ balanceAfter: number }>;
  /** Drizzle query builder instance (injected from the API layer) */
  db: any;
}

export interface ClawvilleActionState {
  /** Pet performing the action */
  petId: string;
  /** User who owns the pet */
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
    typeof state.petId === 'string' &&
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
