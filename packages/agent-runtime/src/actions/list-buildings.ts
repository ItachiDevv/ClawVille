import { MAP_LOCATIONS } from '@clawville/shared';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import type { Action, ActionResult } from './types';
import { getMessageText } from './types';

/**
 * LIST_BUILDINGS — show all 10 buildings in ClawVille with their themes.
 *
 * Parameters: none
 */
export const listBuildingsAction: Action = {
  name: 'LIST_BUILDINGS',
  description:
    'List all 10 buildings in ClawVille with their names, themes, and categories.',
  similes: [
    'SHOW_MAP',
    'WHERE_CAN_I_GO',
    'SHOW_BUILDINGS',
    'SHOW_LOCATIONS',
    'EXPLORE',
  ],

  parameters: [],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'What buildings are there?', action: 'LIST_BUILDINGS' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Show me the map', action: 'LIST_BUILDINGS' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Where can I go?', action: 'LIST_BUILDINGS' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = [
      'buildings',
      'locations',
      'where',
      'map',
      'explore',
      'places',
      'what can i visit',
      'where can i go',
      'show me around',
    ];
    return triggers.some((t) => text.includes(t));
  },

  async handler(
    _runtime: any,
    _message: any,
    _state?: any,
    _options?: any,
    _callback?: any,
  ): Promise<ActionResult> {
    try {
      const lines = MAP_LOCATIONS.map((loc) => {
        const theme = BUILDING_OPENCLAW_THEMES[loc.id];
        return `${loc.icon} **${loc.name}** (\`${loc.id}\`)  \n  ${loc.description}${theme ? `  \n  Category: ${theme.category}` : ''}`;
      });

      return {
        success: true,
        text: [
          '**ClawVille Buildings**',
          '',
          ...lines,
          '',
          'Use "visit <building>" to travel to one!',
        ].join('\n'),
        data: {
          buildings: MAP_LOCATIONS.map((loc) => ({
            id: loc.id,
            name: loc.name,
            icon: loc.icon,
            description: loc.description,
            category: BUILDING_OPENCLAW_THEMES[loc.id]?.category,
          })),
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to list buildings' };
    }
  },

  suppressPostActionContinuation: false,
};
