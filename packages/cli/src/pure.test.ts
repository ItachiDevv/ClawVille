import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_API_BASE, parseArgs, UsageError, validateApiBase } from './args';
import { catalogRows, gatewayTools } from './catalog';
import { parseCodexListJson, parseHermesList } from './clients';
import { buildSpawnRequest, makeWhich, UnsafeCommandError } from './exec';
import { planClient, planRow, rowUsesOAuth, serverNameOf } from './plan';
import { outputTail, stripControl } from './text';
import { isSafeToken, tokenizeSnippet, tokenizeSnippetLine, UnsafeTokenError } from './tokenize';
import { CLI_VERSION } from './version';

const API_BASES = [DEFAULT_API_BASE, 'https://api-staging.clawville.world', 'http://127.0.0.1:4000', 'http://localhost:4000'];

describe('tokenizer', () => {
  test('splits a plain line on spaces', () => {
    expect(tokenizeSnippetLine('claude mcp add --transport http clawville https://api.clawville.world/api/agent/mcp')).toEqual([
      'claude', 'mcp', 'add', '--transport', 'http', 'clawville', 'https://api.clawville.world/api/agent/mcp',
    ]);
    expect(tokenizeSnippetLine('  codex   mcp  list ')).toEqual(['codex', 'mcp', 'list']);
  });

  test('refuses every shell metacharacter', () => {
    const bad = [';', '&', '&&', '|', '||', '>', '<', '$', '$(x)', '`x`', '"', "'", '%PATH%', '!x!', '^', '\\', '(', ')', '*', '?', '~', '#', '{apiBase}', '='];
    for (const piece of bad) {
      expect(() => tokenizeSnippetLine(`claude mcp add x${piece}`)).toThrow(UnsafeTokenError);
    }
    expect(() => tokenizeSnippetLine('claude mcp add a\nrm -rf b')).toThrow(UnsafeTokenError);
    expect(() => tokenizeSnippetLine('   ')).toThrow(UnsafeTokenError);
  });

  test('every served install line for claude-code, codex-cli and hermes tokenizes, for every API base', () => {
    let lines = 0;
    for (const apiBase of API_BASES) {
      for (const row of catalogRows(apiBase)) {
        for (const install of row.installs ?? []) {
          if (install.client === 'generic-json') continue;
          const argvs = tokenizeSnippet(install.snippet);
          expect(argvs.length).toBeGreaterThan(0);
          for (const argv of argvs) for (const token of argv) expect(isSafeToken(token)).toBe(true);
          lines += argvs.length;
        }
      }
    }
    expect(lines).toBeGreaterThanOrEqual(API_BASES.length * 13);
  });
});

describe('arguments', () => {
  test('defaults', () => {
    expect(parseArgs([])).toEqual({ command: 'install', client: undefined, apiBase: DEFAULT_API_BASE, dryRun: false, yes: false });
  });

  test('commands and flags', () => {
    expect(parseArgs(['add', 'studios', '--client', 'codex-cli', '--dry-run'])).toEqual({
      command: 'add', rowId: 'studios', client: 'codex-cli', apiBase: DEFAULT_API_BASE, dryRun: true, yes: false,
    });
    expect(parseArgs(['--client=hermes', '-y', '--api=https://api-staging.clawville.world'])).toMatchObject({
      command: 'install', client: 'hermes', yes: true, apiBase: 'https://api-staging.clawville.world',
    });
    expect(parseArgs(['doctor', '--api', 'http://127.0.0.1:4000'])).toMatchObject({ command: 'doctor', apiBase: 'http://127.0.0.1:4000' });
    expect(parseArgs(['list']).command).toBe('list');
    expect(parseArgs(['help']).command).toBe('help');
    expect(parseArgs(['add', 'x', '--help']).command).toBe('help');
    expect(parseArgs(['--version']).command).toBe('version');
  });

  test('usage errors', () => {
    const bad: string[][] = [
      ['--bogus'], ['frobnicate'], ['add'], ['add', 'a', 'b'], ['list', 'x'], ['list', '--client', 'hermes'],
      ['--client', 'cursor'], ['--client'], ['--api'], ['--dry-run=1'], ['doctor', 'extra'],
    ];
    for (const argv of bad) expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  test('--api validation', () => {
    expect(validateApiBase('https://api-staging.clawville.world')).toBe('https://api-staging.clawville.world');
    expect(validateApiBase('https://api-staging.clawville.world/')).toBe('https://api-staging.clawville.world');
    expect(validateApiBase('https://API.ClawVille.world:8443')).toBe('https://api.clawville.world:8443');
    expect(validateApiBase('http://localhost:4000')).toBe('http://localhost:4000');
    expect(validateApiBase('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
    const bad = [
      'http://api.clawville.world', 'http://10.0.0.1', 'ftp://x.example', 'file:///etc/passwd', 'not a url',
      'https://x.example/path', 'https://x.example/?q=1', 'https://x.example/#h', 'https://user:pw@x.example',
      'https://x.example?', 'javascript:alert(1)',
    ];
    for (const value of bad) expect(() => validateApiBase(value)).toThrow(UsageError);
  });

  test('the version constant equals package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string; name: string; bin: Record<string, string> };
    expect(CLI_VERSION).toBe(pkg.version);
    expect(pkg.name).toBe('clawville');
    expect(pkg.bin.clawville).toBe('dist/clawville.js');
  });
});

describe('plans', () => {
  const rows = catalogRows('https://api-staging.clawville.world');
  const row = (id: string) => rows.find((entry) => entry.id === id)!;

  test('server names are the same for every client of a row', () => {
    const expected: Record<string, string> = { clawville: 'clawville', studios: 'studios', shinjuku: 'shinjuku-shielded', paysh: 'pay' };
    for (const entry of rows.filter((r) => r.bucket !== 'gateway')) {
      for (const client of ['claude-code', 'codex-cli', 'hermes'] as const) {
        const plan = planClient(entry, client, 'linux');
        expect(plan.kind).not.toBe('none');
        if (plan.kind !== 'none') expect(plan.serverName).toBe(expected[entry.id]!);
      }
    }
    expect(Object.keys(expected).sort()).toEqual(rows.filter((r) => r.bucket !== 'gateway').map((r) => r.id).sort());
  });

  test('ClawVille runs on every client with the API base in the URL', () => {
    for (const client of ['claude-code', 'codex-cli', 'hermes'] as const) {
      const plan = planClient(row('clawville'), client, 'linux');
      expect(plan.kind).toBe('run');
      if (plan.kind === 'run') {
        expect(plan.add).toContain('https://api-staging.clawville.world/api/agent/mcp');
        expect(plan.followUps).toEqual([]);
      }
    }
  });

  test('a sign-in row runs only where the add does not sign in', () => {
    expect(rowUsesOAuth(row('studios'))).toBe(true);
    for (const id of ['clawville', 'shinjuku', 'paysh']) expect(rowUsesOAuth(row(id))).toBe(false);
    expect(planClient(row('studios'), 'claude-code', 'linux').kind).toBe('run');
    const codex = planClient(row('studios'), 'codex-cli', 'linux');
    expect(codex.kind).toBe('manual');
    if (codex.kind === 'manual') expect(codex.lines).toEqual(['codex mcp add studios --url https://mcp.mystudios.fun/mcp', 'codex mcp login studios']);
    expect(planClient(row('studios'), 'hermes', 'linux').kind).toBe('manual');
  });

  test('guard: no served OAuth row is ever run on codex-cli or hermes', () => {
    for (const entry of rows.filter((r) => r.bucket !== 'gateway' && rowUsesOAuth(r))) {
      expect(planClient(entry, 'codex-cli', 'linux').kind).not.toBe('run');
      expect(planClient(entry, 'hermes', 'linux').kind).not.toBe('run');
    }
  });

  test('no run plan holds a login or setup line in its add argv', () => {
    for (const entry of rows.filter((r) => r.bucket !== 'gateway')) {
      for (const client of ['claude-code', 'codex-cli', 'hermes'] as const) {
        const plan = planClient(entry, client, 'linux');
        if (plan.kind !== 'run') continue;
        expect(plan.add.slice(0, 3)).toEqual([plan.add[0]!, 'mcp', 'add']);
        expect(plan.add).not.toContain('login');
        expect(plan.add).not.toContain('setup');
        expect(plan.add).not.toContain('--auth');
      }
    }
  });

  test('Windows: Claude Code stdio npx rows get cmd /c; other rows and clients do not', () => {
    const win = planClient(row('shinjuku'), 'claude-code', 'win32');
    expect(win.kind === 'run' && win.add).toEqual([
      'claude', 'mcp', 'add', '--scope', 'user', 'shinjuku-shielded', '--', 'cmd', '/c', 'npx', '-y', '--no-audit', '--no-fund', 'shinjuku-shield@0.3.95', 'mcp',
    ]);
    const linux = planClient(row('shinjuku'), 'claude-code', 'linux');
    expect(linux.kind === 'run' && linux.add.includes('cmd')).toBe(false);
    const pay = planClient(row('paysh'), 'claude-code', 'win32');
    expect(pay.kind === 'run' && pay.add).toEqual(['claude', 'mcp', 'add', 'pay', '--', 'pay', 'mcp']);
    const codex = planClient(row('shinjuku'), 'codex-cli', 'win32');
    expect(codex.kind === 'run' && codex.add.includes('cmd')).toBe(false);
  });

  test('gateway rows plan no command and name the ClawVille tools', () => {
    const plans = rows.filter((r) => r.bucket === 'gateway').map((r) => planRow(r, ['claude-code', 'codex-cli', 'hermes'], 'linux'));
    expect(plans.map((p) => p.kind)).toEqual(['gateway', 'gateway']);
    expect(gatewayTools(row('clawpump'))).toEqual(['clawville_market']);
    expect(gatewayTools(row('said'))).toEqual(['clawville_trust']);
  });

  test('server name extraction skips claude options', () => {
    expect(serverNameOf('claude-code', ['claude', 'mcp', 'add', '--transport', 'http', 'x1', 'https://a.example'])).toBe('x1');
    expect(serverNameOf('claude-code', ['claude', 'mcp', 'add', '-s', 'user', 'x2', '--', 'npx'])).toBe('x2');
    expect(() => serverNameOf('claude-code', ['claude', 'mcp', 'add', '--', 'npx'])).toThrow();
  });
});

describe('process start', () => {
  const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe' };

  test('POSIX and a Windows .exe start the program directly', () => {
    const posix = buildSpawnRequest('/usr/bin/claude', ['claude', 'mcp', 'list'], { platform: 'linux', env: {}, cwd: '/tmp', timeoutMs: 1 });
    expect(posix.file).toBe('/usr/bin/claude');
    expect(posix.args).toEqual(['mcp', 'list']);
    expect(posix.windowsVerbatimArguments).toBeUndefined();
    const exe = buildSpawnRequest('C:\\bin\\hermes.exe', ['hermes', 'mcp', 'list'], { platform: 'win32', env, cwd: 'C:\\', timeoutMs: 1 });
    expect(exe.file).toBe('C:\\bin\\hermes.exe');
    expect(exe.args).toEqual(['mcp', 'list']);
  });

  test('a Windows .cmd shim goes through cmd.exe with a quoted path and checked arguments', () => {
    const request = buildSpawnRequest('C:\\Program Files\\x\\codex.cmd', ['codex', 'mcp', 'get', 'clawville', '--json'], { platform: 'win32', env, cwd: 'C:\\', timeoutMs: 1 });
    expect(request.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(request.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\x\\codex.cmd" mcp get clawville --json"']);
    expect(request.windowsVerbatimArguments).toBe(true);
  });

  test('unsafe arguments and shim paths are refused', () => {
    expect(() => buildSpawnRequest('/usr/bin/x', ['x', 'a&b'], { platform: 'linux', env: {}, cwd: '/', timeoutMs: 1 })).toThrow(UnsafeCommandError);
    expect(() => buildSpawnRequest('C:\\a%PATH%\\x.cmd', ['x', 'ok'], { platform: 'win32', env, cwd: 'C:\\', timeoutMs: 1 })).toThrow(UnsafeCommandError);
    expect(() => buildSpawnRequest('C:\\a"b\\x.cmd', ['x', 'ok'], { platform: 'win32', env, cwd: 'C:\\', timeoutMs: 1 })).toThrow(UnsafeCommandError);
  });

  test('PATH lookup: PATHEXT order on Windows, the execute bit on POSIX', () => {
    const files = new Set(['C:\\bin\\hermes.cmd', 'C:\\bin\\hermes.exe', 'C:\\tools\\codex.cmd', 'C:\\tools\\codex']);
    const winWhich = makeWhich('win32', { Path: 'C:\\bin;C:\\tools\\', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, { isFile: (p) => files.has(p), isExecutable: () => false });
    expect(winWhich('hermes')).toBe('C:\\bin\\hermes.exe');
    expect(winWhich('codex')).toBe('C:\\tools\\codex.cmd');
    expect(winWhich('claude')).toBeNull();
    const posixWhich = makeWhich('linux', { PATH: '/a:/b' }, { isFile: (p) => p === '/a/claude' || p === '/b/claude', isExecutable: (p) => p === '/b/claude' });
    expect(posixWhich('claude')).toBe('/b/claude');
  });
});

describe('client output parsers', () => {
  test('hermes list table, with colour codes', () => {
    const output = [
      '',
      '  \u001b[36m\u001b[1mMCP Servers:\u001b[0m',
      '',
      '  Name             Transport                      Tools        Status    ',
      '  ──────────────── ────────────────────────────── ──────────── ──────────',
      '  clawville        https://api-staging.clawvi...  all          \u001b[32m✓ enabled\u001b[0m',
      '  pay              pay mcp                        all          \u001b[2m✗ disabled\u001b[0m',
      '',
    ].join('\n');
    expect(parseHermesList(output)).toEqual(['clawville', 'pay']);
    expect(parseHermesList('\n  No MCP servers configured.\n')).toEqual([]);
  });

  test('codex list --json, with a warning before it', () => {
    expect(parseCodexListJson('WARNING: x\n[{"name":"clawville"},{"name":"pay"}]')).toEqual(['clawville', 'pay']);
    expect(parseCodexListJson('[]')).toEqual([]);
    expect(parseCodexListJson('No MCP servers configured yet.')).toBeNull();
  });

  test('control characters are removed from client output', () => {
    expect(stripControl('a\u001b[31mred\u001b[0m\u0007b\r\nc\u001b]0;title\u0007d')).toBe('aredb\ncd');
    expect(outputTail('1\n2\n3\n', 2)).toEqual(['2', '3']);
  });
});
