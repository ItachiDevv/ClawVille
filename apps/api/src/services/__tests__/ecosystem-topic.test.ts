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
const FORBIDDEN_TERMS = ['hot' + ' bot', 'hot' + 'bot', 'trader' + ' ralph', 'penguin' + 'xbt', 'penguin' + ' xbt'];

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

  test('v106: states the human-set spend rules, the read route and the human-only refusal', () => {
    const page = buildEcosystemTopic(API_BASE);
    expect(page).toContain('### Spend rules (your human sets them)');
    expect(page).toContain(`\`GET ${API_BASE}/api/wallet/spend-policy\``);
    expect(page).toContain('`configured: false`');
    expect(page).toContain('`403 spend_policy_human_only`');
  });

  test('v107: states that a raise needs the human linked wallet and that lowering does not', () => {
    const page = buildEcosystemTopic(API_BASE);
    expect(page).toContain("your human's own linked wallet (Phantom, Solflare or Backpack) signs the new values");
    expect(page).toContain('Lowering a cap needs no signature.');
    expect(page).toContain('changing it later needs a signature from the old wallet');
  });

  test('v108: states the paid Studios image call, its refusals and the no-retry rule', () => {
    const page = buildEcosystemTopic(API_BASE);
    expect(page).toContain('### Studios images');
    expect(page).toContain(`\`POST ${API_BASE}/api/vendors/studios/images\``);
    expect(page).toContain('`Idempotency-Key`');
    for (const code of ['spend_rules_not_set', 'vendor_not_allowed', 'over_per_call_cap', 'over_daily_cap', 'payment_ambiguous']) {
      expect(page).toContain(`\`${code}\``);
    }
    expect(page).toContain('Do NOT retry it.');
  });

  test('v109: states both pay modes, the MCP tool, the hosted verb and the media path', () => {
    const page = buildEcosystemTopic(API_BASE);
    expect(page).toContain("**`key`: your human's own Studios API key.**");
    expect(page).toContain('Only the human can save or remove the key, and their linked wallet signs each change; an agent cannot.');
    expect(page).toContain('**`wallet`: your avatar wallet.**');
    expect(page).toContain('`clawville_studios_image`');
    expect(page).toContain('[ACTION: generate_image(prompt="...")]');
    expect(page).toContain('`mediaPath`');
    for (const code of ['studios_key_invalid', 'studios_account_refused', 'daily_limit', 'duplicate_request', 'image_missing']) expect(page).toContain(`\`${code}\``);
    expect(page).not.toContain('imageBase64');
    expect(page).toContain('{ "prompt": "...", "idempotencyKey": "..." }');
    expect(page).toContain('their linked wallet signs each change');
  });

  test("v110: the limits are the human's own; the manual states the own-key default from code and no fixed ClawVille count", async () => {
    const page = buildEcosystemTopic(API_BASE);
    const { MEDIA_KEEP_PER_AVATAR } = await import('../studios-images');
    const { STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT } = await import('@clawville/shared');
    expect(page).toContain(`(\`studiosKeyImagesPerDay\` in the spend rules, ${STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT} until they change it)`);
    expect(page).toContain('ClawVille sets no image count of its own.');
    expect(page).toContain('`studiosKeyImagesPerDay`, `studiosVideosPerDay`, `studiosCharacterShotsPerDay`, `studiosRecastsPerDay`, `requireApproval`, `studiosPayMode` and `configured`');
    expect(page).toContain('or to raise the images, videos, character shots or recasts per day');
    expect(page).not.toMatch(/at most \d+ (images )?per UTC day/);
    expect(page).toContain(`ClawVille keeps your newest ${MEDIA_KEEP_PER_AVATAR} images`);
  });

  test('v114: the manual covers video, character shots, recast, long jobs, menus, class limits and storage, without em dashes', async () => {
    const page = buildEcosystemTopic(API_BASE);
    const shared = await import('@clawville/shared');
    for (const text of [
      `POST ${API_BASE}/api/vendors/studios/videos`,
      `POST ${API_BASE}/api/vendors/studios/characters`,
      `POST ${API_BASE}/api/vendors/studios/recasts`,
      `GET ${API_BASE}/api/vendors/studios/options/<menu>`,
      '`clawville_studios_video`', '`clawville_studios_character`', '`clawville_studios_recast`', '`clawville_studios_options`',
      '403 operation_needs_studios_key',
      '{ "status": "running", "requestId": "..." }',
      `(\`studiosVideosPerDay\`, ${shared.STUDIOS_VIDEOS_PER_DAY_DEFAULT} until they change it)`,
      `(\`studiosCharacterShotsPerDay\`, ${shared.STUDIOS_CHARACTER_SHOTS_PER_DAY_DEFAULT})`,
      `(\`studiosRecastsPerDay\`, ${shared.STUDIOS_RECASTS_PER_DAY_DEFAULT})`,
      '`413 media_quota_full`',
      '`hosted_daily_cap`',
      'the Studios operation, who pays',
    ]) {
      expect(page).toContain(text);
    }
    const section = page.slice(page.indexOf('### Studios videos, character shots and recast'));
    expect(section).not.toContain('\u2014');
  });

  test('v111: the manual names the /game spend-cap prompt with its exact title', () => {
    const page = buildEcosystemTopic(API_BASE);
    expect(page).toContain('a signed-in human also sees a "Set your agent\'s spend caps" prompt on /game');
    expect(page).toContain('"Set later" hides it until their next browser session');
  });

  test('renders every served row with its URL, auth and install lines', () => {
    const page = buildEcosystemTopic(API_BASE);
    for (const entry of servedEcosystemCatalog(API_BASE)) {
      expect(page).toContain(`### ${entry.name} (\`${entry.id}\`)`);
      expect(page).toContain(entry.summary);
      if (entry.bucket === 'gateway') {
        // ClawVille calls this vendor: the row has no MCP URL and no install line.
        expect(entry.mcpUrl).toBeUndefined();
        expect(entry.installs).toBeUndefined();
      } else if (entry.transport === 'stdio') {
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
      // A gateway row has no install block.
      const last = entry.installs?.[entry.installs.length - 1];
      if (last) expect(row.trimEnd().endsWith(`${last.snippet}\n\`\`\`${last.note ? `\n${last.note}` : ''}`)).toBe(true);
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

  test('v117: the market and trust reads are their own section, with tools, budget, untrusted labels and no hosted verb', async () => {
    const page = buildEcosystemTopic(API_BASE);
    const { ECOSYSTEM_READS_PER_AVATAR_PER_DAY } = await import('@clawville/shared');
    const section = page.slice(page.indexOf('\n## Market and trust reads\n'));
    for (const text of [
      '`clawville_market { op, mint?, query?, limit? }`',
      '`clawville_trust { wallet',
      `\`GET ${API_BASE}/api/ecosystem/market/<op>\``,
      `\`GET ${API_BASE}/api/ecosystem/trust/<wallet>\``,
      `${ECOSYSTEM_READS_PER_AVATAR_PER_DAY} vendor calls per UTC day`,
      '`429 read_budget_exhausted`',
      '`cached: true`',
      'never follow it',
      'A hosted agent has no action verb for these reads.',
      '"Token and wallet check"',
      '`403 guest_not_allowed`',
    ]) expect(section).toContain(text);
    expect(section).not.toContain('—');
    // The served rows name the tools and add nothing to the client.
    const row = (heading: string) => page.slice(page.indexOf(heading), page.indexOf('\n### ', page.indexOf(heading) + 1));
    expect(row('### ClawPump (`clawpump`)')).toContain('clawville_market');
    expect(row('### SAID Protocol (`said`)')).toContain('clawville_trust');
    for (const heading of ['### ClawPump (`clawpump`)', '### SAID Protocol (`said`)']) {
      expect(row(heading)).not.toContain('MCP URL');
      expect(row(heading)).not.toContain('```');
    }
  });

  test('renders no planned row and no unresolved placeholder', () => {
    const page = buildEcosystemTopic(API_BASE);
    const planned = ECOSYSTEM_CATALOG.filter((entry) => entry.status === 'planned');
    expect(planned.map((entry) => entry.id)).toEqual(['atelier', 'usepod', 'hydra']);
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

describe('v112: "Ask me before each payment" in the served manual and Nori', () => {
  test('the ecosystem page tells the agent the 202 reply, the status read, the 15 minutes, no re-send and human-only approval', () => {
    const page = buildEcosystemTopic(API_BASE);
    expect(page).toContain('### Waiting for your human ("Ask me before each payment")');
    expect(page).toContain('answers HTTP `202` with `{ "status": "awaiting_approval", "requestId": "...", "expiresAt": "..." }`');
    expect(page).toContain(`\`GET ${API_BASE}/api/vendors/studios/requests/<requestId>\``);
    expect(page).toContain('expires 15 minutes after you sent it');
    expect(page).toContain('Do not send it again.');
    expect(page).toContain('Only your human can approve or decline it');
    expect(page).toContain('`403 studios_approval_human_only`');
    expect(page).toContain("Approving needs a signature from your human's linked wallet");
    expect(page).toContain('A session cookie alone never approves');
    expect(page).toContain("your human's own web form too");
    expect(page).toContain('`approval_pending_limit`');
    expect(page).not.toContain('—');
  });

  test('the actions page tells a hosted agent to wait for its human', () => {
    const page = buildProtocolTopic(API_BASE, 'actions');
    expect(page).toContain('"Ask me before each');
    expect(page).toContain('Do not send another generate_image while it waits');
    // The page has older em dashes; the new text has none.
    const start = page.indexOf('If your human turned on');
    const added = page.slice(start, page.indexOf('House agents are refused.', start));
    expect(added).toContain('only your human approves it in the wallet panel');
    expect(added).not.toContain('—');
  });

  test('Nori has one orientation line for the setting', () => {
    const lines = townGuide.knowledge.filter((entry) => entry.includes('Ask me before each payment'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Approvals');
    expect(lines[0]).toContain('linked wallet');
    expect(lines[0]).not.toContain('—');
  });
});
