import { expect, test } from 'bun:test';
import { readWorldProximity } from './world-frame-interaction';
import { BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME, BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME, WORLD_CENTER_PX } from '@clawville/shared';
import { CHARACTER_POSITIONS } from './three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z } from './three/town-guide-position';
test('shared proximity identifies the Office door, guide, residents, and Nori', () => {
  for (const [point,id] of [[BRAINCHAIN_OFFICE_DOOR_APPROACH_GAME,'brainchain-office'],[BRAINCHAIN_OFFICE_GUIDE_APPROACH_GAME,'brainchain-office-guide']] as const) {
    expect(readWorldProximity(point.x-WORLD_CENTER_PX.x,point.y-WORLD_CENTER_PX.y).nearLocation).toBe(id);
  }
  const resident = CHARACTER_POSITIONS['code-development'];
  expect(readWorldProximity(resident.worldX,resident.worldZ)).toMatchObject({nearLocation: resident.buildingId,nearCharacter: resident.characterName});
  expect(readWorldProximity(NORI_WORLD_X,NORI_WORLD_Z).nearGuide).toBe(true);
  expect(readWorldProximity(10000,10000)).toEqual({nearLocation:null,nearCharacter:null,nearGuide:false});
});
