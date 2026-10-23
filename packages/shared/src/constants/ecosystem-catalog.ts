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
  readonly homepage?: string;
  readonly installs?: readonly EcosystemInstallSnippet[];
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

/** The `mcpServers` JSON shape the entry manual already serves for ClawVille. */
function mcpServersJson(name: string, url: string): string {
  return `{ "mcpServers": { "${name}": { "type": "http", "url": "${url}" } } }`;
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
        note: 'With an API key instead of OAuth, add `--header "Authorization: Bearer atelier_<key>"`.',
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
    ...(entry.notes !== undefined ? { notes: entry.notes.map(r) } : {}),
  };
}

/** The served rows: `available` only, resolved for `apiBase`, in catalog order. */
export function servedEcosystemCatalog(apiBase: string): EcosystemCatalogEntry[] {
  return ECOSYSTEM_CATALOG
    .filter((entry) => entry.status === 'available')
    .map((entry) => resolveEcosystemEntry(entry, apiBase));
}
