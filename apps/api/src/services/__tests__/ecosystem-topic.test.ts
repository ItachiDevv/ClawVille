import { describe, expect, test } from 'bun:test';
import {
  ECOSYSTEM_API_BASE_PLACEHOLDER,
  ECOSYSTEM_CATALOG,
  ECOSYSTEM_CLIENT_LABELS,
  servedEcosystemCatalog,
} from '@clawville/shared';
import {
  PROTOCOL_TOPICS,
  buildEcosystemTopic,
  buildPlayManual,
  buildProtocolManual,
  buildProtocolTopic,
} from '../skill-protocol';

const API_BASE = 'https://api.example.test';

// Built from pieces so this file itself does not carry the names.
const FORBIDDEN_TERMS = ['hot' + ' bot', 'hot' + 'bot', 'shin' + 'juku'];

describe('protocol `ecosystem` page', () => {
  test('is the last PROTOCOL_TOPICS entry and is part of the full manual', () => {
    const last = PROTOCOL_TOPICS[PROTOCOL_TOPICS.length - 1]!;
    expect(last.id).toBe('ecosystem');
    expect(last.title).toBe('Ecosystem MCPs');
    const page = buildEcosystemTopic(API_BASE);
    expect(page.startsWith('## Ecosystem MCPs\n')).toBe(true);
    expect(buildProtocolManual(API_BASE)).toContain(page);
    expect(buildProtocolTopic(API_BASE, 'ecosystem')).toBe(`# ClawVille — Ecosystem MCPs\n\n${page}`);
    expect(page).toContain(`\`GET ${API_BASE}/api/ecosystem/catalog\``);
  });

  test('renders every served row with its URL, auth and install lines', () => {
    const page = buildEcosystemTopic(API_BASE);
    for (const entry of servedEcosystemCatalog(API_BASE)) {
      expect(page).toContain(`### ${entry.name} (\`${entry.id}\`)`);
      expect(page).toContain(entry.summary);
      expect(page).toContain(`- MCP URL: \`${entry.mcpUrl}\` (Streamable HTTP)`);
      expect(page).toContain(`- Sign-in: ${entry.auth}`);
      for (const install of entry.installs ?? []) {
        expect(page).toContain(`${ECOSYSTEM_CLIENT_LABELS[install.client]}:`);
        expect(page).toContain(install.snippet);
        if (install.note) expect(page).toContain(install.note);
      }
    }
    expect(page).toContain('claude mcp add --transport http clawville https://api.example.test/api/agent/mcp');
    expect(page).toContain('cmd /c npx');
  });

  test('renders no planned row and no unresolved placeholder', () => {
    const page = buildEcosystemTopic(API_BASE);
    const planned = ECOSYSTEM_CATALOG.filter((entry) => entry.status === 'planned');
    expect(planned.map((entry) => entry.id)).toEqual(['usepod', 'clawpump', 'hydra']);
    for (const entry of planned) {
      expect(page).not.toContain(`(\`${entry.id}\`)`);
      expect(page).not.toContain(entry.name);
      expect(page).not.toContain(entry.summary);
      if (entry.homepage) expect(page).not.toContain(entry.homepage);
    }
    expect(page).not.toContain(ECOSYSTEM_API_BASE_PLACEHOLDER);
  });

  test('the ClawVille generic block is the same one the entry manual serves', () => {
    const generic = servedEcosystemCatalog(API_BASE)[0]!.installs!.find((install) => install.client === 'generic-json')!;
    expect(buildPlayManual(API_BASE)).toContain(generic.snippet);
  });

  test('the rendered page carries no forbidden name and no em dash', () => {
    const page = buildEcosystemTopic(API_BASE);
    const lower = page.toLowerCase();
    for (const term of FORBIDDEN_TERMS) expect({ term, found: lower.includes(term) }).toEqual({ term, found: false });
    expect(page).not.toContain('—');
  });
});
