/**
 * `clawville` commands. Every side effect goes through `CliDeps`, so the tests
 * inject spawn, PATH lookup, prompt, fetch and output.
 */
import { CLIENT_IDS, parseArgs, UsageError, type ClientId, type ParsedArgs } from './args';
import { catalogRows, ECOSYSTEM_GENERAL_NOTES, gatewayTools, isPlannedRow, type EcosystemCatalogEntry } from './catalog';
import { clientInfo, parseCodexListJson, parseHermesList } from './clients';
import { buildSpawnRequest, type SpawnFn, type SpawnResult, type WhichFn } from './exec';
import { planRow, type ClientPlan } from './plan';
import { outputTail, stripControl } from './text';
import { CLI_VERSION } from './version';

export interface CliDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly spawn: SpawnFn;
  readonly which: WhichFn;
  readonly fetch: typeof fetch;
  /** True when stdin and stdout are a terminal. */
  readonly isTTY: boolean;
  /** Ask one question on the terminal; resolves to the typed answer. */
  readonly prompt: (question: string) => Promise<string>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const CLAWVILLE_ID = 'clawville';
const ADD_TIMEOUT_MS = 180_000;
const CHECK_TIMEOUT_MS = 60_000;
const DOCTOR_FETCH_TIMEOUT_MS = 15_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
/**
 * Answers piped to `hermes mcp add`, in its prompt order: "require authentication?"
 * -> n; "Enable all tools? [Y/n/select]" -> Enter (all). If Hermes ever asks
 * "already exists. Overwrite?" first, the "n" answers it: no overwrite.
 */
const HERMES_ADD_ANSWERS = 'n\n\n\n';

export const HELP_TEXT = `clawville ${CLI_VERSION}: add the ClawVille MCP, and other reviewed MCP servers, to the LLM clients on your computer.

Usage:
  clawville                 Add ClawVille to each client found on this computer (asks once).
  clawville list            Show the servers you can add.
  clawville add <id>        Add one server from the list.
  clawville doctor          Check each client and the ClawVille API.
  clawville help            Show this text.
  clawville --version       Show the version.

Options:
  --client <id>   Use one client only: ${CLIENT_IDS.join(', ')}.
  --dry-run       Print the commands. Run nothing.
  --yes, -y       Do not ask before a change.
  --api <url>     The ClawVille API origin (default https://api.clawville.world).

clawville runs only the commands that are bundled in this package. It reads no
secret, makes no key and pays nothing. A sign-in or a setup step is printed for
you to run yourself.`;

type Outcome = 'added' | 'exists' | 'manual' | 'none' | 'failed' | 'missing' | 'not-run';

interface ClientOutcome {
  readonly client: ClientId;
  readonly outcome: Outcome;
  readonly detail: string;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`clawville: ${error.message}`);
      deps.err('Run "clawville help" for usage.');
      return 1;
    }
    throw error;
  }

  try {
    switch (args.command) {
      case 'version':
        deps.out(CLI_VERSION);
        return 0;
      case 'help':
        deps.out(HELP_TEXT);
        return 0;
      case 'list':
        return commandList(args, deps);
      case 'doctor':
        return await commandDoctor(args, deps);
      case 'add':
        return await commandAdd(args, deps);
      case 'install':
        return await commandInstall(args, deps);
    }
  } catch (error) {
    deps.err(`clawville: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// list

function commandList(args: ParsedArgs, deps: CliDeps): number {
  for (const row of catalogRows(args.apiBase)) {
    deps.out(`${row.id}  (${row.name})`);
    deps.out(`  ${row.summary}`);
    if (row.bucket === 'gateway') {
      deps.out(`  No install. Use it through the ClawVille MCP tool ${gatewayTools(row).join(', ')}.`);
    } else {
      deps.out(`  Install: clawville add ${row.id}`);
    }
    deps.out('');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// shared helpers

function chosenClients(args: ParsedArgs): ClientId[] {
  return args.client ? [args.client] : [...CLIENT_IDS];
}

async function runArgv(
  deps: CliDeps,
  argv: readonly string[],
  options: { input?: string; timeoutMs: number },
): Promise<SpawnResult> {
  const resolved = deps.which(argv[0]!);
  if (!resolved) return { code: null, stdout: '', stderr: '', timedOut: false, error: `${argv[0]} is not on PATH` };
  const request = buildSpawnRequest(resolved, argv, {
    platform: deps.platform,
    env: deps.env,
    cwd: deps.cwd,
    timeoutMs: options.timeoutMs,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  return deps.spawn(request);
}

function printFailureOutput(deps: CliDeps, label: string, result: SpawnResult): void {
  if (result.error) deps.err(`  ${result.error}`);
  if (result.timedOut) deps.err('  The command took too long and was stopped.');
  const tail = outputTail(`${result.stdout}\n${result.stderr}`);
  if (tail.length > 0) {
    deps.err(`  Output from ${label}:`);
    for (const line of tail) deps.err(`    ${line}`);
  }
}

/** null = the check failed (cannot tell). */
async function serverExists(deps: CliDeps, client: ClientId, name: string): Promise<{ exists: boolean | null; result?: SpawnResult }> {
  if (client === 'codex-cli') {
    const result = await runArgv(deps, ['codex', 'mcp', 'get', name, '--json'], { timeoutMs: CHECK_TIMEOUT_MS });
    if (result.code === 0) return { exists: true };
    if (result.code !== null && /No MCP server named/i.test(stripControl(result.stderr + result.stdout))) return { exists: false };
    return { exists: null, result };
  }
  if (client === 'hermes') {
    const result = await runArgv(deps, ['hermes', 'mcp', 'list'], { timeoutMs: CHECK_TIMEOUT_MS });
    if (result.code !== 0) return { exists: null, result };
    return { exists: parseHermesList(result.stdout).includes(name) };
  }
  // Claude Code: `claude mcp add` itself refuses a name that exists in the same scope.
  // (`claude mcp get` would health-check, and so start, a stdio server.)
  return { exists: false };
}

async function runClientPlan(deps: CliDeps, plan: Extract<ClientPlan, { kind: 'run' }>): Promise<ClientOutcome> {
  const { label } = clientInfo(plan.client);
  const name = plan.serverName;
  const before = await serverExists(deps, plan.client, name);
  if (before.exists === null) {
    deps.err(`${label}: could not check for an existing "${name}" entry, so nothing changed.`);
    if (before.result) printFailureOutput(deps, label, before.result);
    return { client: plan.client, outcome: 'failed', detail: 'the check for an existing entry failed' };
  }
  if (before.exists) return { client: plan.client, outcome: 'exists', detail: `"${name}" already exists; not changed` };

  const result = await runArgv(deps, plan.add, {
    timeoutMs: ADD_TIMEOUT_MS,
    ...(plan.client === 'hermes' ? { input: HERMES_ADD_ANSWERS } : {}),
  });
  const text = stripControl(`${result.stdout}\n${result.stderr}`);

  if (plan.client === 'claude-code') {
    if (result.code === 0) return { client: plan.client, outcome: 'added', detail: `added "${name}"` };
    if (/already exists/i.test(text)) return { client: plan.client, outcome: 'exists', detail: `"${name}" already exists; not changed` };
  } else {
    const after = await serverExists(deps, plan.client, name);
    if (result.code === 0 && after.exists === true) return { client: plan.client, outcome: 'added', detail: `added "${name}"` };
  }
  printFailureOutput(deps, label, result);
  return { client: plan.client, outcome: 'failed', detail: result.timedOut ? 'timed out' : `"${name}" was not added (exit ${result.code ?? 'none'})` };
}

function printRowNotes(deps: CliDeps, row: EcosystemCatalogEntry, followUps: readonly string[]): void {
  deps.out('');
  deps.out(`About ${row.name} (reviewed ClawVille text):`);
  deps.out(`  Sign-in: ${row.auth}`);
  for (const note of row.notes ?? []) deps.out(`  - ${note}`);
  if (row.cli) {
    deps.out('  Its command-line tool (clawville does not run these):');
    for (const line of row.cli.split('\n')) deps.out(`    ${line}`);
  }
  if (followUps.length > 0) {
    deps.out('  Next step (clawville does not run it, because it signs in or sets up):');
    for (const line of followUps) deps.out(`    ${line}`);
  }
  if (row.id !== CLAWVILLE_ID) {
    for (const note of ECOSYSTEM_GENERAL_NOTES.slice(1)) deps.out(`  - ${note}`);
  }
}

/** Plan, print, confirm, run. Shared by the default command and `add`. */
async function installRow(
  args: ParsedArgs,
  deps: CliDeps,
  row: EcosystemCatalogEntry,
  clients: readonly ClientId[],
  missing: readonly ClientId[],
): Promise<number> {
  const plan = planRow(row, clients, deps.platform);
  if (plan.kind === 'gateway') {
    deps.out(`${row.name} needs no install. ClawVille calls it for your agent.`);
    deps.out(`Use the ClawVille MCP tool ${plan.tools.join(', ')} (add ClawVille first: clawville add clawville).`);
    deps.out(`Sign-in: ${row.auth}`);
    for (const note of row.notes ?? []) deps.out(`  - ${note}`);
    return 0;
  }

  const runnable = plan.clients.filter((entry): entry is Extract<ClientPlan, { kind: 'run' }> => entry.kind === 'run');
  deps.out(`Add ${row.name}:`);
  for (const entry of plan.clients) {
    const { label } = clientInfo(entry.client);
    if (entry.kind === 'run') {
      deps.out(`  ${label}: ${entry.add.join(' ')}`);
    } else if (entry.kind === 'manual') {
      deps.out(`  ${label}: ${entry.reason}`);
      for (const line of entry.lines) deps.out(`    ${line}`);
    } else {
      deps.out(`  ${label}: no install line for this client.`);
    }
  }
  const followUps = [...new Set(runnable.flatMap((entry) => entry.followUps))];

  const outcomes: ClientOutcome[] = [];
  for (const client of missing) outcomes.push({ client, outcome: 'missing', detail: `${clientInfo(client).bin} is not on PATH` });
  for (const entry of plan.clients) {
    if (entry.kind === 'manual') outcomes.push({ client: entry.client, outcome: 'manual', detail: 'run the printed command yourself' });
    if (entry.kind === 'none') outcomes.push({ client: entry.client, outcome: 'none', detail: 'no install line for this client' });
  }

  let proceed = runnable.length > 0;
  if (proceed && args.dryRun) {
    deps.out('');
    deps.out('Dry run: nothing ran.');
    proceed = false;
  } else if (proceed && !args.yes && !deps.isTTY) {
    deps.out('');
    deps.out('Not a terminal, so nothing changed. Run the commands above yourself, or run again with --yes.');
    proceed = false;
  } else if (proceed && !args.yes) {
    const labels = runnable.map((entry) => clientInfo(entry.client).label).join(', ');
    const answer = (await deps.prompt(`Add ${row.name} to ${labels}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      deps.out('Cancelled. Nothing changed.');
      proceed = false;
    }
  }

  if (proceed) {
    for (const entry of runnable) outcomes.push(await runClientPlan(deps, entry));
  } else {
    for (const entry of runnable) outcomes.push({ client: entry.client, outcome: 'not-run', detail: 'nothing ran' });
  }

  printRowNotes(deps, row, followUps);
  deps.out('');
  for (const client of CLIENT_IDS) {
    const outcome = outcomes.find((entry) => entry.client === client);
    if (outcome) deps.out(`${clientInfo(client).label}: ${outcome.outcome} (${outcome.detail})`);
  }
  return outcomes.some((entry) => entry.outcome === 'failed' || entry.outcome === 'missing') ? 1 : 0;
}

function detectClients(args: ParsedArgs, deps: CliDeps): { found: ClientId[]; missing: ClientId[] } {
  const found: ClientId[] = [];
  const missing: ClientId[] = [];
  for (const client of chosenClients(args)) (deps.which(clientInfo(client).bin) ? found : missing).push(client);
  return { found, missing };
}

// ---------------------------------------------------------------------------
// default command and add

async function commandInstall(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const { found, missing } = detectClients(args, deps);
  deps.out('Clients on this computer:');
  for (const client of chosenClients(args)) {
    const { label, bin } = clientInfo(client);
    deps.out(`  ${label}: ${found.includes(client) ? 'found' : `not found (${bin} is not on PATH)`}`);
  }
  deps.out('');
  const row = catalogRows(args.apiBase).find((entry) => entry.id === CLAWVILLE_ID)!;
  if (found.length === 0) {
    deps.err('No supported client found. For another MCP client, add this block to its config:');
    deps.err(`  ${row.installs?.find((install) => install.client === 'generic-json')?.snippet ?? ''}`);
    return 1;
  }
  // Without --client, a client that is not installed is not a failure.
  return installRow(args, deps, row, found, args.client ? missing : []);
}

async function commandAdd(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const id = args.rowId!;
  const row = catalogRows(args.apiBase).find((entry) => entry.id === id);
  if (!row) {
    deps.err(isPlannedRow(id) ? `"${id}" is not available yet.` : `Unknown id "${id.slice(0, 40)}". Run "clawville list".`);
    return 1;
  }
  if (row.bucket === 'gateway') return installRow(args, deps, row, [], []);
  const { found, missing } = detectClients(args, deps);
  if (found.length === 0) {
    deps.err(args.client ? `${clientInfo(args.client).bin} is not on PATH.` : 'No supported client found (claude, codex or hermes on PATH).');
    return 1;
  }
  return installRow(args, deps, row, found, args.client ? missing : []);
}

// ---------------------------------------------------------------------------
// doctor

async function clawvilleListed(deps: CliDeps, client: ClientId): Promise<{ listed: boolean | null; result?: SpawnResult }> {
  if (client === 'claude-code') {
    // `claude mcp list` health-checks (starts) every configured stdio server; `get` checks only this one.
    const result = await runArgv(deps, ['claude', 'mcp', 'get', CLAWVILLE_ID], { timeoutMs: CHECK_TIMEOUT_MS });
    if (result.code === 0) return { listed: true };
    if (result.code !== null && /not found|No MCP server/i.test(stripControl(result.stdout + result.stderr))) return { listed: false };
    return { listed: null, result };
  }
  if (client === 'codex-cli') {
    const result = await runArgv(deps, ['codex', 'mcp', 'list', '--json'], { timeoutMs: CHECK_TIMEOUT_MS });
    const names = result.code === 0 ? parseCodexListJson(result.stdout) : null;
    return names === null ? { listed: null, result } : { listed: names.includes(CLAWVILLE_ID) };
  }
  const result = await runArgv(deps, ['hermes', 'mcp', 'list'], { timeoutMs: CHECK_TIMEOUT_MS });
  return result.code === 0 ? { listed: parseHermesList(result.stdout).includes(CLAWVILLE_ID) } : { listed: null, result };
}

function shortText(value: unknown): string {
  return typeof value === 'string' ? stripControl(value).replace(/\s+/g, ' ').slice(0, 80) : '?';
}

/** Parse a JSON-RPC answer from a JSON body or a text/event-stream body. */
export function parseMcpBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim());
  }
  throw new Error('no JSON in the answer');
}

async function commandDoctor(args: ParsedArgs, deps: CliDeps): Promise<number> {
  let ok = true;
  for (const client of chosenClients(args)) {
    const { label, bin } = clientInfo(client);
    const path = deps.which(bin);
    if (!path) {
      deps.out(`${label}: not found (${bin} is not on PATH)`);
      if (args.client) ok = false;
      continue;
    }
    const listed = await clawvilleListed(deps, client);
    if (listed.listed === null) {
      ok = false;
      deps.out(`${label}: found at ${path}; its MCP list command failed`);
      if (listed.result) printFailureOutput(deps, label, listed.result);
    } else {
      deps.out(`${label}: found at ${path}; clawville ${listed.listed ? 'is' : 'is not'} in its MCP list`);
    }
  }

  const url = `${args.apiBase}/api/agent/mcp`;
  deps.out('');
  deps.out(`MCP initialize: POST ${url}`);
  try {
    const response = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'clawville-cli', version: CLI_VERSION } },
      }),
      signal: AbortSignal.timeout(DOCTOR_FETCH_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      deps.out(`  failed: HTTP ${response.status}`);
      return 1;
    }
    const parsed = parseMcpBody(body) as { result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } }; error?: { message?: unknown } };
    if (!parsed.result) {
      deps.out(`  failed: ${shortText(parsed.error?.message)}`);
      return 1;
    }
    deps.out(`  ok: HTTP ${response.status}, server ${shortText(parsed.result.serverInfo?.name)} ${shortText(parsed.result.serverInfo?.version)}, protocol ${shortText(parsed.result.protocolVersion)}`);
  } catch (error) {
    deps.out(`  failed: ${error instanceof Error ? shortText(error.message) : 'request error'}`);
    return 1;
  }
  return ok ? 0 : 1;
}
