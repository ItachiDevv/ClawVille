import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ECOSYSTEM_API_BASE_PLACEHOLDER,
  ECOSYSTEM_CATALOG,
  ECOSYSTEM_GENERAL_NOTES,
  resolveEcosystemEntry,
  servedEcosystemCatalog,
} from './ecosystem-catalog';

const API_BASE = 'https://api.example.test';

// Names that must never appear in the catalog. Built from pieces so this
// test file itself does not carry them.
const ECOSYSTEM_FORBIDDEN_TERMS = ['hot' + ' bot', 'hot' + 'bot', 'trader' + ' ralph', 'penguin' + 'xbt', 'penguin' + ' xbt'];

describe('ECOSYSTEM_CATALOG', () => {
  test('ids are unique and ClawVille is row 1', () => {
    const ids = ECOSYSTEM_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('clawville');
  });

  test('the served list excludes every planned row', () => {
    const served = servedEcosystemCatalog(API_BASE);
    const planned = ECOSYSTEM_CATALOG.filter((entry) => entry.status === 'planned').map((entry) => entry.id);
    expect(planned.length).toBeGreaterThan(0);
    expect(served.map((entry) => entry.id)).toEqual(['clawville', 'studios', 'atelier', 'shinjuku', 'paysh']);
    expect(planned).toEqual(['usepod', 'clawpump', 'hydra', 'said']);
    for (const id of planned) expect(served.some((entry) => entry.id === id)).toBe(false);
    for (const entry of served) expect(entry.status).toBe('available');
  });

  test('every served row has an MCP URL (http) or a command (stdio), auth text and install lines', () => {
    for (const entry of servedEcosystemCatalog(API_BASE)) {
      if (entry.transport === 'stdio') {
        expect(entry.mcpUrl).toBeUndefined();
        expect(entry.command?.trim().length ?? 0).toBeGreaterThan(0);
      } else {
        expect(entry.transport).toBe('http');
        expect(entry.mcpUrl).toMatch(/^https?:\/\//);
        expect(entry.command).toBeUndefined();
      }
      expect(entry.auth.trim().length).toBeGreaterThan(0);
      expect(entry.installs?.map((install) => install.client)).toEqual(['claude-code', 'codex-cli', 'hermes', 'generic-json']);
    }
  });

  test('the Pay.sh row is stdio and its generic block parses as a command block', () => {
    const paysh = servedEcosystemCatalog(API_BASE).find((entry) => entry.id === 'paysh')!;
    expect(paysh.transport).toBe('stdio');
    expect(paysh.command).toBe('pay mcp');
    expect(paysh.installs).toEqual([
      { client: 'claude-code', snippet: 'claude mcp add pay -- pay mcp' },
      { client: 'codex-cli', snippet: 'codex mcp add pay -- pay mcp' },
      { client: 'hermes', snippet: 'hermes mcp add pay --command pay --args mcp' },
      { client: 'generic-json', snippet: '{ "mcpServers": { "pay": { "command": "pay", "args": ["mcp"] } } }' },
    ]);
    const generic = JSON.parse(paysh.installs!.find((install) => install.client === 'generic-json')!.snippet) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(generic).toEqual({ mcpServers: { pay: { command: 'pay', args: ['mcp'] } } });
    expect(paysh.cli).toBe('brew install pay\npay setup');
  });

  test('the Shinjuku StAItion row is the pinned npm wallet over stdio, with a cli and no MCP URL', () => {
    const shinjuku = servedEcosystemCatalog(API_BASE).find((entry) => entry.id === 'shinjuku')!;
    const command = 'npx -y --no-audit --no-fund shinjuku-shield@0.3.95 mcp';
    expect(shinjuku.transport).toBe('stdio');
    expect(shinjuku.mcpUrl).toBeUndefined();
    expect(shinjuku.command).toBe(command);
    expect(shinjuku.installs).toEqual([
      { client: 'claude-code', snippet: `claude mcp add --scope user shinjuku-shielded -- ${command}` },
      { client: 'codex-cli', snippet: `codex mcp add shinjuku-shielded -- ${command}` },
      {
        client: 'hermes',
        snippet: 'hermes mcp add shinjuku-shielded --connect-timeout 60 --command npx --args -y --no-audit --no-fund shinjuku-shield@0.3.95 mcp',
      },
      {
        client: 'generic-json',
        snippet: '{ "mcpServers": { "shinjuku-shielded": { "command": "npx", "args": ["-y","--no-audit","--no-fund","shinjuku-shield@0.3.95","mcp"] } } }',
      },
    ]);
    const generic = JSON.parse(shinjuku.installs!.find((install) => install.client === 'generic-json')!.snippet) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(generic).toEqual({
      mcpServers: { 'shinjuku-shielded': { command: 'npx', args: ['-y', '--no-audit', '--no-fund', 'shinjuku-shield@0.3.95', 'mcp'] } },
    });
    expect(shinjuku.cli).toBe('npm install -g shinjuku@0.3.95\nshinjuku help');
    expect(shinjuku.homepage).toBe('https://shinjukustaition.com');
    // Built from pieces so this file does not carry the word.
    expect(JSON.stringify(shinjuku).toLowerCase()).not.toContain('part' + 'ner');
  });

  test('the Shinjuku version is one constant in the source, used by every versioned line', () => {
    const source = readFileSync(join(import.meta.dir, 'ecosystem-catalog.ts'), 'utf8');
    const version = /shinjuku-shield@(\d+\.\d+\.\d+)/.exec(
      servedEcosystemCatalog(API_BASE).find((entry) => entry.id === 'shinjuku')!.command!,
    )![1]!;
    expect(source.split(version).length - 1).toBe(1);
    const shinjuku = servedEcosystemCatalog(API_BASE).find((entry) => entry.id === 'shinjuku')!;
    for (const install of shinjuku.installs!) expect(install.snippet).toContain(`shinjuku-shield@${version}`);
    expect(shinjuku.cli).toContain(`shinjuku@${version}`);
    expect(shinjuku.notes![0]).toContain(`shinjuku-shield@${version} setup`);
    expect(shinjuku.notes!.some((note) => note.includes(`npm install -g shinjuku@${version}`))).toBe(true);
    // No other version string of the package hides in the row.
    const versions = JSON.stringify(shinjuku).match(/shinjuku(?:-shield)?@\d+\.\d+\.\d+/g)!;
    expect(new Set(versions.map((v) => v.split('@')[1]))).toEqual(new Set([version]));
  });

  test('only the shinjuku and paysh rows carry a cli', () => {
    const withCli = servedEcosystemCatalog(API_BASE).filter((entry) => entry.cli !== undefined).map((entry) => entry.id);
    expect(withCli).toEqual(['shinjuku', 'paysh']);
  });

  test('resolving a row also fills the API base in its cli', () => {
    const row = { ...ECOSYSTEM_CATALOG[0]!, cli: `curl ${ECOSYSTEM_API_BASE_PLACEHOLDER}/health` };
    expect(resolveEcosystemEntry(row, API_BASE).cli).toBe(`curl ${API_BASE}/health`);
  });

  test('planned rows serve no URL and no install line', () => {
    for (const entry of ECOSYSTEM_CATALOG.filter((row) => row.status === 'planned')) {
      expect(entry.mcpUrl).toBeUndefined();
      expect(entry.installs).toBeUndefined();
    }
  });

  test('the ClawVille row resolves to the API base and leaves no placeholder', () => {
    const served = servedEcosystemCatalog(API_BASE);
    const clawville = served[0]!;
    expect(clawville.mcpUrl).toBe(`${API_BASE}/api/agent/mcp`);
    expect(clawville.installs).toEqual([
      { client: 'claude-code', snippet: `claude mcp add --transport http clawville ${API_BASE}/api/agent/mcp` },
      { client: 'codex-cli', snippet: `codex mcp add clawville --url ${API_BASE}/api/agent/mcp` },
      { client: 'hermes', snippet: `hermes mcp add clawville --url ${API_BASE}/api/agent/mcp` },
      { client: 'generic-json', snippet: `{ "mcpServers": { "clawville": { "type": "http", "url": "${API_BASE}/api/agent/mcp" } } }` },
    ]);
    expect(JSON.stringify(served)).not.toContain(ECOSYSTEM_API_BASE_PLACEHOLDER);
    // The constant itself is not mutated by resolving.
    expect(ECOSYSTEM_CATALOG[0]!.mcpUrl).toBe(`${ECOSYSTEM_API_BASE_PLACEHOLDER}/api/agent/mcp`);
  });

  test('the catalog source and its served rows contain no forbidden name and no em dash', () => {
    const source = readFileSync(join(import.meta.dir, 'ecosystem-catalog.ts'), 'utf8').toLowerCase();
    const served = JSON.stringify([servedEcosystemCatalog(API_BASE), ECOSYSTEM_GENERAL_NOTES]).toLowerCase();
    for (const term of ECOSYSTEM_FORBIDDEN_TERMS) {
      expect({ term, inSource: source.includes(term) }).toEqual({ term, inSource: false });
      expect({ term, inServed: served.includes(term) }).toEqual({ term, inServed: false });
    }
    // The planned SAID row lives in the source but is never served.
    expect(served).not.toContain('said');
    expect(JSON.stringify(ECOSYSTEM_CATALOG)).not.toContain('—');
  });
});
