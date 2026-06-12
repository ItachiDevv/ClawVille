/**
 * Hatcher partner P5-1 + P5-2 handler-driven tests (Codex pass-5, 2026-06-12).
 *
 * Drives the REAL register Hono handler via `app.request` with a genuine partner
 * signature. Mocks ONLY `@clawville/database` (no real Postgres — the tx callback
 * runs against an in-memory stub) and uses the REAL `npcSimulation` singleton (so
 * we do NOT globally replace the sim module — that would leak into the real-sim
 * primitive tests in partner-hatcher-p5.test.ts). The proxy host is a PUBLIC IP
 * literal (8.8.8.8) so validateHatcherProxyUrlResolved returns WITHOUT a DNS
 * round-trip — fully hermetic.
 *
 * P5-1 (commit-first ordering): the db.transaction stub records whether the agent's
 *   body is live in the real sim Map at the moment the tx callback resolves — and
 *   asserts it is NOT yet, proving the spawn runs AFTER the tx commits (the safe
 *   commit-first-spawn-after ordering: an uncommitted row can never have a phantom
 *   live ledgerCapable body; a body-less committed row is healed by restore/PATCH).
 *   The xact-scoped advisory lock guards ONLY the DB write; the in-process
 *   withKeyedMutex serializes the post-commit Map mutation.
 *
 * P5-2 (override fail-closed): an OVERRIDE register whose target NPC is already
 *   occupied (real sim throws on the duplicate override) returns 409
 *   override_target_unavailable with NO sessionId and NO live body — never ok:true
 *   handing the partner a bearer for a body that never took over the NPC. The
 *   committed row is left honest (body-less, restorable), not rolled back.
 */

import { describe, it, expect, beforeAll, afterEach, mock } from 'bun:test';
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
ensureEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
ensureEnv('CLOUDFLARE_WORKER_URL', 'https://example.invalid');
ensureEnv('CLOUDFLARE_WORKER_BEARER', 'dummy');
ensureEnv('VANITY_ENCRYPTION_KEY', HEX32);
// Real PUBLIC unicast IP literal — isPrivateIP() false + isIP()===4, so
// validateHatcherProxyUrlResolved returns early without DNS. Never connected to.
// We do NOT mutate HATCHER_PROXY_ALLOWED_HOSTS at module top (that leaks into
// hatcher-config.test.ts) — it is set+restored around each request().
const PROXY_HOST = '8.8.8.8';
const PROXY_URL = `https://${PROXY_HOST}/cognition`;

const partnerKp = nacl.sign.keyPair();
const partnerPubB58 = bs58.encode(partnerKp.publicKey);
process.env.PARTNER_PUBKEYS = JSON.stringify({ hatcher: partnerPubB58 });
const issuerKp = nacl.sign.keyPair();
ensureEnv('CLAWVILLE_SERVICE_ISSUER_SK', bs58.encode(issuerKp.secretKey));
ensureEnv('CLAWVILLE_SERVICE_ISSUER_PUBKEY', bs58.encode(issuerKp.publicKey));

// ---------------------------------------------------------------------------
// In-memory `db` stub. The register handler does: tx.execute (advisory lock),
// tx.query.openclawBots.findFirst (re-read), tx.insert (...).returning(),
// tx.select (cap count). Post-commit it calls db.update / ensureWallet — those use
// the mocked db too and are wrapped non-fatal, so a stub miss just logs+continues.
// A throw inside the tx callback rejects (mirrors ROLLBACK). We probe the REAL sim
// Map at tx-resolve time to prove the spawn was inside the held tx (P5-1).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

interface StubState {
  existingRow: Row | null;
  inserts: Row[];
  todayCount: number;
  // The namespaced agentId whose live-body presence we probe at tx-resolve.
  probeAgentId: string | null;
  bodyLiveAtTxResolve: boolean | null;
}

const state: StubState = {
  existingRow: null,
  inserts: [],
  todayCount: 0,
  probeAgentId: null,
  bodyLiveAtTxResolve: null,
};

function resetState(opts: { existingRow?: Row | null; todayCount?: number; probeAgentId?: string | null } = {}) {
  state.existingRow = opts.existingRow ?? null;
  state.inserts = [];
  state.todayCount = opts.todayCount ?? 0;
  state.probeAgentId = opts.probeAgentId ?? null;
  state.bodyLiveAtTxResolve = null;
}

function insertBuilder() {
  let values: Row = {};
  return {
    values(v: Row) { values = v; return this; },
    returning: async () => {
      const inserted: Row = { id: 'inserted-id', walletAddress: null, ...values };
      state.inserts.push(inserted);
      state.existingRow = inserted;
      return [inserted];
    },
  };
}

function updateBuilder() {
  let values: Row = {};
  const builder = {
    set(v: Row) { values = v; return builder; },
    where() {
      const merged = { ...(state.existingRow ?? {}), ...values };
      state.existingRow = merged;
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
    limit: async () => [{ n: state.todayCount }],
    // Allow `await select().from().where()` (cap-count path: no .limit()).
    then: (resolve: (v: unknown) => void) => resolve([{ n: state.todayCount }]),
  };
  return b;
}

let sim: typeof import('../../services/npc-simulation');

const txStub = {
  execute: async () => undefined,
  query: { openclawBots: { findFirst: async () => state.existingRow } },
  update: () => updateBuilder(),
  insert: () => insertBuilder(),
  select: () => selectBuilder(),
};

const dbStub = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const result = await fn(txStub);
    // P5-1 (commit-first) probe: the body must NOT be live in the sim Map yet at the
    // instant the tx callback resolves — the spawn runs AFTER the tx commits (the
    // safe commit-first-spawn-after ordering: a phantom live ledgerCapable body can
    // never exist for an uncommitted row). We assert this is false here and that the
    // body IS live only AFTER the handler returns.
    if (state.probeAgentId && sim) {
      state.bodyLiveAtTxResolve =
        sim.npcSimulation.findActiveSessionsByAgentIds([state.probeAgentId]).length > 0;
    }
    return result;
  },
  update: () => updateBuilder(),
  insert: () => insertBuilder(),
  select: () => selectBuilder(),
  query: {
    openclawBots: { findFirst: async () => state.existingRow },
    avatars: { findFirst: async () => null },
  },
};

// Mock the database package: spread the REAL module (so every schema-table named
// export resolves) and override ONLY `db`. The real `sql` tag is kept (our no-op
// tx.execute never runs it). Spreading the real module satisfies all the named
// imports the transitive graph pulls in without enumerating ~40 table names.
const realDb = await import('@clawville/database');
mock.module('@clawville/database', () => ({
  ...realDb,
  db: dbStub,
}));

// --- WRITE-signature helper -------------------------------------------------
function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function signWrite(method: string, path: string, ts: string, rawBody: string): string {
  const challenge = `clawville-partner-write\n${method.toUpperCase()}\n${path}\n${ts}\n${sha256hex(rawBody)}`;
  const digest = createHash('sha256').update(challenge).digest();
  return bs58.encode(nacl.sign.detached(new Uint8Array(digest), partnerKp.secretKey));
}
function writeHeaders(method: string, path: string, rawBody: string): Record<string, string> {
  const ts = String(Date.now());
  return {
    'Content-Type': 'application/json',
    'X-Hatcher-Issuer-Pubkey': partnerPubB58,
    'X-Hatcher-Signature': signWrite(method, path, ts, rawBody),
    'X-Hatcher-Timestamp': ts,
  };
}

describe('Hatcher P5-1 + P5-2 — handler-driven (mocked db, real sim)', () => {
  let app: Hono;
  let NPC_IDS: string[];
  // Track sim sessions we spawn so afterEach can clean them up (the real sim is a
  // process-wide singleton shared with other test files).
  const spawnedSids: string[] = [];

  beforeAll(async () => {
    const ph = await import('../partner-hatcher');
    sim = await import('../../services/npc-simulation');
    const shared = await import('@clawville/shared');
    NPC_IDS = shared.NPC_IDS as string[];
    sim.startSimulation(false);
    app = new Hono();
    app.route('/api/partner/hatcher', ph.partnerHatcherRoutes);
  });

  afterEach(() => {
    // Clean up any bodies WE spawned + any the handler spawned for our test agents.
    for (const sid of spawnedSids.splice(0)) sim.npcSimulation.unregisterOpenClaw(sid);
    for (const agentId of ['hatcher:p5-held-tx', 'hatcher:p5-override-fail', 'hatcher:p6-patch-override', 'hatcher:p6-minted-override']) {
      for (const sid of sim.npcSimulation.findActiveSessionsByAgentIds([agentId])) {
        sim.npcSimulation.unregisterOpenClaw(sid);
      }
    }
  });

  const REG_PATH = '/api/partner/hatcher/agents';

  // Set the proxy-host allowlist ONLY for the duration of a single request, then
  // restore it — `getHatcherAllowedHosts()` reads the env per-call, and bun runs
  // tests serially, so this never leaks `8.8.8.8` into hatcher-config.test.ts.
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

  it('P5-1 (commit-first): register spawns AFTER the DB tx commits, not inside it', async () => {
    resetState({ probeAgentId: 'hatcher:p5-held-tx' });
    const body = JSON.stringify({
      agentId: 'p5-held-tx',
      mode: 'avatar',
      cognition: { backend: 'hatcher-proxy', proxyBaseUrl: PROXY_URL, scopedToken: 'tok-abcdef12' },
    });
    const res = await request(REG_PATH, { method: 'POST', headers: writeHeaders('POST', REG_PATH, body), body });
    if (res.status !== 200) console.error('P5-1 unexpected body:', await res.clone().text());
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok?: boolean; spawned?: boolean };
    expect(j.ok).toBe(true);
    expect(j.spawned).toBe(true);
    // COMMIT-FIRST ORDERING: the body was NOT yet live in the sim Map at the moment
    // the DB tx callback resolved — the spawn happens AFTER commit (so an uncommitted
    // row can never have a phantom live ledgerCapable body). It IS live now that the
    // handler has returned (spawned:true above + the post-commit Map mutation).
    expect(state.bodyLiveAtTxResolve).toBe(false);
    expect(sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p5-held-tx']).length).toBeGreaterThan(0);
  });

  it('P5-2: OVERRIDE register whose target NPC is occupied -> 409 override_target_unavailable, NO sessionId, no live body', async () => {
    const target = NPC_IDS[3];
    // Occupy the target with a DIFFERENT agent so the handler's override spawn
    // throws ("already overridden") — the real P5-2 trigger.
    const blockerSid = 'p5-blocker-handler';
    sim.npcSimulation.registerOpenClaw(
      {
        agentId: 'hatcher:blocker-handler', sessionId: blockerSid, sessionKey: blockerSid,
        gatewayUrl: 'http://localhost:0', authToken: '', protocol: 'hatcher-proxy', mode: 'override',
        autonomyMode: 'server-managed', targetNpcId: target, ledgerCapable: true, boundUserId: null,
      } as unknown as Parameters<typeof sim.npcSimulation.registerOpenClaw>[0],
      { getProtocol: () => 'hatcher-proxy', setWorldStateProvider() {}, setSystemContextProvider() {} } as never,
    );
    spawnedSids.push(blockerSid);

    resetState({});
    const body = JSON.stringify({
      agentId: 'p5-override-fail',
      mode: 'override',
      targetNpcId: target,
      cognition: { backend: 'hatcher-proxy', proxyBaseUrl: PROXY_URL, scopedToken: 'tok-abcdef12' },
    });
    const res = await request(REG_PATH, { method: 'POST', headers: writeHeaders('POST', REG_PATH, body), body });
    // Occupied target → client-actionable 409 override_target_unavailable (the id is
    // a real NPC so it passes the NPC_IDS pre-validation; the throw is the
    // already-overridden case, not a transient 503).
    expect(res.status).toBe(409);
    const j = (await res.json()) as { error?: string; sessionId?: string; ok?: boolean };
    expect(j.error).toBe('override_target_unavailable');
    // CRITICAL: no bearer for a body that never appeared, and not ok:true.
    expect(j.sessionId).toBeUndefined();
    expect(j.ok).not.toBe(true);
    // The failed-override agent has NO live body. Commit-first keeps the row
    // committed (honest, body-less — a later PATCH/restore heals it), but the spawn
    // threw so no body exists and the prior body (none here) was restored.
    expect(sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p5-override-fail'])).toHaveLength(0);
  });

  it('P6-2: PATCH override to an occupied target -> 409 AND the committed row is compensated back to the PRIOR body (mode/target/token), not the failed target', async () => {
    // 1) Register the agent in AVATAR mode so it has a live body + a stored,
    //    decryptable cognition token the PATCH re-register can reuse.
    resetState({});
    const regBody = JSON.stringify({
      agentId: 'p6-patch-override',
      mode: 'avatar',
      cognition: { backend: 'hatcher-proxy', proxyBaseUrl: PROXY_URL, scopedToken: 'tok-prior123' },
    });
    const regRes = await request(REG_PATH, { method: 'POST', headers: writeHeaders('POST', REG_PATH, regBody), body: regBody });
    if (regRes.status !== 200) console.error('P6-2 register unexpected body:', await regRes.clone().text());
    expect(regRes.status).toBe(200);
    // The agent now has a live AVATAR body, and state.existingRow describes it.
    expect(sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p6-patch-override']).length).toBeGreaterThan(0);
    const priorRow = { ...(state.existingRow as Row) };
    expect(priorRow.mode).toBe('avatar');
    expect(priorRow.targetNpcId == null).toBe(true);
    const priorProxyEnc = priorRow.proxyTokenEnc;
    expect(typeof priorProxyEnc).toBe('string');
    // The register committed a bearer hash for the live body. This PATCH PRESERVES
    // that live bearer (a live session exists, so minted === false), so the
    // compensation must LEAVE the hash intact (it still commits to the live body).
    const priorSessionKeyHash = priorRow.sessionKeyHash;
    expect(typeof priorSessionKeyHash).toBe('string');

    // 2) Occupy an NPC with a DIFFERENT agent so the PATCH's override re-register
    //    throws OverrideTargetUnavailableError (the real P6-2 trigger).
    const target = NPC_IDS[5];
    const blockerSid = 'p6-blocker-handler';
    sim.npcSimulation.registerOpenClaw(
      {
        agentId: 'hatcher:p6-blocker', sessionId: blockerSid, sessionKey: blockerSid,
        gatewayUrl: 'http://localhost:0', authToken: '', protocol: 'hatcher-proxy', mode: 'override',
        autonomyMode: 'server-managed', targetNpcId: target, ledgerCapable: true, boundUserId: null,
      } as unknown as Parameters<typeof sim.npcSimulation.registerOpenClaw>[0],
      { getProtocol: () => 'hatcher-proxy', setWorldStateProvider() {}, setSystemContextProvider() {} } as never,
    );
    spawnedSids.push(blockerSid);

    // 3) PATCH the agent to OVERRIDE the occupied target. No new cognition → the
    //    tx .set() only changes mode/targetNpcId; proxy fields stay, so the
    //    compensation must restore mode/target (and leave the token intact).
    const PATCH_PATH = `${REG_PATH}/p6-patch-override`;
    const patchBody = JSON.stringify({ mode: 'override', targetNpcId: target });
    const patchRes = await request(PATCH_PATH, { method: 'PATCH', headers: writeHeaders('PATCH', PATCH_PATH, patchBody), body: patchBody });
    if (patchRes.status !== 409) console.error('P6-2 patch unexpected body:', await patchRes.clone().text());

    // Occupied target → 409 override_target_unavailable, NO sessionId, not ok:true.
    expect(patchRes.status).toBe(409);
    const pj = (await patchRes.json()) as { error?: string; sessionId?: string; ok?: boolean };
    expect(pj.error).toBe('override_target_unavailable');
    expect(pj.sessionId).toBeUndefined();
    expect(pj.ok).not.toBe(true);

    // CORE P6-2 ASSERTION: the persisted row was COMPENSATED back to the PRIOR body,
    // NOT left describing the failed override target. A restart/idle-despawn restore
    // would otherwise re-attempt the occupied target (or "succeed" into the 409-failed
    // PATCH). The row must read avatar/null-target again, with the prior token intact.
    const finalRow = state.existingRow as Row;
    expect(finalRow.mode).toBe('avatar');
    expect(finalRow.targetNpcId == null).toBe(true);
    expect(finalRow.proxyTokenEnc).toBe(priorProxyEnc);
    // PRESERVED-bearer case: the live bearer's hash MUST survive the compensation;
    // the restored prior body is live under it. Nulling it would brick a working
    // bearer (that is exactly why the hash-null is gated on `minted`).
    expect(finalRow.sessionKeyHash).toBe(priorSessionKeyHash);

    // And the prior live body was restored (no orphan): the agent still has a body.
    expect(sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p6-patch-override']).length).toBeGreaterThan(0);
  });

  it('P6-2 (minted sub-case): PATCH override fail when NO live body exists -> 409 AND the minted-but-never-lived bearer hash is NULLED (terminal-transition invariant), row compensated to prior body', async () => {
    // 1) Register an OVERRIDE agent on a free NPC so a row + bearer exist, then
    //    DESPAWN its live body so the next PATCH finds NO live session to preserve
    //    (minted === true path). It re-registers cleanly on a free target first.
    const freeTarget = NPC_IDS[6];
    resetState({});
    const regBody = JSON.stringify({
      agentId: 'p6-minted-override',
      mode: 'override',
      targetNpcId: freeTarget,
      cognition: { backend: 'hatcher-proxy', proxyBaseUrl: PROXY_URL, scopedToken: 'tok-minted123' },
    });
    const regRes = await request(REG_PATH, { method: 'POST', headers: writeHeaders('POST', REG_PATH, regBody), body: regBody });
    if (regRes.status !== 200) console.error('P6-2 minted register unexpected body:', await regRes.clone().text());
    expect(regRes.status).toBe(200);
    const priorRow = { ...(state.existingRow as Row) };
    expect(priorRow.mode).toBe('override');
    expect(priorRow.targetNpcId).toBe(freeTarget);
    expect(typeof priorRow.sessionKeyHash).toBe('string');

    // Despawn the live body so the PATCH has NO session to preserve → it MINTS a new
    // bearer. (Free the override seat too so re-register would normally succeed.)
    for (const sid of sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p6-minted-override'])) {
      sim.npcSimulation.unregisterOpenClaw(sid);
    }
    expect(sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p6-minted-override'])).toHaveLength(0);

    // 2) Occupy a DIFFERENT target so the minted re-register throws.
    const occupied = NPC_IDS[7];
    const blockerSid = 'p6-minted-blocker';
    sim.npcSimulation.registerOpenClaw(
      {
        agentId: 'hatcher:p6-minted-blocker', sessionId: blockerSid, sessionKey: blockerSid,
        gatewayUrl: 'http://localhost:0', authToken: '', protocol: 'hatcher-proxy', mode: 'override',
        autonomyMode: 'server-managed', targetNpcId: occupied, ledgerCapable: true, boundUserId: null,
      } as unknown as Parameters<typeof sim.npcSimulation.registerOpenClaw>[0],
      { getProtocol: () => 'hatcher-proxy', setWorldStateProvider() {}, setSystemContextProvider() {} } as never,
    );
    spawnedSids.push(blockerSid);

    // 3) PATCH override to the occupied target. No live body → minted === true →
    //    re-register throws → 409, prior fields compensated, minted hash NULLED.
    const PATCH_PATH = `${REG_PATH}/p6-minted-override`;
    const patchBody = JSON.stringify({ mode: 'override', targetNpcId: occupied });
    const patchRes = await request(PATCH_PATH, { method: 'PATCH', headers: writeHeaders('PATCH', PATCH_PATH, patchBody), body: patchBody });
    if (patchRes.status !== 409) console.error('P6-2 minted patch unexpected body:', await patchRes.clone().text());
    expect(patchRes.status).toBe(409);
    const pj = (await patchRes.json()) as { error?: string; sessionId?: string; ok?: boolean };
    expect(pj.error).toBe('override_target_unavailable');
    expect(pj.sessionId).toBeUndefined();
    expect(pj.ok).not.toBe(true);

    const finalRow = state.existingRow as Row;
    // Row compensated back to the PRIOR override target (the free one), not the occupied.
    expect(finalRow.mode).toBe('override');
    expect(finalRow.targetNpcId).toBe(freeTarget);
    // TERMINAL-TRANSITION INVARIANT: the minted bearer never entered the sim Map and
    // its id was never surfaced (no sessionId in the 409 body), so its committed hash
    // is nulled here, matching DELETE / expiry / sweep. No dangling hash for a
    // session that never lived.
    expect(finalRow.sessionKeyHash == null).toBe(true);
    // No live body for this agent (the spawn failed, nothing to restore).
    expect(sim.npcSimulation.findActiveSessionsByAgentIds(['hatcher:p6-minted-override'])).toHaveLength(0);
  });
});
