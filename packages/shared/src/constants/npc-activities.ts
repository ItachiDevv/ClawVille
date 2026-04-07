/** Activities an NPC or autonomous pet can be doing */
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
  'cron-hub': ['reading', 'thinking', 'researching'],
  'webhook-gateway': ['trading', 'socializing', 'thinking'],
  'memory-vault': ['reading', 'researching', 'thinking'],
  'skill-forge': ['crafting', 'training', 'thinking'],
  'channel-bridge': ['socializing', 'trading', 'exploring'],
  'tool-workshop': ['crafting', 'researching', 'thinking'],
  'canvas-studio': ['crafting', 'thinking', 'exploring'],
  'voice-tower': ['socializing', 'training', 'thinking'],
  'security-fortress': ['training', 'thinking', 'researching'],
  'config-citadel': ['reading', 'researching', 'crafting'],
};
