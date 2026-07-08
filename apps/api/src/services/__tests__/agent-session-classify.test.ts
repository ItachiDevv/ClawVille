/**
 * `/me/agent-session` mode-label classification (§B.2 hosted-label fix,
 * 2026-07-08). DB-free unit coverage of the pure `classifyAgentSessionHot`
 * extracted from routes/auth.ts.
 *
 * THE DEFECT: after §B.2 mints a hosted avatar-agent's internal tool-surface
 * session (an `openclaw_bots` row keyed to the user), `/me/agent-session` reported
 * mode:'external-active' instead of 'hosted' — misrepresenting the user's own
 * hosted agent as a BYO/external connection. Both directions + the pre-mint hosted
 * case are pinned here so it can't regress (and fix 30352e60's pre-mint 'hosted'
 * shape stays byte-identical).
 */

import { describe, it, expect } from 'bun:test';
import {
  classifyAgentSessionHot,
  isHostedAvatarAgentSessionRow,
  hostedAgentSessionResponse,
  type AgentSessionBotInput,
  type AgentSessionAvatarInput,
} from '../agent-session-classify';

const PLATFORM_AGENT_ID = '22222222-2222-4222-8222-222222222222';
const WINDOW_MS = 300_000; // 5 min
const NOW = 1_800_000_000_000;

function hostedAvatar(over: Partial<AgentSessionAvatarInput> = {}): AgentSessionAvatarInput {
  return { platformAgentId: PLATFORM_AGENT_ID, harness: 'milady', flags: null, ...over };
}
/** A bot row that IS the user's own hosted avatar-agent session (agentId == platformAgentId). */
function hostedSessionBot(over: Partial<AgentSessionBotInput> = {}): AgentSessionBotInput {
  return {
    agentId: PLATFORM_AGENT_ID,
    lastSeenAt: new Date(NOW - 1000),
    sessionExpiresAt: new Date(NOW + 86_400_000),
    identityType: 'nanoclaw',
    ...over,
  };
}
/** A genuine BYO/external bot row (agentId is the agent's own external id). */
function byoBot(over: Partial<AgentSessionBotInput> = {}): AgentSessionBotInput {
  return {
    agentId: 'hatcher:external-agent-123',
    lastSeenAt: new Date(NOW - 1000),
    sessionExpiresAt: new Date(NOW + 86_400_000),
    identityType: 'hatcher',
    ...over,
  };
}
const call = (bot: AgentSessionBotInput | null, avatar: AgentSessionAvatarInput | null) =>
  classifyAgentSessionHot({ bot, avatar, now: NOW, externalActiveWindowMs: WINDOW_MS });

// ---------------------------------------------------------------------------
// (1) discriminator
// ---------------------------------------------------------------------------
describe('isHostedAvatarAgentSessionRow — the un-spoofable discriminator', () => {
  it('TRUE only when agentId == avatar.platformAgentId AND harness is hosted', () => {
    expect(isHostedAvatarAgentSessionRow(hostedSessionBot(), hostedAvatar())).toBe(true);
    // BYO id → false (a BYO agentId never equals the user's platform_agents.id)
    expect(isHostedAvatarAgentSessionRow(byoBot(), hostedAvatar())).toBe(false);
    // agentId matches but harness NOT hosted (custom) → false
    expect(
      isHostedAvatarAgentSessionRow(hostedSessionBot(), hostedAvatar({ harness: 'custom' })),
    ).toBe(false);
    // no platformAgentId → false
    expect(
      isHostedAvatarAgentSessionRow(hostedSessionBot(), hostedAvatar({ platformAgentId: null })),
    ).toBe(false);
    // all three hosted harnesses qualify
    for (const harness of ['milady', 'hermes', 'openclaw']) {
      expect(isHostedAvatarAgentSessionRow(hostedSessionBot(), hostedAvatar({ harness }))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (2) the fix: hosted avatar-agent reports 'hosted' — minted OR not
// ---------------------------------------------------------------------------
describe('hosted avatar-agent → mode:hosted at ALL times', () => {
  it('POST-mint (its own session row present) → hosted, not external-active', () => {
    const r = call(hostedSessionBot(), hostedAvatar());
    expect(r.kind).toBe('response');
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body.mode).toBe('hosted');
    expect(r.body.connected).toBe(true);
    expect(r.body.agentId).toBe(PLATFORM_AGENT_ID);
    expect(r.body.harness).toBe('milady');
    expect(r.body.expiresAt).toBeNull();
    expect(r.body.lastSeenAt).toBeNull();
  });

  it('PRE-mint (no bot row, hosted harness + platformAgentId) → hosted (fix 30352e60 preserved)', () => {
    const r = call(null, hostedAvatar({ harness: 'openclaw' }));
    expect(r.kind).toBe('response');
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body).toEqual(hostedAgentSessionResponse(PLATFORM_AGENT_ID, 'openclaw'));
  });

  it('the two hosted returns are BYTE-IDENTICAL (post-mint short-circuit == pre-mint branch)', () => {
    const postMint = call(hostedSessionBot(), hostedAvatar({ harness: 'hermes' }));
    const preMint = call(null, hostedAvatar({ harness: 'hermes' }));
    if (postMint.kind !== 'response' || preMint.kind !== 'response') throw new Error('unreachable');
    expect(postMint.body).toEqual(preMint.body);
  });

  it('hosted short-circuit BEATS TTL — an EXPIRED or IDLE hosted-session row still reports hosted', () => {
    // The tool-surface session's TTL/idle is irrelevant to the hosted runtime's liveness.
    const expired = call(
      hostedSessionBot({ sessionExpiresAt: new Date(NOW - 1) }),
      hostedAvatar(),
    );
    const idle = call(
      hostedSessionBot({ lastSeenAt: new Date(NOW - WINDOW_MS - 60_000) }),
      hostedAvatar(),
    );
    for (const r of [expired, idle]) {
      if (r.kind !== 'response') throw new Error('unreachable');
      expect(r.body.mode).toBe('hosted');
      expect(r.body.connected).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (3) genuine BYO/external rows stay BYTE-IDENTICAL (no mislabel)
// ---------------------------------------------------------------------------
describe('genuine BYO/external rows are unchanged', () => {
  it('active BYO → external-active with the exact prior field shape', () => {
    const lastSeen = new Date(NOW - 1000);
    const expiresAt = new Date(NOW + 86_400_000);
    const r = call(
      byoBot({ lastSeenAt: lastSeen, sessionExpiresAt: expiresAt, identityType: 'hatcher' }),
      hostedAvatar({ harness: null }), // BYO agent, avatar harness irrelevant
    );
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body).toEqual({
      connected: true,
      mode: 'external-active',
      agentId: 'hatcher:external-agent-123',
      harness: 'hatcher', // avatar.harness ?? bot.identityType ?? null
      expiresAt: expiresAt.toISOString(),
      lastSeenAt: lastSeen.toISOString(),
    });
  });

  it('a BYO row whose agentId collides-shape but harness is hosted still reports external (agentId != platformAgentId)', () => {
    const r = call(byoBot(), hostedAvatar()); // hosted harness, but BYO agentId
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body.mode).toBe('external-active');
  });

  it('expired BYO → external-expired', () => {
    const lastSeen = new Date(NOW - 1000);
    const expiresAt = new Date(NOW - 1);
    const r = call(byoBot({ lastSeenAt: lastSeen, sessionExpiresAt: expiresAt }), null);
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body).toEqual({
      connected: false,
      reason: 'expired',
      mode: 'external-expired',
      agentId: 'hatcher:external-agent-123',
      lastSeenAt: lastSeen.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
  });

  it('idle BYO → external-idle', () => {
    const lastSeen = new Date(NOW - WINDOW_MS - 60_000);
    const r = call(byoBot({ lastSeenAt: lastSeen, sessionExpiresAt: new Date(NOW + 1000) }), null);
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body.mode).toBe('external-idle');
    expect(r.body.connected).toBe(false);
    expect(r.body.reason).toBe('idle');
    expect(r.body.canReconnect).toBe(true);
    expect(r.body.idleSinceMs).toBe(NOW - lastSeen.getTime());
  });

  it('a matching agentId but NON-hosted harness (custom) does NOT short-circuit → external', () => {
    const r = call(hostedSessionBot(), hostedAvatar({ harness: 'custom' }));
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body.mode).toBe('external-active');
  });
});

// ---------------------------------------------------------------------------
// (4) no-bot non-hosted branches
// ---------------------------------------------------------------------------
describe('no-bot branches', () => {
  it('dismissed flag → mode:dismissed', () => {
    const r = call(null, hostedAvatar({ flags: { agentBannerDismissed: true } }));
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body).toEqual({
      connected: false,
      reason: 'dismissed',
      mode: 'dismissed',
      harness: 'milady',
    });
  });

  it('dismissed takes precedence over the hosted-harness branch', () => {
    const r = call(null, hostedAvatar({ harness: 'hermes', flags: { agentBannerDismissed: true } }));
    if (r.kind !== 'response') throw new Error('unreachable');
    expect(r.body.mode).toBe('dismissed');
  });

  it('no bot + non-hosted harness + no platformAgent → cold-fallthrough (route does the guest read)', () => {
    expect(call(null, { platformAgentId: null, harness: 'custom', flags: null }).kind).toBe(
      'cold-fallthrough',
    );
    expect(call(null, null).kind).toBe('cold-fallthrough');
  });

  it('no bot + hosted harness but NO platformAgentId → cold-fallthrough (not hosted)', () => {
    expect(call(null, hostedAvatar({ platformAgentId: null })).kind).toBe('cold-fallthrough');
  });
});
