/**
 * Hatcher stats cache invalidation (mock-Hatcher harness finding 2026-10-15).
 *
 * The 60s in-process stats cache in `routes/partner-hatcher.ts` was keyed only
 * by agentId + owner period, and register / PATCH / DELETE never touched it.
 * A DELETE + re-register by the same owner (owner_since unchanged) then served
 * the previous record for up to 60 s.
 *
 * Drives the REAL partner-signed register, PATCH, DELETE and stats handlers via
 * `app.request`. Mocks ONLY `@clawville/database` `db` with a one-row in-memory
 * stub (same pattern as partner-hatcher-p5-handler.test.ts) and uses the REAL
 * npcSimulation singleton. The proxy host is a public IP literal, so URL
 * validation needs no DNS.
 *
 * Pinned here:
 *   1. register -> stats -> DELETE -> stats -> register -> stats: each stats
 *      read returns the CURRENT row, not the cached previous record;
 *   2. PATCH -> stats returns the patched value;
 *   3. race: a stats build that began (read the row) BEFORE a PATCH does not
 *      store its stale body in the cache after the PATCH.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Env (crash-loud module-load requirements) + partner keypair, BEFORE imports.
// ---------------------------------------------------------------------------
const HEX32 = '0'.repeat(64);
function ensureEnv(k: string, v: string) {
  if (!process.env[k]) process.env[k] = v;
}
ensureEnv('FINGERPRINT_SECRET', HEX32);
const DB_URL_WAS_SET = !!process.env.DATABASE_URL;
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
const PROXY_HOST = '8.8.8.8';
const PROXY_URL = `https://${PROXY_HOST}/cognition`;

const partnerKp = nacl.sign.keyPair();
const partnerPubB58 = bs58.encode(partnerKp.publicKey);
const PRIOR_PARTNER_PUBKEYS = process.env.PARTNER_PUBKEYS;
process.env.PARTNER_PUBKEYS = JSON.stringify({ hatcher: partnerPubB58 });
const issuerKp = nacl.sign.keyPair();
ensureEnv('CLAWVILLE_SERVICE_ISSUER_SK', bs58.encode(issuerKp.secretKey));
ensureEnv('CLAWVILLE_SERVICE_ISSUER_PUBKEY', bs58.encode(issuerKp.publicKey));

// ---------------------------------------------------------------------------
// One-row in-memory db stub. `ownerSince` is fixed: the owner never changes in
// these tests, so the owner-period guard alone can never drop the cache.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
const OWNER_SINCE = new Date('2026-10-01T00:00:00Z');

const state: { row: Row | null } = { row: null };

/** When set, the NEXT stats row read snapshots the row, then waits on this gate. */
let statsReadGate: { snapshot?: Row; reached: () => void; release: Promise<void> } | null = null;

const realDb = await import('@clawville/database');
function isAgentBotsTable(table: unknown): boolean {
  return table === (realDb as Record<string, unknown>).agentBots;
}

function insertBuilder(track: boolean) {
  let values: Row = {};
  return {
    values(v: Row) { values = v; return this; },
    returning: async () => {
      const inserted: Row = {
        id: 'inserted-id',
        walletAddress: null,
        knowledge: [],
        ownerSince: OWNER_SINCE,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...values,
      };
      if (track) state.row = inserted;
      return [inserted];
    },
  };
}

function updateBuilder(track: boolean) {
  let values: Row = {};
  const builder = {
    set(v: Row) { values = v; return builder; },
    where() {
      const merged = track ? { ...(state.row ?? {}), ...values } : { ...values };
      if (track) state.row = merged;
      const p = Promise.resolve(undefined) as Promise<unknown> & { returning?: () => Promise<Row[]> };
      p.returning = async () => [merged];
      return p;
    },
  };
  return builder;
}

function selectBuilder() {
  const b = {
    from() { return b; },
    where() { return b; },
    orderBy() { return b; },
    innerJoin() { return b; },
    limit: async () => [{ n: 0 }],
    then: (resolve: (v: unknown) => void) => resolve([{ n: 0 }]),
  };
  return b;
}

const txStub = {
  execute: async () => undefined,
  query: { agentBots: { findFirst: async () => (state.row ? { ...state.row } : undefined) } },
  update: (table: unknown) => updateBuilder(isAgentBotsTable(table)),
  insert: (table: unknown) => insertBuilder(isAgentBotsTable(table)),
  select: () => selectBuilder(),
};

const dbStub = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txStub),
  execute: async () => [],
  update: (table: unknown) => updateBuilder(isAgentBotsTable(table)),
  insert: (table: unknown) => insertBuilder(isAgentBotsTable(table)),
  select: () => selectBuilder(),
  query: {
    agentBots: {
      findFirst: async () => {
        const snapshot = state.row ? { ...state.row } : undefined;
        const gate = statsReadGate;
        if (gate) {
          statsReadGate = null;
          gate.snapshot = snapshot;
          gate.reached();
          await gate.release;
        }
        return snapshot;
      },
    },
    avatars: { findFirst: async () => null },
  },
};

let suiteActive = true;
const DELEGATE_DB = (realDb as unknown as { db: Record<string, unknown> }).db;
mock.module('@clawville/database', () => ({
  ...realDb,
  db: new Proxy(dbStub, {
    get: (t, p, r) => (suiteActive ? Reflect.get(t, p, r) : Reflect.get(DELEGATE_DB, p, DELEGATE_DB)),
  }),
}));
if (!DB_URL_WAS_SET) delete process.env.DATABASE_URL;

afterAll(() => {
  suiteActive = false;
  if (PRIOR_PARTNER_PUBKEYS === undefined) delete process.env.PARTNER_PUBKEYS;
  else process.env.PARTNER_PUBKEYS = PRIOR_PARTNER_PUBKEYS;
});

// --- signing helpers ----------------------------------------------------------
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function writeHeaders(method: string, path: string, rawBody: string): Record<string, string> {
  const ts = String(Date.now());
  const challenge = `clawville-partner-write\n${method}\n${path}\n${ts}\n${sha256hex(rawBody)}`;
  const digest = createHash('sha256').update(challenge).digest();
  return {
    'Content-Type': 'application/json',
    'X-Hatcher-Issuer-Pubkey': partnerPubB58,
    'X-Hatcher-Signature': bs58.encode(nacl.sign.detached(new Uint8Array(digest), partnerKp.secretKey)),
    'X-Hatcher-Timestamp': ts,
  };
}
function getHeaders(path: string): Record<string, string> {
  const ts = String(Date.now());
  const challenge = `clawville-partner-get\nGET\n${path}\n${ts}`;
  const digest = createHash('sha256').update(challenge).digest();
  return {
    'X-Hatcher-Issuer-Pubkey': partnerPubB58,
    'X-Hatcher-Signature': bs58.encode(nacl.sign.detached(new Uint8Array(digest), partnerKp.secretKey)),
    'X-Hatcher-Timestamp': ts,
  };
}

const REG_PATH = '/api/partner/hatcher/agents';
const TEST_AGENTS = ['cache-redelete', 'cache-patch', 'cache-race'];

describe('Hatcher stats cache: invalidated on register, PATCH and DELETE', () => {
  let app: Hono;
  let sim: typeof import('../../services/npc-simulation');

  beforeAll(async () => {
    const ph = await import('../partner-hatcher');
    sim = await import('../../services/npc-simulation');
    sim.startSimulation(false);
    app = new Hono();
    app.route('/api/partner/hatcher', ph.partnerHatcherRoutes);
  });

  afterEach(() => {
    for (const raw of TEST_AGENTS) {
      for (const sid of sim.npcSimulation.findActiveSessionsByAgentIds([`hatcher:${raw}`])) {
        sim.npcSimulation.unregisterAgentBot(sid);
      }
    }
    state.row = null;
    statsReadGate = null;
  });

  async function request(path: string, init: RequestInit): Promise<Response> {
    const prior = process.env.HATCHER_PROXY_ALLOWED_HOSTS;
    process.env.HATCHER_PROXY_ALLOWED_HOSTS = PROXY_HOST;
    try {
      return await app.request(path, init);
    } finally {
      if (prior === undefined) delete process.env.HATCHER_PROXY_ALLOWED_HOSTS;
      else process.env.HATCHER_PROXY_ALLOWED_HOSTS = prior;
    }
  }

  async function register(rawId: string, name: string): Promise<void> {
    const body = JSON.stringify({
      agentId: rawId,
      mode: 'avatar',
      name,
      cognition: { backend: 'hatcher-proxy', proxyBaseUrl: PROXY_URL, scopedToken: 'tok-abcdef12' },
    });
    const res = await request(REG_PATH, { method: 'POST', headers: writeHeaders('POST', REG_PATH, body), body });
    if (res.status !== 200) console.error('register unexpected body:', await res.clone().text());
    expect(res.status).toBe(200);
  }

  async function patch(rawId: string, fields: Record<string, unknown>): Promise<void> {
    const path = `${REG_PATH}/${rawId}`;
    const body = JSON.stringify(fields);
    const res = await request(path, { method: 'PATCH', headers: writeHeaders('PATCH', path, body), body });
    if (res.status !== 200) console.error('patch unexpected body:', await res.clone().text());
    expect(res.status).toBe(200);
  }

  async function del(rawId: string): Promise<void> {
    const path = `${REG_PATH}/${rawId}`;
    const res = await request(path, { method: 'DELETE', headers: writeHeaders('DELETE', path, ''), body: '' });
    if (res.status !== 200) console.error('delete unexpected body:', await res.clone().text());
    expect(res.status).toBe(200);
  }

  async function stats(rawId: string): Promise<Record<string, unknown>> {
    const path = `${REG_PATH}/${rawId}/stats`;
    const res = await app.request(path, { method: 'GET', headers: getHeaders(path) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { registration: Record<string, unknown> };
    return body.registration;
  }

  it('register -> stats -> DELETE -> stats -> register -> stats returns the NEW record each time', async () => {
    await register('cache-redelete', 'first-name');
    const first = await stats('cache-redelete');
    expect(first.name).toBe('first-name');
    expect(first.cognitionBackend).toBe('hatcher-proxy');
    expect(first.active).toBe(true);
    expect(first.totalSessions).toBe(1);
    const firstExpiry = first.sessionExpiresAt as string;

    // Same owner (none) and same owner_since: only the write invalidation can
    // drop the cached body.
    await del('cache-redelete');
    const deleted = await stats('cache-redelete');
    expect(deleted.cognitionBackend).toBeNull();
    expect(deleted.active).toBe(false);
    expect(deleted.sessionExpiresAt).not.toBe(firstExpiry);

    await Bun.sleep(5);
    await register('cache-redelete', 'second-name');
    const second = await stats('cache-redelete');
    expect(second.name).toBe('second-name');
    expect(second.cognitionBackend).toBe('hatcher-proxy');
    expect(second.active).toBe(true);
    expect(second.totalSessions).toBe(2);
    expect(second.sessionExpiresAt).toBe((state.row!.sessionExpiresAt as Date).toISOString());
    expect(second.sessionExpiresAt).not.toBe(firstExpiry);
  });

  it('PATCH -> stats returns the patched value', async () => {
    await register('cache-patch', 'before-patch');
    expect((await stats('cache-patch')).name).toBe('before-patch');
    // A second read is a cache hit for the same value.
    expect((await stats('cache-patch')).name).toBe('before-patch');

    await patch('cache-patch', { name: 'after-patch' });
    expect((await stats('cache-patch')).name).toBe('after-patch');
  });

  it('race: a stats build that read the row BEFORE a PATCH does not cache its stale body', async () => {
    await register('cache-race', 'race-old');

    // Start a stats build and hold it right after its row read (old row).
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    const releaseP = new Promise<void>((r) => { release = r; });
    const gate = { reached, release: releaseP } as NonNullable<typeof statsReadGate>;
    statsReadGate = gate;
    const slow = stats('cache-race');
    await reachedP;
    expect(gate.snapshot?.name).toBe('race-old');

    // The write commits while the old build is in flight.
    await patch('cache-race', { name: 'race-new' });

    // Let the old build finish: it answers with the row it read (it began
    // before the write), but it must NOT store that body in the cache.
    release();
    expect((await slow).name).toBe('race-old');

    // The next read is fresh, not the stale body the old build produced.
    expect((await stats('cache-race')).name).toBe('race-new');
    expect((await stats('cache-race')).name).toBe('race-new');
  });
});
