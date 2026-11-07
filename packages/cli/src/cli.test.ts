import { describe, expect, test } from 'bun:test';

import { parseMcpBody, runCli, type CliDeps } from './cli';
import type { SpawnRequest, SpawnResult } from './exec';

type Handler = (argv: string[], request: SpawnRequest) => Partial<SpawnResult>;

interface Harness {
  deps: CliDeps;
  calls: { argv: string[]; request: SpawnRequest }[];
  out: string[];
  err: string[];
  prompts: string[];
  fetches: { url: string; init: RequestInit | undefined }[];
}

const BINS: Record<string, string> = { claude: '/bin/claude', codex: '/bin/codex', hermes: '/bin/hermes' };

function harness(options: {
  handler?: Handler;
  onPath?: string[];
  isTTY?: boolean;
  answer?: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
} = {}): Harness {
  const calls: Harness['calls'] = [];
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const fetches: Harness['fetches'] = [];
  const onPath = new Set(options.onPath ?? ['claude', 'codex', 'hermes']);
  const deps: CliDeps = {
    platform: 'linux',
    env: { PATH: '/bin' },
    cwd: '/work',
    which: (bin) => (onPath.has(bin) ? BINS[bin] ?? null : null),
    spawn: async (request) => {
      const name = Object.entries(BINS).find(([, path]) => path === request.file)?.[0] ?? request.file;
      const argv = [name, ...request.args];
      calls.push({ argv, request });
      const result = options.handler?.(argv, request) ?? {};
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...result };
    },
    fetch: (async (url: string, init?: RequestInit) => {
      fetches.push({ url, init });
      if (!options.fetchImpl) throw new Error('no network in this test');
      return options.fetchImpl(url, init);
    }) as unknown as typeof fetch,
    isTTY: options.isTTY ?? false,
    prompt: async (question) => {
      prompts.push(question);
      return options.answer ?? '';
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, calls, out, err, prompts, fetches };
}

/** A fake client config: names per client, and `add` succeeds unless told not to. */
function fakeClients(state: { claude?: string[]; codex?: string[]; hermes?: string[] } = {}, opts: { hermesSaves?: boolean } = {}): Handler {
  const claude = new Set(state.claude ?? []);
  const codex = new Set(state.codex ?? []);
  const hermes = new Set(state.hermes ?? []);
  return (argv, request) => {
    const [bin, , verb] = argv;
    if (bin === 'claude' && verb === 'add') {
      const name = argv.find((token, i) => i > 2 && !token.startsWith('-') && argv[i - 1] !== '--transport' && argv[i - 1] !== '--scope')!;
      if (claude.has(name)) return { code: 1, stderr: `MCP server ${name} already exists in local config` };
      claude.add(name);
      return { code: 0, stdout: `Added HTTP MCP server ${name}` };
    }
    if (bin === 'claude' && verb === 'get') return claude.has(argv[3]!) ? { code: 0 } : { code: 1, stdout: `No MCP server named "${argv[3]}".` };
    if (bin === 'codex' && verb === 'get') return codex.has(argv[3]!) ? { code: 0, stdout: '{}' } : { code: 1, stderr: `Error: No MCP server named '${argv[3]}' found.` };
    if (bin === 'codex' && verb === 'add') {
      codex.add(argv[3]!);
      return { code: 0 };
    }
    if (bin === 'codex' && verb === 'list') return { code: 0, stdout: JSON.stringify([...codex].map((name) => ({ name }))) };
    if (bin === 'hermes' && verb === 'list') {
      const rows = [...hermes].map((name) => `  ${name.padEnd(16)} x  all  enabled`);
      return { code: 0, stdout: hermes.size === 0 ? '\n  No MCP servers configured.\n' : ['  Name  Transport', '  ──────── ────', ...rows, ''].join('\n') };
    }
    if (bin === 'hermes' && verb === 'add') {
      expect(request.input).toBe('n\n\n\n');
      if (opts.hermesSaves !== false) hermes.add(argv[3]!);
      return { code: 0, stdout: opts.hermesSaves === false ? '  ✗ Failed to connect: \u001b[31mboom\u001b[0m' : 'Saved' };
    }
    return { code: 0 };
  };
}

const STAGING = ['--api', 'https://api-staging.clawville.world'];

describe('safety: nothing runs without consent', () => {
  test('--dry-run prints the exact commands and runs nothing', async () => {
    const h = harness({ handler: fakeClients(), isTTY: true, answer: 'y' });
    expect(await runCli(['--dry-run', ...STAGING], h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.prompts).toEqual([]);
    const text = h.out.join('\n');
    expect(text).toContain('claude mcp add --transport http clawville https://api-staging.clawville.world/api/agent/mcp');
    expect(text).toContain('codex mcp add clawville --url https://api-staging.clawville.world/api/agent/mcp');
    expect(text).toContain('hermes mcp add clawville --url https://api-staging.clawville.world/api/agent/mcp');
    expect(text).toContain('Dry run: nothing ran.');
  });

  test('not a terminal and no --yes: prints, changes nothing, exits 0', async () => {
    const h = harness({ handler: fakeClients(), isTTY: false });
    expect(await runCli(['add', 'paysh'], h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.out.join('\n')).toContain('Not a terminal, so nothing changed.');
  });

  test('a terminal asks once; any answer but y changes nothing', async () => {
    const h = harness({ handler: fakeClients(), isTTY: true, answer: 'n' });
    expect(await runCli([], h.deps)).toBe(0);
    expect(h.prompts).toEqual(['Add ClawVille to Claude Code, Codex CLI, Hermes? [y/N] ']);
    expect(h.calls).toEqual([]);
  });

  test('a terminal with y runs each client once', async () => {
    const h = harness({ handler: fakeClients(), isTTY: true, answer: 'y' });
    expect(await runCli([], h.deps)).toBe(0);
    expect(h.prompts.length).toBe(1);
    expect(h.calls.filter((c) => c.argv[2] === 'add').map((c) => c.argv[0])).toEqual(['claude', 'codex', 'hermes']);
  });

  test('the default API base is production', async () => {
    const h = harness({ handler: fakeClients() });
    expect(await runCli(['--yes', '--client', 'claude-code'], h.deps)).toBe(0);
    expect(h.calls[0]!.argv).toEqual(['claude', 'mcp', 'add', '--transport', 'http', 'clawville', 'https://api.clawville.world/api/agent/mcp']);
    expect(h.calls[0]!.request.cwd).toBe('/work');
  });
});

describe('install with --yes', () => {
  test('adds ClawVille to all three clients and verifies each', async () => {
    const h = harness({ handler: fakeClients() });
    expect(await runCli(['--yes', ...STAGING], h.deps)).toBe(0);
    expect(h.calls.map((c) => c.argv.slice(0, 4).join(' '))).toEqual([
      'claude mcp add --transport',
      'codex mcp get clawville',
      'codex mcp add clawville',
      'codex mcp get clawville',
      'hermes mcp list',
      'hermes mcp add clawville',
      'hermes mcp list',
    ]);
    const summary = h.out.slice(-3);
    expect(summary).toEqual([
      'Claude Code: added (added "clawville")',
      'Codex CLI: added (added "clawville")',
      'Hermes: added (added "clawville")',
    ]);
  });

  test('an existing entry is never overwritten, and the run still exits 0', async () => {
    const h = harness({ handler: fakeClients({ claude: ['clawville'], codex: ['clawville'], hermes: ['clawville'] }) });
    expect(await runCli(['--yes'], h.deps)).toBe(0);
    // Codex and Hermes: checked first, no add. Claude: its own add refused the duplicate.
    expect(h.calls.filter((c) => c.argv[0] !== 'claude' && c.argv[2] === 'add')).toEqual([]);
    expect(h.out.slice(-3)).toEqual([
      'Claude Code: exists ("clawville" already exists; not changed)',
      'Codex CLI: exists ("clawville" already exists; not changed)',
      'Hermes: exists ("clawville" already exists; not changed)',
    ]);
  });

  test('running twice: the second run reports exists for every client', async () => {
    const handler = fakeClients();
    expect(await runCli(['--yes'], harness({ handler }).deps)).toBe(0);
    const second = harness({ handler });
    expect(await runCli(['--yes'], second.deps)).toBe(0);
    expect(second.out.slice(-3).every((line) => line.includes(': exists ('))).toBe(true);
  });

  test('hermes exits 0 but did not save: failure, exit 1, output tail without colour codes', async () => {
    const h = harness({ handler: fakeClients({}, { hermesSaves: false }) });
    expect(await runCli(['--yes', '--client', 'hermes'], h.deps)).toBe(1);
    expect(h.out.at(-1)).toBe('Hermes: failed ("clawville" was not added (exit 0))');
    expect(h.err.join('\n')).toContain('✗ Failed to connect: boom');
    expect(h.err.join('\n')).not.toContain('\u001b');
  });

  test('a failed existence check changes nothing for that client', async () => {
    const h = harness({
      handler: (argv) => (argv[0] === 'codex' ? { code: 2, stderr: 'config parse error' } : { code: 0 }),
    });
    expect(await runCli(['--yes', '--client', 'codex-cli'], h.deps)).toBe(1);
    expect(h.calls.map((c) => c.argv[2])).toEqual(['get']);
    expect(h.out.at(-1)).toBe('Codex CLI: failed (the check for an existing entry failed)');
  });

  test('a client that is not on PATH: skipped without --client, a failure with it', async () => {
    const without = harness({ handler: fakeClients(), onPath: ['claude'] });
    expect(await runCli(['--yes'], without.deps)).toBe(0);
    expect(without.out).toContain('  Codex CLI: not found (codex is not on PATH)');
    const withClient = harness({ handler: fakeClients(), onPath: ['claude'] });
    expect(await runCli(['--yes', '--client', 'hermes'], withClient.deps)).toBe(1);
    expect(withClient.calls).toEqual([]);
  });

  test('no client at all: exit 1 and the generic JSON block', async () => {
    const h = harness({ onPath: [] });
    expect(await runCli(['--yes'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('"mcpServers"');
    expect(h.calls).toEqual([]);
  });
});

describe('add <id>', () => {
  test('studios: Claude Code runs; Codex and Hermes print only (they would sign in); login never runs', async () => {
    const h = harness({ handler: fakeClients() });
    expect(await runCli(['add', 'studios', '--yes'], h.deps)).toBe(0);
    expect(h.calls.map((c) => c.argv.join(' '))).toEqual(['claude mcp add --transport http studios https://mcp.mystudios.fun/mcp']);
    const text = h.out.join('\n');
    expect(text).toContain('codex mcp login studios');
    expect(text).toContain('hermes mcp add studios --url https://mcp.mystudios.fun/mcp --auth oauth');
    expect(text).toContain('Codex CLI: manual');
    expect(text).toContain('Sign-in: OAuth 2.1 sign-in in your client.');
  });

  test('shinjuku: adds the server, prints setup notes, never runs setup', async () => {
    const h = harness({ handler: fakeClients() });
    expect(await runCli(['add', 'shinjuku', '--yes', '--client', 'codex-cli'], h.deps)).toBe(0);
    expect(h.calls.map((c) => c.argv.join(' '))).toEqual([
      'codex mcp get shinjuku-shielded --json',
      'codex mcp add shinjuku-shielded -- npx -y --no-audit --no-fund shinjuku-shield@0.3.95 mcp',
      'codex mcp get shinjuku-shielded --json',
    ]);
    expect(h.calls.some((c) => c.argv.includes('setup'))).toBe(false);
    expect(h.out.join('\n')).toContain('shinjuku-shield@0.3.95 setup');
  });

  test('paysh on hermes: the stdio form, with the piped answers', async () => {
    const h = harness({ handler: fakeClients() });
    expect(await runCli(['add', 'paysh', '--yes', '--client', 'hermes'], h.deps)).toBe(0);
    expect(h.calls.map((c) => c.argv.join(' '))).toContain('hermes mcp add pay --command pay --args mcp');
    expect(h.out.join('\n')).toContain('pay setup');
  });

  test('a gateway row needs no install and names the ClawVille tool', async () => {
    const h = harness({ handler: fakeClients() });
    expect(await runCli(['add', 'clawpump', '--yes'], h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.out.join('\n')).toContain('Use the ClawVille MCP tool clawville_market');
  });

  test('unknown and planned ids fail', async () => {
    const unknown = harness();
    expect(await runCli(['add', 'nope'], unknown.deps)).toBe(1);
    expect(unknown.err.join('\n')).toContain('Unknown id');
    const planned = harness();
    expect(await runCli(['add', 'hydra'], planned.deps)).toBe(1);
    expect(planned.err.join('\n')).toContain('not available yet');
  });

  test('Windows .cmd shim: codex goes through cmd.exe with checked arguments', async () => {
    const h = harness({ handler: () => ({ code: 0, stdout: '{}' }) });
    const deps: CliDeps = {
      ...h.deps,
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      which: (bin) => (bin === 'codex' ? 'C:\\Users\\u\\.local\\bin\\codex.cmd' : null),
    };
    expect(await runCli(['add', 'clawville', '--yes', '--client', 'codex-cli', ...STAGING], deps)).toBe(0);
    expect(h.calls[0]!.request.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(h.calls[0]!.request.args).toEqual(['/d', '/s', '/c', '""C:\\Users\\u\\.local\\bin\\codex.cmd" mcp get clawville --json"']);
    expect(h.calls[0]!.request.windowsVerbatimArguments).toBe(true);
  });
});

describe('list, help, version, usage', () => {
  test('list shows available rows only, with install or gateway text, and runs nothing', async () => {
    const h = harness();
    expect(await runCli(['list'], h.deps)).toBe(0);
    const ids = h.out.filter((line) => /^\S/.test(line)).map((line) => line.split(' ')[0]);
    expect(ids).toEqual(['clawville', 'studios', 'shinjuku', 'paysh', 'clawpump', 'said']);
    const text = h.out.join('\n');
    expect(text).toContain('Install: clawville add studios');
    expect(text).toContain('No install. Use it through the ClawVille MCP tool clawville_trust.');
    expect(text).not.toContain('atelier');
    expect(h.calls).toEqual([]);
    expect(h.fetches).toEqual([]);
  });

  test('help, version and a usage error', async () => {
    const help = harness();
    expect(await runCli(['help'], help.deps)).toBe(0);
    expect(help.out[0]).toContain('clawville add <id>');
    const version = harness();
    expect(await runCli(['--version'], version.deps)).toBe(0);
    expect(version.out).toEqual(['0.1.0']);
    const usage = harness();
    expect(await runCli(['--api', 'http://example.com'], usage.deps)).toBe(1);
    expect(usage.calls).toEqual([]);
  });
});

describe('doctor', () => {
  const okBody = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'clawville', version: '1.0.0' } } };

  test('lists each client, then one initialize POST to the API', async () => {
    const h = harness({
      handler: fakeClients({ claude: ['clawville'], codex: [], hermes: ['clawville'] }),
      fetchImpl: async () => new Response(JSON.stringify(okBody), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    expect(await runCli(['doctor', ...STAGING], h.deps)).toBe(0);
    expect(h.out).toContain('Claude Code: found at /bin/claude; clawville is in its MCP list');
    expect(h.out).toContain('Codex CLI: found at /bin/codex; clawville is not in its MCP list');
    expect(h.out).toContain('Hermes: found at /bin/hermes; clawville is in its MCP list');
    expect(h.out.at(-1)).toBe('  ok: HTTP 200, server clawville 1.0.0, protocol 2025-06-18');
    expect(h.fetches.length).toBe(1);
    expect(h.fetches[0]!.url).toBe('https://api-staging.clawville.world/api/agent/mcp');
    const body = JSON.parse(String(h.fetches[0]!.init?.body)) as { method: string };
    expect(body.method).toBe('initialize');
    expect(h.calls.every((c) => c.argv[2] === 'get' || c.argv[2] === 'list')).toBe(true);
  });

  test('an HTTP error or a JSON-RPC error fails with exit 1', async () => {
    const http = harness({ handler: fakeClients(), fetchImpl: async () => new Response('{}', { status: 400 }) });
    expect(await runCli(['doctor'], http.deps)).toBe(1);
    const rpc = harness({
      handler: fakeClients(),
      fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } }), { status: 200 }),
    });
    expect(await runCli(['doctor'], rpc.deps)).toBe(1);
    expect(rpc.out.at(-1)).toBe('  failed: nope');
  });

  test('an event-stream answer parses', () => {
    expect(parseMcpBody(`event: message\ndata: ${JSON.stringify(okBody)}\n\n`)).toEqual(okBody);
  });
});
