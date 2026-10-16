import { describe, expect, test } from 'bun:test';
import { withoutResearchFeatures } from './queries';

describe('withoutResearchFeatures: research fields never reach a position payload', () => {
  test('strips firstSight and pumpFlow, keeps every other field', () => {
    const features = {
      source: 'ds:token-profiles', exits: { tp: [] },
      firstSight: { at: '2026-10-15T12:00:00.000Z' },
      pumpFlow: { mint: 'x', creator: 'HT9e1ZuEmTupYQjk4mRWu37EFYKB5ENFH82Zyi1YUp8i', w1m: null },
    };
    expect(withoutResearchFeatures(features)).toEqual({ source: 'ds:token-profiles', exits: { tp: [] } });
    expect(withoutResearchFeatures({ source: 's', pumpFlow: null })).toEqual({ source: 's' });
  });

  test('passes through rows without research fields and non-objects unchanged', () => {
    const plain = { source: 's' };
    expect(withoutResearchFeatures(plain)).toBe(plain);
    expect(withoutResearchFeatures(null)).toBeNull();
    expect(withoutResearchFeatures([1])).toEqual([1]);
  });
});
