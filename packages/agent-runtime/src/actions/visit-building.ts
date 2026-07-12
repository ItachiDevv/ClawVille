import { MAP_LOCATIONS, LOCATION_IDS } from '@clawville/shared';
import { BUILDING_OPENCLAW_THEMES } from '@clawville/shared';
import { getBooksForBuilding } from '@clawville/shared';
import type { Action, ActionResult } from './types';
import { hasServices, getMessageText, getParam , getDbModule } from './types';

const BUILDING_IDS = LOCATION_IDS;

/**
 * VISIT_BUILDING — teleport the avatar to a building and return its info.
 *
 * Parameters:
 *   buildingId — one of the 10 building IDs
 */
export const visitBuildingAction: Action = {
  name: 'VISIT_BUILDING',
  description:
    'Move the avatar to a specific building in ClawVille and learn what it offers.',
  similes: [
    'GO_TO_BUILDING',
    'ENTER_BUILDING',
    'TRAVEL_TO',
    'TELEPORT',
    'MOVE_TO',
  ],

  parameters: [
    {
      name: 'buildingId',
      description:
        'The ID of the building to visit (e.g. cron-automation, code-development, memory-rag).',
      required: true,
      schema: {
        type: 'string',
        enum: [...BUILDING_IDS],
      },
    },
  ],

  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Take me to the Chum Bucket', action: 'VISIT_BUILDING' },
      },
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Go to the memory vault', action: 'VISIT_BUILDING' },
      },
    ],
  ],

  async validate(_runtime: any, message: any, _state?: any): Promise<boolean> {
    const text = getMessageText(message).toLowerCase();
    const triggers = [
      'go to',
      'visit',
      'enter',
      'travel to',
      'take me to',
      'move to',
      'teleport',
    ];
    if (triggers.some((t) => text.includes(t))) return true;

    // Also match if any building name / id appears in the message
    for (const loc of MAP_LOCATIONS) {
      if (text.includes(loc.id) || text.includes(loc.name.toLowerCase())) {
        return true;
      }
    }
    return false;
  },

  async handler(
    _runtime: any,
    message: any,
    state?: any,
    _options?: any,
    _callback?: any,
  ): Promise<ActionResult> {
    try {
      if (!hasServices(state)) {
        return { success: false, text: 'Service layer not available' };
      }

      const { avatarId, services } = state;
      const { db } = services;

      // Resolve buildingId from parameters or by matching message text
      let buildingId = getParam(message, 'buildingId');

      if (!buildingId) {
        const text = getMessageText(message).toLowerCase();
        for (const loc of MAP_LOCATIONS) {
          if (text.includes(loc.id) || text.includes(loc.name.toLowerCase())) {
            buildingId = loc.id;
            break;
          }
        }
      }

      if (!buildingId || !BUILDING_IDS.includes(buildingId)) {
        return {
          success: false,
          text: `Unknown building. Available buildings: ${MAP_LOCATIONS.map((l) => `${l.name} (${l.id})`).join(', ')}`,
        };
      }

      const location = MAP_LOCATIONS.find((l) => l.id === buildingId)!;
      const theme = BUILDING_OPENCLAW_THEMES[buildingId];
      const shopBooks = getBooksForBuilding(buildingId);

      // Import schema tables dynamically from the injected db
      // We need the avatars table reference — import from @clawville/database for types only
      // But we use raw SQL via db to avoid the direct import chain
      const { avatars, eq } = await getDbModule();

      // Update avatar position to building entrance
      await db
        .update(avatars)
        .set({
          positionX: location.positionX + Math.floor(location.width / 2),
          positionY: location.positionY + Math.floor(location.height / 2),
          lastActiveAt: new Date(),
        })
        .where(eq(avatars.id, avatarId));

      const shopSummary = shopBooks
        .map((b) => `  - ${b.icon} ${b.name} (${b.price} vCLAW)`)
        .join('\n');

      return {
        success: true,
        text: [
          `You arrived at **${location.name}** ${location.icon}`,
          `*${location.description}*`,
          theme ? `Focus: ${theme.focus}` : '',
          '',
          shopBooks.length > 0
            ? `Shop items:\n${shopSummary}`
            : 'No items available at this location.',
        ]
          .filter(Boolean)
          .join('\n'),
        data: {
          buildingId,
          buildingName: location.name,
          theme: theme?.category,
          shopItems: shopBooks.map((b) => ({
            id: b.id,
            name: b.name,
            price: b.price,
          })),
        },
      };
    } catch (error: any) {
      return { success: false, text: error.message ?? 'Failed to visit building' };
    }
  },

  suppressPostActionContinuation: false,
};
