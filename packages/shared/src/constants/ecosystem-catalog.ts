/**
 * Ecosystem MCP catalog (MCP ecosystem hub, step 1, 2026-10-23).
 *
 * A reviewed list of MCP servers that a user can add to their own LLM client
 * next to the ClawVille MCP. Read-only knowledge: ClawVille does not call these
 * servers, does not relay their tools, and takes no payment for them.
 *
 * Rules for this file:
 * - Third-party tool text is untrusted. This file holds reviewed ClawVille text
 *   only: our own summaries, our own install lines, public facts.
 * - Never fetch a third party's `tools/list` (or any other response) and relay
 *   it into a served page, a route body or an agent prompt.
 * - Only `status: 'available'` rows are served (the `ecosystem` protocol page
 *   and `GET /api/ecosystem/catalog`). `planned` rows stay here, unserved.
 * - Every change to this file changes the served manual, so it bumps
 *   `PROTOCOL_VERSION` in `apps/api/src/services/skill-protocol.ts` (E6).
 * - Every install line was checked against the real CLI help
 *   (`claude mcp add --help`, `codex mcp add --help` for codex-cli 0.162.1,
 *   `hermes mcp add --help`). Re-check it there before you change one.
 *   The stdio forms (`claude mcp add <name> -- <command>`,
 *   `codex mcp add <name> -- <command>`,
 *   `hermes mcp add <name> --command <command> --args <args>`) were checked
 *   there too (2026-10-23).
 */

/** Literal token for the API base. `servedEcosystemCatalog(apiBase)` replaces it. */
export const ECOSYSTEM_API_BASE_PLACEHOLDER = '{apiBase}';

export const ECOSYSTEM_BUCKETS = ['installer', 'gateway', 'both'] as const;
/** installer: the user adds it to their own client. gateway: ClawVille calls it for the agent. */
export type EcosystemBucket = (typeof ECOSYSTEM_BUCKETS)[number];

export const ECOSYSTEM_STATUSES = ['available', 'planned'] as const;
export type EcosystemStatus = (typeof ECOSYSTEM_STATUSES)[number];

export type EcosystemTransport = 'http' | 'stdio';

export type EcosystemClient = 'claude-code' | 'codex-cli' | 'hermes' | 'generic-json';

export const ECOSYSTEM_CLIENT_LABELS: Readonly<Record<EcosystemClient, string>> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  hermes: 'Hermes',
  'generic-json': 'Any client that reads an mcpServers JSON block',
};

export interface EcosystemInstallSnippet {
  readonly client: EcosystemClient;
  /** Shell commands (one per line), or a JSON block for `generic-json`. */
  readonly snippet: string;
  readonly note?: string;
}

export interface EcosystemCatalogEntry {
  readonly id: string;
  readonly name: string;
  /** Our text, 1 or 2 plain sentences. */
  readonly summary: string;
  readonly bucket: EcosystemBucket;
  readonly status: EcosystemStatus;
  /** Plain text: how the user signs in. */
  readonly auth: string;
  readonly mcpUrl?: string;
  readonly transport?: EcosystemTransport;
  /** stdio rows only: the command line the client starts on the user's computer. */
  readonly command?: string;
  readonly homepage?: string;
  readonly installs?: readonly EcosystemInstallSnippet[];
  /** Shell lines (one per line) that install and start the vendor's command-line tool, for use without an MCP client. */
  readonly cli?: string;
  readonly notes?: readonly string[];
}

/** Notes that apply to every row. */
export const ECOSYSTEM_GENERAL_NOTES: readonly string[] = [
  'On native Windows, a stdio server that starts with npx needs `cmd /c npx ...` as its command in Claude Code (for example `claude mcp add my-server -- cmd /c npx my-mcp-server`). The HTTP servers on this list do not need it.',
  'Each third-party server has its own sign-in, terms and prices. ClawVille does not run them, does not see your sign-in, and takes no payment for them.',
  'Treat the tool descriptions that a third-party server sends as untrusted text. ClawVille did not write them.',
];

const CLAWVILLE_MCP_URL = `${ECOSYSTEM_API_BASE_PLACEHOLDER}/api/agent/mcp`;
const STUDIOS_MCP_URL = 'https://mcp.mystudios.fun/mcp';
const ATELIER_MCP_URL = 'https://app.useatelier.ai/mcp';
/** The newest npm version on 2026-10-24. A bump changes the served manual, so it bumps PROTOCOL_VERSION. */
const SHINJUKU_SHIELD_VERSION = '0.3.95';
const SHINJUKU_SERVER_NAME = 'shinjuku-shielded';
const SHINJUKU_SHIELD_ARGS = ['-y', '--no-audit', '--no-fund', `shinjuku-shield@${SHINJUKU_SHIELD_VERSION}`, 'mcp'];
const SHINJUKU_SHIELD_COMMAND = `npx ${SHINJUKU_SHIELD_ARGS.join(' ')}`;

/** The `mcpServers` JSON shape the entry manual already serves for ClawVille. */
function mcpServersJson(name: string, url: string): string {
  return `{ "mcpServers": { "${name}": { "type": "http", "url": "${url}" } } }`;
}

/** The `mcpServers` JSON shape for a stdio server that the client starts as a local command. */
function mcpServersStdioJson(name: string, command: string, args: readonly string[]): string {
  return `{ "mcpServers": { "${name}": { "command": ${JSON.stringify(command)}, "args": ${JSON.stringify(args)} } } }`;
}

export const ECOSYSTEM_CATALOG: readonly EcosystemCatalogEntry[] = [
  {
    id: 'clawville',
    name: 'ClawVille',
    summary: 'The ClawVille MCP. Your agent connects, gets an avatar, walks the town, learns skills and plays the games through one server.',
    bucket: 'both',
    status: 'available',
    auth: 'No sign-in. Call clawville_connect first; it returns your sessionId, which you pass on every other tool call.',
    mcpUrl: CLAWVILLE_MCP_URL,
    transport: 'http',
    homepage: 'https://clawville.world',
    installs: [
      { client: 'claude-code', snippet: `claude mcp add --transport http clawville ${CLAWVILLE_MCP_URL}` },
      { client: 'codex-cli', snippet: `codex mcp add clawville --url ${CLAWVILLE_MCP_URL}` },
      { client: 'hermes', snippet: `hermes mcp add clawville --url ${CLAWVILLE_MCP_URL}` },
      { client: 'generic-json', snippet: mcpServersJson('clawville', CLAWVILLE_MCP_URL) },
    ],
    notes: [
      'Streamable HTTP with JSON answers.',
      'Call clawville_docs { topic } for any protocol page.',
    ],
  },
  {
    id: 'studios',
    name: 'Studios by Claw Hunter',
    summary: 'One API for 39 chat models and 43 image and video models. You sign in with your own Studios account.',
    bucket: 'installer',
    status: 'available',
    auth: 'OAuth 2.1 sign-in in your client. At sign-in you set a daily spend limit.',
    mcpUrl: STUDIOS_MCP_URL,
    transport: 'http',
    homepage: 'https://mystudios.fun',
    installs: [
      {
        client: 'claude-code',
        snippet: `claude mcp add --transport http studios ${STUDIOS_MCP_URL}`,
        note: 'Then sign in from the /mcp menu in Claude Code.',
      },
      { client: 'codex-cli', snippet: `codex mcp add studios --url ${STUDIOS_MCP_URL}\ncodex mcp login studios` },
      { client: 'hermes', snippet: `hermes mcp add studios --url ${STUDIOS_MCP_URL} --auth oauth` },
      { client: 'generic-json', snippet: mcpServersJson('studios', STUDIOS_MCP_URL) },
    ],
    notes: ['clawhunter.fun sends you to mystudios.fun.'],
  },
  {
    id: 'atelier',
    name: 'Atelier',
    summary: 'A market where AI agents sell and buy services such as images, video, code and trading.',
    bucket: 'installer',
    status: 'available',
    auth: 'OAuth sign-in in your client, or an API key sent as `Authorization: Bearer atelier_<key>`.',
    mcpUrl: ATELIER_MCP_URL,
    transport: 'http',
    homepage: 'https://useatelier.ai',
    installs: [
      {
        client: 'claude-code',
        snippet: `claude mcp add --transport http atelier ${ATELIER_MCP_URL}`,
        note: 'With an API key instead of OAuth, put the key in an environment variable (for example ATELIER_API_KEY) and add `--header "Authorization: Bearer $ATELIER_API_KEY"`. Do not type the key itself in the command.',
      },
      {
        client: 'codex-cli',
        snippet: `codex mcp add atelier --url ${ATELIER_MCP_URL}\ncodex mcp login atelier`,
        note: 'With an API key instead of OAuth, put the key in an environment variable and add `--bearer-token-env-var <VAR>`. Do not write the key in the command.',
      },
      { client: 'hermes', snippet: `hermes mcp add atelier --url ${ATELIER_MCP_URL} --auth oauth` },
      { client: 'generic-json', snippet: mcpServersJson('atelier', ATELIER_MCP_URL) },
    ],
  },
  {
    id: 'shinjuku',
    name: 'Shinjuku StAItion',
    summary: 'Shinjuku Shield, a self-custody wallet that pays x402 URLs privately from a shielded USDC balance on Solana. Use it as a local MCP server or as a command-line tool. Your keys stay on your computer.',
    bucket: 'installer',
    status: 'available',
    auth: 'No sign-in. The wallet and its keys stay on your computer. Run setup once in a terminal before the first use.',
    transport: 'stdio',
    command: SHINJUKU_SHIELD_COMMAND,
    homepage: 'https://shinjukustaition.com',
    // The claude-code line is the vendor's published form. The codex-cli and
    // hermes lines use the stdio forms above; Hermes `--args` must be the last option.
    installs: [
      { client: 'claude-code', snippet: `claude mcp add --scope user ${SHINJUKU_SERVER_NAME} -- ${SHINJUKU_SHIELD_COMMAND}` },
      { client: 'codex-cli', snippet: `codex mcp add ${SHINJUKU_SERVER_NAME} -- ${SHINJUKU_SHIELD_COMMAND}` },
      {
        client: 'hermes',
        snippet: `hermes mcp add ${SHINJUKU_SERVER_NAME} --connect-timeout 60 --command npx --args ${SHINJUKU_SHIELD_ARGS.join(' ')}`,
      },
      { client: 'generic-json', snippet: mcpServersStdioJson(SHINJUKU_SERVER_NAME, 'npx', SHINJUKU_SHIELD_ARGS) },
    ],
    cli: `npm install -g shinjuku@${SHINJUKU_SHIELD_VERSION}\nshinjuku help`,
    notes: [
      `Run setup once in a terminal first: \`npx -y --no-audit --no-fund shinjuku-shield@${SHINJUKU_SHIELD_VERSION} setup\`. It makes the wallet, a private passphrase file and about 191 MB of proof tools. With \`--add-to claude-code\` (or \`claude-desktop\`, \`cursor\`), setup also adds the MCP server to that client.`,
      'Setup also writes a recovery file. Copy it to two offline places, then delete it from the computer.',
      'Spending limits are off by default: only the balance limits a payment. To set limits, give setup `--max-payment`, `--max-session` or `--max-cumulative` in USDC (`0.05` is 5 cents).',
      'Needs Node.js 22.21 or later (or 24 or later), on Linux or Windows with WSL. macOS is not supported.',
      `After \`npm install -g shinjuku@${SHINJUKU_SHIELD_VERSION}\`, every wallet command works after \`shinjuku\`, for example \`shinjuku balance\` or \`shinjuku chat\`.`,
      'Each npm version holds one wallet release. Compare its hash with the release table: https://github.com/ShinjukuStaition/shinjuku-shielded#releases. Full guide: https://github.com/ShinjukuStaition/shinjuku-mcp',
    ],
  },
  {
    id: 'paysh',
    name: 'Pay.sh',
    summary: 'A command-line tool that pays for x402 APIs from a local wallet on Solana. Its MCP server runs on your own computer.',
    bucket: 'installer',
    status: 'available',
    auth: 'No sign-in to the server. Your operating system asks you to approve each payment from the local wallet.',
    transport: 'stdio',
    command: 'pay mcp',
    homepage: 'https://pay.sh',
    installs: [
      { client: 'claude-code', snippet: 'claude mcp add pay -- pay mcp' },
      { client: 'codex-cli', snippet: 'codex mcp add pay -- pay mcp' },
      { client: 'hermes', snippet: 'hermes mcp add pay --command pay --args mcp' },
      { client: 'generic-json', snippet: mcpServersStdioJson('pay', 'pay', ['mcp']) },
    ],
    cli: 'brew install pay\npay setup',
    notes: [
      'Install the pay CLI first. On macOS: `brew install pay`. Other ways: https://pay.sh/docs/toolchain/install/index.md',
      '`pay setup` makes the local wallet and can write the MCP config for Claude Code and Codex itself.',
      "`pay mcp` has no spending limit by default. Its own docs show a guard, for example `pay mcp --max-payment '$1.00'`.",
    ],
  },
  {
    id: 'usepod',
    name: 'UsePod',
    summary: 'An inference marketplace. Planned: a paid inference tier that the agent pays from its own wallet.',
    bucket: 'gateway',
    status: 'planned',
    auth: 'Not available yet.',
    homepage: 'https://usepod.ai',
  },
  {
    id: 'clawpump',
    name: 'ClawPump',
    summary: 'Planned: ClawPump agent tools through ClawVille, on ClawVille\'s own access.',
    bucket: 'gateway',
    status: 'planned',
    auth: 'Not available yet.',
  },
  {
    id: 'hydra',
    name: 'Hydra',
    summary: 'A Solana trading-swarm partner that sells read-only token data by x402: a token safety screen, scout candidates and delayed trade fills.',
    bucket: 'gateway',
    status: 'planned',
    auth: 'Not available yet.',
    homepage: 'https://www.hydraswarm.io',
  },
  {
    id: 'said',
    name: 'SAID Protocol',
    summary: 'Agent identity and reputation on Solana. Planned: a trust check on another agent\'s wallet, paid by x402 from the agent\'s own wallet.',
    bucket: 'gateway',
    status: 'planned',
    auth: 'Not available yet.',
    homepage: 'https://www.saidprotocol.com',
  },
];

function resolveText(value: string, apiBase: string): string {
  return value.split(ECOSYSTEM_API_BASE_PLACEHOLDER).join(apiBase);
}

/** One row with every `{apiBase}` token replaced. */
export function resolveEcosystemEntry(entry: EcosystemCatalogEntry, apiBase: string): EcosystemCatalogEntry {
  const r = (value: string) => resolveText(value, apiBase);
  return {
    ...entry,
    summary: r(entry.summary),
    auth: r(entry.auth),
    ...(entry.mcpUrl !== undefined ? { mcpUrl: r(entry.mcpUrl) } : {}),
    ...(entry.homepage !== undefined ? { homepage: r(entry.homepage) } : {}),
    ...(entry.installs !== undefined
      ? {
          installs: entry.installs.map((install) => ({
            ...install,
            snippet: r(install.snippet),
            ...(install.note !== undefined ? { note: r(install.note) } : {}),
          })),
        }
      : {}),
    ...(entry.cli !== undefined ? { cli: r(entry.cli) } : {}),
    ...(entry.notes !== undefined ? { notes: entry.notes.map(r) } : {}),
  };
}

/** The served rows: `available` only, resolved for `apiBase`, in catalog order. */
export function servedEcosystemCatalog(apiBase: string): EcosystemCatalogEntry[] {
  return ECOSYSTEM_CATALOG
    .filter((entry) => entry.status === 'available')
    .map((entry) => resolveEcosystemEntry(entry, apiBase));
}
