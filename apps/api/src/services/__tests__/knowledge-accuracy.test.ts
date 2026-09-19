import { describe, expect, test } from 'bun:test';
import {
  CLAWVILLE_ORIENTATION_KNOWLEDGE,
  LAND_PARCELS,
  TUTORIAL_QUESTS,
  getServerColliders,
  MAP_LOCATIONS,
} from '@clawville/shared';
import { townGuide } from '@clawville/agent-templates';
import { buildProtocolManual } from '../skill-protocol';

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
