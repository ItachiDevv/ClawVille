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
  'claim_parcel',
  'prepay_rent',
  'release_parcel',
  'enter_poker_room',
  'enter_kelp_forest',
  'claim_tutorial_quest',
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
    syntax: 'play_cove_game(game=<slots|blackjack>, wager=<game bounds: slots 20..1000 step 20; blackjack 5..500 int>)',
    whenToUse: 'play one fully settled cove game with your own vCLAW; blackjack uses basic strategy; enter the cove first',
  },
  {
    verb: 'claim_parcel',
    syntax: 'claim_parcel(parcelCode=<listed code>, door=<hold|rent>, weeks=<1..26; rent only>)',
    whenToUse: 'claim one listed available parcel; hold spends no vCLAW, rent requires weeks and makes week one non-refundable',
  },
  {
    verb: 'prepay_rent',
    syntax: 'prepay_rent(parcelCode=<owned rent parcel code>, weeks=<1..26>)',
    whenToUse: 'add refundable vCLAW escrow for an owned rent parcel using its server-set weekly price',
  },
  {
    verb: 'release_parcel',
    syntax: 'release_parcel(parcelCode=<owned parcel code>)',
    whenToUse: 'return an owned hold or rent parcel; rent refunds only remaining escrow and hold refunds nothing',
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
    verb: 'claim_tutorial_quest',
    syntax: 'claim_tutorial_quest(questId=<listed claimable quest id>)',
    whenToUse:
      'claim one qualified tutorial or land quest as yourself; the server re-checks proof of engagement and pays vCLAW or materials once, ever',
  },
  {
    verb: 'talk_to_npc',
    syntax:
      'talk_to_npc(npcId=<public id>, message=<short text>) or talk_to_npc(buildingId=<teacher slug>, message=<short text>)',
    whenToUse: 'speak to a nearby NPC or teacher; message may contain commas but not a closing parenthesis',
  },
] as const;

