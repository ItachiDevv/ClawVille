import { expect, test } from 'bun:test';
import { readWorldProximity } from './world-frame-interaction';
import { CHARACTER_POSITIONS } from './three/character-positions';
import { NORI_WORLD_X, NORI_WORLD_Z } from './three/town-guide-position';
test('shared proximity identifies residents and Nori', () => {
  const resident = CHARACTER_POSITIONS['code-development'];
  expect(readWorldProximity(resident.worldX,resident.worldZ)).toMatchObject({nearLocation: resident.buildingId,nearCharacter: resident.characterName});
  expect(readWorldProximity(NORI_WORLD_X,NORI_WORLD_Z).nearGuide).toBe(true);
  expect(readWorldProximity(10000,10000)).toEqual({nearLocation:null,nearCharacter:null,nearGuide:false});
});
