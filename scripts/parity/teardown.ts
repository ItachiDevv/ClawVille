import type { Driver } from './driver';

export interface FixtureRunHandle {
  runId: string;
}

export interface PracticeHoldemReconciliation {
  clean: true;
  reconciled: boolean;
  absentStatus: number;
}

export function buildPracticeHoldemReconciliationScript(
  apiBase: string,
): string {
  const base = apiBase.replace(/\/$/, '');
  return `(async () => {
    const apiBase = ${JSON.stringify(base)};
    const json = async (path, init = {}) => {
      const response = await fetch(apiBase + path, {
        credentials: 'include',
        ...init,
      });
      let body = null;
      try { body = await response.json(); } catch {}
      return { status: response.status, ok: response.ok, body };
    };
    const mutate = (path, body) => json(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const current = await json('/api/cove/holdem/session/current');
    if (current.status === 404) {
      return { clean: true, reconciled: false, absentStatus: current.status };
    }
    if (!current.ok) {
      throw new Error(
        'practice holdem reconciliation current returned HTTP ' + current.status,
      );
    }
    const tableId = current.body?.table?.id;
    if (typeof tableId !== 'string' || !tableId) {
      throw new Error(
        'practice holdem reconciliation could not resolve the open table',
      );
    }
    const handId = current.body?.hand?.handId;
    if (typeof handId === 'string' && handId) {
      const folded = await mutate('/api/cove/holdem/action', {
        handId,
        action: 'fold',
      });
      if (!folded.ok) {
        throw new Error(
          'practice holdem reconciliation fold returned HTTP ' + folded.status,
        );
      }
    }
    const closed = await mutate('/api/cove/holdem/session/close', { tableId });
    if (!closed.ok) {
      throw new Error(
        'practice holdem reconciliation close returned HTTP ' + closed.status,
      );
    }
    const proof = await json('/api/cove/holdem/session/current');
    if (proof.status !== 404) {
      throw new Error(
        'practice holdem reconciliation absence proof returned HTTP '
        + proof.status,
      );
    }
    return { clean: true, reconciled: true, absentStatus: proof.status };
  })()`;
}

export async function reconcilePracticeHoldemSession(
  driver: Driver,
  apiBase: string,
): Promise<PracticeHoldemReconciliation> {
  const result = await driver.evalJson<PracticeHoldemReconciliation>(
    buildPracticeHoldemReconciliationScript(apiBase),
  );
  if (
    result?.clean !== true
    || typeof result.reconciled !== 'boolean'
    || result.absentStatus !== 404
  ) {
    throw new Error('practice holdem reconciliation returned malformed proof');
  }
  return result;
}

async function clickButtonByText(
  driver: Driver,
  labels: readonly string[],
): Promise<boolean> {
  return driver.evalJson<boolean>(`(() => {
    const labels = ${JSON.stringify(labels)};
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      labels.some((label) => candidate.textContent?.trim().startsWith(label))
      && !candidate.disabled
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function currentStatus(
  driver: Driver,
  game: 'blackjack' | 'baccarat',
  apiBase: string,
): Promise<number> {
  // A busy agent-browser daemon can surface a retry envelope instead of the
  // evaluated value; validate the shape and retry before failing loudly.
  let lastValue: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastValue = await driver.evalJson<unknown>(`(async () => {
      const response = await fetch(
        ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/cove/${game}/session/current',
        { credentials: 'include' },
      );
      return response.status;
    })()`);
    if (typeof lastValue === 'number') return lastValue;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500 * (attempt + 1)));
  }
  throw new Error(
    `${game} session/current probe returned a non-number after 3 attempts: ${JSON.stringify(lastValue)}`,
  );
}

export async function teardownGame(
  driver: Driver,
  game: 'holdem' | 'blackjack' | 'baccarat',
  apiBase: string,
): Promise<void> {
  if (game === 'blackjack') {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      const settled = await driver.evalJson<boolean>(
        `window.__CV_READ_PARITY?.('blackjack-3d')?.dealStep === 'settled'`,
      );
      if (settled) break;
      if (!await clickButtonByText(driver, ['Stand', 'Surrender'])) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    await driver.waitFn(
      `!window.__CV_READ_PARITY?.('blackjack-3d')
        || window.__CV_READ_PARITY?.('blackjack-3d')?.dealStep === 'settled'`,
      20_000,
    );
    if (!await clickButtonByText(driver, ['Walk Away', 'Close'])) {
      throw new Error('blackjack teardown could not find Walk Away/Close');
    }
    await driver.waitFn(
      `!window.__CV_READ_PARITY?.('blackjack-3d')`,
      10_000,
    );
    const status = await currentStatus(driver, 'blackjack', apiBase);
    if (![403, 404].includes(status)) {
      throw new Error(`blackjack teardown verification returned ${status}`);
    }
    return;
  }
  if (game === 'baccarat') {
    await driver.waitFn(
      `!window.__CV_READ_PARITY?.('baccarat-3d')
        || window.__CV_READ_PARITY?.('baccarat-3d')?.transition === 'idle'`,
      15_000,
    );
    if (!await clickButtonByText(driver, ['Walk Away', 'Close'])) {
      throw new Error('baccarat teardown could not find Walk Away/Close');
    }
    await driver.waitFn(
      `!window.__CV_READ_PARITY?.('baccarat-3d')`,
      10_000,
    );
    const status = await currentStatus(driver, 'baccarat', apiBase);
    if (![403, 404].includes(status)) {
      throw new Error(`baccarat teardown verification returned ${status}`);
    }
    return;
  }
  const cashHud = await driver.evalJson<boolean>(
    `Boolean(document.querySelector('[data-testid="cash-table-room-hud"]'))`,
  );
  if (!cashHud) {
    await reconcilePracticeHoldemSession(driver, apiBase);
    await driver.evalJson(`(() => { location.href = '/cove'; return true; })()`);
    return;
  }
  const before = await driver.evalJson<{
    tableId: string;
    avatarId: string;
    wallet: number;
  }>(`(async () => {
    const tableId = new URL(location.href).searchParams.get('tableId') ?? '';
    const response = await fetch(
      ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/avatars/me',
      { credentials: 'include' },
    );
    const body = await response.json();
    return {
      tableId,
      avatarId: String(body.avatar?.id ?? ''),
      wallet: Number(body.avatar?.clawTokens),
    };
  })()`);
  if (!before.tableId || !before.avatarId || !Number.isSafeInteger(before.wallet)) {
    throw new Error('cash holdem teardown could not resolve table/avatar/wallet');
  }
  if (!await clickButtonByText(driver, ['Leave', 'Walk Away'])) {
    throw new Error('cash holdem teardown could not find Leave/Walk Away');
  }
  await driver.waitFn(
    `!document.querySelector('[data-testid="cash-table-room-hud"]')`,
    30_000,
  );
  const proof = await driver.evalJson<{
    queued: boolean;
    cashedOutCt: number;
    cashOutLedgerTxnId: string | null;
    seatAbsent: boolean;
    walletDelta: number;
  }>(`(async () => {
    const records = window.__CV_WIRE_ALL?.() ?? [];
    const leave = [...records].reverse().find((record) =>
      record.method === 'POST'
      && record.urlSuffix === 'poker/cash/tables/${before.tableId}/leave'
    );
    const leaveBody = leave?.responseBody ?? {};
    const [tableResponse, avatarResponse] = await Promise.all([
      fetch(
        ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/cove/poker/cash/tables/${before.tableId}',
        { credentials: 'include' },
      ),
      fetch(
        ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/avatars/me',
        { credentials: 'include' },
      ),
    ]);
    const tableBody = await tableResponse.json();
    const avatarBody = await avatarResponse.json();
    return {
      queued: leaveBody.queued === true,
      cashedOutCt: Number(leaveBody.cashedOutCt),
      cashOutLedgerTxnId:
        typeof leaveBody.cashOutLedgerTxnId === 'string'
          ? leaveBody.cashOutLedgerTxnId
          : null,
      seatAbsent: !tableBody.seats?.some(
        (seat) => seat.avatarId === ${JSON.stringify(before.avatarId)}
      ),
      walletDelta: Number(avatarBody.avatar?.clawTokens) - ${before.wallet},
    };
  })()`);
  if (proof.queued) {
    throw new Error(
      'cash holdem teardown queued leave lacks an observable final cashOutLedgerTxnId; rerun from a between-hands boundary',
    );
  }
  if (
    !Number.isSafeInteger(proof.cashedOutCt)
    || proof.cashedOutCt < 0
    || (proof.cashedOutCt > 0 && !proof.cashOutLedgerTxnId)
    || !proof.seatAbsent
    || proof.walletDelta !== proof.cashedOutCt
  ) {
    throw new Error(
      `cash holdem teardown proof failed (amount=${proof.cashedOutCt}, ledger=${Boolean(
        proof.cashOutLedgerTxnId,
      )}, absent=${proof.seatAbsent}, walletDelta=${proof.walletDelta})`,
    );
  }
}

export async function closeFixtureRun(
  driver: Driver,
  fixture: FixtureRunHandle | null,
  apiBase: string,
): Promise<void> {
  if (!fixture) return;
  const closed = await driver.evalJson<boolean>(`(async () => {
    const response = await fetch(
      ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/cove/test-fixture/run/' + ${JSON.stringify(fixture.runId)},
      { method: 'DELETE', credentials: 'include' },
    );
    window.__CV_TEST_FIXTURE_HEADER = undefined;
    return response.ok || response.status === 404;
  })()`);
  if (!closed) {
    throw new Error(`fixture teardown failed for run ${fixture.runId}`);
  }
}
