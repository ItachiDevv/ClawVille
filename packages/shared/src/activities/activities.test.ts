import { describe, expect, test } from 'bun:test';
import { getActivityDefinition, getLiveActivitiesForBuilding } from './activities';

describe('Boating School activity placement', () => {
  test('both live activities belong to Mrs. Puff and retain distinct IDs', () => {
    expect(getLiveActivitiesForBuilding('app-publishing').map((a) => a.id))
      .toEqual(['bumper-shells', 'reef-race']);
    expect(getActivityDefinition('bumper-shells')?.skillBuildingMatches).toEqual(['app-publishing']);
    expect(getLiveActivitiesForBuilding('api-integrations')).toEqual([]);
  });
});
