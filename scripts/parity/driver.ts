import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  rootFromJournalEntry,
  type BrowserParityJournalEntry,
} from './journal';
import type {
  CardParityRoot,
  ParityCheckpoint,
  Surface,
  WireRecord,
} from './types';

export interface Driver {
  openWithInitScript(url: string, initScript: string): Promise<void>;
  evalJson<T>(js: string): Promise<T>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitFn(js: string, timeoutMs?: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  close(): Promise<void>;
}

interface AgentBrowserJson {
  success?: boolean;
  data?: unknown;
  result?: unknown;
  error?: string;
}

export function agentBrowserExecutable(): string {
  return process.env.AGENT_BROWSER_BIN
    ?? (process.platform === 'win32'
      ? join(
          process.env.APPDATA ?? '',
          'npm',
          'node_modules',
          'agent-browser',
          'bin',
          'agent-browser-win32-x64.exe',
        )
      : 'agent-browser');
}

export function serializeAgentBrowserEval(js: string): string {
  return `Promise.resolve(${js}).then((value) => JSON.stringify(value))`;
}

function parseAgentBrowserValue<T>(stdout: string): T {
  const parsed = JSON.parse(stdout) as AgentBrowserJson | unknown;
  if (parsed && typeof parsed === 'object' && 'success' in parsed) {
    const envelope = parsed as AgentBrowserJson;
    if (envelope.success === false) {
      throw new Error(envelope.error ?? 'agent-browser command failed');
    }
    const value = envelope.data ?? envelope.result;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as T;
      }
    }
    return value as T;
  }
  return parsed as T;
}

export class AgentBrowserDriver implements Driver {
  readonly session: string;
  readonly statePath: string | null;

  constructor(
    session = `cove-parity-${process.pid}`,
    statePath: string | null = null,
  ) {
    this.session = session;
    this.statePath = statePath;
  }

  private async run(args: readonly string[], json = false): Promise<string> {
    const command = agentBrowserExecutable();
    const commandArgs = [
      '--session',
      this.session,
      ...(this.statePath ? ['--state', resolve(this.statePath)] : []),
      ...(json ? ['--json'] : []),
      ...args,
    ];
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolveResult, reject) => {
      const proc = spawn(command, commandArgs, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => { stdout += chunk; });
      proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
      proc.once('error', reject);
      proc.once('close', (code) => resolveResult({
        stdout,
        stderr,
        exitCode: code ?? 1,
      }));
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `agent-browser exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  async openWithInitScript(url: string, initScript: string): Promise<void> {
    await this.run([
      'open',
      '--init-script',
      resolve(initScript),
      url,
    ]);
  }

  async evalJson<T>(js: string): Promise<T> {
    const stdout = await this.run([
      'eval',
      serializeAgentBrowserEval(js),
    ], true);
    return parseAgentBrowserValue<T>(stdout);
  }

  async click(selector: string): Promise<void> {
    await this.run(['click', selector]);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.run(['fill', selector, value]);
  }

  async waitFn(js: string, timeoutMs = 25_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evalJson<boolean>(`Boolean(${js})`)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`waitFn timed out after ${timeoutMs}ms`);
  }

  async screenshot(path: string): Promise<void> {
    await this.run(['screenshot', resolve(path)]);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.run(['set', 'viewport', String(width), String(height)]);
  }

  async close(): Promise<void> {
    await this.run(['close']).catch(() => undefined);
  }
}

export async function readParityRoot(
  driver: Driver,
  surface: Surface,
): Promise<CardParityRoot | null> {
  return driver.evalJson<CardParityRoot | null>(
    `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
  );
}

export async function readCapturedWire(driver: Driver): Promise<WireRecord[]> {
  return driver.evalJson<WireRecord[]>('window.__CV_WIRE_ALL?.() ?? []');
}

export async function waitForCheckpoint(
  driver: Driver,
  surface: Surface,
  afterRevision: number,
  dealStep: string,
  final: boolean,
  timeoutMs?: number,
): Promise<CardParityRoot> {
  const expression = `(() => {
    const entries = window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [];
    return entries.some((entry) =>
      entry.revision > ${afterRevision}
      && entry.dealStep === ${JSON.stringify(dealStep)}
      ${final ? "&& entry.transition === 'idle'" : ''}
    );
  })()`;
  await driver.waitFn(expression, timeoutMs);
  const entries = await driver.evalJson<BrowserParityJournalEntry[]>(
    `window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? []`,
  );
  const entry = entries
    .filter((candidate) => candidate.revision > afterRevision)
    .filter((candidate) => candidate.dealStep === dealStep)
    .filter((candidate) => !final || candidate.transition === 'idle')
    .sort((left, right) => left.revision - right.revision)[0];
  if (!entry) throw new Error(`No pinned journal entry for ${surface}@${dealStep}`);
  return rootFromJournalEntry(entry);
}

export async function waitForParityCheckpoint(
  driver: Driver,
  checkpoint: ParityCheckpoint,
  afterRevision: number,
  timeoutMs?: number,
): Promise<CardParityRoot> {
  const predicate = `(entry) =>
    entry.revision > ${afterRevision}
    ${checkpoint.expectDealStep
      ? `&& entry.dealStep === ${JSON.stringify(checkpoint.expectDealStep)}`
      : ''}
    ${checkpoint.expectTransition
      ? `&& entry.transition === ${JSON.stringify(checkpoint.expectTransition)}`
      : ''}
    ${checkpoint.final ? "&& entry.transition === 'idle'" : ''}`;
  await driver.waitFn(`(() => {
    const entries = window.__CV_PARITY_JOURNAL?.(${JSON.stringify(checkpoint.surface)}) ?? [];
    return entries.some(${predicate});
  })()`, timeoutMs);
  const entries = await driver.evalJson<BrowserParityJournalEntry[]>(
    `window.__CV_PARITY_JOURNAL?.(${JSON.stringify(checkpoint.surface)}) ?? []`,
  );
  const entry = entries
    .filter((candidate) => candidate.revision > afterRevision)
    .filter((candidate) => (
      checkpoint.expectDealStep === undefined
      || candidate.dealStep === checkpoint.expectDealStep
    ))
    .filter((candidate) => (
      checkpoint.expectTransition === undefined
      || candidate.transition === checkpoint.expectTransition
    ))
    .filter((candidate) => !checkpoint.final || candidate.transition === 'idle')
    .sort((left, right) => left.revision - right.revision)[0];
  if (!entry) throw new Error(`No pinned journal entry for ${checkpoint.label}`);
  return rootFromJournalEntry(entry);
}
