import { describe, expect, test } from 'bun:test';
import { MAP_LOCATIONS, WORLD_PX_WIDTH } from '@clawville/shared';
import { agentMoveSchemaForTest } from '../agent-gateway';

// 2026-09-18 knowledge audit: REST /move accepted only 16..5104 (a stale map
// size) while the town sits around 6,900..15,200, so a coordinate move to
// almost any town point returned 400.

describe('agent REST move accepts every town coordinate', () => {
  test('each building centre is a valid target', () => {
    for (const loc of MAP_LOCATIONS as unknown as Array<{ id: string; positionX: number; positionY: number }>) {
      const r = agentMoveSchemaForTest.safeParse({ targetX: loc.positionX, targetY: loc.positionY });
      expect(r.success).toBe(true);
    }
  });

  test('the town centre is a valid target, the map edge still is not', () => {
    expect(agentMoveSchemaForTest.safeParse({ targetX: 11264, targetY: 11264 }).success).toBe(true);
    expect(agentMoveSchemaForTest.safeParse({ targetX: 0, targetY: 11264 }).success).toBe(false);
    expect(agentMoveSchemaForTest.safeParse({ targetX: WORLD_PX_WIDTH, targetY: 11264 }).success).toBe(false);
  });
});
