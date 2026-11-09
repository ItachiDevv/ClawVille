import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { runTaskParent, validateIsolatedTaskConfig, type IsolatedTaskBinding, type TaskChildChannel, type VerifiedTaskChildResult } from '@clawville/agent-runtime/isolated-task';
import { z } from 'zod';
import type { ComputeReceipt, DurableInferenceProxy } from './inference-proxy';

export const BRAINCHAIN_COGNITION_IMAGE = 'oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4';
const DOCKER_VERSION = '29.1.3';
const configSchema = z.object({ bundlePath: z.string().min(1).max(1024), bundleSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export interface IsolatedProcessBundle { bundlePath: string; bundleSha256: string }
export class IsolatedProcessCoordinatorError extends Error {
  constructor(readonly code: 'invalid_request' | 'launcher_unavailable' | 'policy_refused' | 'task_refused') {
    super(`BrainChain isolated process refused: ${code}`); this.name = 'IsolatedProcessCoordinatorError';
  }
}
function dockerPrefix(): string[] {
  if (process.platform === 'win32') return ['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu-24.04', '--', '/usr/bin/docker', '--host', 'unix:///var/run/docker.sock'];
  if (process.platform === 'linux') return ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock'];
  throw new IsolatedProcessCoordinatorError('launcher_unavailable');
}
function parentEnvironment(): Record<string, string> {
  return process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' } : { PATH: '/usr/bin:/bin' };
}
async function boundedText(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let count = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break;
      count += item.value.length; if (count > limit) throw new IsolatedProcessCoordinatorError('policy_refused'); chunks.push(item.value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel(); }
}
/** Only fixed metadata/cleanup calls within this module can invoke this function. */
async function dockerMetadata(args: readonly string[], limit = 65536): Promise<{ exit: number; output: string; missingContainer: boolean }> {
  const child = Bun.spawn([...dockerPrefix(), ...args], { env: parentEnvironment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([Promise.all([child.exited, boundedText(child.stdout, limit), boundedText(child.stderr, 4096)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new IsolatedProcessCoordinatorError('launcher_unavailable')); }, 2000); })]);
    return { exit: result[0], output: result[1], missingContainer: result[2].includes('No such container:') };
  } catch { child.kill(); throw new IsolatedProcessCoordinatorError('launcher_unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}
async function bundleSource(raw: IsolatedProcessBundle): Promise<string> {
  const config = configSchema.parse(raw);
  if (!isAbsolute(config.bundlePath)) throw new IsolatedProcessCoordinatorError('policy_refused');
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(config.bundlePath)) throw new IsolatedProcessCoordinatorError('policy_refused');
  const stat = await lstat(config.bundlePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32*1024*1024 || stat.size < 1) throw new IsolatedProcessCoordinatorError('policy_refused');
  if (process.platform === 'linux' && (stat.mode & 0o022) !== 0) throw new IsolatedProcessCoordinatorError('policy_refused');
  const resolved = await realpath(config.bundlePath);
  if (!/^[a-zA-Z0-9_ .:/\\-]+$/.test(resolved)) throw new IsolatedProcessCoordinatorError('policy_refused');
  if (createHash('sha256').update(await readFile(resolved)).digest('hex') !== config.bundleSha256) throw new IsolatedProcessCoordinatorError('policy_refused');
  if (process.platform === 'win32') {
    const match = /^([A-Za-z]):[\\/](.+)$/.exec(resolved);
    if (!match) throw new IsolatedProcessCoordinatorError('policy_refused');
    return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
  }
  return resolved;
}
/** Pure fixed launch policy. No caller can choose a command, image, environment, or container identity. */
export function cognitionContainerArguments(source: string, name: string): string[] {
  if (!/^\/[a-zA-Z0-9_ ./-]+$/.test(source) || !/^cv-brainchain-task-[a-f0-9-]{36}$/.test(name)) throw new IsolatedProcessCoordinatorError('policy_refused');
  return ['run', '--rm', '--pull=never', '-i', '--name', name, '--label', 'clawville.job=brainchain-office',
    '--network', 'none', '--read-only', '--user', '10002:10002', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--ipc', 'none', '--log-driver', 'none', '--pids-limit', '64', '--memory', '256m', '--memory-swap', '256m', '--cpus', '1',
    '--ulimit', 'nofile=64:64', '--ulimit', 'core=0', '--stop-timeout', '1', '--workdir', '/',
    '--mount', `type=bind,src=${source},dst=/worker.js,readonly`, '--env', 'NODE_ENV=production',
    '--env', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0', '--entrypoint', '/usr/local/bin/bun', BRAINCHAIN_COGNITION_IMAGE,
    '--no-env-file', '/worker.js'];
}

async function assertContainer(name: string, source: string): Promise<void> {
  const inspection = await dockerMetadata(['inspect', name]);
  if (inspection.exit !== 0) throw new IsolatedProcessCoordinatorError('policy_refused');
  const rows: unknown = JSON.parse(inspection.output);
  const schema = z.array(z.object({ Config: z.object({ Image: z.literal(BRAINCHAIN_COGNITION_IMAGE), User: z.literal('10002:10002'), Env: z.array(z.string()), Entrypoint: z.array(z.string()), Cmd: z.array(z.string()) }),
    HostConfig: z.object({ NetworkMode: z.literal('none'), ReadonlyRootfs: z.literal(true), Privileged: z.literal(false), CapDrop: z.array(z.string()),
      CapAdd: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()), PidsLimit: z.literal(64), Memory: z.literal(268435456), NanoCpus: z.literal(1000000000), IpcMode: z.literal('none'),
      LogConfig: z.object({ Type: z.literal('none') }), Devices: z.array(z.unknown()).nullable() }),
    Mounts: z.array(z.object({ Destination: z.literal('/worker.js'), Source: z.literal(source), RW: z.literal(false), Type: z.literal('bind') })).length(1),
  })).length(1).safeParse(rows);
  if (!schema.success) throw new IsolatedProcessCoordinatorError('policy_refused');
  const row = schema.data[0]!;
  const names = row.Config.Env.map(value => value.split('=')[0]);
  if (names.some(name => !['PATH', 'BUN_INSTALL_BIN', 'NODE_ENV', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH'].includes(name!))
    || row.HostConfig.CapDrop.length !== 1 || row.HostConfig.CapDrop[0] !== 'ALL' || row.HostConfig.CapAdd?.length
    || row.HostConfig.SecurityOpt.length !== 1 || !row.HostConfig.SecurityOpt.some(value => value === 'no-new-privileges' || value === 'no-new-privileges:true') || row.HostConfig.Devices?.length
    || row.Config.Entrypoint.join(',') !== '/usr/local/bin/bun' || row.Config.Cmd.join(',') !== '--no-env-file,/worker.js') {
    throw new IsolatedProcessCoordinatorError('policy_refused');
  }
}

async function launch(source: string, deadlineMs: number, signal?: AbortSignal): Promise<{ channel: TaskChildChannel; inspect: () => Promise<void> }> {
  if (signal?.aborted || Date.now() >= deadlineMs) throw new IsolatedProcessCoordinatorError('task_refused');
  const version = await dockerMetadata(['version', '--format', '{{.Client.Version}}']);
  if (version.exit !== 0 || version.output.trim() !== DOCKER_VERSION) throw new IsolatedProcessCoordinatorError('policy_refused');
  if (signal?.aborted || Date.now() >= deadlineMs) throw new IsolatedProcessCoordinatorError('task_refused');
  const name = `cv-brainchain-task-${randomUUID()}`;
  const child = Bun.spawn([...dockerPrefix(), ...cognitionContainerArguments(source, name)], {
    env: parentEnvironment(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  let terminated = false;
  const channel: TaskChildChannel = { stdout: child.stdout, stderr: child.stderr, exited: child.exited,
    write: async bytes => { child.stdin.write(bytes); await child.stdin.flush(); }, closeInput: async () => { await child.stdin.end(); },
    terminate: async () => { if (terminated) return; terminated = true; try { child.kill(); } catch {}
      // Cleanup selects only this generated name. --rm may already have removed it.
      const removed = await dockerMetadata(['rm', '-f', name]);
      if (removed.exit !== 0 && !removed.missingContainer) throw new IsolatedProcessCoordinatorError('launcher_unavailable'); },
  };
  return { channel, inspect: () => assertContainer(name, source) };
}

/** Internal coordinator adapter. The child never receives the retained capability or proxy object. */
export async function runBrainchainIsolatedProcess(input: {
  bundle: IsolatedProcessBundle; binding: IsolatedTaskBinding; brief: string; capability: string;
  proxy: Pick<DurableInferenceProxy, 'dispatch' | 'status'>; signal?: AbortSignal;
}): Promise<{ result: VerifiedTaskChildResult; receipt: ComputeReceipt }> {
  const brief = input.brief, capability = input.capability, signal = input.signal;
  let approved: ReturnType<typeof validateIsolatedTaskConfig>;
  try { approved = validateIsolatedTaskConfig({ executionProfile: { kind: 'isolated-task', binding: input.binding, brief,
    proxy: { generate: async () => { throw new IsolatedProcessCoordinatorError('task_refused'); } } } }); }
  catch { throw new IsolatedProcessCoordinatorError('invalid_request'); }
  const binding = approved.binding;
  if (typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability) || signal?.aborted) throw new IsolatedProcessCoordinatorError('invalid_request');
  const dispatch = input.proxy.dispatch.bind(input.proxy), status = input.proxy.status.bind(input.proxy);
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const source = await bundleSource(input.bundle); launched = await launch(source, binding.deadlineMs, signal);
    let receipt: ComputeReceipt | undefined;
    const result = await runTaskParent({ binding, brief, child: launched.channel, signal,
      proxy: {
        generate: async (request, signal) => {
          await launched!.inspect();
          receipt = await dispatch(capability, request, signal);
          if (receipt.state !== 'settled' || !receipt.response || receipt.callId !== binding.callId) throw new IsolatedProcessCoordinatorError('task_refused');
          return receipt.response;
        },
        confirm: async () => {
          receipt = await status(capability);
          if (receipt.state !== 'settled' || !receipt.response || receipt.callId !== binding.callId) throw new IsolatedProcessCoordinatorError('task_refused');
          return receipt.response;
        },
      } });
    if (!receipt || receipt.state !== 'settled' || !receipt.response || receipt.chargedMicros === null) throw new IsolatedProcessCoordinatorError('task_refused');
    return { result, receipt };
  } catch (error) {
    if (error instanceof IsolatedProcessCoordinatorError) throw error;
    throw new IsolatedProcessCoordinatorError('task_refused');
  } finally { if (launched) await launched.channel.terminate(); }
}
