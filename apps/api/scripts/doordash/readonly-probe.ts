/**
 * Manual staging-container probe: bun apps/api/scripts/doordash/readonly-probe.ts
 * Never run from CI or bun test. Requires the real binary and account token.
 * Checks the full token and every contiguous eight-character token fragment.
 * Literal one-character substring exclusion would also reject ordinary JSON.
 */
import { format } from 'node:util';

const token = process.env.DD_CLI_ACCESS_TOKEN ?? '';
const fragments = new Set<string>();
if (token) {
  fragments.add(token);
  for (let i = 0; i + 8 <= token.length; i++) fragments.add(token.slice(i, i + 8));
}
const containsToken = (text: string) => [...fragments].some((fragment) => text.includes(fragment));

// Buffer both streams, including console output and deferred wrapper alerts.
// Validate before any emission. Keep interception installed until process exit.
const writes: { stream: 'stdout' | 'stderr'; text: string }[] = [];
const originalWrites = {
  stdout: process.stdout.write.bind(process.stdout),
  stderr: process.stderr.write.bind(process.stderr),
};
let outputSize = 0;
let outputRejected = false;
for (const stream of ['stdout', 'stderr'] as const) {
  process[stream].write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(
      typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8',
    );
    outputSize += Buffer.byteLength(text);
    if (outputSize > 4 * 1024 * 1024) outputRejected = true;
    if (!outputRejected) writes.push({ stream, text });
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (done) queueMicrotask(done);
    return true;
  }) as typeof process.stdout.write;
}

// Bun's native console methods bypass process.stdout.write/process.stderr.write.
// Redirect them explicitly so wrapper logs receive the same pre-emission check.
for (const method of ['log', 'info', 'debug', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed'] as const) {
  console[method] = (...args: unknown[]) => { process.stdout.write(`${format(...args)}\n`); };
}
for (const method of ['warn', 'error', 'trace'] as const) {
  console[method] = (...args: unknown[]) => { process.stderr.write(`${format(...args)}\n`); };
}
console.assert = (condition?: boolean, ...args: unknown[]) => {
  if (!condition) process.stderr.write(`${format(...args)}\n`);
};

process.on('beforeExit', () => {
  const combined = writes.map((write) => write.text).join('');
  const stdout = writes.filter((write) => write.stream === 'stdout').map((write) => write.text).join('');
  const stderr = writes.filter((write) => write.stream === 'stderr').map((write) => write.text).join('');
  if (outputRejected || [combined, stdout, stderr].some(containsToken)) {
    process.exitCode = 1;
    const message = 'Read-only probe failed: output safety assertion. Captured output suppressed.\n';
    if (!containsToken(message)) originalWrites.stderr(message);
  } else {
    for (const write of writes) originalWrites[write.stream](write.text);
  }
  writes.length = 0;
});

try {
  if (!token) throw new Error('Missing token');
  // Import only after the output guards cover module initialization too.
  const { runDdCli } = await import('../../src/services/doordash-cli');
  const probes = [
    ['version', []],
    ['address-list', []],
    ['search', ['pizza']],
  ] as const;
  let failures = 0;
  for (const [operation, args] of probes) {
    const result = await runDdCli(operation, args);
    console.log(JSON.stringify({ operation, result }));
    if (!result.ok || result.data === null || typeof result.data !== 'object') {
      failures++;
      continue;
    }
    // The wrapper parses and validates JSON; confirm a JSON value reached us.
    JSON.parse(JSON.stringify(result.data));
    console.log(JSON.stringify({ operation, ok: true, parsedJson: true }));
  }
  if (failures) throw new Error('Probe assertions failed');
  console.log(JSON.stringify({ ok: true, probes: 3, tokenFragmentLength: 8 }));
} catch {
  // Never print an exception or failed assertion value: it can contain secrets.
  process.exitCode = 1;
  console.error('Read-only probe failed. Check the guarded results and staging configuration.');
}

export {};
