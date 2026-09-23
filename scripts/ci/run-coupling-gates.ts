import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const PROTOCOL = 'apps/api/src/services/skill-protocol.ts';
export const REQUIRED_IDS = [
  'gameplay-change-updates-nori-knowledge', 'gameplay-updates-connection-skillmd',
  'action-whitelist-bumps-protocol-version', 'protocol-version-propagates-three-surfaces',
  'protected-partner-surface-updates-spec-and-harness', 'partner-dependency-binds-surface',
  'new-route-table-service-env-updates-architecture', 'env-var-updates-architecture',
  'gameplay-economy-ui-updates-gamefeatures', 'three-d-updates-3dstructure',
  'map-locations-updates-worldcontent', 'phase51-wallet-identity-doc-coupling',
  'wager-program-change-updates-architecture', 'agent-connect-updates-docs',
] as const;
const SELECTORS = ['any', 'architecture', 'new-env', 'executor', 'protocol-version'] as const;
export type Gate = {
  id: string; mechanism: 'coupling'; owner: string; status: 'active';
  trigger: string[]; requires: string[][]; selector: typeof SELECTORS[number];
  assertion?: 'protocol-increase'; escapeHatch?: '[skip-nori-update]';
};
export type Change = { path: string; before: string | null; after: string | null };
export type Result = { errors: string[]; warnings: string[]; triggered: string[] };
const KEYS = new Set(['id', 'mechanism', 'owner', 'status', 'trigger', 'requires', 'selector', 'assertion', 'escapeHatch']);

function pattern(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.*?/-]+$/.test(value) ||
      value.startsWith('/') || value.split('/').some((part) => !part || part === '..' || part === '.') ||
      value.includes('***') || value.split('/').some((part) => part.includes('**') && part !== '**')) {
    throw new Error(`Invalid repository glob: ${String(value)}`);
  }
}

/** JSON frontmatter is a deliberately restricted YAML subset: no tags, aliases, or implicit values. */
export function parseGate(text: string, filename: string): Gate {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${filename}: missing JSON/YAML frontmatter`);
  const value = JSON.parse(match[1]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${filename}: invalid gate object`);
  for (const key of Object.keys(value)) if (!KEYS.has(key)) throw new Error(`${filename}: unknown field ${key}`);
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]+$/.test(value.id) || filename !== `${value.id}.md` ||
      value.mechanism !== 'coupling' || value.status !== 'active' ||
      typeof value.owner !== 'string' || !/^[a-z0-9][a-z0-9-]+$/.test(value.owner) ||
      !SELECTORS.includes(value.selector) || !Array.isArray(value.trigger) || !value.trigger.length ||
      !Array.isArray(value.requires) || !value.requires.length) throw new Error(`${filename}: invalid schema`);
  value.trigger.forEach(pattern);
  for (const group of value.requires) {
    if (!Array.isArray(group) || !group.length) throw new Error(`${filename}: empty requirement group`);
    group.forEach(pattern);
  }
  if (value.assertion !== undefined && value.assertion !== 'protocol-increase') throw new Error(`${filename}: unknown assertion`);
  if (value.escapeHatch !== undefined && (value.id !== REQUIRED_IDS[0] || value.escapeHatch !== '[skip-nori-update]')) {
    throw new Error(`${filename}: unsupported escape`);
  }
  if (value.id === 'action-whitelist-bumps-protocol-version' &&
      (value.assertion !== 'protocol-increase' || value.selector !== 'executor')) throw new Error(`${filename}: missing protocol assertion`);
  return value as Gate;
}

export function loadRegistry(root: string): Gate[] {
  const dir = resolve(root, '.claude/gates/coupling');
  const names = readdirSync(dir).sort();
  if (names.some((name) => !name.endsWith('.md'))) throw new Error('Unknown coupling registry entry');
  const gates = names.map((name) => parseGate(readFileSync(resolve(dir, name), 'utf8'), name));
  for (const id of REQUIRED_IDS) if (!gates.some((gate) => gate.id === id)) throw new Error(`Required coupling gate missing: ${id}`);
  return gates;
}

export function matches(path: string, glob: string): boolean {
  return new Bun.Glob(glob).match(path);
}
export function protocolVersion(source: string | null): number | null {
  const declarations = [...(source ?? '').matchAll(/^export const PROTOCOL_VERSION\s*=\s*([^;\r\n]+);?\s*$/gm)];
  if (declarations.length !== 1 || !/^\d+$/.test(declarations[0][1].trim())) return null;
  const value = Number(declarations[0][1].trim());
  return Number.isSafeInteger(value) ? value : null;
}
function envKeys(source: string | null): Set<string> {
  return new Set([...(source ?? '').matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g)]
    .map((match) => match[1] ?? match[2]));
}
function method(source: string | null, name: string): string | null {
  if (source === null) return null;
  const start = new RegExp(`^  (?:private |public |protected )?(?:async )?${name}\\(`, 'm').exec(source);
  if (!start) return source;
  const tail = source.slice(start.index);
  const end = /\r?\n  }(?:\r?\n|$)/.exec(tail);
  // An unrecognized shape conservatively compares the whole source.
  return end ? tail.slice(0, end.index + end[0].length) : source;
}
function relevant(gate: Gate, change: Change): boolean {
  switch (gate.selector) {
    case 'any': return true;
    case 'architecture':
      return !/^apps\/api\/src\/(routes|services)\//.test(change.path) || change.before === null;
    case 'new-env':
      return change.path === '.env.example' || [...envKeys(change.after)].some((key) => !envKeys(change.before).has(key));
    case 'protocol-version':
      return protocolVersion(change.before) !== protocolVersion(change.after) || protocolVersion(change.after) === null;
    case 'executor':
      if (change.path !== 'apps/api/src/services/npc-simulation.ts') return true;
      return ['executeHatcherAction', 'dispatchHatcherActions'].some((name) =>
        method(change.before, name) !== method(change.after, name));
  }
}

export function evaluate(gates: Gate[], changes: Change[], headMessage = ''): Result {
  const result: Result = { errors: [], warnings: [], triggered: [] };
  const actual = changes.filter((change) => change.before !== change.after);
  const updated = actual.filter((change) => change.after !== null && change.after.trim().length > 0 &&
    // Renaming a byte-identical document does not update its content.
    !(change.before === null && actual.some((old) => old.after === null && old.before === change.after)));
  for (const gate of gates) {
    if (!actual.some((change) => gate.trigger.some((glob) => matches(change.path, glob)) && relevant(gate, change))) continue;
    result.triggered.push(gate.id);
    if (gate.escapeHatch && headMessage.split(/\r?\n/).some((line) => line === gate.escapeHatch)) {
      result.warnings.push(`${gate.id}: explicit ${gate.escapeHatch} in final commit; Nori requirement waived`);
      continue;
    }
    for (const alternatives of gate.requires) {
      if (!updated.some((change) => alternatives.some((glob) => matches(change.path, glob)))) {
        result.errors.push(`${gate.id}: change ${alternatives.join(' OR ')} in the same diff; existing or deleted files do not satisfy this rule`);
      }
    }
    if (gate.assertion === 'protocol-increase') {
      const source = actual.find((change) => change.path === PROTOCOL);
      const before = protocolVersion(source?.before ?? null);
      const after = protocolVersion(source?.after ?? null);
      if (before === null || after === null || after <= before) {
        result.errors.push(`${gate.id}: PROTOCOL_VERSION must be a single literal integer that strictly increases (${before} -> ${after})`);
      }
    }
  }
  return result;
}

export function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed; required commit/history is unavailable`);
  return result.stdout.toString('utf8');
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value) || /^0+$/.test(value)) throw new Error('A nonzero full 40-character commit SHA is required');
  return value;
}
export function eventRange(event: any, eventName: string, head: string, dispatchBase?: string): { base: string; head: string; mergeBase: boolean } {
  if (eventName === 'pull_request') return { base: sha(event.pull_request?.base?.sha), head: sha(event.pull_request?.head?.sha), mergeBase: true };
  if (eventName === 'push') return { base: sha(event.before), head: sha(event.after), mergeBase: false };
  if (eventName === 'workflow_dispatch' || eventName === 'workflow_call') {
    return { base: sha(dispatchBase), head: sha(head), mergeBase: false };
  }
  throw new Error(`Unsupported coupling event: ${eventName}`);
}
export function collectChanges(root: string, base: string, head: string): Change[] {
  const names = git(root, ['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean);
  const contents = (commit: string, path: string): string | null => {
    const exists = git(root, ['ls-tree', '-z', commit, '--', path]);
    if (!exists) return null;
    const result = Bun.spawnSync(['git', '-C', root, 'show', `${commit}:${path}`], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error('Required Git blob is unavailable');
    const decoded = result.stdout.toString('utf8');
    return Buffer.from(decoded, 'utf8').equals(result.stdout) ? decoded
      : `BINARY_SHA256:${createHash('sha256').update(result.stdout).digest('hex')}`;
  };
  return names.map((path) => ({ path, before: contents(base, path), after: contents(head, path) }));
}
export function indexText(gates: Gate[]): string {
  return '# Coupling gate registry\n\nGenerated by `bun .claude/gates/build-index.ts`. Do not edit by hand.\n\n' +
    '| Gate | Owner | Required changes |\n|---|---|---|\n' + gates.map((gate) =>
      `| [${gate.id}](coupling/${gate.id}.md) | ${gate.owner} | ${gate.requires.map((group) => group.join(' OR ')).join(' AND ')} |`).join('\n') + '\n';
}

function main(): void {
  const root = process.cwd();
  const args = process.argv.slice(2);
  let range: { base: string; head: string; mergeBase: boolean };
  if (args.length === 4 && args[0] === '--base' && args[2] === '--head') {
    range = { base: sha(args[1]), head: sha(args[3]), mergeBase: false };
  } else if (args.length === 1 && args[0] === '--github') {
    if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required');
    range = eventRange(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      process.env.GITHUB_EVENT_NAME ?? '', process.env.GITHUB_SHA ?? '', process.env.COUPLING_BASE_SHA);
  } else throw new Error('Use --github or --base <full-sha> --head <full-sha>');
  if (git(root, ['rev-parse', 'HEAD']).trim() !== range.head) throw new Error('Checkout HEAD must equal the evaluated head SHA');
  git(root, ['cat-file', '-e', `${range.base}^{commit}`]);
  if (range.mergeBase) range.base = sha(git(root, ['merge-base', range.base, range.head]).trim());
  if (range.base === range.head) throw new Error('Coupling base must differ from head');
  const gates = loadRegistry(root);
  if (readFileSync(resolve(root, '.claude/gates/INDEX.md'), 'utf8') !== indexText(gates)) throw new Error('Coupling INDEX.md is stale; regenerate it');
  const result = evaluate(gates, collectChanges(root, range.base, range.head), git(root, ['show', '-s', '--format=%B', range.head]));
  console.log(`Coupling range ${range.base}..${range.head}; ${gates.length} rules; ${result.triggered.length} triggered`);
  for (const warning of result.warnings) console.warn(`WARNING ${warning}`);
  for (const error of result.errors) console.error(`FAIL ${error}`);
  if (result.errors.length) process.exitCode = 1;
}
if (import.meta.main) {
  try { main(); } catch (error) { console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
