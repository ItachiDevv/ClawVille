import { expect, test } from 'bun:test';
import { assertDatabaseMarker, assertProbeBodyAbsent, captureCursor, disconnectProbeBody, matchesTradingHaltState, parseCli, readProbeAutonomyDiagnostic, startDeclaredGatewayMock, validateDatabaseUrl, waitForCapturedPrompt } from './hosted-skill-runtime-probe';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  DATABASE_ENV_MARKER_SQL,
  DatabaseEnvMarkerError,
  assertWriteTargetMarker,
  namesSupabaseProject,
  resolveDatabaseEnvMarker,
} from '../db-env-marker';

test('the write transaction re-reads the marker and refuses any change from the pre-check', async () => {
  const reader = (database: string[] | null, session: string | null) => {
    const queries: string[] = [];
    const read = async (query: string) => { queries.push(query); return [{ database_markers: database, session_marker: session }]; };
    return { read, queries };
  };
  const same = reader(['clawville.env=staging'], 'staging');
  await assertWriteTargetMarker(same.read, 'staging');
  expect(same.queries).toEqual([DATABASE_ENV_MARKER_SQL]);
  await assertWriteTargetMarker(reader(null, null).read, null);
  for (const [changed, preCheck] of [
    [reader(['clawville.env=production'], 'production'), 'staging'],
    [reader(null, null), 'staging'],
    [reader(['clawville.env=staging'], 'staging'), null],
    [reader(['clawville.env=staging'], 'production'), 'staging'], // session spoof on the write connection
  ] as const) {
    await expect(assertWriteTargetMarker(changed.read, preCheck)).rejects.toThrow(DatabaseEnvMarkerError);
  }
  await expect(assertWriteTargetMarker(async () => [], 'staging')).rejects.toThrow(DatabaseEnvMarkerError);
});

test('the legacy Supabase fallback matches the exact pooler user or direct host only', () => {
  const ref = 'mtpixvtclsjqjguouxes';
  const prod = 'wheuidgiyyccqyoppxoa';
  expect(namesSupabaseProject(`postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, ref)).toBe(true);
  expect(namesSupabaseProject(`postgresql://postgres.${ref}:pw@AWS-0-US-EAST-1.Pooler.Supabase.COM:6543/postgres`, ref)).toBe(true);
  expect(namesSupabaseProject(`postgres://postgres:pw@db.${ref}.supabase.co:5432/postgres`, ref)).toBe(true);
  expect(namesSupabaseProject(`postgres://postgres:pw@DB.${ref.toUpperCase()}.SUPABASE.CO:5432/postgres`, ref)).toBe(true);
  for (const url of [
    // the right pooler user on a host that is not a Supabase pooler
    `postgresql://postgres.${ref}:pw@127.0.0.1:15432/clawville`,
    `postgresql://postgres.${ref}:pw@database.internal.example:5432/postgres`,
    `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com.evil.example:5432/postgres`,
    `postgresql://postgres.${ref}:pw@aws-0-us-east-1.pooler.supabase.com.:5432/postgres`, // trailing dot
    `postgresql://postgres.${ref}:pw@.pooler.supabase.com:5432/postgres`, // empty label
    `postgresql://postgres.${ref}:pw@evilpooler.supabase.com:5432/postgres`,
    `postgres://postgres:pw@db.${ref}.supabase.co.:5432/postgres`, // trailing dot on the direct host
    `postgresql://postgres.${prod}:${ref}@aws-0-us-west-1.pooler.supabase.com:5432/postgres`, // ref in the password
    `postgresql://clawville:pw@127.0.0.1:15432/clawville?application_name=${ref}`, // ref in the query
    `postgresql://clawville:pw@127.0.0.1:15432/${ref}`, // ref in the path
    `postgresql://postgres:pw@db.${ref}.supabase.co.evil.example:5432/postgres`, // lookalike host
    `https://db.${ref}.supabase.co/postgres`,
    'not-a-url',
  ]) {
    expect(namesSupabaseProject(url, ref)).toBe(false);
  }
});

test('the database-level marker decides; a differing session value is a refused spoof', () => {
  const row = (database: string[] | null, session: string | null) => ({ database_markers: database, session_marker: session });
  expect(resolveDatabaseEnvMarker(row(['clawville.env=staging'], 'staging'))).toBe('staging');
  expect(resolveDatabaseEnvMarker(row(['clawville.env=production'], 'production'))).toBe('production');
  expect(resolveDatabaseEnvMarker(row(null, null))).toBeNull();
  expect(resolveDatabaseEnvMarker(row(['clawville.env='], ''))).toBeNull();
  expect(resolveDatabaseEnvMarker(row(null, ''))).toBeNull();
  for (const refused of [
    row(null, 'staging'), // URL option / PGOPTIONS / role setting on an unmarked database
    row(['clawville.env=production'], 'staging'), // spoofed over a production marker
    row(['clawville.env=staging'], 'production'),
    row(['clawville.env=staging'], null),
    row(['clawville.env=staging', 'clawville.env=production'], 'staging'),
  ]) {
    expect(() => resolveDatabaseEnvMarker(refused)).toThrow(DatabaseEnvMarkerError);
  }
  expect(() => resolveDatabaseEnvMarker(undefined)).toThrow(DatabaseEnvMarkerError);
});

test('--allow-unmarked-db is an explicit, single-use opt-in', () => {
  expect(parseCli(['--api', 'http://localhost:4000']).allowUnmarkedDb).toBe(false);
  expect(parseCli(['--api', 'http://localhost:4000', '--allow-unmarked-db']).allowUnmarkedDb).toBe(true);
  expect(() => parseCli(['--api', 'http://localhost:4000', '--allow-unmarked-db', '--allow-unmarked-db'])).toThrow('duplicate');
  expect(() => parseCli(['--api', 'http://localhost:4000', '--allow-unmarked-db=true'])).toThrow('unknown argument');
});

test('only a staging marker, or an unmarked local database named by the operator, admits fixtures', () => {
  const loopback = validateDatabaseUrl('DATABASE_URL', 'postgresql://clawville:pw@127.0.0.1:15432/clawville')!;
  const composeLocal = validateDatabaseUrl('DATABASE_URL', 'postgresql://postgres:pw@postgres:5432/clawville')!;
  const onBox = validateDatabaseUrl('DATABASE_URL', 'postgresql://clawville:pw@clawville-db:5432/clawville')!;
  const legacyStaging = validateDatabaseUrl('DATABASE_URL', 'postgresql://postgres:pw@db.mtpixvtclsjqjguouxes.supabase.co:5432/postgres')!;
  expect([loopback.isLocal, composeLocal.isLocal, onBox.isLocal, legacyStaging.isLocal]).toEqual([true, true, false, false]);
  expect(() => validateDatabaseUrl('DATABASE_URL', 'postgresql://postgres:pw@db.wheuidgiyyccqyoppxoa.supabase.co:5432/postgres')).toThrow('production');
  expect(() => validateDatabaseUrl('DATABASE_URL', 'postgresql://clawville:pw@10.0.0.5:5432/clawville')).toThrow('must target');

  for (const target of [loopback, onBox, legacyStaging]) {
    expect(assertDatabaseMarker('staging', target, false)).toBe('staging');
    expect(assertDatabaseMarker('staging', target, true)).toBe('staging');
  }
  for (const target of [loopback, composeLocal, onBox, legacyStaging]) {
    for (const allow of [false, true]) {
      expect(() => assertDatabaseMarker('production', target, allow)).toThrow('clawville.env=production');
      for (const other of ['Staging', ' staging', 'prod', 'dev']) {
        expect(() => assertDatabaseMarker(other, target, allow)).toThrow('unrecognized');
      }
    }
    for (const unmarked of [null, '']) {
      expect(() => assertDatabaseMarker(unmarked, target, false)).toThrow('no clawville.env marker');
    }
  }
  for (const unmarked of [null, '']) {
    expect(assertDatabaseMarker(unmarked, loopback, true)).toBe('unmarked-local');
    expect(assertDatabaseMarker(unmarked, composeLocal, true)).toBe('unmarked-local');
    expect(() => assertDatabaseMarker(unmarked, onBox, true)).toThrow('admits only a loopback or local');
    expect(() => assertDatabaseMarker(unmarked, legacyStaging, true)).toThrow('admits only a loopback or local');
  }
});

test('autonomy failure diagnostics retain phase evidence without thought text or identities', async () => {
  let body: unknown = {
    enrolled: true, phase: 'deciding', phaseSince: 100,
    bodyId: 'private-body', wallet: { balance: 100 },
    thoughts: [{ at: 101, type: 'directive', text: 'private-prefix nori-marker private-suffix' }],
  };
  let httpStatus = 200;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe('/api/world/autonomy/status');
    expect(request.headers.get('cookie')).toBe('fixture-cookie');
    return Response.json(body, { status: httpStatus });
  } });
  try {
    const read = () => readProbeAutonomyDiagnostic(`http://127.0.0.1:${server.port}`, 'fixture-cookie', 'nori-marker');
    expect(await read()).toEqual({
      available: true, enrolled: true, phase: 'deciding', phaseSince: 100,
      directiveMarkerSeen: true, thoughts: [{ at: 101, type: 'directive' }],
    });
    body = { enrolled: false, unexpected: 'private-data' };
    expect(await read()).toEqual({ available: true, enrolled: false });
    body = { enrolled: true, phase: 'private-data' };
    expect(await read()).toEqual({ available: false });
    httpStatus = 403;
    expect(await read()).toEqual({ available: false, httpStatus: 403 });
  } finally { server.stop(true); }
});

test('signal cancellation still permits all bounded fixture teardown requests', async () => {
  const source = new URL('./hosted-skill-runtime-probe.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '--eval', `
    import { abortProbe, disconnectProbeBody } from ${JSON.stringify(source)};
    const paths = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith('/challenge')) return Response.json({ nonce: '1'.repeat(32) });
      if (path.endsWith('/disconnect')) return Response.json({ disconnected: true });
      if (path.endsWith('/active')) return Response.json({ bots: [] });
      return Response.json({ npcs: [] });
    } });
    try {
      abortProbe();
      await disconnectProbeBody('http://127.0.0.1:' + server.port, {
        userId: crypto.randomUUID(), platformAgentId: crypto.randomUUID(), identitySecretKey: new Uint8Array(64),
      });
      console.log(JSON.stringify(paths.sort()));
    } finally { server.stop(true); }
  `], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe('');
  expect(status).toBe(0);
  expect(JSON.parse(out.trim())).toEqual(['/api/agent/challenge', '/api/agent/disconnect', '/api/npc/state', '/api/openclaw/active']);
}, 10_000);

test('probe requires preserved fleet halt suppression and disarmed fixture', () => {
  const base = 'Status: armed=false; killed=true\n';
  expect(matchesTradingHaltState(base + 'TRADING IS HALTED:', true, ['mint'])).toBe(true);
  expect(matchesTradingHaltState(base + 'TRADING IS HALTED: Allowed mints: mint', true, ['mint'])).toBe(false);
  expect(matchesTradingHaltState(base + 'Allowed mints: mint', true, ['mint'])).toBe(false);
  expect(matchesTradingHaltState('TRADING IS HALTED:', true, ['mint'])).toBe(false);
  expect(matchesTradingHaltState(base + 'Allowed mints: mint', false, ['mint'])).toBe(true);
  expect(matchesTradingHaltState(base + 'Allowed mints: other', false, ['requiredMintAddress'])).toBe(false);
  expect(matchesTradingHaltState(base + 'TRADING IS HALTED: Allowed mints: mint', false, ['mint'])).toBe(false);
});

test('fixture cleanup signs the existing disconnect contract and verifies both live registries', async () => {
  const identity = nacl.sign.keyPair();
  const nonceBytes = nacl.randomBytes(32);
  const nonce = bs58.encode(nonceBytes);
  const fixture = { userId: crypto.randomUUID(), platformAgentId: crypto.randomUUID(), identitySecretKey: identity.secretKey };
  const bodyId = `ocb-${Buffer.from(fixture.platformAgentId).toString('base64url')}`;
  let remaining: 'none' | 'session' | 'body' | 'invalid' = 'none';
  let disconnects = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/agent/challenge') return Response.json({ nonce });
    if (path === '/api/agent/disconnect') {
      const body = await request.json() as Record<string, string>;
      expect(body.userId).toBe(fixture.userId);
      expect(body.agentId).toBe(fixture.platformAgentId);
      expect(body.nonce).toBe(nonce);
      expect(nacl.sign.detached.verify(nonceBytes, bs58.decode(body.signature!), identity.publicKey)).toBe(true);
      expect(Object.keys(body).sort()).toEqual(['agentId', 'nonce', 'signature', 'userId']);
      disconnects++;
      return Response.json({ disconnected: true });
    }
    if (path === '/api/openclaw/active') return Response.json({ bots: [{ agentId: remaining === 'session' ? fixture.platformAgentId : 'unrelated-agent' }] });
    if (path === '/api/npc/state') return Response.json(remaining === 'invalid' ? {} : { npcs: [{ id: remaining === 'body' ? bodyId : 'unrelated-body' }] });
    return new Response(null, { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await disconnectProbeBody(base, fixture);
    expect(disconnects).toBe(1);
    remaining = 'session';
    await expect(assertProbeBodyAbsent(base, fixture.platformAgentId)).rejects.toThrow('surviving fixture');
    remaining = 'body';
    await expect(assertProbeBodyAbsent(base, fixture.platformAgentId)).rejects.toThrow('surviving fixture');
    remaining = 'invalid';
    await expect(assertProbeBodyAbsent(base, fixture.platformAgentId)).rejects.toThrow();
  } finally { server.stop(true); }
});

test('bounded capture keeps fresh decisions after saturation and never reuses a stale match', async () => {
  const mock = await startDeclaredGatewayMock();
  const send = async (content: string) => {
    const response = await fetch(`http://127.0.0.1:${mock.server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    await response.arrayBuffer();
  };
  try {
    for (let i = 0; i < 25; i++) await send(`old-${i}`);
    const cursor = captureCursor(mock.captured);
    expect(cursor).toBe(25);
    expect(mock.captured).toHaveLength(24);
    await send('fresh decision');
    expect(await waitForCapturedPrompt(mock.captured, cursor, (prompt) => prompt === 'fresh decision', 25))
      .toBe('fresh decision');
    expect(captureCursor(mock.captured)).toBe(26);
    expect(mock.captured).toHaveLength(24);
    await expect(waitForCapturedPrompt(mock.captured, cursor, (prompt) => prompt === 'old-24', 1))
      .rejects.toThrow('"requestsSinceCursor":1');
  } finally { mock.server.stop(true); }
});

test('timeout diagnostics report phase and counts without private prompt content', async () => {
  const privateText = 'PRIVATE-REPLY-AND-IDENTITY';
  const captured = [{ sequence: 1, prompts: [
    `Available actions (choose exactly one Status: armed=false; killed=true TRADING IS HALTED: ${privateText}`,
  ] }];
  let message = '';
  try {
    await waitForCapturedPrompt(captured, 0, () => false, 1, 'fixture-halt-cleared');
  } catch (error) { message = (error as Error).message; }
  expect(message).toContain('fixture-halt-cleared');
  expect(message).toContain('"decisionPrompts":1');
  expect(message).toContain('"halted":1');
  expect(message).toContain('"allowedMints":0');
  expect(message).not.toContain(privateText);
});

test('controlled gateway emits one Nori action only on the requested decision', async () => {
  const mock = await startDeclaredGatewayMock();
  const send = async (content: string) => {
    const response = await fetch(`http://127.0.0.1:${mock.server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    return (await response.json() as any).choices[0].message.content as string;
  };
  try {
    mock.queueNoriQuestion('unique-directive');
    expect(await send('unique-directive chat history')).not.toContain('[ACTION:');
    expect(await send('Available actions (choose exactly one unrelated')).not.toContain('[ACTION:');
    const prompt = 'Available actions (choose exactly one unique-directive';
    expect(await send(prompt)).toBe('[ACTION: chat_nori(message=Where is the Bounty Board and who runs it?)]');
    expect(await send(prompt)).not.toContain('[ACTION:');
    expect(mock.captured).toHaveLength(4);
    expect(mock.noriCounts()).toEqual({ noriQueued: 1, noriEmitted: 1, decisionRequests: 3,
      noriMarkerRequests: 2, noriDecisionRequests: 2, noriDirectiveBlocks: 0, noriBothSameMessage: 1 });
  } finally { mock.server.stop(true); }
});


test('controlled gateway emits one appearance action only for its requested decision', async () => {
  const mock = await startDeclaredGatewayMock();
  const send = async (content: string) => {
    const response = await fetch(`http://127.0.0.1:${mock.server.port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    return (await response.json() as any).choices[0].message.content as string;
  };
  try {
    mock.queueAppearanceChange('appearance-marker');
    expect(await send('appearance-marker chat history')).not.toContain('[ACTION:');
    expect(await send('Available actions (choose exactly one unrelated')).not.toContain('[ACTION:');
    const prompt = 'Available actions (choose exactly one appearance-marker';
    expect(await send(prompt)).toBe('[ACTION: update_appearance(color=red)]');
    expect(await send(prompt)).not.toContain('[ACTION:');
  } finally { mock.server.stop(true); }
});
