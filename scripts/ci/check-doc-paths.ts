import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCS = [
  'ARCHITECTURE.md', 'GameFeatures.md', '3dStructure.md', 'WorldContent.md',
  'CONTRIBUTING.md', 'docs/DEPLOY-HETZNER.md', 'branding/BRAND.md',
  'docs/hatcher-integration-spec.md',
] as const;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE = resolve(ROOT, 'scripts/ci/doc-paths-baseline.txt');
const PREFIX = /^(?:apps|packages|scripts|docs|branding|contracts|ops)\/|^\.github\//;
const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;
// Docs outside the repo root also write paths relative to their own folder.
export const LOCAL_PREFIXES: Record<string, readonly string[]> = {
  'branding/BRAND.md': ['assets', 'graphics', 'scripts'],
};

export function extractPaths(source: string, localPrefixes: readonly string[] = []): Set<string> {
  const paths = new Set<string>();
  for (const match of source.matchAll(/`([^`\r\n]+)`/g)) {
    let path = match[1];
    const local = localPrefixes.some((prefix) => path.startsWith(`${prefix}/`));
    if ((!PREFIX.test(path) && !local) || /[\s*{}<>$]|\.\.\./.test(path)) continue;
    // Remove suffixes repeatedly so combinations such as file.ts:12#section also work.
    for (;;) {
      const stripped = path.replace(/(?:\?[^?#]*|#[^?#]*|::[A-Za-z_$][\w$]*|:\d+)$/, '');
      if (stripped === path) break;
      path = stripped;
    }
    if ((path.endsWith('/') || FILE_EXTENSION.test(path)) && !path.split('/').includes('..')) {
      paths.add(path);
    }
  }
  return paths;
}

export function diffBaseline(
  references: ReadonlySet<string>, missing: ReadonlySet<string>, baseline: ReadonlySet<string>,
): { added: string[]; stale: string[] } {
  return {
    added: [...missing].filter((entry) => !baseline.has(entry)).sort(),
    stale: [...baseline].filter((entry) => !references.has(entry) || !missing.has(entry)).sort(),
  };
}

function trackedPaths(root: string): Set<string> {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  return new Set(result.stdout.toString().split('\0').filter(Boolean));
}

function run(): void {
  const tracked = trackedPaths(ROOT);
  const trackedDirectories = new Set<string>();
  for (const file of tracked) {
    let slash = file.indexOf('/');
    while (slash !== -1) {
      trackedDirectories.add(file.slice(0, slash));
      slash = file.indexOf('/', slash + 1);
    }
  }
  const references = new Set<string>();
  const missing = new Set<string>();
  for (const doc of DOCS) {
    if (!existsSync(resolve(ROOT, doc))) continue;
    const docDir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/') + 1) : '';
    const exists = (path: string) => tracked.has(path) || trackedDirectories.has(path.replace(/\/$/, ''));
    for (const path of extractPaths(readFileSync(resolve(ROOT, doc), 'utf8'), LOCAL_PREFIXES[doc] ?? [])) {
      const entry = `${doc}\t${path}`;
      references.add(entry);
      if (!exists(path) && !(docDir && exists(docDir + path))) {
        missing.add(entry);
      }
    }
  }
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE, [...missing].sort().join('\n') + (missing.size ? '\n' : ''));
    console.log(`Wrote ${missing.size} missing references to ${BASELINE}`);
    return;
  }
  const baseline = new Set(existsSync(BASELINE) ? readFileSync(BASELINE, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  const { added, stale } = diffBaseline(references, missing, baseline);
  for (const entry of stale) console.log(`Stale baseline: ${entry}`);
  for (const entry of added) console.error(`Missing doc path: ${entry}`);
  if (added.length) {
    console.error('fix the reference, or if the text is deliberate history mark it and run --write-baseline');
    process.exitCode = 1;
  }
  if (stale.length) {
    console.error('baseline has repaired or removed entries: run --write-baseline so it shrinks');
    process.exitCode = 1;
  }
  if (!added.length && !stale.length) {
    console.log(`Doc path check passed (${references.size} references, ${baseline.size} baseline entries).`);
  }
}

if (import.meta.main) run();
