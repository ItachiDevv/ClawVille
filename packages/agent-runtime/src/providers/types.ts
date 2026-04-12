/**
 * Local Provider/ProviderResult types for ClawVille providers.
 *
 * Defined here instead of importing from @elizaos/core because the
 * alpha-3 build may not export complete type definitions for these
 * interfaces. Once upstream stabilises we can switch to re-exports.
 */

export interface ProviderResult {
  /** Human-readable text injected into the agent prompt. */
  text?: string;
  /** Template variable substitutions (key/value pairs). */
  values?: Record<string, any>;
  /** Structured data available to other providers/actions. */
  data?: Record<string, any>;
}

export interface Provider {
  /** Unique name identifying this provider. */
  name: string;
  /** Short description of what data this provider supplies. */
  description?: string;
  /** Ordering hint — lower values appear earlier in the context string. */
  position?: number;
  /** Fetch the provider's data for the current request. */
  get(runtime: any, message: any, state: any): Promise<ProviderResult>;
}
