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

export function createOneShotStatePath(
  statePath: string | null,
): () => string | null {
  let pending = statePath;
  return () => {
    const value = pending;
    pending = null;
    return value;
  };
}

function parseAgentBrowserValue<T>(stdout: string): T {
  // agent-browser responses can nest: a {success, data|result} daemon envelope
  // whose payload is the stringified {lifecycle, origin, result} eval envelope,
  // whose `result` is the JSON.stringify'd eval value. A leaked envelope
  // poisons every consumer (truthy waits pass vacuously; snapshot reads
  // compare envelope fields), so unwrap until a plain value remains.
  let value: unknown = JSON.parse(stdout);
  for (let depth = 0; depth < 4; depth += 1) {
    if (value && typeof value === 'object' && 'success' in value) {
      const envelope = value as AgentBrowserJson;
      if (envelope.success === false) {
        throw new Error(envelope.error ?? 'agent-browser command failed');
      }
      value = envelope.data ?? envelope.result;
    } else if (
      value && typeof value === 'object'
      && 'result' in value && 'lifecycle' in value
    ) {
      value = (value as { result: unknown }).result;
    } else if (typeof value === 'string') {
      try {
        const reparsed: unknown = JSON.parse(value);
        if (reparsed && typeof reparsed === 'object'
          && ('success' in reparsed || ('result' in reparsed && 'lifecycle' in reparsed))) {
          value = reparsed;
          continue;
        }
        return reparsed as T;
      } catch {
        return value as T;
      }
    } else {
      break;
    }
  }
  return value as T;
}

export class AgentBrowserDriver implements Driver {
  readonly session: string;
  readonly statePath: string | null;
  private readonly consumeStatePath: () => string | null;

  constructor(
    session = `cove-parity-${process.pid}`,
    statePath: string | null = null,
  ) {
    this.session = session;
    this.statePath = statePath;
    this.consumeStatePath = createOneShotStatePath(statePath);
  }

  private async run(args: readonly string[], json = false, timeoutMs = 90_000): Promise<string> {
    const command = agentBrowserExecutable();
    // --state is a launch-time seed, not an attachment option. Replaying it
    // on eval/wait resets the daemon session before every command and makes
    // authenticated rows wait forever for navigation that already happened.
    const initialStatePath = this.consumeStatePath();
    const commandArgs = [
      '--session',
      this.session,
      ...(initialStatePath ? ['--state', resolve(initialStatePath)] : []),
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
      // A wedged agent-browser daemon can leave a CLI call hanging forever,
      // which silently freezes the whole runner; bound every call.
      const killTimer = setTimeout(() => {
        proc.kill();
        reject(new Error(
          `agent-browser call timed out after ${Math.round(timeoutMs / 1000)}s: ${commandArgs.filter((a) => !a.startsWith('{')).join(' ').slice(0, 160)}`,
        ));
      }, timeoutMs);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => { stdout += chunk; });
      proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
      proc.once('error', (error) => { clearTimeout(killTimer); reject(error); });
      // Resolve on 'exit', NOT 'close': the first open per daemon spawns a
      // browser/daemon grandchild that inherits the stdout pipe, so the pipe
      // never reaches EOF and 'close' never fires even though the CLI printed
      // its result and terminated. A short grace lets trailing output flush.
      proc.once('exit', (code) => {
        clearTimeout(killTimer);
        setTimeout(() => resolveResult({
          stdout,
          stderr,
          exitCode: code ?? 1,
        }), 400);
      });
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `agent-browser exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  async openWithInitScript(url: string, initScript: string): Promise<void> {
    // Launch on about:blank with the init script staged, then navigate via
    // location.assign and wait only for the pathname to commit. `open <url>`
    // waits for a page-quiescence signal that a live game page (constant
    // polling/SSE) can never reach — it hangs unboundedly on healthy pages.
    await this.run([
      'open',
      '--init-script',
      resolve(initScript),
    ], false, 240_000);
    const target = new URL(url);
    await this.evalJson(
      `(() => { location.assign(${JSON.stringify(url)}); return true; })()`,
    );
    await this.waitFn(
      `location.pathname === ${JSON.stringify(target.pathname)}`,
      90_000,
    );
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
    ${checkpoint.expectRenderRevision !== undefined
      ? `&& entry.revision === ${checkpoint.expectRenderRevision}`
      : ''}
    ${checkpoint.expectDealStep
      ? `&& entry.dealStep === ${JSON.stringify(checkpoint.expectDealStep)}`
      : ''}
    ${checkpoint.expectTransition
      ? `&& entry.transition === ${JSON.stringify(checkpoint.expectTransition)}`
      : ''}
    ${checkpoint.expectCorrelationHand
      ? `&& (() => {
          try {
            return JSON.parse(entry.signature)[2]
              === ${JSON.stringify(checkpoint.expectCorrelationHand)};
          } catch {
            return false;
          }
        })()`
      : ''}
    ${checkpoint.expectMinPlayerCards !== undefined
      ? `&& (() => {
          try {
            const slots = JSON.parse(entry.signature)[8];
            return Array.isArray(slots)
              && slots.filter((slot) =>
                Array.isArray(slot)
                && String(slot[0]).startsWith('player-')
                && slot[1] === 'up'
                && String(slot[2]).length > 0
              ).length >= ${checkpoint.expectMinPlayerCards};
          } catch {
            return false;
          }
        })()`
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
      checkpoint.expectRenderRevision === undefined
      || candidate.revision === checkpoint.expectRenderRevision
    ))
    .filter((candidate) => (
      checkpoint.expectDealStep === undefined
      || candidate.dealStep === checkpoint.expectDealStep
    ))
    .filter((candidate) => (
      checkpoint.expectTransition === undefined
      || candidate.transition === checkpoint.expectTransition
    ))
    .filter((candidate) => {
      if (checkpoint.expectCorrelationHand === undefined) return true;
      try {
        return JSON.parse(candidate.signature)[2]
          === checkpoint.expectCorrelationHand;
      } catch {
        return false;
      }
    })
    .filter((candidate) => {
      if (checkpoint.expectMinPlayerCards === undefined) return true;
      try {
        const slots = JSON.parse(candidate.signature)[8] as unknown;
        return Array.isArray(slots)
          && slots.filter((slot) => (
            Array.isArray(slot)
            && String(slot[0]).startsWith('player-')
            && slot[1] === 'up'
            && String(slot[2]).length > 0
          )).length >= checkpoint.expectMinPlayerCards;
      } catch {
        return false;
      }
    })
    .filter((candidate) => !checkpoint.final || candidate.transition === 'idle')
    .sort((left, right) => left.revision - right.revision)[0];
  if (!entry) throw new Error(`No pinned journal entry for ${checkpoint.label}`);
  return rootFromJournalEntry(entry);
}
