import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  AgentBrowserDriver,
  agentBrowserExecutable,
} from './driver';

const DEFAULT_WEB_BASE = 'https://itachi222.tail06a01b.ts.net:9443';
const DEFAULT_API_BASE = 'https://itachi222.tail06a01b.ts.net:9444';
const DEFAULT_LIVE_STATE = 'scripts/parity/out/auth/live-state.json';
const DEFAULT_GUEST_STATE = 'scripts/parity/out/auth/guest-state.json';
const LIVE_BALANCE_FLOOR = 500;

interface AuthProbe {
  status: number;
  isGuest: boolean | null;
}

interface AvatarProbe {
  status: number;
  balance: number | null;
}

interface TableProbe {
  status: number;
  id: string | null;
}

function absoluteApiBase(): string {
  return (process.env.CV_PARITY_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, '');
}

function webBase(): string {
  return (process.env.CV_PARITY_WEB_BASE ?? DEFAULT_WEB_BASE).replace(/\/$/, '');
}

function liveStatePath(): string {
  return process.env.CV_PARITY_AUTH_STATE ?? DEFAULT_LIVE_STATE;
}

function guestStatePath(): string {
  return process.env.CV_PARITY_GUEST_AUTH_STATE ?? DEFAULT_GUEST_STATE;
}

async function pageRequest<T>(
  driver: AgentBrowserDriver,
  path: string,
  init: Record<string, unknown> = {},
): Promise<{ status: number; body: T | null }> {
  return driver.evalJson<{ status: number; body: T | null }>(`(async () => {
    const response = await fetch(
      ${JSON.stringify(absoluteApiBase())} + ${JSON.stringify(path)},
      { credentials: 'include', ...${JSON.stringify(init)} },
    );
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  })()`);
}

async function probeAuth(driver: AgentBrowserDriver): Promise<AuthProbe> {
  const response = await pageRequest<{ user?: { isGuest?: unknown } }>(
    driver,
    '/api/auth/me',
  );
  return {
    status: response.status,
    isGuest:
      response.status === 200 && typeof response.body?.user?.isGuest === 'boolean'
        ? response.body.user.isGuest
        : null,
  };
}

async function probeAvatar(driver: AgentBrowserDriver): Promise<AvatarProbe> {
  const response = await pageRequest<{ avatar?: { clawTokens?: unknown } }>(
    driver,
    '/api/avatars/me',
  );
  const value = response.body?.avatar?.clawTokens;
  return {
    status: response.status,
    balance:
      response.status === 200 && typeof value === 'number' && Number.isFinite(value)
        ? value
        : null,
  };
}

async function createPrivateCashTable(
  driver: AgentBrowserDriver,
): Promise<TableProbe> {
  const response = await pageRequest<{
    ok?: unknown;
    table?: { id?: unknown };
  }>(
    driver,
    '/api/cove/poker/cash/tables',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'private',
        buyInCt: 200,
        smallBlindCt: 1,
        bigBlindCt: 2,
        maxSeats: 6,
      }),
    },
  );
  const id = response.body?.table?.id;
  return {
    status: response.status,
    id:
      response.status === 201
      && response.body?.ok === true
      && typeof id === 'string'
      && id.length > 0
        ? id
        : null,
  };
}

async function saveBrowserState(
  session: string,
  path: string,
): Promise<void> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await new Promise<{ exitCode: number; stderr: string }>(
    (resolveResult, reject) => {
      const proc = spawn(
        agentBrowserExecutable(),
        ['--session', session, 'state', 'save', outputPath],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      let stderr = '';
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('guest state save timed out after 30s'));
      }, 30_000);
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
      proc.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.once('exit', (code) => {
        clearTimeout(timeout);
        resolveResult({ exitCode: code ?? 1, stderr });
      });
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `guest state save failed (exit ${result.exitCode})${
        result.stderr.trim() ? `: ${result.stderr.trim()}` : ''
      }`,
    );
  }
}

async function launchSavedStateSession(
  session: string,
  statePath: string,
): Promise<void> {
  const result = await new Promise<{ exitCode: number }>(
    (resolveResult, reject) => {
      const proc = spawn(
        agentBrowserExecutable(),
        [
          '--session',
          session,
          '--state',
          resolve(statePath),
          'open',
          '--init-script',
          resolve('scripts/parity/capture-hook.js'),
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
        },
      );
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('saved-state browser launch timed out after 240s'));
      }, 240_000);
      proc.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      // Match the shared driver's proven lifecycle contract: resolve on exit,
      // not close, because daemon/browser descendants can inherit pipe handles.
      proc.once('exit', (code) => {
        clearTimeout(timeout);
        setTimeout(
          () => resolveResult({ exitCode: code ?? 1 }),
          400,
        );
      });
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `saved-state browser launch failed (exit ${result.exitCode})`,
    );
  }
}

async function openProfile(
  statePath: string | null,
  purpose: string,
  path: '/sw.js' | '/game',
): Promise<AgentBrowserDriver> {
  const session =
    `cove-pack-preflight-${purpose}-${Date.now().toString(36)}`;
  // Loading --state on every CLI command resets the session before each
  // wait/eval. Apply it exactly once at launch, then attach a state-less
  // driver to that same daemon session for all subsequent commands.
  const driver = new AgentBrowserDriver(session, null);
  try {
    if (statePath) {
      await launchSavedStateSession(session, statePath);
      const url = `${webBase()}${path}`;
      await driver.evalJson(
        `(() => { location.assign(${JSON.stringify(url)}); return true; })()`,
      );
      await driver.waitFn(
        `location.pathname === ${JSON.stringify(path)}`,
        90_000,
      );
    } else {
      await driver.openWithInitScript(
        `${webBase()}${path}`,
        'scripts/parity/capture-hook.js',
      );
    }
    return driver;
  } catch (error) {
    await driver.close().catch(() => undefined);
    throw error;
  }
}

async function ensureGuestProfile(): Promise<void> {
  let existing: AgentBrowserDriver | null = null;
  try {
    // Use a same-origin static document: authenticated guests are redirected
    // by app routes, while /sw.js remains stable and still permits eval/fetch.
    existing = await openProfile(guestStatePath(), 'guest-verify', '/sw.js');
    const auth = await probeAuth(existing);
    if (auth.status === 200 && auth.isGuest === true) {
      console.log('PREFLIGHT guest auth: PASS (existing guest state)');
      return;
    }
    console.warn(
      `PREFLIGHT guest auth: STALE (status=${auth.status}, guest=${String(auth.isGuest)}); auto-re-minting anonymous guest`,
    );
  } catch (error) {
    console.warn(
      `PREFLIGHT guest auth: unreadable/stale state; auto-re-minting anonymous guest (${String(error)})`,
    );
  } finally {
    await existing?.close().catch(() => undefined);
  }

  const remint = await openProfile(null, 'guest-remint', '/game');
  try {
    const minted = await pageRequest<unknown>(
      remint,
      '/api/auth/guest',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    if (minted.status !== 200) {
      throw new Error(`anonymous guest mint returned HTTP ${minted.status}`);
    }
    const verified = await probeAuth(remint);
    if (verified.status !== 200 || verified.isGuest !== true) {
      throw new Error(
        `new guest failed authentication check (status=${verified.status}, guest=${String(verified.isGuest)})`,
      );
    }
    await saveBrowserState(remint.session, guestStatePath());
    console.log('PREFLIGHT guest auth: PASS (anonymous guest re-minted and state saved)');
  } finally {
    await remint.close().catch(() => undefined);
  }
}

async function verifyLiveProfileAndPrepareTable(): Promise<string> {
  // App routes redirect based on loaded identity. The same-origin /sw.js
  // document is stable while retaining the page-context fetch/cookie behavior.
  const driver = await openProfile(liveStatePath(), 'live-verify', '/sw.js');
  try {
    const auth = await probeAuth(driver);
    if (auth.status !== 200 || auth.isGuest !== false) {
      throw new Error(
        `PREFLIGHT REFUSED: live profile is not an authenticated non-guest (status=${auth.status}, guest=${String(auth.isGuest)}); re-minting it requires orchestrator credentials`,
      );
    }
    console.log('PREFLIGHT live auth: PASS (authenticated non-guest)');

    const avatar = await probeAvatar(driver);
    if (avatar.status !== 200 || avatar.balance === null) {
      throw new Error(
        `PREFLIGHT REFUSED: live vCLAW balance could not be read (status=${avatar.status})`,
      );
    }
    console.log(
      `PREFLIGHT live balance: ${avatar.balance} vCLAW (floor ${LIVE_BALANCE_FLOOR} vCLAW)`,
    );
    if (avatar.balance < LIVE_BALANCE_FLOOR) {
      throw new Error(
        `PREFLIGHT REFUSED: live balance ${avatar.balance} vCLAW is below floor ${LIVE_BALANCE_FLOOR} vCLAW; top-up is an orchestrator/founder action`,
      );
    }

    let createFailure: string;
    try {
      const table = await createPrivateCashTable(driver);
      if (table.id) {
        console.log(
          `PREFLIGHT cash table: created fresh private table ${table.id}`,
        );
        return table.id;
      }
      createFailure = `HTTP ${table.status}`;
    } catch (error) {
      // Do not echo a browser error body: request/daemon messages can contain
      // state paths or page details. The operational class is sufficient for
      // a loud fallback while keeping auth material out of logs.
      const message = error instanceof Error ? error.message : '';
      createFailure =
        /timed out/i.test(message)
          ? 'request timed out'
          : /agent-browser exited/i.test(message)
            ? 'browser command failed'
            : `request threw ${error instanceof Error ? error.name : 'unknown error'}`;
    }

    const fallback = process.env.CV_PARITY_CASH_TABLE_ID?.trim();
    if (!fallback) {
      throw new Error(
        `PREFLIGHT REFUSED: fresh private cash table creation failed (${createFailure}) and CV_PARITY_CASH_TABLE_ID fallback is empty`,
      );
    }
    console.warn(
      `PREFLIGHT cash table: CREATION FAILED (${createFailure}); LOUD FALLBACK to CV_PARITY_CASH_TABLE_ID=${fallback}`,
    );
    return fallback;
  } finally {
    await driver.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  await ensureGuestProfile();
  const cashTableId = await verifyLiveProfileAndPrepareTable();
  console.log(`PACK_CASH_TABLE_ID=${cashTableId}`);
  console.log('PACK-PREFLIGHT-PASS');
}

void main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
