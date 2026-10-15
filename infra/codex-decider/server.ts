/**
 * codex-decider: a small HOST sidecar (not in the API container) that asks the Codex CLI, logged in with the
 * founder's ChatGPT plan, for a money judgement on one Trading Floor arena paper entry.
 *
 * POST /decide  (Authorization: Bearer <CODEX_DECIDER_TOKEN>)  body {agentId, mint, packet}
 *   200 {decision, confidence, exit_room, rug_risk, reasons, model, ms}
 *   400 bad_request | 401 unauthorized | 413 too_large | 429 dropped | 502 codex_failed / bad_output | 504 timeout
 * GET /health   {ok, codexVersion, login: 'chatgpt'|'api_key'|'logged_out'|'unknown', running, queued, ...}
 *
 * Each decision runs `codex exec --skip-git-repo-check --ephemeral -s read-only [-m MODEL] --output-schema
 * decision.schema.json -o <tmp>/out.json "<prompt>"` with stdin closed (= /dev/null), in a new empty temp dir,
 * with a hard deadline (queue wait included); the whole process tree is killed on timeout. Concurrency is capped
 * and the wait queue is bounded: when full, the OLDEST waiting request is answered 429 `dropped`.
 * Never logs or returns the token or any Codex credential. See README.md.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCHEMA_PATH = join(import.meta.dir, 'decision.schema.json');
export const MAX_BODY_BYTES = 16_384;
export const MAX_PACKET_CHARS = 4_000;
/** A queued job that would start with less than this left is answered `timeout` without running Codex. */
export const MIN_RUN_MS = 5_000;

export interface Config {
  token: string;
  model: string | null;
  effort: string;
  host: string;
  port: number;
  timeoutMs: number;
  concurrency: number;
  queueMax: number;
  bin: string;
}

function intEnv(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw === undefined || raw.trim() === '' ? def : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`env value out of range (${min}..${max})`);
  return n;
}

/** Reads the env; throws on a missing/short token or a wildcard/public-looking bind. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = env.CODEX_DECIDER_TOKEN?.trim() ?? '';
  if (token.length < 24) throw new Error('CODEX_DECIDER_TOKEN must be set (at least 24 characters)');
  const bind = env.CODEX_DECIDER_BIND?.trim() || '127.0.0.1:8790';
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(bind);
  if (!m) throw new Error('CODEX_DECIDER_BIND must be IPv4:port, e.g. 10.0.1.1:8790');
  const host = m[1]!;
  if (host === '0.0.0.0') throw new Error('CODEX_DECIDER_BIND must not be 0.0.0.0 (bind the docker gateway IP)');
  const effort = env.CODEX_DECIDER_EFFORT?.trim() || 'low';
  if (!/^[a-z]{1,16}$/.test(effort)) throw new Error('CODEX_DECIDER_EFFORT must be a plain word (low, medium, ...)');
  const model = env.CODEX_DECIDER_MODEL?.trim() || null;
  if (model !== null && !/^[A-Za-z0-9._:-]{1,64}$/.test(model)) throw new Error('CODEX_DECIDER_MODEL has bad characters');
  return {
    token,
    model,
    effort,
    host,
    port: intEnv(m[2], 8790, 1, 65_535),
    timeoutMs: intEnv(env.CODEX_DECIDER_TIMEOUT_MS, 90_000, 10_000, 600_000),
    concurrency: intEnv(env.CODEX_DECIDER_CONCURRENCY, 2, 1, 8),
    queueMax: intEnv(env.CODEX_DECIDER_QUEUE_MAX, 8, 0, 100),
    bin: env.CODEX_DECIDER_BIN?.trim() || 'codex',
  };
}

// ---------------------------------------------------------------- prompt + output

export function buildPrompt(packet: Record<string, unknown>): string {
  return [
    'You judge ONE paper trade for a Solana memecoin trading bot. Do not run any commands; answer only from the facts.',
    'The bot buys a fixed USD position now and exits only by its own rules (take profit, stop, trail, max hold).',
    'Real cost: about 2.5% of the position per round trip (fees + slippage).',
    'Question: over the next 60 minutes, is this entry more likely to make money than lose it, after costs,',
    'given the bot strategy? Say "enter" only if the expected net dollar result is positive; else "skip".',
    'confidence = your probability (0..1) that the decision is right. exit_room = can a buy and sell of this size',
    'fill without heavy price impact. rug_risk = chance of a rug or collapse inside the hold. reasons: at most 3',
    'short money-based reasons. Null values are unknown facts, not good or bad facts.',
    `Facts (JSON): ${JSON.stringify(packet)}`,
  ].join(' '); // one line: argv stays intact even through a Windows .cmd shim (cmd.exe cuts an argument at a newline)
}

export interface Decision {
  decision: 'enter' | 'skip';
  confidence: number;
  exit_room: 'yes' | 'no';
  rug_risk: 'low' | 'med' | 'high';
  reasons: string[];
}

export function parseDecision(raw: unknown): Decision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.decision !== 'enter' && o.decision !== 'skip') return null;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  if (o.exit_room !== 'yes' && o.exit_room !== 'no') return null;
  if (o.rug_risk !== 'low' && o.rug_risk !== 'med' && o.rug_risk !== 'high') return null;
  if (!Array.isArray(o.reasons) || !o.reasons.every((r) => typeof r === 'string')) return null;
  return {
    decision: o.decision,
    confidence: o.confidence,
    exit_room: o.exit_room,
    rug_risk: o.rug_risk,
    reasons: (o.reasons as string[]).slice(0, 3).map((r) => r.slice(0, 200)),
  };
}

// ---------------------------------------------------------------- queue

export type QueueResult<T> = { kind: 'ran'; value: T } | { kind: 'dropped' } | { kind: 'expired' };

interface Waiting<T> {
  deadline: number;
  run: (remainingMs: number) => Promise<T>;
  resolve: (r: QueueResult<T>) => void;
}

/** Concurrency-capped FIFO; a full wait queue drops its OLDEST entry; each job has an absolute deadline. */
export function createQueue<T>(concurrency: number, queueMax: number, now: () => number = Date.now) {
  let running = 0;
  const waiting: Waiting<T>[] = [];

  function pump(): void {
    while (running < concurrency && waiting.length > 0) {
      const job = waiting.shift()!;
      const remaining = job.deadline - now();
      if (remaining < MIN_RUN_MS) {
        job.resolve({ kind: 'expired' });
        continue;
      }
      running += 1;
      job.run(remaining)
        .then((value) => job.resolve({ kind: 'ran', value }))
        .catch(() => job.resolve({ kind: 'expired' }))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  function submit(deadline: number, run: (remainingMs: number) => Promise<T>): Promise<QueueResult<T>> {
    return new Promise((resolve) => {
      if (running >= concurrency && waiting.length >= queueMax) {
        if (queueMax === 0) {
          resolve({ kind: 'dropped' });
          return;
        }
        waiting.shift()!.resolve({ kind: 'dropped' });
      }
      waiting.push({ deadline, run, resolve });
      pump();
    });
  }

  return { submit, running: () => running, queued: () => waiting.length };
}

// ---------------------------------------------------------------- codex runner

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // the whole process group (spawned detached)
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export type RunOutcome =
  | { ok: true; decision: Decision }
  | { ok: false; error: 'timeout' | 'codex_failed' | 'bad_output'; detail?: string };

export async function runCodex(cfg: Config, prompt: string, timeoutMs: number): Promise<RunOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-decider-'));
  const outFile = join(dir, 'out.json');
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only'];
  if (cfg.model) args.push('-m', cfg.model);
  args.push('-c', `model_reasoning_effort="${cfg.effort}"`, '--output-schema', SCHEMA_PATH, '-o', outFile, prompt);
  try {
    const child = spawn(cfg.bin, args, {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'], // stdin closed: codex exec never waits for input
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stderrTail = '';
    child.stderr?.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-400); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c));
    });
    clearTimeout(timer);
    if (timedOut) return { ok: false, error: 'timeout' };
    if (code !== 0) {
      const lastLine = stderrTail.trim().split('\n').pop() ?? '';
      return { ok: false, error: 'codex_failed', detail: `exit ${code}: ${lastLine.slice(0, 160)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(outFile, 'utf8'));
    } catch {
      return { ok: false, error: 'bad_output', detail: 'no JSON in the output file' };
    }
    const decision = parseDecision(parsed);
    return decision ? { ok: true, decision } : { ok: false, error: 'bad_output', detail: 'schema mismatch' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- health

function runText(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/** Maps `codex login status` to an enum; the raw text is never returned (it can show a masked key). */
export function loginMode(text: string): 'chatgpt' | 'api_key' | 'logged_out' | 'unknown' {
  if (/logged in using chatgpt/i.test(text)) return 'chatgpt';
  if (/logged in using an api key/i.test(text)) return 'api_key';
  if (/not logged in/i.test(text)) return 'logged_out';
  return 'unknown';
}

// ---------------------------------------------------------------- http

function sha(s: string): Buffer { return createHash('sha256').update(s, 'utf8').digest(); }

export function authorized(header: string | null, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return m !== null && timingSafeEqual(sha(m[1]!), sha(token));
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

export function createHandler(cfg: Config, deps: { run?: typeof runCodex; now?: () => number } = {}) {
  const run = deps.run ?? runCodex;
  const now = deps.now ?? Date.now;
  const queue = createQueue<RunOutcome>(cfg.concurrency, cfg.queueMax, now);
  const counts = { ok: 0, timeout: 0, dropped: 0, codex_failed: 0, bad_output: 0 };
  let health: { at: number; body: Record<string, unknown> } | null = null;

  async function decide(req: Request): Promise<Response> {
    if (!authorized(req.headers.get('authorization'), cfg.token)) return json(401, { error: 'unauthorized' });
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return json(400, { error: 'bad_request' });
    }
    const { agentId, mint, packet } = body ?? {};
    if (typeof agentId !== 'string' || agentId.length < 1 || agentId.length > 128) return json(400, { error: 'bad_request' });
    if (typeof mint !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(mint)) return json(400, { error: 'bad_request' });
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return json(400, { error: 'bad_request' });
    if (JSON.stringify(packet).length > MAX_PACKET_CHARS) return json(413, { error: 'too_large' });
    const prompt = buildPrompt(packet as Record<string, unknown>);

    const started = now();
    const res = await queue.submit(started + cfg.timeoutMs, (remaining) => run(cfg, prompt, remaining));
    const ms = now() - started;
    if (res.kind === 'dropped') { counts.dropped += 1; return json(429, { error: 'dropped', ms }); }
    if (res.kind === 'expired') { counts.timeout += 1; return json(504, { error: 'timeout', ms }); }
    const out = res.value;
    if (!out.ok) {
      counts[out.error] += 1;
      if (out.error !== 'timeout') console.warn(`[codex-decider] ${out.error}${out.detail ? `: ${out.detail}` : ''}`);
      return json(out.error === 'timeout' ? 504 : 502, { error: out.error, ms });
    }
    counts.ok += 1;
    return json(200, { ...out.decision, model: cfg.model ?? 'codex-default', ms });
  }

  async function healthRes(): Promise<Response> {
    if (!health || now() - health.at > 60_000) {
      const version = (await runText(cfg.bin, ['--version'], 10_000)).trim().split('\n')[0]?.slice(0, 64) ?? '';
      const login = loginMode(await runText(cfg.bin, ['login', 'status'], 10_000));
      health = { at: now(), body: { codexVersion: version || null, login } };
    }
    return json(200, {
      ok: health.body.login === 'chatgpt',
      ...health.body,
      model: cfg.model ?? 'codex-default',
      running: queue.running(),
      queued: queue.queued(),
      concurrency: cfg.concurrency,
      queueMax: cfg.queueMax,
      timeoutMs: cfg.timeoutMs,
      counts,
    });
  }

  return async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.method === 'POST' && path === '/decide') return decide(req);
    if (req.method === 'GET' && path === '/health') return healthRes();
    return json(404, { error: 'not_found' });
  };
}

if (import.meta.main) {
  const cfg = loadConfig(process.env);
  const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: createHandler(cfg), idleTimeout: 0 });
  console.log(`[codex-decider] listening on ${server.hostname}:${server.port} model=${cfg.model ?? 'codex-default'}`
    + ` concurrency=${cfg.concurrency} queueMax=${cfg.queueMax} timeoutMs=${cfg.timeoutMs}`);
}
