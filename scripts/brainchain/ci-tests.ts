import { bootstrapBrainchainFixture, restoreBrainchainFixtureWrappers } from '../../apps/api/src/services/brainchain/test-fixtures/bootstrap';
import { parseSuiteResult } from './ci-results';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { getBrainchainFixtureSettings } from '../../apps/api/src/services/brainchain/test-fixtures/database';

const root = resolve(import.meta.dir, '../..');
const service = 'apps/api/src/services/brainchain/';
const pg = ['bindings-db.test.ts', 'tasks-db.test.ts', 'signer-db.test.ts', 'signer-capture-db.test.ts',
  'inference-budget-db.test.ts', 'execution-db.test.ts', 'inference-proxy-db.test.ts', 'task-delivery-db.test.ts',
  'delivery-recovery.test.ts', 'worker-coordinator.test.ts', 'result-signing-pool.test.ts', 'root-compute-store.test.ts',
  'worker-owner-policy.test.ts', 'signer-receipts-db.test.ts', 'worker-scheduler.test.ts', 'worker-scheduler-flow.test.ts',
  'exact-result-recovery-consent.test.ts', 'purchases.test.ts', 'purchase-solana.test.ts', 'exact-capture-recovery.test.ts', 'funding-exit-operations.test.ts', 'configured-authority-db.test.ts', 'probe-embedding-budget.test.ts', 'probe-bootstrap.test.ts'];
const protectedFiles = ['signer-linux-fixture.test.ts', 'signer-payload-store.test.ts', 'root-compute-store.test.ts', 'paid-trial.test.ts'];
export const image = 'oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4';
const bundleDirectory = resolve(root, '.brainchain-work/ci-linux-bundles');
const bundleNames = [...protectedFiles, 'signer-policy.ts'].map(name => name.replace(/\.ts$/, '.js'));
const mode = process.argv[2];
if (!['pure', 'postgres', 'prepare-linux', 'linux'].includes(mode ?? '')) throw Error('Choose the required pure, postgres, prepare-linux, or linux lane');
const results: { file: string; passed: number; skipped: number }[] = [];

async function run(command: string[], cwd = root, label = command.join(' ')) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) { process.stdout.write(out); process.stderr.write(err); throw Error(`BrainChain CI failed: ${label}`); }
  return out + err;
}
async function suite(file: string, args: string[] = [], command?: string[]) {
  const web = file.startsWith('apps/web/');
  const output = await run(command ?? [process.execPath, 'test', web ? './' + file.slice('apps/web/'.length) : './' + file, ...args],
    web && !command ? resolve(root, 'apps/web') : root, file);
  const splitDockerSuite = file === service + 'isolated-process-coordinator.test.ts';
  const { passed, skipped } = parseSuiteResult(output, mode === 'postgres' || (mode === 'pure' && !splitDockerSuite));
  if (mode === 'pure' && splitDockerSuite && skipped !== 1) throw Error('Review the separate Docker fixture inventory');
  results.push({ file, passed, skipped });
  console.log(JSON.stringify(results.at(-1)));
}
async function files(pattern: string) { return [...new Bun.Glob(pattern).scanSync({ cwd: root })].map(file => file.replaceAll('\\', '/')).sort(); }

await mkdir(resolve(root, '.brainchain-work'), { recursive: true });
await writeFile(resolve(root, `.brainchain-work/ci-${mode}-results.json`), JSON.stringify({ mode, status: 'running', results: [] }));

if (mode === 'pure') {
  if (process.env.DATABASE_URL || process.env.BRAINCHAIN_DB_FIXTURE || process.env.BRAINCHAIN_DOCKER_FIXTURE) throw Error('Pure lane requires database and Docker fixture environment unset');
  const candidates = await files(`${service}**/*.test.ts`);
  for (const file of candidates) {
    const name = file.slice(service.length), source = await readFile(resolve(root, file), 'utf8');
    if ((source.includes('BRAINCHAIN_DB_FIXTURE') || source.includes('getBrainchainFixtureSettings')) && !pg.includes(name) && name !== 'test-fixtures/database.test.ts') throw Error(`Unclassified database fixture: ${file}`);
  }
  for (const file of candidates) {
    const name = file.slice(service.length);
    if (!pg.includes(name) && !protectedFiles.includes(name)) await suite(file);
  }
  for (const pattern of ['apps/api/src/routes/brainchain*.test.ts', 'apps/api/src/services/__tests__/brainchain*.test.ts',
    'apps/web/src/components/brainchain/*.test.{ts,tsx}', 'apps/web/src/lib/brainchain*.test.ts', 'apps/web/src/lib/{three,pixi}/brainchain*.test.ts',
    'packages/shared/src/constants/brainchain*.test.ts', 'packages/agent-runtime/src/isolated-task/**/*.test.ts']) {
    for (const file of await files(pattern)) await suite(file);
  }
  await suite('apps/api/src/services/__tests__/agent-mcp-tools.test.ts');
  for (const file of ['apps/api/src/middleware/__tests__/require-auth-or-agent-owner-proof.test.ts',
    'apps/api/src/middleware/__tests__/require-auth-or-agent-ttl-slide.test.ts',
    'apps/api/src/routes/__tests__/agent-gateway-owner-proof-reads.test.ts',
    'apps/api/src/routes/__tests__/agent-gateway-hydra-chat.test.ts']) await suite(file);
  for (const file of ['apps/api/src/routes/__tests__/agent-paid-surface.test.ts',
    'apps/api/src/services/__tests__/skill-protocol-onboarding.test.ts',
    'apps/api/src/services/__tests__/floor-arena-knowledge.test.ts',
    'apps/api/src/services/__tests__/trading-floor-constants.test.ts']) await suite(file);
  await suite('scripts/brainchain/ci-results.test.ts');
  await suite('apps/api/scripts/brainchain/runtime-evidence.test.ts');
  await suite('apps/api/scripts/agent-connect/hosted-skill-runtime-probe.test.ts');
  await suite('packages/agent-runtime/src/probe-runtime.test.ts');
} else if (mode === 'postgres') {
  await getBrainchainFixtureSettings(); // Refuse disabled or ambiguous targets before any suite can silently skip.
  if (process.env.BRAINCHAIN_DOCKER_FIXTURE !== '1') throw Error('Postgres lane requires the actual isolated Docker exchange');
  await mkdir(resolve(root, '.brainchain-work'), { recursive: true });
  await run([process.execPath, 'build', '--target=bun', 'packages/agent-runtime/src/isolated-task/process-entry.ts', '--outfile=.brainchain-work/isolated-task-parent-worker.js']);
  await bootstrapBrainchainFixture();
  for (const name of pg) {
    try { await suite(service + name, name === 'root-compute-store.test.ts' ? ['--test-name-pattern', 'actual PostgreSQL reconciliation'] : name === 'funding-exit-operations.test.ts' ? ['--timeout', '15000'] : []); }
    finally { await restoreBrainchainFixtureWrappers(); }
  }
  try { await suite('apps/api/scripts/brainchain/probe-runtime-cleanup.test.ts'); }
  finally { await restoreBrainchainFixtureWrappers(); }
  await suite(service + 'isolated-process-coordinator.test.ts');
} else if (mode === 'prepare-linux') {
  const outputDirectory = bundleDirectory;
  const manifest: Record<string, string> = {};
  await mkdir(outputDirectory, { recursive: true });
  for (const name of [...protectedFiles, 'signer-policy.ts']) {
    const policy = name === 'signer-policy.ts';
    const built = await Bun.build({ entrypoints: [resolve(root, service + name)], target: 'bun', env: 'disable', external: ['bun:test'],
      plugins: policy ? [] : [{ name: 'preserve-policy-mock-boundary', setup(build) {
        build.onResolve({ filter: /\/signer-policy$/ }, () => ({ path: './signer-policy.js', external: true }));
      } }] });
    if (!built.success) throw Error(built.logs.join('\n'));
    const content = (await built.outputs[0]!.text()).replaceAll('"./signer-policy"', '"./signer-policy.js"');
    for (const dependency of new Bun.Transpiler({ loader: 'js' }).scanImports(content)) {
      if (!isBuiltin(dependency.path) && !['bun:test', './signer-policy.js'].includes(dependency.path)) throw Error('Non-fixture bundle dependency refused');
    }
    const outputName = name.replace(/\.ts$/, '.js');
    await writeFile(resolve(outputDirectory, outputName), content);
    manifest[outputName] = createHash('sha256').update(content).digest('hex');
  }
  await writeFile(resolve(root, '.brainchain-work/ci-linux-manifest.json'), JSON.stringify(manifest));
} else {
  if (process.platform !== 'linux') throw Error('Protected fixture lane requires Linux');
  async function verifyMount() {
    const directory = await lstat(bundleDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Protected fixture directory must be ordinary');
    const entries = await readdir(bundleDirectory);
    if (entries.sort().join('|') !== [...bundleNames].sort().join('|')) throw Error('Unexpected protected fixture mount contents');
    const manifest = JSON.parse(await readFile(resolve(root, '.brainchain-work/ci-linux-manifest.json'), 'utf8')) as Record<string, string>;
    for (const name of bundleNames) {
      const path = resolve(bundleDirectory, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(await readFile(path)).digest('hex') !== manifest[name]) throw Error('Protected fixture content manifest mismatch');
    }
  }
  const expected = [[1, 0], [3, 1], [4, 3], [4, 1]];
  for (const [index, name] of protectedFiles.entries()) {
    await verifyMount();
    await suite(service + name, [], ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'run', '--rm', '--pull=never',
      '--network', 'none', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '128', '--memory', '512m', '--log-driver', 'none',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--tmpfs', '/fixture:rw,nosuid,nodev,size=64m,mode=700,uid=10001,gid=10001',
      '--mount', `type=bind,src=${resolve(root, '.brainchain-work/ci-linux-bundles')},dst=/tests,readonly`, '--workdir', '/tests',
      '--env', 'BRAINCHAIN_SIGNER_STORE_TEST_ROOT=/fixture', '--entrypoint', '/usr/local/bin/bun', image,
      'test', './' + name.replace(/\.ts$/, '.js')]);
    const result = results.at(-1)!;
    if (result.passed !== expected[index]![0] || result.skipped !== expected[index]![1]) throw Error('Required protected fixture execution changed; review test inventory');
  }
}
await mkdir(resolve(root, '.brainchain-work'), { recursive: true });
await writeFile(resolve(root, `.brainchain-work/ci-${mode}-results.json`), JSON.stringify({ mode, status: 'passed', results }, null, 2));
console.log(mode === 'prepare-linux' ? 'BrainChain protected fixture bundles prepared and import-checked' : `BrainChain ${mode}: ${results.length} isolated suites executed`);
