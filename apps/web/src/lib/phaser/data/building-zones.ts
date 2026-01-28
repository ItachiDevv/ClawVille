import { MAP_LOCATIONS } from '@elizapets/shared';

export interface BuildingZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const SCALE = 2;

export const BUILDING_ZONES: BuildingZone[] = MAP_LOCATIONS.map((loc) => ({
  id: loc.id,
  x: loc.positionX * SCALE,
  y: loc.positionY * SCALE,
  width: loc.width * SCALE,
  height: loc.height * SCALE,
}));
