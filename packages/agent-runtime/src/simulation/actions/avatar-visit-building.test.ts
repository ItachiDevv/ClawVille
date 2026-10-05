/**
 * AVATAR_VISIT_BUILDING — daily paid-visit cap (security pass 2026-10-04).
 *
 * The server-side dbHooks.awardToken enforces the durable per-avatar cap and
 * resolves to the vCLAW it credited. The action must always perform the visit,
 * but count + log only what was actually credited: 1 under the cap, 0 over it,
 * 0 on a reward failure, and 0 for a hook that resolves to nothing.
 */

import { describe, expect, it } from 'bun:test';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import { AvatarStateStore } from '../avatar-state-store';
import type { AvatarDbHooks } from '../types';
import { createAvatarVisitBuildingAction } from './avatar-visit-building';

type LogCall = { avatarId: string; type: string; description: string; tokens: number };

function harness(award: (avatarId: string) => Promise<unknown>) {
  const store = new AvatarStateStore();
  store.register({
    avatarId: 'avatar-1', userId: 'user-1', name: 'Shelly', species: 'crab',
    color: '#f00', archetype: 'curious', positionX: 0, positionY: 0,
  });
  const avatar = store.get('user-1')!;
  const logs: LogCall[] = [];
  const awards: string[] = [];
  const dbHooks = {
    awardToken: async (avatarId: string) => {
      awards.push(avatarId);
      return award(avatarId);
    },
    logActivity: async (avatarId: string, type: string, description: string, tokens: number) => {
      logs.push({ avatarId, type, description, tokens });
    },
  } as unknown as AvatarDbHooks;
  const action = createAvatarVisitBuildingAction({
    stateStore: store,
    buildingActivities: { 'memory-rag': ['reading'] } as never,
    activityEmojis: { reading: 'R' } as never,
    dbHooks,
  });
  const visit = async () => {
    avatar.destinationBuildingId = 'memory-rag';
    return action.handler!(
      {} as IAgentRuntime, {} as Memory, undefined,
      { parameters: { userId: 'user-1' } } as never,
    );
  };
  return { avatar, logs, awards, visit };
}

describe('AVATAR_VISIT_BUILDING daily paid-visit cap', () => {
  it('pays and logs 1 vCLAW when the server credits 1', async () => {
    const h = harness(async () => 1);
    const result = await h.visit();
    expect(result).toMatchObject({ success: true, values: { tokensEarned: 1 } });
    expect(h.avatar.activity).toBe('reading');
    expect(h.avatar.tokensEarned).toBe(1);
    expect(h.logs).toEqual([{
      avatarId: 'avatar-1', type: 'visit',
      description: 'Visited memory-rag and earned 1 vCLAW', tokens: 1,
    }]);
  });

  it('still visits over the cap but pays and logs 0 (server credits 0 after 10)', async () => {
    let credited = 0;
    const h = harness(async () => (credited < 10 ? (credited += 1, 1) : 0));
    const earned: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      const result = await h.visit();
      expect(result).toMatchObject({ success: true });
      earned.push((result as { values: { tokensEarned: number } }).values.tokensEarned);
    }
    expect(earned).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(h.avatar.visitCount).toBe(12);
    expect(h.avatar.tokensEarned).toBe(10);
    expect(h.awards).toHaveLength(12);
    expect(h.logs.slice(10)).toEqual([
      { avatarId: 'avatar-1', type: 'visit', description: 'Visited memory-rag (daily paid-visit cap reached, no vCLAW)', tokens: 0 },
      { avatarId: 'avatar-1', type: 'visit', description: 'Visited memory-rag (daily paid-visit cap reached, no vCLAW)', tokens: 0 },
    ]);
  });

  it('records 0 (never a phantom 1) when the reward fails', async () => {
    const h = harness(async () => { throw new Error('db down'); });
    const result = await h.visit();
    expect(result).toMatchObject({ success: true, values: { tokensEarned: 0 } });
    expect(h.avatar.tokensEarned).toBe(0);
    expect(h.logs[0]).toMatchObject({ description: 'Visited memory-rag (reward failed, no vCLAW)', tokens: 0 });
  });

  it('records 0 for a hook that resolves to nothing', async () => {
    const h = harness(async () => undefined);
    const result = await h.visit();
    expect(result).toMatchObject({ success: true, values: { tokensEarned: 0 } });
    expect(h.logs[0].tokens).toBe(0);
  });
});
