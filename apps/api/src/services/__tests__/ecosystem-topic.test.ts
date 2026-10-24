import { describe, expect, test } from 'bun:test';
import { townGuide } from '@clawville/agent-templates';
import {
  ECOSYSTEM_API_BASE_PLACEHOLDER,
  ECOSYSTEM_CATALOG,
  ECOSYSTEM_CLIENT_LABELS,
  servedEcosystemCatalog,
} from '@clawville/shared';
import {
  PROTOCOL_TOPICS,
  buildPlayManual,
  buildProtocolManual,
  buildProtocolTopic,
} from '../skill-protocol';
import { buildEcosystemTopic } from '../skill-protocol-topics/ecosystem';

const API_BASE = 'https://api.example.test';

// Built from pieces so this file itself does not carry the names.
const FORBIDDEN_TERMS = ['hot' + ' bot', 'hot' + 'bot', 'trader' + ' ralph', 'penguin' + 'xbt', 'penguin' + ' xbt', 'said'];

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
      if (entry.transport === 'stdio') {
        expect(page).toContain(`- Command: \`${entry.command}\` (stdio, runs on your computer)`);
      } else {
        expect(page).toContain(`- MCP URL: \`${entry.mcpUrl}\` (Streamable HTTP)`);
      }
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

  test('the Pay.sh stdio row shows its command and no MCP URL', () => {
    const page = buildEcosystemTopic(API_BASE);
    const start = page.indexOf('### Pay.sh (`paysh`)');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('\n### ', start + 1);
    const row = page.slice(start, end);
    expect(row).toContain('- Command: `pay mcp` (stdio, runs on your computer)');
    expect(row).toContain('claude mcp add pay -- pay mcp');
    expect(row).toContain('{ "mcpServers": { "pay": { "command": "pay", "args": ["mcp"] } } }');
    expect(row).not.toContain('MCP URL');
    expect(page).not.toContain('undefined');
  });

  test('the Shinjuku StAItion row is the npm wallet over stdio and carries no forbidden word', () => {
    const page = buildEcosystemTopic(API_BASE);
    const start = page.indexOf('### Shinjuku StAItion (`shinjuku`)');
    expect(start).toBeGreaterThan(-1);
    const row = page.slice(start, page.indexOf('\n### ', start + 1));
    expect(row).toContain('- Command: `npx -y --no-audit --no-fund shinjuku-shield@0.3.95 mcp` (stdio, runs on your computer)');
    expect(row).not.toContain('MCP URL');
    // Built from pieces so this file does not carry the word.
    expect(row.toLowerCase()).not.toContain('part' + 'ner');
  });

  test('the command-line block renders for the shinjuku and paysh rows only', () => {
    const page = buildEcosystemTopic(API_BASE);
    const label = 'Command-line tool (no MCP client needed):';
    expect(page.split(label).length - 1).toBe(2);
    const rowOf = (heading: string) => {
      const start = page.indexOf(heading);
      expect(start).toBeGreaterThan(-1);
      return page.slice(start, page.indexOf('\n### ', start + 1));
    };
    expect(rowOf('### Shinjuku StAItion (`shinjuku`)')).toContain(
      `${label}\n\n\`\`\`bash\nnpm install -g shinjuku@0.3.95\nshinjuku help\n\`\`\``,
    );
    expect(rowOf('### Pay.sh (`paysh`)')).toContain(`${label}\n\n\`\`\`bash\nbrew install pay\npay setup\n\`\`\``);
    for (const entry of servedEcosystemCatalog(API_BASE).filter((row) => !row.cli)) {
      const row = rowOf(`### ${entry.name} (\`${entry.id}\`)`);
      expect(row).not.toContain(label);
      // A row without cli still ends with its last install block, as before.
      const last = entry.installs![entry.installs!.length - 1]!;
      expect(row.trimEnd().endsWith(`${last.snippet}\n\`\`\`${last.note ? `\n${last.note}` : ''}`)).toBe(true);
    }
  });

  test('the ClawVille row renders exactly as before the cli field', () => {
    const page = buildEcosystemTopic(API_BASE);
    const start = page.indexOf('### ClawVille (`clawville`)');
    const row = page.slice(start, page.indexOf('\n### ', start + 1));
    const url = `${API_BASE}/api/agent/mcp`;
    expect(row).toBe(`### ClawVille (\`clawville\`)

The ClawVille MCP. Your agent connects, gets an avatar, walks the town, learns skills and plays the games through one server.

- MCP URL: \`${url}\` (Streamable HTTP)
- Sign-in: No sign-in. Call clawville_connect first; it returns your sessionId, which you pass on every other tool call.
- Home page: https://clawville.world
- Streamable HTTP with JSON answers.
- Call clawville_docs { topic } for any protocol page.

Claude Code:

\`\`\`bash
claude mcp add --transport http clawville ${url}
\`\`\`

Codex CLI:

\`\`\`bash
codex mcp add clawville --url ${url}
\`\`\`

Hermes:

\`\`\`bash
hermes mcp add clawville --url ${url}
\`\`\`

Any client that reads an mcpServers JSON block:

\`\`\`json
{ "mcpServers": { "clawville": { "type": "http", "url": "${url}" } } }
\`\`\`
`);
  });

  test('renders no planned row and no unresolved placeholder', () => {
    const page = buildEcosystemTopic(API_BASE);
    const planned = ECOSYSTEM_CATALOG.filter((entry) => entry.status === 'planned');
    expect(planned.map((entry) => entry.id)).toEqual(['usepod', 'clawpump', 'hydra', 'said']);
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

describe('Nori points at the ecosystem list', () => {
  test('one orientation line names the topic page and the public route', () => {
    const lines = townGuide.knowledge.filter((entry) => entry.includes('/api/ecosystem/catalog'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/api/skills/protocol/ecosystem.md');
  });
});
