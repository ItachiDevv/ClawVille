import { describe, expect, test } from 'bun:test';
import { parcelDisplayName } from './land-tiers';

describe('parcelDisplayName', () => {
  test('derives stable friendly names from the frozen code suffix', () => {
    expect(parcelDisplayName('parcel-starter-24', 'starter')).toBe('Starter Cove #24');
    expect(parcelDisplayName('parcel-c-07', 'c')).toBe('Outer Ward #07');
    expect(parcelDisplayName('parcel-founder-03', 'founder')).toBe("Founders' Row #03");
    expect(parcelDisplayName('parcel-a-01', 'a')).toBe('Town Crest #01');
    expect(parcelDisplayName('parcel-b-09', 'b')).toBe('Inner Ward #09');
  });

  test('keeps malformed input human-readable without inventing an ordinal', () => {
    expect(parcelDisplayName('not-a-parcel', 'starter')).toBe('Starter Cove');
  });
});
