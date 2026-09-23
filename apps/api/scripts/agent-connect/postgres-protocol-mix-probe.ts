import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Run from apps/api. Only fresh connections and SELECT constants are used.
// Never print connection strings, errors, SQL text, values, or row contents.
const selected = process.argv[2];
const cases = ['mixed-default', 'parameter-default', 'mixed-one', 'mixed-zero'] as const;
if (!cases.includes(selected as any)) throw new Error('Choose one fixed diagnostic case');
if (process.env.CLAWVILLE_ENV !== 'staging') throw new Error('Staging only');
if (!process.env.DATABASE_URL) throw new Error('Database configuration missing');
let port: number;
try { port = Number(new URL(process.env.DATABASE_URL).port || 5432); }
catch { throw new Error('Invalid database configuration'); }
const modulePath = Bun.resolveSync('postgres', process.cwd());
const { default: postgres } = await import(modulePath);
let packagePath = dirname(modulePath);
let version = 'unknown';
for (let depth = 0; depth < 4; depth++) {
  try {
    const meta = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'));
    if (meta.name === 'postgres') { version = meta.version; break; }
  } catch { /* No diagnostic content from filesystem exceptions. */ }
  packagePath = dirname(packagePath);
}
const started = Date.now();
let completed = 0;
let rounds = 0;
let lastLabel = 'connect';
let client: ReturnType<typeof postgres>;
try { client = postgres(process.env.DATABASE_URL, {
  prepare: false, max: 1, idle_timeout: 30, connect_timeout: 5,
  keep_alive: 30, max_lifetime: 3600,
  ...(selected === 'mixed-one' ? { max_pipeline: 1 } : {}),
  ...(selected === 'mixed-zero' ? { max_pipeline: 0 } : {}),
  connection: { application_name: 'cv-readonly-transport-probe' },
  onnotice: () => {},
}); } catch { throw new Error('Database client initialization failed'); }
console.log(JSON.stringify({ phase: 'start', case: selected, bun: Bun.version, postgres: version,
  port, max: 1,
  maxPipeline: client.options.max_pipeline }));
const hardStop = setTimeout(() => {
  console.log(JSON.stringify({ phase: 'hard-timeout', case: selected, completed, rounds, lastLabel, elapsedMs: Date.now() - started }));
  process.exit(2); // Only this disposable client/process; closes its sockets.
}, 12000);
let deadlineTimer: ReturnType<typeof setTimeout>;
const deadline = new Promise<never>((_, reject) => {
  deadlineTimer = setTimeout(() => reject(new Error('deadline')), 9000);
});
try {
  await Promise.race([deadline, (async () => {
    await client.unsafe('select 1').values();
    for (let round = 0; round < 100; round++) {
      lastLabel = 'concurrent-pair';
      const first = selected === 'parameter-default'
        ? client.unsafe('select $1::int', [1]).values()
        : client.unsafe('select 1', []).values();
      const second = client.unsafe('select $1::int', [2]).values();
      await Promise.all([
        first.then(() => { completed++; }),
        second.then(() => { completed++; }),
      ]);
      rounds++;
    }
    lastLabel = 'finished';
  })()]);
  console.log(JSON.stringify({ phase: 'pass', case: selected, completed, rounds, elapsedMs: Date.now() - started }));
} catch {
  console.log(JSON.stringify({ phase: 'fail-or-timeout', case: selected, completed, rounds, lastLabel, elapsedMs: Date.now() - started }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadlineTimer!);
  await client.end({ timeout: 1 }).catch(() => {});
  clearTimeout(hardStop);
}
