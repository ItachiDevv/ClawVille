import { expect, test } from 'bun:test';
import { assertProbeBodyAbsent, captureCursor, disconnectProbeBody, matchesTradingHaltState, startDeclaredGatewayMock, waitForCapturedPrompt } from './hosted-skill-runtime-probe';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

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
