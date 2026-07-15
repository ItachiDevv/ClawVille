import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sweepOutstandingWagerIntents } from '../wager-intent-reconciler';

describe('wager intent operational reconciliation', () => {
  test('sweeps every candidate and remains fail-soft per row', async () => {
    const processed: string[] = [];
    const result = await sweepOutstandingWagerIntents({
      listCandidates: async () => [
        { id: 'confirmed', lobbyId: 'lobby-1', status: 'confirmed' },
        { id: 'ambiguous', lobbyId: 'lobby-1', status: 'reconcile' },
        { id: 'stale-prepared', lobbyId: 'lobby-2', status: 'prepared' },
      ],
      processCandidate: async (candidate) => {
        processed.push(candidate.id);
        if (candidate.id === 'ambiguous') throw new Error('rpc still unavailable');
      },
    });

    expect(processed).toEqual(['confirmed', 'ambiguous', 'stale-prepared']);
    expect(result).toEqual({ attempted: 3, repaired: 2, failed: 1 });
  });

  test('caps an operator-supplied sweep limit at 100', async () => {
    let observedLimit = 0;
    await sweepOutstandingWagerIntents({
      limit: 10_000,
      listCandidates: async (limit) => {
        observedLimit = limit;
        return [];
      },
    });
    expect(observedLimit).toBe(100);
  });
});

describe('wager lifecycle fence structural lock', () => {
  const service = readFileSync(join(import.meta.dir, '..', 'wager-program-client.ts'), 'utf8');
  const route = readFileSync(join(import.meta.dir, '..', '..', 'routes', 'wager.ts'), 'utf8');
  const bridge = readFileSync(
    join(import.meta.dir, '..', 'activity', 'wager-lobby-bridge.ts'),
    'utf8',
  );

  test('capture and lifecycle transitions share the same advisory lock helper', () => {
    const capture = service.slice(
      service.indexOf('async function broadcastDurableTransaction'),
      service.indexOf('export function deriveCreateSolLobbyIntentPda'),
    );
    const lifecycle = service.slice(
      service.indexOf('export async function withResolvedWagerLobbyFence'),
      service.indexOf('export type WagerIntentReconcileResult'),
    );
    expect(capture).toContain('acquireWagerLobbyFence');
    expect(capture).toContain("lobby?.state === 'open'");
    expect(lifecycle).toContain('acquireWagerLobbyFence');
    expect(lifecycle).toContain("intent.status === 'sending'");
    expect(lifecycle).toContain("intent.status === 'reconcile'");
  });

  test('lock, settle, cancel, refund, and activity bridge all use the fence', () => {
    for (const marker of [
      "'/lobbies/:id/lock'",
      "'/lobbies/:id/settle'",
      "'/lobbies/:id/cancel'",
      "'/lobbies/:id/refund'",
    ]) {
      const start = route.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      expect(route.slice(start, start + 9_000)).toContain('withResolvedWagerLobbyFence');
    }
    expect(bridge.match(/withResolvedWagerLobbyFence/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test('terminal create/join retries reconcile before state rejection', () => {
    expect(route.indexOf('reconcileExistingIntent(operationKey)')).toBeLessThan(
      route.indexOf("error: 'match_room_terminal'"),
    );
    const joinStart = route.indexOf("'/lobbies/:id/join'");
    const joinRoute = route.slice(joinStart, route.indexOf("'/lobbies/:id/lock'"));
    expect(joinRoute.indexOf('reconcileWagerChainIntent(existingIntent.id)')).toBeLessThan(
      joinRoute.indexOf("lobby.state !== 'open'"),
    );
  });

  test('agent-owned reads key mine and private invite recovery by bound avatar', () => {
    const listStart = route.indexOf("wagerRoutes.get('/lobbies'");
    const detailStart = route.indexOf("wagerRoutes.get('/lobbies/:idOrInviteCode'");
    const joinStart = route.indexOf("'/lobbies/:id/join'");
    const listRoute = route.slice(listStart, detailStart);
    const detailRoute = route.slice(detailStart, joinStart);

    expect(route).toContain('resolveAgentSession(sessionId)');
    expect(route).toContain('resolved.ledgerCapable !== true');
    expect(listRoute).toContain('eq(lobbies.creatorAvatarId, readIdentity.avatarId)');
    expect(listRoute).toContain('row.creatorAvatarId === readIdentity.avatarId');
    expect(detailRoute).toContain('row.creatorAvatarId === readIdentity.avatarId');
  });
});
