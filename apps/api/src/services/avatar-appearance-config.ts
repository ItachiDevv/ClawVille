import { sql, type SQL } from 'drizzle-orm';
import { agents } from '@clawville/database';
import type { AgentCategory, AgentModelKey } from '@clawville/shared';

/** Merge only appearance-owned keys against the row at UPDATE time. */
export function appearanceAgentConfigMerge(patch: {
  modelKey?: AgentModelKey;
  agentCategory?: AgentCategory;
}): SQL | undefined {
  const changed = {
    ...(patch.modelKey ? { modelKey: patch.modelKey } : {}),
    ...(patch.agentCategory ? { agentCategory: patch.agentCategory } : {}),
  };
  if (Object.keys(changed).length === 0) return undefined;
  return sql`COALESCE(${agents.config}, '{}'::jsonb) || ${JSON.stringify(changed)}::jsonb`;
}
