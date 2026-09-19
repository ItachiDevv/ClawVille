import { describe, expect, test } from 'bun:test';
import {
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  LAND_PARCELS,
  TUTORIAL_QUESTS,
  getServerColliders,
  MAP_LOCATIONS,
  TOWN_BUILDING_PLACES,
  NPC_BUILDING_CENTERS,
  compassFromWorldOffset,
  type CompassPoint,
} from '@clawville/shared';
import { LOCATION_TEMPLATES, townGuide } from '@clawville/agent-templates';
import { buildPlayManual, buildProtocolManual } from '../skill-protocol';

// 2026-09-18 knowledge audit (founder: "check on all the seeded knowledge for
// the agents"). Every fact below was wrong or missing in what ClawVille seeds
// into agents; each assertion reads the fact from the CODE, so the text cannot
// drift from the game again without this test failing.

const orientation = CLAWVILLE_ORIENTATION_KNOWLEDGE.join('\n');
const nori = [
  townGuide.description,
  ...townGuide.bio,
  ...townGuide.lore,
  ...townGuide.knowledge,
  JSON.stringify(townGuide.messageExamples ?? []),
].join('\n');
const manual = buildProtocolManual('https://api.example.test');
const all = orientation + '\n' + nori + '\n' + manual;
const collider = (id: string) => getServerColliders().find((c) => c.id === id)!;

describe('seeded knowledge matches the code', () => {
  test('the Downtown teacher is Pearl, not Gary', () => {
    expect(orientation).not.toMatch(/Gary/);
    expect(orientation).toMatch(/Downtown Building \(cron-automation\): Pearl/);
  });

  test('no surface promises the retired daily-login payout or per-message chat pay', () => {
    expect(all).not.toMatch(/10 \+ streak ?(×|x|\*) ?5/);
    expect(all).not.toMatch(/\+1 (vCLAW )?per message|one vCLAW per message/i);
    expect(orientation).toMatch(/no longer pays vCLAW/);
  });

  test('starting balances are the real ones', () => {
    expect(orientation).toMatch(/starts with 1,000 vCLAW/);
    expect(orientation).toMatch(/100 DEMO vCLAW/);
    expect(orientation).not.toMatch(/Every agent starts with 100 vCLAW/);
  });

  test('guests are told they earn nothing real', () => {
    expect(orientation).toMatch(/Guests earn no real vCLAW/);
  });

  test('the quest count is the real ladder', () => {
    const tiers = new Set(TUTORIAL_QUESTS.map((q: { tier: number }) => q.tier)).size;
    expect(orientation).toMatch(new RegExp(`${TUTORIAL_QUESTS.length} tutorial quests across ${tiers} tiers`));
    expect(nori).toMatch(new RegExp(`Tutorial quests \\(${TUTORIAL_QUESTS.length} total, ${tiers} tiers`));
    expect(orientation).not.toMatch(/10 onboarding quests/);
  });

  test('Downtown is south of the town centre', () => {
    const downtown = MAP_LOCATIONS.find((l: { id: string }) => l.id === "cron-automation")! as unknown as { positionY: number };
    const centre = { x: 11264, y: 11264 };
    expect(downtown.positionY).toBeGreaterThan(centre.y); // +y is south on the map
    expect(nori).not.toMatch(/Downtown[^.]*north of the town cent/i);
    expect(nori).toMatch(/due south of the town center/);
  });

  test('the town-centre stalls are named with their real positions', () => {
    const cos = collider('bazaar-stall');
    expect(orientation).toContain(`Cosmetics stall (about (${cos.centerX}, ${cos.centerZ}))`);
    const ex = collider('marketplace-stall');
    expect(orientation).toContain(`Exchange stall (about (${ex.centerX}, ${ex.centerZ}))`);
    expect(orientation).toMatch(/Quest NPC, a crayfish, stands at \(-110, -60\)/);
    expect(orientation).toMatch(/Land Office is NOT a building/);
  });

  test('the parcel count matches the rendered land', () => {
    expect(orientation).toContain(`Land has ${LAND_PARCELS.length} parcels`);
  });

  test('agents are not told Hold\'em or baccarat play is still coming', () => {
    expect(all).not.toMatch(/ship with the WebSocket connection protocol in Phase 6\.5\.2/);
    expect(nori).not.toMatch(/once the connection protocol lands/);
  });

  test('the manual lists the land REST routes an agent needs', () => {
    for (const route of ['claim-hold', 'claim-rent', 'deposit-topup', '/release', '/structure ', '/upgrade', 'salvage/:nodeId/approach', 'salvage/:nodeId/claim']) {
      expect(manual).toContain(route);
    }
    expect(manual).not.toMatch(/no kit\s+`\[ACTION:\]` verb yet/);
  });

  test('directions use the real axes (+Z is south)', () => {
    const sign = collider('town-directory-sign');
    const pavilion = collider('quest-bounty-pavilion');
    expect(pavilion.centerZ).toBeLessThan(sign.centerZ); // pavilion is north of the sign
    expect(orientation).toMatch(/Quest \+ Bounty Pavilion at \(0, -1220\), north of the sign/);
    expect(400).toBeGreaterThan(sign.centerZ); // Nori is south of the sign, toward spawn
    expect(nori).toMatch(/between the spawn point and the wooden town-directory sign/);
  });

  test('guest-bound agents and the Hold\'em window are described as coded', () => {
    expect(orientation).not.toMatch(/once an agent connects, the carve-out lifts/);
    expect(all).not.toMatch(/Autonomous \(a connected agent (plays|makes the decisions) on its own\)/);
    expect(orientation).toMatch(/advisor panel and in-window Autonomous mode are not live yet/);
  });

  test('the manual\'s land contract matches the route schemas', () => {
    expect(manual).toMatch(/Every write except `\/structure`/);
    expect(manual).toMatch(/`parcelCode`/);
  });

  test('removed peer commerce is not advertised as a place to trade', () => {
    expect(nori + orientation).not.toMatch(/Chum Bucket auctions|Forge auction house|bazaar of skills/);
  });
});

// 2026-09-19 live prod chat with Nori: she put the Downtown Building "directly
// north at (0, -1220)" (the pavilion's point), sent cove questions to "Patrick
// at the Cove", and answered "yes" to an agent playing Hold'em in the human's
// table window. No surface said where the buildings are or which places have
// no teacher.
describe('seeded knowledge states where every building is', () => {
  // Independent of town-directions.ts: zone centre, +X east, +Z south.
  const expected = MAP_LOCATIONS.map((l) => {
    const x = Math.round(l.positionX + l.width / 2) - 11264;
    const z = Math.round(l.positionY + l.height / 2) - 11264;
    return { id: l.id, name: l.name, x, z };
  });
  // The render ring's own slot labels (apps/web/src/lib/pixi/tilemap-data.ts
  // buildingZones: slot k sits at bearing k x 30 degrees, clockwise from north).
  const slotDirection: Record<string, CompassPoint> = {
    'visual-creation': 'north',
    'code-development': 'north-northeast',
    'mcp-tool-use': 'east-northeast',
    'messaging-channels': 'east',
    'api-integrations': 'east-southeast',
    'app-publishing': 'south-southeast',
    'cron-automation': 'south',
    'deployment-ops': 'south-southwest',
    'claw-arcade': 'west-southwest',
    cove: 'west',
    'agent-security': 'west-northwest',
    'memory-rag': 'north-northwest',
  };
  const COMPASS: CompassPoint[] = [
    'north', 'north-northeast', 'northeast', 'east-northeast',
    'east', 'east-southeast', 'southeast', 'south-southeast',
    'south', 'south-southwest', 'southwest', 'west-southwest',
    'west', 'west-northwest', 'northwest', 'north-northwest',
  ];
  // Orientation, all of Nori (incl. style), and both served manuals.
  const everySurface = [
    all,
    JSON.stringify(townGuide.style ?? {}),
    buildPlayManual('https://api.example.test'),
  ].join('\n');
  const atBearing = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return compassFromWorldOffset(Math.sin(r) * 1000, -Math.cos(r) * 1000); // north = -Z
  };

  test('the compass words point the right way, on both sides of every boundary', () => {
    expect(Object.keys(slotDirection).sort()).toEqual(MAP_LOCATIONS.map((l) => l.id).sort());
    for (const [id, word] of Object.entries(slotDirection)) {
      expect(TOWN_BUILDING_PLACES.find((p) => p.id === id)!.direction).toBe(word);
    }
    for (let k = 0; k < 16; k++) {
      const edge = 11.25 + 22.5 * k;
      expect(atBearing(edge - 0.5)).toBe(COMPASS[k]);
      expect(atBearing(edge + 0.5)).toBe(COMPASS[(k + 1) % 16]);
      expect(atBearing(22.5 * k)).toBe(COMPASS[k]);
    }
  });

  test('every building is placed at its real zone centre on the orientation surface (and so Nori)', () => {
    for (const e of expected) {
      const dir = slotDirection[e.id];
      const phrase = `${e.name} is ${dir} at world (${e.x}, ${e.z})`;
      expect(orientation).toContain(phrase);
      expect(nori).toContain(phrase);
    }
  });

  test('both manuals give every building its direction and game-pixel centre', () => {
    const play = buildPlayManual('https://api.example.test');
    for (const p of TOWN_BUILDING_PLACES) {
      const teaching = p.id in LOCATION_TEMPLATES;
      expect(manual).toContain(
        `- ${p.name} (\`${p.id}\`): ${p.direction}, game-pixel centre (${p.gameX}, ${p.gameY})${teaching ? '' : ', no teacher'}`,
      );
      if (teaching) {
        expect(play).toContain(`- ${p.name} (\`${p.id}\`): ${p.direction} of the town centre, game-pixel centre (${p.gameX}, ${p.gameY})`);
      }
    }
    expect(play).toMatch(/Arcade City \(`claw-arcade`, west-southwest/);
    expect(play).toMatch(/Predictive Gaming Cove \(`cove`, west,/);
    // Only the 10 teaching ids resolve for /move and /visit-building.
    expect(Object.keys(NPC_BUILDING_CENTERS).sort()).toEqual(Object.keys(LOCATION_TEMPLATES).sort());
    expect(manual).toMatch(/reach Arcade City and the cove by coordinates/);
  });

  test('each building line names the real teacher', () => {
    for (const [id, template] of Object.entries(LOCATION_TEMPLATES)) {
      expect(orientation).toMatch(new RegExp(`\\(${id}\\): ${template.name.replace(/[.]/g, '\\.')} teaches`));
    }
  });

  test('places without a teacher are named, and nobody is sent to Patrick at the cove', () => {
    const noriAll = nori + '\n' + JSON.stringify(townGuide.style ?? {});
    expect(orientation).toMatch(/Arcade City and the Predictive Gaming Cove have no teacher/);
    expect(orientation).toMatch(/Nobody named Patrick works at the cove/);
    expect(noriAll).toMatch(/never sends anyone to a teacher for a place that has no teacher/);
    expect(noriAll).toMatch(/never send anyone to a teacher for them/);
    expect(noriAll).not.toMatch(/suggest which building teacher might/);
    expect(noriAll).not.toMatch(/daily-login economy/);
  });

  test('teachers are described where they stand: outside, on the town-centre side', () => {
    // apps/web/src/lib/three/character-positions.ts NPC_INSET_WORLD: each
    // teacher stands 1300 wu from the building centre toward the town centre.
    expect(orientation).toMatch(/Each teacher stands just outside their own building, on the side that faces the town centre/);
    expect(everySurface).not.toMatch(/teach\w* [A-Za-z ]* inside (their|his|her|Patrick)/);
  });

  test("the Hold'em window question has a direct answer that matches table ownership", () => {
    // routes/cove-holdem.ts ownerMatch: the table is keyed on userId, so the
    // human and the bound agent share one table and one balance.
    expect(orientation).toContain("Can your agent play Hold'em for you from your table window? No:");
    expect(orientation).toMatch(/at the same table and with the same balance as you, just not through the window/);
    expect(everySurface).not.toMatch(/Hold'em[^"]*in its own hands with its own vCLAW/);
    expect(everySurface).not.toMatch(/agent can play Hold'em for you[^.]*(window|controlled mode)/i);
  });
});
