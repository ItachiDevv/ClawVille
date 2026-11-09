#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { runCli } from './cli';
import { makeWhich, realSpawn } from './exec';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => resolve(''));
  });
}

const env = process.env as Readonly<Record<string, string | undefined>>;

runCli(process.argv.slice(2), {
  platform: process.platform,
  env,
  cwd: process.cwd(),
  spawn: realSpawn,
  which: makeWhich(process.platform, env),
  fetch: globalThis.fetch,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`clawville: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
