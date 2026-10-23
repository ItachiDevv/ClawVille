import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ECOSYSTEM_API_BASE_PLACEHOLDER,
  ECOSYSTEM_CATALOG,
  ECOSYSTEM_GENERAL_NOTES,
  servedEcosystemCatalog,
} from './ecosystem-catalog';

const API_BASE = 'https://api.example.test';

// Names that must never appear in the catalog. Built from pieces so this
// test file itself does not carry them.
const ECOSYSTEM_FORBIDDEN_TERMS = ['hot' + ' bot', 'hot' + 'bot', 'shin' + 'juku'];

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
    expect(served.map((entry) => entry.id)).toEqual(['clawville', 'studios', 'atelier']);
    for (const id of planned) expect(served.some((entry) => entry.id === id)).toBe(false);
    for (const entry of served) expect(entry.status).toBe('available');
  });

  test('every served row has an MCP URL, auth text and install lines', () => {
    for (const entry of servedEcosystemCatalog(API_BASE)) {
      expect(entry.mcpUrl).toMatch(/^https?:\/\//);
      expect(entry.auth.trim().length).toBeGreaterThan(0);
      expect(entry.transport).toBe('http');
      expect(entry.installs?.map((install) => install.client)).toEqual(['claude-code', 'codex-cli', 'hermes', 'generic-json']);
    }
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
    expect(JSON.stringify(ECOSYSTEM_CATALOG)).not.toContain('—');
  });
});
