import { describe, expect, test } from 'bun:test';
import {
  getPaletteAppearanceOptions,
  getShellAppearanceOptions,
  getShellLockCopy,
} from './land-appearance-options';

describe('land appearance picker options', () => {
  test('shows only the matching shell type and marks level locks', () => {
    const options = getShellAppearanceOptions('home', 1, 'b');

    expect(options).toHaveLength(4);
    expect(options.every((option) => option.entry.structureType === 'home')).toBe(true);
    expect(options.find((option) => option.entry.key === 'coastal-cottage')?.locked).toBe(false);
    expect(options.find((option) => option.entry.key === 'driftwood-cabin')).toMatchObject({
      locked: true,
      levelLocked: true,
      tierLocked: false,
    });
  });

  test('keeps premium shells visible and marks a tier lock', () => {
    const option = getShellAppearanceOptions('shop', 2, 'starter').find(
      (candidate) => candidate.entry.key === 'premium-mall',
    );

    expect(option).toMatchObject({
      locked: true,
      levelLocked: true,
      tierLocked: true,
    });
    expect(getShellLockCopy(option!, 'starter')).toEqual([
      'Needs a B-tier parcel or higher',
    ]);
  });

  test('shows a reachable level requirement alongside the premium tier requirement', () => {
    const option = getShellAppearanceOptions('home', 2, 'c').find(
      (candidate) => candidate.entry.key === 'premium-tower',
    );

    expect(getShellLockCopy(option!, 'c')).toEqual([
      'Unlocks at Lv 4',
      'Needs a B-tier parcel or higher',
    ]);
  });

  test('unlocks every founder shell at its required level', () => {
    expect(getShellAppearanceOptions('home', 5, 'founder').every((option) => !option.locked)).toBe(true);
  });

  test('shows three palettes at level one and all eight at level two', () => {
    const levelOne = getPaletteAppearanceOptions(1);
    const levelTwo = getPaletteAppearanceOptions(2);

    expect(levelOne).toHaveLength(8);
    expect(levelOne.filter((option) => !option.locked)).toHaveLength(3);
    expect(levelTwo.every((option) => !option.locked)).toBe(true);
  });
});
