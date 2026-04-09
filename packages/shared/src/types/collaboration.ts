/**
 * Collaboration & Extended Thinking types for ClawVille agents.
 */

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export const THINKING_BUDGET: Record<ThinkingEffort, number> = {
  low: 2048,
  medium: 5000,
  high: 10000,
  max: 20000,
};

export interface AgentThinkingConfig {
  effort: ThinkingEffort;
  enableThinkTool: boolean;
  model: string;
}
