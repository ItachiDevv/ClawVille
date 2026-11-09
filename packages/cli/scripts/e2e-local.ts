/**
 * Local end-to-end test of the built `clawville` bundle against the REAL
 * claude, codex and hermes CLIs on this computer. Not run in CI.
 *
 *   cd packages/cli && bun run build && bun scripts/e2e-local.ts
 *
 * Safety:
 * - Each client runs with a TEMP config folder only (CLAUDE_CONFIG_DIR,
 *   CODEX_HOME, HERMES_HOME). Before any add, the script runs the client's list
 *   command against the temp folder and checks that the real config files keep
 *   the same mtime and hash. A client that fails this check is skipped.
 * - The real config files are checked again at the end.
 * - Only the ClawVille row is added (no sign-in, no key, no payment), against
 *   the API given by E2E_API (default staging).
 * - The temp folder is deleted at the end (links inside it are never followed).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ClientId } from '../src/args';
import { CLIENTS, parseCodexListJson, parseHermesList, type ClientInfo } from '../src/clients';
import { buildSpawnRequest, makeWhich, realSpawn, type SpawnResult } from '../src/exec';
import { stripControl } from '../src/text';

const API = process.env.E2E_API ?? 'https://api-staging.clawville.world';
const MCP_URL = `${API}/api/agent/mcp`;
const BUNDLE = resolve(import.meta.dir, '..', 'dist', 'clawville.js');
const PACKAGE_DIR = resolve(import.meta.dir, '..');
const TIMEOUT_MS = 300_000;

const env = process.env as Record<string, string | undefined>;
const which = makeWhich(process.platform, env);

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Real config files per client.

function realConfigFiles(client: ClientInfo): string[] {
  const home = homedir();
  const override = env[client.configEnv];
  switch (client.id) {
    case 'claude-code': {
      const dir = override ?? join(home, '.claude');
      // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside it; check the home copy too.
      const files = [join(home, '.claude.json'), join(dir, 'settings.json')];
      if (override) files.unshift(join(override, '.claude.json'));
      return files;
    }
    case 'codex-cli':
      return [join(override ?? join(home, '.codex'), 'config.toml')];
    case 'hermes': {
      const base = override ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'hermes') : join(home, '.hermes'));
      return [join(base, 'config.yaml')];
    }
  }
}

interface Snapshot {
  readonly exists: boolean;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly urlCount: number;
}

function snapshot(path: string): Snapshot {
  if (!existsSync(path)) return { exists: false, mtimeMs: 0, sha256: '', urlCount: 0 };
  const data = readFileSync(path);
  return {
    exists: true,
    mtimeMs: statSync(path).mtimeMs,
    sha256: createHash('sha256').update(data).digest('hex'),
    urlCount: data.toString('utf8').split(MCP_URL).length - 1,
  };
}

/** Compare real files. A file this live session also writes (~/.claude.json) may move; then the staging URL count must not. */
function compare(label: string, files: readonly string[], before: readonly Snapshot[]): boolean {
  let ok = true;
  files.forEach((file, i) => {
    const now = snapshot(file);
    const was = before[i]!;
    if (now.exists === was.exists && now.mtimeMs === was.mtimeMs && now.sha256 === was.sha256) {
      log(`    [isolation] ${label}: ${file} unchanged (sha256 ${now.sha256.slice(0, 12) || 'absent'}, mtime ${now.mtimeMs})`);
    } else if (now.urlCount === was.urlCount) {
      log(`    [isolation] ${label}: ${file} CHANGED by another process (hash ${was.sha256.slice(0, 12)} -> ${now.sha256.slice(0, 12)}), but holds the test URL ${now.urlCount} time(s), as before`);
    } else {
      log(`    [isolation] ${label}: ${file} CHANGED and its test URL count moved ${was.urlCount} -> ${now.urlCount}: NOT ISOLATED`);
      ok = false;
    }
  });
  return ok;
}

// ---------------------------------------------------------------------------
// Process helpers (no shell; the same spawn path as the CLI).

async function run(argv: readonly string[], runEnv: Record<string, string | undefined>, cwd: string, input?: string): Promise<SpawnResult> {
  const resolved = which(argv[0]!);
  if (!resolved) return { code: null, stdout: '', stderr: '', timedOut: false, error: `${argv[0]} not on PATH` };
  if (argv[0] === 'node') {
    return realSpawn({ file: resolved, args: argv.slice(1), cwd, env: runEnv, timeoutMs: TIMEOUT_MS, ...(input !== undefined ? { input } : {}) });
  }
  return realSpawn(buildSpawnRequest(resolved, argv, { platform: process.platform, env: runEnv, cwd, timeoutMs: TIMEOUT_MS, ...(input !== undefined ? { input } : {}) }));
}

function show(result: SpawnResult, indent = '      '): void {
  const text = stripControl(`${result.stdout}\n${result.stderr}`)
    .split('\n')
    .filter((line) => line.trim().length > 0 && !/RequestsDependencyWarning|warnings\.warn|PATH aliases/.test(line));
  for (const line of text) log(`${indent}${line}`);
  log(`${indent}(exit ${result.code ?? 'none'}${result.timedOut ? ', timed out' : ''}${result.error ? `, ${result.error}` : ''})`);
}

/** The server names in the client's own list. */
async function listNames(client: ClientId, runEnv: Record<string, string | undefined>, cwd: string): Promise<string[] | null> {
  if (client === 'claude-code') {
    const result = await run(['claude', 'mcp', 'list'], runEnv, cwd);
    if (result.code !== 0) return null;
    if (/No MCP servers configured/.test(result.stdout)) return [];
    return stripControl(result.stdout)
      .split('\n')
      .map((line) => /^([A-Za-z0-9_-]+): /.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
  }
  if (client === 'codex-cli') {
    const result = await run(['codex', 'mcp', 'list', '--json'], runEnv, cwd);
    if (result.code !== 0) return null;
    if (/No MCP servers configured/.test(result.stdout)) return [];
    return parseCodexListJson(result.stdout);
  }
  const result = await run(['hermes', 'mcp', 'list'], runEnv, cwd);
  return result.code === 0 ? parseHermesList(result.stdout) : null;
}

async function apiOffersOAuth(): Promise<boolean> {
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/agent/mcp']) {
    const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) });
    log(`    OAuth discovery ${path}: HTTP ${response.status}`);
    if (response.status !== 404) return true;
  }
  return false;
}

/** Delete our temp root. Refuse when anything inside is a link (never follow one). */
function cleanup(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        log(`Temp folder kept: it holds a link (${path}). Delete it by hand: ${root}`);
        return;
      }
      if (stat.isDirectory()) stack.push(path);
    }
  }
  rmSync(root, { recursive: true, force: true });
  log(`Temp folder deleted: ${root}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  if (!existsSync(BUNDLE)) {
    log(`No bundle at ${BUNDLE}. Run "bun run build" first.`);
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), 'clawville-cli-e2e-'));
  log(`API: ${API}`);
  log(`Temp root: ${root}`);
  const results: string[] = [];
  let failed = false;

  try {
    for (const client of CLIENTS) {
      log('');
      log(`== ${client.label} (${client.id})`);
      if (!which(client.bin)) {
        results.push(`${client.id}: SKIPPED (${client.bin} not on PATH)`);
        continue;
      }
      const configDir = join(root, client.id);
      const cwd = join(root, `${client.id}-cwd`);
      mkdirSync(configDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const runEnv = { ...env, [client.configEnv]: configDir };
      const files = realConfigFiles(client);
      const before = files.map(snapshot);

      // 1. Isolation proof BEFORE any add: the list runs against the temp folder only.
      log(`  1. isolation check: ${client.bin} list with ${client.configEnv}=${configDir}`);
      const empty = await listNames(client.id, runEnv, cwd);
      const tempUsed = readdirSync(configDir).length > 0;
      // `codex mcp list` writes nothing; then the proof is that the real list (read-only, no
      // health check) is not empty while the temp list is. Claude's real list is not run:
      // it health-checks, and so starts, every real stdio server.
      const realNames = client.id === 'codex-cli' && !tempUsed ? await listNames(client.id, env, cwd) : null;
      const overrideSeen = tempUsed || (realNames !== null && realNames.length > 0);
      log(`    temp list: ${empty === null ? 'FAILED' : JSON.stringify(empty)}; temp folder written: ${tempUsed}${realNames ? `; real list has ${realNames.length} server(s)` : ''}`);
      const isolated = empty !== null && empty.length === 0 && overrideSeen && compare(client.id, files, before);
      if (!isolated) {
        results.push(`${client.id}: SKIPPED (could not prove isolation)`);
        failed = true;
        continue;
      }

      // `codex mcp add --url` starts an OAuth login when the server offers OAuth. Never start one here.
      if (client.id === 'codex-cli' && (await apiOffersOAuth())) {
        results.push(`${client.id}: SKIPPED (the API offers OAuth discovery; codex add would start a login)`);
        continue;
      }

      const cli = (...args: string[]) => run(['node', BUNDLE, ...args], runEnv, cwd);

      // 2. Dry run and non-terminal without --yes change nothing.
      log('  2. --dry-run, then no --yes (stdin is a pipe, so not a terminal)');
      const dry = await cli('add', 'clawville', '--client', client.id, '--api', API, '--dry-run');
      const noYes = await cli('add', 'clawville', '--client', client.id, '--api', API);
      const afterDry = await listNames(client.id, runEnv, cwd);
      log(`    dry-run exit ${dry.code}, no-yes exit ${noYes.code}, list after: ${JSON.stringify(afterDry)}`);
      const dryOk = dry.code === 0 && noYes.code === 0 && /Dry run: nothing ran/.test(dry.stdout) && /Not a terminal/.test(noYes.stdout) && afterDry?.length === 0;

      // 3. Add with --yes.
      log(`  3. clawville add clawville --client ${client.id} --api ${API} --yes`);
      const first = await cli('add', 'clawville', '--client', client.id, '--api', API, '--yes');
      show(first);
      const afterAdd = await listNames(client.id, runEnv, cwd);
      log(`    ${client.bin} list after add: ${JSON.stringify(afterAdd)}`);
      const added = first.code === 0 && afterAdd?.includes('clawville') === true;

      // 4. Second run: no overwrite.
      log('  4. second run (must report exists and change nothing)');
      const second = await cli('add', 'clawville', '--client', client.id, '--api', API, '--yes');
      show(second);
      const afterSecond = await listNames(client.id, runEnv, cwd);
      const noOverwrite = second.code === 0 && /: exists \(/.test(second.stdout) && JSON.stringify(afterSecond) === JSON.stringify(afterAdd);

      // 5. doctor for this client.
      log(`  5. clawville doctor --client ${client.id} --api ${API}`);
      const doctor = await cli('doctor', '--client', client.id, '--api', API);
      show(doctor);

      // 6. Real files again.
      log('  6. real config files after the run');
      const stillIsolated = compare(client.id, files, before);

      const verdict = [
        `isolation=${stillIsolated ? 'proved' : 'BROKEN'}`,
        `dry-run+no-yes=${dryOk ? 'nothing changed' : 'FAIL'}`,
        `add=${added ? 'added' : 'FAIL'}`,
        `second-run=${noOverwrite ? 'exists, not overwritten' : added ? 'FAIL' : 'n/a'}`,
        `doctor=exit ${doctor.code}`,
      ].join(' ');
      results.push(`${client.id}: ${verdict}`);
      if (!stillIsolated || !dryOk || !added || !noOverwrite || doctor.code !== 0) failed = true;
    }

    // Bundle under plain node, and the npm file list.
    log('');
    log('== bundle under plain node');
    const head = readFileSync(BUNDLE, 'utf8').split('\n')[0];
    log(`  first line: ${head}`);
    const version = await run(['node', BUNDLE, '--version'], env, PACKAGE_DIR);
    log(`  node ${BUNDLE} --version -> ${version.stdout.trim()} (exit ${version.code})`);

    log('');
    log('== npm pack --dry-run');
    const pack = await run(['npm', 'pack', '--dry-run'], env, PACKAGE_DIR);
    show(pack, '  ');
  } finally {
    log('');
    for (const line of results) log(`RESULT ${line}`);
    cleanup(root);
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log(`e2e error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
