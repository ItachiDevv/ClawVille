/**
 * Process start without a shell.
 *
 * Every argv comes from the bundled catalog (checked by `tokenize.ts`) or from
 * fixed text in this package. On POSIX, and for a Windows `.exe`, the CLI starts
 * the program directly with an argv array. A Windows `.cmd` / `.bat` shim cannot
 * start without cmd.exe (Node refuses since the 2024 batch-file fix), so the CLI
 * starts `cmd.exe /d /s /c "<shim> <args>"` and only after it checks the shim path
 * and every argument against strict character sets. No `%`, `!`, `^`, `&`, `|`,
 * `<`, `>` or quote can reach cmd.exe.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { isSafeToken } from './tokenize';

export interface SpawnRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Text written to the child's stdin, then stdin closes. Without it stdin is closed at once. */
  readonly input?: string;
  readonly timeoutMs: number;
  readonly windowsVerbatimArguments?: boolean;
}

export interface SpawnResult {
  /** Exit code; null when the process did not start or was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the process did not start. */
  readonly error?: string;
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>;

export type WhichFn = (bin: string) => string | null;

/** A Windows path that is safe inside double quotes on a cmd.exe line. */
const SAFE_WINDOWS_PATH = /^[^"%!^&|<>\r\n]+$/;

export class UnsafeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCommandError';
  }
}

/**
 * Build the spawn request for `argv`, where `resolved` is the full path of
 * argv[0]. Pure, so the Windows shim rule is unit-tested on every platform.
 */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  const value = key === undefined ? undefined : env[key]?.trim();
  return value ? value : undefined;
}

/**
 * The cmd.exe that starts a `.cmd` shim: `<SystemRoot or WINDIR>\System32\cmd.exe`,
 * never `ComSpec` (any program can sit there). Refuses unless the path is
 * absolute, its file name is cmd.exe, its folder is System32 and the file exists.
 */
export function windowsCmdExe(env: Readonly<Record<string, string | undefined>>, fileExists: (path: string) => boolean = isFile): string {
  const root = envValue(env, 'SYSTEMROOT') ?? envValue(env, 'WINDIR');
  if (root === undefined) throw new UnsafeCommandError('Cannot find cmd.exe: SystemRoot and WINDIR are not set.');
  const path = win32.normalize(win32.join(root, 'System32', 'cmd.exe'));
  const ok =
    win32.isAbsolute(path) &&
    /^[A-Za-z]:\\/.test(path) &&
    win32.basename(path).toLowerCase() === 'cmd.exe' &&
    win32.basename(win32.dirname(path)).toLowerCase() === 'system32' &&
    SAFE_WINDOWS_PATH.test(path) &&
    fileExists(path);
  if (!ok) throw new UnsafeCommandError('Refused cmd.exe: it is not an existing System32\\cmd.exe under SystemRoot.');
  return path;
}

export function buildSpawnRequest(
  resolved: string,
  argv: readonly string[],
  options: {
    platform: NodeJS.Platform;
    env: Readonly<Record<string, string | undefined>>;
    cwd: string;
    input?: string;
    timeoutMs: number;
    /** Test hook for the cmd.exe check. */
    fileExists?: (path: string) => boolean;
  },
): SpawnRequest {
  const args = argv.slice(1);
  for (const arg of args) {
    if (!isSafeToken(arg)) throw new UnsafeCommandError(`Refused argument "${arg.slice(0, 40)}".`);
  }
  const base = { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs, ...(options.input !== undefined ? { input: options.input } : {}) };
  if (options.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    if (!SAFE_WINDOWS_PATH.test(resolved)) throw new UnsafeCommandError(`Refused program path "${resolved}".`);
    const cmdExe = windowsCmdExe(options.env, options.fileExists);
    const line = [`"${resolved}"`, ...args].join(' ');
    return { ...base, file: cmdExe, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
  }
  return { ...base, file: resolved, args };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find `bin` on PATH. On Windows it tries each PATHEXT extension (`.exe` before `.cmd` by default). */
export function makeWhich(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  probe: { isFile: (path: string) => boolean; isExecutable: (path: string) => boolean } = { isFile, isExecutable },
): WhichFn {
  const win = platform === 'win32';
  const pathValue = (win ? env.Path ?? env.PATH ?? env.path : env.PATH) ?? '';
  const dirs = pathValue.split(win ? ';' : ':').filter((dir) => dir.length > 0);
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0) : [''];
  return (bin) => {
    for (const rawDir of dirs) {
      const dir = rawDir.replace(/^"(.*)"$/, '$1');
      for (const ext of exts) {
        const candidate = win ? `${dir.replace(/[\\/]+$/, '')}\\${bin}${ext.toLowerCase()}` : posix.join(dir, bin);
        if (!probe.isFile(candidate)) continue;
        if (!win && !probe.isExecutable(candidate)) continue;
        return candidate;
      }
    }
    return null;
  };
}

/** The real spawn: no shell, stdout and stderr captured, a hard timeout. */
export const realSpawn: SpawnFn = (request) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      resolve(result);
    };
    const child = nodeSpawn(request.file, [...request.args], {
      cwd: request.cwd,
      env: request.env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: request.windowsVerbatimArguments ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      child.kill();
    }, request.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(request.input ?? '');
    child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut, error: err.message }));
    // A grandchild (a shim's real program) can keep the pipes open after the
    // child exits, so 'close' may come late: wait 3 s after 'exit', then finish.
    child.on('exit', (code) => {
      grace = setTimeout(() => finish({ code: timedOut ? null : code, stdout, stderr, timedOut }), 3000);
    });
    child.on('close', (code) => finish({ code: timedOut ? null : code, stdout, stderr, timedOut }));
  });

/** On Windows, end the child and every process it started (fixed argv, no shell). */
function killTree(pid: number | undefined): void {
  if (process.platform !== 'win32' || pid === undefined) return;
  try {
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch {
    // child.kill() below still ends the direct child.
  }
}
