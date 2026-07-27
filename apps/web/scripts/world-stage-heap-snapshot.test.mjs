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
        edge_types: [['property'], 'string_or_number', 'node'],
      },
    },
    // root -> Foo A -> Bar; root -> Foo B
    nodes: [
      0, 1, 1, 0, 2,
      1, 2, 3, 10, 1,
      1, 3, 5, 20, 0,
      1, 2, 7, 5, 0,
    ],
    edges: [
      0, 4, 5,
      0, 5, 15,
      0, 6, 10,
    ],
    strings: ['', '(GC roots)', 'Foo', 'Bar', 'a', 'c', 'b'],
  };
}

describe('world-stage heap snapshot analyzer', () => {
  test('computes constructor counts and dominator retained sizes', () => {
    const analysis = testOnly.analyzeSnapshot(syntheticSnapshot(), false);
    const foo = analysis.aggregates.get('object\u0000Foo');
    const bar = analysis.aggregates.get('object\u0000Bar');

    expect(analysis.reachableCount).toBe(4);
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
