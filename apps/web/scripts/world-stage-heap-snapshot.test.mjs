import { describe, expect, test } from 'bun:test';
import {
  testOnly,
  withinGrowthTolerance,
} from './world-stage-heap-snapshot.mjs';

function syntheticSnapshot() {
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
        node_types: [['hidden', 'object'], 'string', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['property', 'weak'], 'string_or_number', 'node'],
      },
    },
    // root -> Foo A -> Bar; root -> Foo B; root -weak-> WeakOnly
    nodes: [
      0, 1, 1, 0, 3,
      1, 2, 3, 10, 1,
      1, 3, 5, 20, 0,
      1, 2, 7, 5, 0,
      1, 7, 9, 100, 0,
    ],
    edges: [
      0, 4, 5,
      0, 5, 15,
      1, 8, 20,
      0, 6, 10,
    ],
    strings: [
      '',
      '(GC roots)',
      'Foo',
      'Bar',
      'a',
      'c',
      'b',
      'WeakOnly',
      'weak',
    ],
  };
}

describe('world-stage heap snapshot analyzer', () => {
  test('computes constructor counts and dominator retained sizes', () => {
    const analysis = testOnly.analyzeSnapshot(syntheticSnapshot(), false);
    const foo = analysis.aggregates.get('object\u0000Foo');
    const bar = analysis.aggregates.get('object\u0000Bar');

    expect(analysis.reachableCount).toBe(4);
    expect(analysis.nodeCount).toBe(5);
    expect(analysis.aggregates.has('object\u0000WeakOnly')).toBe(false);
    expect(foo).toMatchObject({
      constructor: 'Foo',
      count: 2,
      selfSizeBytes: 15,
      retainedSizeBytes: 30,
    });
    expect(bar).toMatchObject({
      constructor: 'Bar',
      count: 1,
      selfSizeBytes: 20,
      retainedSizeBytes: 20,
    });
  });

  test('normalizes volatile V8 scope suffixes for cross-snapshot groups', () => {
    expect(testOnly.aggregateName('system / Context / scope @95255')).toBe(
      'system / Context / scope',
    );
    expect(testOnly.aggregateName('StableConstructor')).toBe(
      'StableConstructor',
    );
  });
});

describe('renderer byte growth tolerance', () => {
  test('passes decreases, flat values, and growth through one percent', () => {
    expect(withinGrowthTolerance(100_000, 99_000, 0.01)).toBe(true);
    expect(withinGrowthTolerance(100_000, 100_000, 0.01)).toBe(true);
    expect(withinGrowthTolerance(100_000, 101_000, 0.01)).toBe(true);
  });

  test('fails growth beyond one percent and missing counters', () => {
    expect(withinGrowthTolerance(100_000, 101_001, 0.01)).toBe(false);
    expect(withinGrowthTolerance(null, 100_000, 0.01)).toBe(false);
    expect(withinGrowthTolerance(100_000, null, 0.01)).toBe(false);
  });
});
