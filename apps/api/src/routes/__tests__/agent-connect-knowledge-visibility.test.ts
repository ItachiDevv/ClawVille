import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

// Security C5 (batch 2): the POST /api/agent/connect response carries the row's
// learned `knowledge` (owner-private once the row is bound). It now follows the
// GET /:sessionId/knowledge rule: an unbound row's knowledge is returned as
// before, a bound row's knowledge only to a session that passes
// `sessionLedgerCapable` against the persisted owner, else `knowledge: []`.
// The harness mirrors `agent-connect-owner-credential.test.ts` (real route,
// fake DB, mocked identity/wallet/ticket/event services).

process.env.FINGERPRINT_SECRET ??= '45'.repeat(32);

const OWNER_ID = '91111111-1111-4111-8111-111111111111';
const AVATAR_ID = '92222222-2222-4222-8222-222222222222';
const BOT_ID = '93333333-3333-4333-8333-333333333333';
const ROW_KNOWLEDGE = ['row lesson one', 'row lesson two'];

let botRow: Record<string, unknown> | null = null;
let updateReturns: () => unknown[] = () => [];
/** False models an owner with no avatar whose onboarding provisioning fails. */
let avatarPresent = true;

const realDatabase = await import('@clawville/database');
const restoreModules: Array<[string, Record<string, unknown>]> = [['@clawville/database', { ...realDatabase }]];
const delegateDb = realDatabase.db as unknown as Record<PropertyKey, unknown>;

const avatarRow = {
  id: AVATAR_ID,
  userId: OWNER_ID,
  name: 'Owner Avatar 911111',
  isActive: true,
  clawTokens: 100,
  characterConfig: { knowledge: [] },
};

const dbProxy = new Proxy<Record<PropertyKey, unknown>>({}, {
  get(_target, property) {
    if (property === 'query') {
      return {
        avatars: {
          findFirst: async (args?: { columns?: Record<string, boolean> }) => {
            if (!avatarPresent) return undefined;
            if (args?.columns?.characterConfig) return { characterConfig: { knowledge: [] } };
            return avatarRow;
          },
        },
        agentBots: {
          findFirst: async () => (botRow ? { ...botRow } : undefined),
        },
      };
    }
    if (property === 'transaction') {
      // The onboarding avatar insert; failing it leaves the owner avatar-less.
      return async () => {
        throw new Error('avatar provisioning unavailable in this test');
      };
    }
    if (property === 'insert') {
      return () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => [{ ...values, id: BOT_ID }],
        }),
      });
    }
    if (property === 'update') {
      return () => ({
        set: () => ({
          where: () => {
            const rows = updateReturns();
            const result = Promise.resolve(rows) as unknown as Promise<unknown[]> & {
              returning: () => Promise<unknown[]>;
            };
            result.returning = async () => rows;
            return result;
          },
        }),
      });
    }
    return Reflect.get(delegateDb, property, delegateDb);
  },
});

mock.module('@clawville/database', () => ({ ...realDatabase, db: dbProxy }));

const realIdentity = await import('../../services/identity-service');
restoreModules.push(['../../services/identity-service', { ...realIdentity }]);
mock.module('../../services/identity-service', () => ({
  ...realIdentity,
  resolvePublicOnboardingIdentity: async (identityType: string) => ({ user: { id: OWNER_ID }, identityType }),
  resolveOrCreateUserByIdentity: async () => ({
    id: OWNER_ID, email: null, name: 'Owner', identityFingerprint: 'fingerprint', isNewUser: false,
  }),
  generateIdentityKeypairForUser: async () => ({
    publicKey: 'identity-public-key',
    isFirstTime: false,
    needsHumanReauth: false,
  }),
}));

const realWallet = await import('../../services/wallet-service');
restoreModules.push(['../../services/wallet-service', { ...realWallet }]);
mock.module('../../services/wallet-service', () => ({
  ...realWallet,
  ensureWalletWithFirstTimeSecret: async () => ({ publicKey: 'avatar-wallet', firstTimeSecretKeyBase58: undefined }),
  provisionAvatarWallet: async () => ({
    status: 'ready',
    branch: 'canonical-valid-mirror-equal',
    address: 'avatar-wallet',
    inserted: false,
  }),
  resolveAvatarSettlementAddress: async () => ({ status: 'ready', address: 'avatar-wallet' }),
  avatarSettlementAddressFields: (resolution: { status: string; address?: string }) =>
    resolution.status === 'ready'
      ? { walletAddress: resolution.address, walletPending: false }
      : { walletPending: true },
}));

const realTicket = await import('../../services/session-ticket-service');
restoreModules.push(['../../services/session-ticket-service', { ...realTicket }]);
mock.module('../../services/session-ticket-service', () => ({
  ...realTicket,
  mintSessionTicket: async () => ({
    ticket: 'sess-knowledge-visibility-test',
    url: 'https://staging.clawville.world/enter?t=sess-knowledge-visibility-test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    instruction: 'test handoff',
  }),
}));

const realCovenant = await import('../../services/covenant-action-recorder');
restoreModules.push(['../../services/covenant-action-recorder', { ...realCovenant }]);
mock.module('../../services/covenant-action-recorder', () => ({
  ...realCovenant,
  recordCovenantAction: async () => ({ id: 'genesis', deduped: false }),
}));

const realEventLogger = await import('../../services/event-logger');
restoreModules.push(['../../services/event-logger', { ...realEventLogger }]);
mock.module('../../services/event-logger', () => ({
  ...realEventLogger,
  logEvent: async () => {},
  logEventFromContext: async () => {},
}));

const { agentGatewayRoutes } = await import('../agent-gateway');
const { npcSimulation } = await import('../../services/npc-simulation');
const { __resetAgentOwnerFenceForTests } = await import('../../services/agent-owner-fence');

const registeredSessions = new Set<string>();
let ipCounter = 0;

function row(agentId: string, userId: string | null): Record<string, unknown> {
  return {
    id: BOT_ID,
    agentId,
    identityType: 'custom',
    userId,
    gatewayUrl: null,
    protocol: 'nanoclaw',
    mode: 'avatar',
    name: 'Knowledge Agent',
    species: 'milady_official_1',
    color: null,
    totalSessions: 3,
    knowledge: ROW_KNOWLEDGE,
    ack: null,
    metadata: null,
  };
}

async function connect(body: Record<string, unknown>) {
  const app = new Hono();
  app.route('/api/agent', agentGatewayRoutes);
  ipCounter++;
  const response = await app.request('/api/agent/connect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': `198.51.100.${(ipCounter % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json() as Record<string, unknown>;
  if (typeof json.sessionId === 'string') registeredSessions.add(json.sessionId);
  return { status: response.status, json };
}

beforeEach(() => {
  botRow = null;
  updateReturns = () => [];
  avatarPresent = true;
  __resetAgentOwnerFenceForTests();
});

afterAll(() => {
  for (const sessionId of registeredSessions) npcSimulation.unregisterAgentBot(sessionId);
  for (const [path, real] of restoreModules) mock.module(path, () => real);
});

describe('POST /api/agent/connect response knowledge (security C5)', () => {
  test('an anonymous connect to an unbound row still receives the row knowledge', async () => {
    botRow = row('knowledge-unbound-agent', null);
    updateReturns = () => [{ userId: null }];
    const result = await connect({ agentId: 'knowledge-unbound-agent' });
    expect(result.status).toBe(200);
    expect(result.json.isReturning).toBe(true);
    expect(result.json.knowledge).toEqual(ROW_KNOWLEDGE);
  });

  test('the proven owner (identityKey, active avatar) receives its own row knowledge', async () => {
    botRow = row('knowledge-owner-agent', OWNER_ID);
    updateReturns = () => [{ userId: OWNER_ID }];
    const result = await connect({
      agentId: 'knowledge-owner-agent',
      identityType: 'custom',
      identityKey: 'owner-identity-secret',
    });
    expect(result.status).toBe(200);
    expect(result.json.knowledge).toEqual(ROW_KNOWLEDGE);
  });

  test('an owner-proven but non-ledger session (no avatar) receives an empty knowledge array', async () => {
    avatarPresent = false;
    botRow = row('knowledge-avatarless-agent', OWNER_ID);
    updateReturns = () => [{ userId: OWNER_ID }];
    const result = await connect({
      agentId: 'knowledge-avatarless-agent',
      identityType: 'custom',
      identityKey: 'owner-identity-secret',
    });
    expect(result.status).toBe(200);
    expect(typeof result.json.sessionId).toBe('string');
    // The shape stays an array; the owned row's lessons are withheld.
    expect(result.json.knowledge).toEqual([]);
    expect(JSON.stringify(result.json)).not.toContain('row lesson');
  });
});
