import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import postgres from '../../apps/api/node_modules/postgres/src/index.js';
import {
  AgentBrowserDriver,
  agentBrowserExecutable,
} from './driver';
import {
  DEFAULT_CASH_TABLE_STATE_PATH,
  readPersistedCashTableState,
  writePersistedCashTableState,
} from './pack-cash-table-state';

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
  id: string | null;
  balance: number | null;
}

interface ExistingTableProbe {
  status: number;
  isOpen: boolean;
  playableHouse: boolean;
}

interface OwnedPrivateTableProbe {
  joinCode: string | null;
  seededAgentSlots: number;
  activeSeats: number;
  unsettledHands: number;
  escrowCt: number;
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

function cashTableStatePath(): string {
  return process.env.CV_PARITY_CASH_TABLE_STATE
    ?? DEFAULT_CASH_TABLE_STATE_PATH;
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
  const response = await pageRequest<{
    avatar?: { id?: unknown; clawTokens?: unknown };
  }>(
    driver,
    '/api/avatars/me',
  );
  const value = response.body?.avatar?.clawTokens;
  const id = response.body?.avatar?.id;
  return {
    status: response.status,
    id:
      response.status === 200 && typeof id === 'string' && id.length > 0
        ? id
        : null,
    balance:
      response.status === 200 && typeof value === 'number' && Number.isFinite(value)
        ? value
        : null,
  };
}

async function inspectOwnedPrivateTable(
  tableId: string,
  avatarId: string,
): Promise<OwnedPrivateTableProbe | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl
    || !databaseUrl.includes('mtpixvtclsjqjguouxes')
  ) {
    return null;
  }
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 20,
  });
  try {
    const rows = await sql`
      SELECT
        t.join_code,
        t.seeded_agent_slots,
        t.table_escrow_ct,
        count(DISTINCT s.id) FILTER (
          WHERE s.status <> 'left'
        )::int AS active_seats,
        count(DISTINCT h.id) FILTER (
          WHERE h.settled_at IS NULL
        )::int AS unsettled_hands
      FROM poker_cash_tables t
      LEFT JOIN poker_cash_seats s ON s.table_id = t.id
      LEFT JOIN poker_cash_hands h ON h.table_id = t.id
      WHERE t.id = ${tableId}
        AND t.created_by = ${avatarId}
        AND t.visibility = 'private'
        AND t.status = 'open'
      GROUP BY t.id
    `;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    const escrowCt = Number(row.table_escrow_ct);
    if (
      !Number.isSafeInteger(escrowCt)
      || !Number.isSafeInteger(row.seeded_agent_slots)
      || !Number.isSafeInteger(row.active_seats)
      || !Number.isSafeInteger(row.unsettled_hands)
    ) {
      return null;
    }
    return {
      joinCode:
        typeof row.join_code === 'string' && row.join_code.length > 0
          ? row.join_code
          : null,
      seededAgentSlots: row.seeded_agent_slots,
      activeSeats: row.active_seats,
      unsettledHands: row.unsettled_hands,
      escrowCt,
    };
  } finally {
    await sql.end();
  }
}

async function retireOwnedEmptyLegacyTable(
  tableId: string,
  avatarId: string,
): Promise<boolean> {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl
    || !databaseUrl.includes('mtpixvtclsjqjguouxes')
  ) {
    return false;
  }
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 20,
  });
  try {
    const rows = await sql`
      UPDATE poker_cash_tables t
      SET status = 'closed', updated_at = now()
      WHERE t.id = ${tableId}
        AND t.created_by = ${avatarId}
        AND t.source = 'private'
        AND t.visibility = 'private'
        AND t.status = 'open'
        AND t.table_escrow_ct = '0'
        AND NOT EXISTS (
          SELECT 1 FROM poker_cash_seats s
          WHERE s.table_id = t.id AND s.status <> 'left'
        )
        AND NOT EXISTS (
          SELECT 1 FROM poker_cash_hands h
          WHERE h.table_id = t.id AND h.settled_at IS NULL
        )
      RETURNING t.id
    `;
    return rows.length === 1;
  } finally {
    await sql.end();
  }
}

async function selectPlayableHouseCashTable(
  driver: AgentBrowserDriver,
): Promise<string | null> {
  const response = await pageRequest<{
    tables?: Array<{
      id?: unknown;
      source?: unknown;
      tierKey?: unknown;
      buyInCt?: unknown;
      maxSeats?: unknown;
      occupiedSeats?: unknown;
      status?: unknown;
    }>;
  }>(
    driver,
    '/api/cove/poker/cash/tables?limit=50',
  );
  if (response.status !== 200 || !Array.isArray(response.body?.tables)) {
    return null;
  }
  const candidates = response.body.tables
    .filter((table) =>
      typeof table.id === 'string'
      && table.source === 'house'
      && table.tierKey === 'low'
      && Number(table.buyInCt) === 200
      && table.status === 'open'
      && Number.isSafeInteger(table.maxSeats)
      && Number.isSafeInteger(table.occupiedSeats)
      && Number(table.occupiedSeats) >= 1
      && Number(table.occupiedSeats) < Number(table.maxSeats)
    )
    .sort((left, right) =>
      Number(right.occupiedSeats) - Number(left.occupiedSeats)
      || String(left.id).localeCompare(String(right.id))
    );
  return candidates[0]?.id as string | undefined ?? null;
}

async function probeExistingCashTable(
  driver: AgentBrowserDriver,
  tableId: string,
): Promise<ExistingTableProbe> {
  const response = await pageRequest<{
    ok?: unknown;
    table?: {
      id?: unknown;
      source?: unknown;
      tierKey?: unknown;
      buyInCt?: unknown;
      maxSeats?: unknown;
      status?: unknown;
    };
    seats?: unknown[];
  }>(
    driver,
    `/api/cove/poker/cash/tables/${encodeURIComponent(tableId)}`,
  );
  return {
    status: response.status,
    isOpen:
      response.status === 200
      && response.body?.ok === true
      && response.body?.table?.id === tableId
      && response.body?.table?.status === 'open',
    playableHouse:
      response.status === 200
      && response.body?.table?.id === tableId
      && response.body?.table?.source === 'house'
      && response.body?.table?.tierKey === 'low'
      && Number(response.body?.table?.buyInCt) === 200
      && response.body?.table?.status === 'open'
      && Array.isArray(response.body?.seats)
      && response.body.seats.length >= 1
      && response.body.seats.length < Number(response.body.table.maxSeats),
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

    let persistedState = await readPersistedCashTableState(
      cashTableStatePath(),
    );
    const ownedPrivateTable =
      persistedState?.tableId && avatar.id
        ? await inspectOwnedPrivateTable(
            persistedState.tableId,
            avatar.id,
          )
        : null;
    if (persistedState?.tableId && ownedPrivateTable) {
      if (!persistedState.joinCode && ownedPrivateTable.joinCode) {
        persistedState = {
          tableId: persistedState.tableId,
          joinCode: ownedPrivateTable.joinCode,
        };
        await writePersistedCashTableState(
          cashTableStatePath(),
          persistedState,
        );
        console.log(
          'PREFLIGHT cash table: recovered legacy owner access into ignored state',
        );
      }
      if (
        ownedPrivateTable.activeSeats === 0
        && ownedPrivateTable.unsettledHands === 0
        && ownedPrivateTable.escrowCt === 0
      ) {
        const retired = await retireOwnedEmptyLegacyTable(
          persistedState.tableId,
          avatar.id!,
        );
        if (retired) {
          console.warn(
            `PREFLIGHT cash table: retired verified-empty non-playable private table ${persistedState.tableId}`,
          );
          persistedState = null;
        }
      }
    }
    if (persistedState?.tableId) {
      try {
        const persisted = await probeExistingCashTable(
          driver,
          persistedState.tableId,
        );
        if (
          persisted.isOpen
          && (
            persisted.playableHouse
            || Boolean(persistedState.joinCode)
          )
        ) {
          console.log(
            `PREFLIGHT cash table: reused persisted open table ${persistedState.tableId}`,
          );
          return persistedState.tableId;
        }
        console.warn(
          `PREFLIGHT cash table: persisted table unavailable or non-playable (HTTP ${persisted.status}); selecting house table`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const failure =
          /timed out/i.test(message)
            ? 'request timed out'
            : /agent-browser exited/i.test(message)
              ? 'browser command failed'
              : `request threw ${error instanceof Error ? error.name : 'unknown error'}`;
        console.warn(
          `PREFLIGHT cash table: persisted table check failed (${failure}); selecting house table`,
        );
      }
    } else {
      console.log(
        'PREFLIGHT cash table: no persisted playable table; selecting house table',
      );
    }

    const selected = await selectPlayableHouseCashTable(driver);
    if (selected) {
      const selectedProbe = await probeExistingCashTable(driver, selected);
      if (selectedProbe.playableHouse) {
        await writePersistedCashTableState(cashTableStatePath(), {
          tableId: selected,
          joinCode: null,
        });
        console.log(
          `PREFLIGHT cash table: selected and persisted playable low house table ${selected}`,
        );
        return selected;
      }
    }

    const fallback = process.env.CV_PARITY_CASH_TABLE_ID?.trim();
    if (!fallback) {
      throw new Error(
        'PREFLIGHT REFUSED: no playable low house cash table and CV_PARITY_CASH_TABLE_ID fallback is empty',
      );
    }
    const fallbackProbe = await probeExistingCashTable(driver, fallback);
    if (!fallbackProbe.playableHouse) {
      throw new Error(
        `PREFLIGHT REFUSED: CV_PARITY_CASH_TABLE_ID fallback is not a playable low house table (status=${fallbackProbe.status})`,
      );
    }
    console.warn(
      `PREFLIGHT cash table: LOUD VERIFIED-PLAYABLE FALLBACK to CV_PARITY_CASH_TABLE_ID=${fallback}`,
    );
    await writePersistedCashTableState(cashTableStatePath(), {
      tableId: fallback,
      joinCode: null,
    });
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
