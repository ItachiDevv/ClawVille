/**
 * Canonical in-world action vocabulary accepted by the Hatcher action
 * executor. The executor uses this tuple as its hard membership gate and the
 * autonomy decision prompt builds its menu from the matching typed metadata,
 * so a decision surface can never silently expose a narrower verb set.
 *
 * Parameter validation remains server-owned by `npc-simulation.ts`; these
 * strings describe the exact accepted call syntax without weakening any bound.
 */
export const HATCHER_ACTION_VERBS = [
  'move',
  'emote',
  'enter_building',
  'enter_cove',
  'play_cove_game',
  'enter_poker_room',
  'enter_kelp_forest',
  'talk_to_npc',
] as const;

export type HatcherActionVerb = (typeof HATCHER_ACTION_VERBS)[number];

export interface HatcherActionMenuItem {
  verb: HatcherActionVerb;
  syntax: string;
  whenToUse: string;
}

export const HATCHER_ACTION_MENU: readonly HatcherActionMenuItem[] = [
  {
    verb: 'move',
    syntax: 'move(x=<32..22496>, y=<32..22496>)',
    whenToUse: 'walk to exact world coordinates',
  },
  {
    verb: 'emote',
    syntax: 'emote(name=<wave|dance|think|scan|work|celebrate|alert>)',
    whenToUse: 'show a visible reaction without changing destination',
  },
  {
    verb: 'enter_building',
    syntax: 'enter_building(buildingId=<teacher slug>)',
    whenToUse: 'walk to one of the teacher buildings listed below',
  },
  {
    verb: 'enter_cove',
    syntax: 'enter_cove()',
    whenToUse: 'walk to the cove for its provably-fair card tables',
  },
  {
    verb: 'play_cove_game',
    syntax: 'play_cove_game(game=<slots>, wager=<20..1000 vCLAW int, step 20>)',
    whenToUse: 'play one settled game at the cove with your own vCLAW; enter the cove first',
  },
  {
    verb: 'enter_poker_room',
    syntax: 'enter_poker_room()',
    whenToUse: 'walk specifically to the cove poker tables',
  },
  {
    verb: 'enter_kelp_forest',
    syntax: 'enter_kelp_forest()',
    whenToUse: 'walk to the Kelp Forest portal; traversal continues through the authenticated beacon API',
  },
  {
    verb: 'talk_to_npc',
    syntax:
      'talk_to_npc(npcId=<public id>, message=<short text>) or talk_to_npc(buildingId=<teacher slug>, message=<short text>)',
    whenToUse: 'speak to a nearby NPC or teacher; message may contain commas but not a closing parenthesis',
  },
] as const;

