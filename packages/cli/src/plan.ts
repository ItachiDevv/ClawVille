/**
 * Turn one catalog row into a plan per client: the argv to run, or lines to
 * print only. Pure: no process, no file, no network.
 */
import type { ClientId } from './args';
import { gatewayTools, type EcosystemCatalogEntry } from './catalog';
import { clientInfo } from './clients';
import { tokenizeSnippet } from './tokenize';

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Options of `claude mcp add` that take a value (from `claude mcp add --help`). */
const CLAUDE_VALUE_OPTIONS = new Set(['--transport', '-t', '--scope', '-s', '--callback-port', '--client-id', '-e', '--env', '-H', '--header']);

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

export type ClientPlan =
  /** Run `add`, then print `followUps` (never run). */
  | { readonly kind: 'run'; readonly client: ClientId; readonly serverName: string; readonly add: readonly string[]; readonly followUps: readonly string[] }
  /** Print only: running these lines would start a sign-in. */
  | { readonly kind: 'manual'; readonly client: ClientId; readonly serverName: string; readonly lines: readonly string[]; readonly reason: string }
  /** The row has no install line for this client. */
  | { readonly kind: 'none'; readonly client: ClientId };

export type RowPlan =
  | { readonly kind: 'gateway'; readonly row: EcosystemCatalogEntry; readonly tools: readonly string[] }
  | { readonly kind: 'install'; readonly row: EcosystemCatalogEntry; readonly clients: readonly ClientPlan[] };

/** A row signs in with OAuth when its auth text says so or one of its install lines logs in. */
export function rowUsesOAuth(row: EcosystemCatalogEntry): boolean {
  if (/oauth/i.test(row.auth)) return true;
  return (row.installs ?? []).some((install) => /\bmcp login\b|--auth oauth\b/.test(install.snippet));
}

function isAddLine(argv: readonly string[], bin: string): boolean {
  return argv[0] === bin && argv[1] === 'mcp' && argv[2] === 'add';
}

/** The server name in an `mcp add` argv. */
export function serverNameOf(client: ClientId, argv: readonly string[]): string {
  let name: string | undefined;
  if (client === 'claude-code') {
    for (let i = 3; i < argv.length; i++) {
      const token = argv[i]!;
      if (token === '--') break;
      if (CLAUDE_VALUE_OPTIONS.has(token)) {
        i++;
        continue;
      }
      if (token.startsWith('-')) continue;
      name = token;
      break;
    }
  } else {
    name = argv[3];
  }
  if (name === undefined || !SERVER_NAME.test(name)) throw new PlanError(`No valid server name in: ${argv.join(' ')}`);
  return name;
}

/**
 * Claude Code on native Windows: a stdio server that starts with npx needs
 * `cmd /c npx ...` (ECOSYSTEM_GENERAL_NOTES). The added tokens are fixed text.
 */
export function windowsClaudeArgv(argv: readonly string[]): string[] {
  const out = [...argv];
  const dashdash = out.indexOf('--');
  if (dashdash >= 0 && out[dashdash + 1] === 'npx') out.splice(dashdash + 1, 0, 'cmd', '/c');
  return out;
}

export function planClient(row: EcosystemCatalogEntry, client: ClientId, platform: NodeJS.Platform): ClientPlan {
  const install = row.installs?.find((entry) => entry.client === client);
  if (!install) return { kind: 'none', client };
  const { bin } = clientInfo(client);
  const argvs = tokenizeSnippet(install.snippet);
  const adds = argvs.filter((argv) => isAddLine(argv, bin));
  if (adds.length !== 1) throw new PlanError(`The ${row.id} line for ${client} must hold exactly one "${bin} mcp add" command.`);
  for (const argv of argvs) {
    if (argv[0] !== bin) throw new PlanError(`The ${row.id} line for ${client} runs "${argv[0]}", not ${bin}.`);
  }
  let add = adds[0]!;
  const serverName = serverNameOf(client, add);
  const followUps = argvs.filter((argv) => argv !== adds[0]).map((argv) => argv.join(' '));

  const signIn =
    (client === 'hermes' && add.includes('--auth')) ||
    // `codex mcp add --url` starts an OAuth flow at once when the server offers OAuth.
    (client === 'codex-cli' && add.includes('--url') && rowUsesOAuth(row));
  if (signIn) {
    return {
      kind: 'manual',
      client,
      serverName,
      lines: argvs.map((argv) => argv.join(' ')),
      reason: 'This command starts a sign-in, so clawville does not run it. Run it yourself.',
    };
  }
  if (platform === 'win32' && client === 'claude-code') add = windowsClaudeArgv(add);
  return { kind: 'run', client, serverName, add, followUps };
}

export function planRow(row: EcosystemCatalogEntry, clients: readonly ClientId[], platform: NodeJS.Platform): RowPlan {
  if (row.bucket === 'gateway') return { kind: 'gateway', row, tools: gatewayTools(row) };
  return { kind: 'install', row, clients: clients.map((client) => planClient(row, client, platform)) };
}
