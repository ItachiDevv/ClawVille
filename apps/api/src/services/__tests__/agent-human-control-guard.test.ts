import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentHumanControlConflictResponse,
  HUMAN_CONTROLLED_AGENT_ERROR,
  HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS,
  isMutatingCovePokerForward,
} from '../agent-human-control-guard';

describe('external agent human-control guard', () => {
  test('locks the complete production mutation inventory', () => {
    expect(HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS).toEqual([
      '/:sessionId/move',
      '/:sessionId/chat',
      '/:sessionId/visit-building',
      '/:sessionId/building/:buildingId/chat',
      '/:sessionId/combat-action',
      '/:sessionId/emote',
      '/:sessionId/cove/blackjack/:tool',
      '/:sessionId/cove/poker/:tool',
    ]);
  });

  test('wires every inventory constant to the production guard helper', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'routes', 'agent-gateway.ts'),
      'utf8',
    );
    const mountedConstants = [
      'AGENT_MOVE_ROUTE',
      'AGENT_CHAT_ROUTE',
      'AGENT_VISIT_BUILDING_ROUTE',
      'AGENT_BUILDING_CHAT_ROUTE',
      'AGENT_COMBAT_ACTION_ROUTE',
      'AGENT_EMOTE_ROUTE',
      'AGENT_COVE_BLACKJACK_ROUTE',
      'AGENT_COVE_POKER_ROUTE',
    ];

    for (const route of mountedConstants) {
      expect(source).toContain(`agentGatewayRoutes.post(${route}`);
    }
    expect(
      source.match(/agentHumanControlConflictResponse\(c, npcSimulation\)/g),
    ).toHaveLength(8);
    expect(source).toContain("if (isMutatingCovePokerForward(forward)) {");
  });

  test('returns 409 during the lease and succeeds after it lapses', async () => {
    let now = 1_000;
    const controlledUntil = 1_100;
    const calls: string[] = [];
    const state = {
      getAgentBotConfig(sessionId: string) {
        calls.push(`config:${sessionId}`);
        return { agentId: 'agent-1' };
      },
      isAgentHumanControlled(agentId: string) {
        calls.push(`controlled:${agentId}`);
        return now < controlledUntil;
      },
    };
    const app = new Hono();
    app.post(HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS[0], (c) => {
      const conflict = agentHumanControlConflictResponse(c, state);
      return conflict ?? c.json({ success: true });
    });

    const blocked = await app.request('/session-1/move', { method: 'POST' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: HUMAN_CONTROLLED_AGENT_ERROR,
      code: 'human_controlled',
      retryAfterSeconds: 15,
    });
    expect(calls).toEqual(['config:session-1', 'controlled:agent-1']);

    now = 1_101;
    const released = await app.request('/session-1/move', { method: 'POST' });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ success: true });
  });

  test('leaves read-only requests and missing configs to existing handlers', async () => {
    let configCalls = 0;
    let controlCalls = 0;
    const state = {
      getAgentBotConfig() {
        configCalls += 1;
        return null;
      },
      isAgentHumanControlled() {
        controlCalls += 1;
        return true;
      },
    };
    const app = new Hono();
    app.get('/:sessionId/perception', (c) => {
      const conflict = agentHumanControlConflictResponse(c, state);
      return conflict ?? c.json({ visible: true });
    });
    app.post(HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS[1], (c) => {
      // Models the existing authoritative liveness/resolve check running first.
      if (c.req.param('sessionId') !== 'live') {
        return c.json({ error: 'Invalid or expired agent session' }, 404);
      }
      const conflict = agentHumanControlConflictResponse(c, state);
      return conflict ?? c.json({ success: true });
    });

    const perception = await app.request('/live/perception');
    expect(perception.status).toBe(200);
    expect(await perception.json()).toEqual({ visible: true });
    expect(configCalls).toBe(0);
    expect(controlCalls).toBe(0);

    const invalid = await app.request('/missing/chat', { method: 'POST' });
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: 'Invalid or expired agent session' });
    expect(configCalls).toBe(0);
    expect(controlCalls).toBe(0);

    const liveWithoutConfig = await app.request('/live/chat', { method: 'POST' });
    expect(liveWithoutConfig.status).toBe(200);
    expect(await liveWithoutConfig.json()).toEqual({ success: true });
    expect(configCalls).toBe(1);
    expect(controlCalls).toBe(0);
  });

  test('authoritative liveness keeps stale-map controlled sessions on the existing 404', async () => {
    let configCalls = 0;
    const app = new Hono();
    app.post(HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS[0], (c) => {
      const live = false;
      if (!live) return c.json({ error: 'Invalid or expired agent session' }, 404);
      const conflict = agentHumanControlConflictResponse(c, {
        getAgentBotConfig() {
          configCalls += 1;
          return { agentId: 'stale-agent' };
        },
        isAgentHumanControlled() {
          return true;
        },
      });
      return conflict ?? c.json({ success: true });
    });

    const response = await app.request('/stale-session/move', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Invalid or expired agent session' });
    expect(configCalls).toBe(0);
  });

  test('poker read tools remain available and unknown tools keep their 404 precedence', async () => {
    const forwards = {
      poker_register: { method: 'POST' as const },
      poker_get_state: { method: 'GET' as const },
      poker_act: { method: 'POST' as const },
      poker_advise: { method: 'GET' as const },
      poker_connection: { method: 'GET' as const },
    };
    const state = {
      getAgentBotConfig: () => ({ agentId: 'agent-1' }),
      isAgentHumanControlled: () => true,
    };
    const app = new Hono();
    app.post(HUMAN_CONTROLLED_MUTATING_AGENT_ROUTE_PATTERNS[7], (c) => {
      const tool = c.req.param('tool') as keyof typeof forwards;
      const forward = forwards[tool];
      if (!forward) return c.json({ error: 'unknown_tool' }, 404);
      if (isMutatingCovePokerForward(forward)) {
        const conflict = agentHumanControlConflictResponse(c, state);
        if (conflict) return conflict;
      }
      return c.json({ success: true, method: forward.method });
    });

    const advice = await app.request('/session-1/cove/poker/poker_advise', { method: 'POST' });
    expect(advice.status).toBe(200);
    expect(await advice.json()).toEqual({ success: true, method: 'GET' });

    const registration = await app.request('/session-1/cove/poker/poker_register', { method: 'POST' });
    expect(registration.status).toBe(409);
    expect(await registration.json()).toMatchObject({ code: 'human_controlled' });

    const unknown = await app.request('/session-1/cove/poker/not_a_tool', { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_tool' });
  });
});
