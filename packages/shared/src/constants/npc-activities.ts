/** Activities an NPC or autonomous avatar can be doing */
export type NpcActivity =
  | 'idle'
  | 'walking'
  | 'thinking'
  | 'reading'
  | 'crafting'
  | 'trading'
  | 'exploring'
  | 'sleeping'
  | 'socializing'
  | 'training'
  | 'researching';

export const ACTIVITY_EMOJIS: Record<NpcActivity, string> = {
  idle: '',
  walking: '',
  thinking: '💭',
  reading: '📖',
  crafting: '🔨',
  trading: '💰',
  exploring: '🔍',
  sleeping: '💤',
  socializing: '💬',
  training: '⚔️',
  researching: '🧪',
};

/** Activities available per building */
export const BUILDING_ACTIVITIES: Record<string, NpcActivity[]> = {
  'cron-automation': ['reading', 'thinking', 'researching'],
  'api-integrations': ['trading', 'socializing', 'thinking'],
  'memory-rag': ['reading', 'researching', 'thinking'],
  'code-development': ['crafting', 'training', 'thinking'],
  'messaging-channels': ['socializing', 'trading', 'exploring'],
  'mcp-tool-use': ['crafting', 'researching', 'thinking'],
  'visual-creation': ['crafting', 'thinking', 'exploring'],
  'app-publishing': ['socializing', 'training', 'thinking'],
  'agent-security': ['training', 'thinking', 'researching'],
  'deployment-ops': ['reading', 'researching', 'crafting'],
};
