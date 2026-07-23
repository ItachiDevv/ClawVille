import type { AgentBrowserDriver } from './driver';
import type { FixtureRunHandle } from './teardown';

interface FixtureIssueConfig {
  apiBase: string;
  maxLossPerRun: number;
  maxDurationMs: number;
}

/**
 * Build the one page-context transaction which issues a fixture run, reconciles
 * an abandoned predecessor when the API requests it, and retries once.
 *
 * Deliberately, the recovery token only ever exists in this returned script's
 * page-local closure and `window.__CV_TEST_FIXTURE_HEADER`. The Bun process
 * receives only the replacement run id.
 */
export function buildFixtureIssueScript(
  scenarioName: string,
  config: FixtureIssueConfig,
  cashTableId: string | null,
  preflightOnly = false,
): string {
  const base = config.apiBase.replace(/\/$/, '');
  const issueBody = {
    scenarioName,
    exposureBudgetCt: config.maxLossPerRun,
    ttlSeconds: Math.max(60, Math.ceil(config.maxDurationMs / 1_000)),
  };
  return `(async () => {
    const apiBase = ${JSON.stringify(base)};
    const requestedCashTableId = ${JSON.stringify(cashTableId)};
    const preflightOnly = ${JSON.stringify(preflightOnly)};
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
    const requestRun = () => mutate(
      '/api/cove/test-fixture/run',
      ${JSON.stringify(issueBody)},
    );
    const requireOk = (result, operation) => {
      if (!result.ok) {
        throw new Error(operation + ' failed with status ' + result.status);
      }
      return result.body;
    };
    const closeBlackjack = async () => {
      const session = requireOk(
        await json('/api/cove/blackjack/session/current'),
        'blackjack recovery current session',
      );
      const shoeId = session?.shoe?.id;
      if (typeof shoeId !== 'string') {
        throw new Error('blackjack recovery could not prove an open shoe');
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = requireOk(
          await json('/api/cove/blackjack/hand/current'),
          'blackjack recovery current hand',
        );
        if (current?.hand === null) break;
        if (
          typeof current?.handId !== 'string'
          || !Array.isArray(current.playerHands)
        ) {
          throw new Error('blackjack recovery could not resolve the live hand');
        }
        const handSlot = current.playerHands.findIndex(
          (hand) => hand?.isResolved !== true,
        );
        if (handSlot < 0) {
          throw new Error('blackjack recovery found no legal active slot');
        }
        requireOk(
          await mutate('/api/cove/blackjack/action', {
            handId: current.handId,
            action: 'stand',
            handSlot,
          }),
          'blackjack recovery stand',
        );
      }
      const settled = requireOk(
        await json('/api/cove/blackjack/hand/current'),
        'blackjack recovery settlement proof',
      );
      if (settled?.hand !== null) {
        throw new Error('blackjack recovery did not settle every active slot');
      }
      requireOk(
        await mutate('/api/cove/blackjack/session/close', { shoeId }),
        'blackjack recovery close shoe',
      );
      const proof = await json('/api/cove/blackjack/session/current');
      if (proof.status !== 403 && proof.status !== 404) {
        throw new Error(
          'blackjack recovery open-shoe proof failed with status ' + proof.status,
        );
      }
    };
    const closePractice = async () => {
      const current = requireOk(
        await json('/api/cove/holdem/session/current'),
        'practice recovery current session',
      );
      const tableId = current?.table?.id;
      if (typeof tableId !== 'string') {
        throw new Error('practice recovery could not prove an open table');
      }
      if (current?.hand && typeof current.hand.id === 'string') {
        requireOk(
          await mutate('/api/cove/holdem/action', {
            handId: current.hand.id,
            action: 'fold',
          }),
          'practice recovery zero-exposure fold',
        );
      }
      requireOk(
        await mutate('/api/cove/holdem/session/close', { tableId }),
        'practice recovery close table',
      );
      const proof = await json('/api/cove/holdem/session/current');
      if (proof.status !== 404) {
        throw new Error(
          'practice recovery open-table proof failed with status ' + proof.status,
        );
      }
    };
    const closeCash = async () => {
      if (typeof requestedCashTableId !== 'string' || !requestedCashTableId) {
        throw new Error(
          'cash recovery requires the configured isolated fixture table id',
        );
      }
      const avatar = requireOk(
        await json('/api/avatars/me'),
        'cash recovery current avatar',
      )?.avatar;
      if (typeof avatar?.id !== 'string') {
        throw new Error('cash recovery could not resolve the fixture owner');
      }
      const walletBefore = Number(avatar.clawTokens);
      if (!Number.isSafeInteger(walletBefore)) {
        throw new Error('cash recovery could not resolve the owner wallet');
      }
      const tablePath = '/api/cove/poker/cash/tables/'
        + encodeURIComponent(requestedCashTableId);
      let actionSeq = 0;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const stateResult = await json(tablePath);
        if (stateResult.status === 404) {
          throw new Error('cash recovery isolated table is missing');
        }
        const state = requireOk(stateResult, 'cash recovery public state');
        const seated = state?.seats?.some(
          (seat) => seat?.avatarId === avatar.id && seat?.status !== 'left',
        );
        if (!seated) return;
        const viewResult = await json(tablePath + '/state-for-agent');
        if (viewResult.status === 409) {
          const leave = requireOk(
            await json(tablePath + '/leave', { method: 'POST' }),
            'cash recovery Walk Away',
          );
          const cashedOutCt = Number(leave?.cashedOutCt);
          const ledgerId = leave?.cashOutLedgerTxnId;
          if (
            leave?.queued === true
            || !Number.isSafeInteger(cashedOutCt)
            || cashedOutCt < 0
            || (cashedOutCt > 0 && typeof ledgerId !== 'string')
          ) {
            throw new Error(
              'cash recovery Walk Away lacked immediate ledger proof',
            );
          }
          const [afterTable, afterAvatar] = await Promise.all([
            json(tablePath),
            json('/api/avatars/me'),
          ]);
          const tableProof = requireOk(
            afterTable,
            'cash recovery seat-absence proof',
          );
          const walletAfter = Number(requireOk(
            afterAvatar,
            'cash recovery wallet proof',
          )?.avatar?.clawTokens);
          const absent = !tableProof?.seats?.some(
            (seat) => seat?.avatarId === avatar.id && seat?.status !== 'left',
          );
          if (
            !absent
            || !Number.isSafeInteger(walletAfter)
            || walletAfter - walletBefore !== cashedOutCt
          ) {
            throw new Error('cash recovery settlement proof failed');
          }
          return;
        }
        if (!viewResult.ok) {
          throw new Error(
            'cash recovery private state failed with status ' + viewResult.status,
          );
        }
        if (viewResult.ok && viewResult.body?.view?.isYourTurn === true) {
          const view = viewResult.body.view;
          const legal = Array.isArray(view.legalActions) ? view.legalActions : [];
          const kind = legal.includes('check')
            ? 'check'
            : legal.includes('fold')
              ? 'fold'
              : null;
          if (!kind || !Number.isSafeInteger(view.handNumber)) {
            throw new Error(
              'cash recovery refused a positive-exposure or malformed action',
            );
          }
          requireOk(
            await mutate(tablePath + '/action', {
              handNumber: view.handNumber,
              actionSeq: actionSeq++,
              action: { kind },
            }),
            'cash recovery zero-exposure action',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('cash recovery timed out before a safe Walk Away boundary');
    };
    const recover = async (recovery) => {
      if (
        !recovery
        || typeof recovery.runId !== 'string'
        || typeof recovery.token !== 'string'
      ) {
        throw new Error('fixture recovery response was malformed');
      }
      const allowed = new Set([
        'blackjack_hand_requires_settlement',
        'practice_ledger_recovery_required',
        'cash_recovery_required',
      ]);
      if (!allowed.has(recovery.reason)) {
        throw new Error('fixture recovery reason was not recognized');
      }
      window.__CV_SET_FIXTURE_HEADER?.(recovery.runId + '.' + recovery.token);
      try {
        if (recovery.reason === 'blackjack_hand_requires_settlement') {
          await closeBlackjack();
        } else if (recovery.reason === 'practice_ledger_recovery_required') {
          await closePractice();
        } else {
          await closeCash();
        }
        requireOk(
          await json(
            '/api/cove/test-fixture/run/' + encodeURIComponent(recovery.runId),
            { method: 'DELETE' },
          ),
          'fixture recovery stale-run delete',
        );
      } finally {
        window.__CV_SET_FIXTURE_HEADER?.();
      }
    };
    const finishIssued = async (body) => {
      if (
        typeof body?.runId !== 'string'
        || typeof body?.token !== 'string'
      ) {
        throw new Error('fixture issue response was malformed');
      }
      if (!preflightOnly) {
        window.__CV_RELEASE_FIXTURE_GATE?.(body.runId + '.' + body.token);
        return { runId: body.runId };
      }
      window.__CV_SET_FIXTURE_HEADER?.(body.runId + '.' + body.token);
      try {
        requireOk(
          await json(
            '/api/cove/test-fixture/run/' + encodeURIComponent(body.runId),
            { method: 'DELETE' },
          ),
          'fixture owner preflight delete',
        );
      } finally {
        window.__CV_SET_FIXTURE_HEADER?.();
      }
      return { clean: true };
    };

    const first = await requestRun();
    if (first.ok) {
      return finishIssued(first.body);
    }
    if (
      first.status !== 409
      || first.body?.error !== 'fixture_recovery_required'
    ) {
      throw new Error('fixture issue failed with status ' + first.status);
    }
    await recover(first.body.recovery);
    const retry = await requestRun();
    if (!retry.ok) {
      throw new Error('fixture retry failed with status ' + retry.status);
    }
    return finishIssued(retry.body);
  })()`;
}

export async function preflightFixtureOwnerRecovery(
  driver: AgentBrowserDriver,
  scenarioName: string,
  config: FixtureIssueConfig,
  cashTableId: string | null,
): Promise<void> {
  const result = await driver.evalJson<{ clean: boolean }>(
    buildFixtureIssueScript(scenarioName, config, cashTableId, true),
  );
  if (result.clean !== true) {
    throw new Error('fixture owner preflight did not prove clean');
  }
}

export async function issueFixtureWithRecovery(
  driver: AgentBrowserDriver,
  scenarioName: string,
  config: FixtureIssueConfig,
  cashTableId: string | null,
): Promise<FixtureRunHandle> {
  return driver.evalJson<FixtureRunHandle>(
    buildFixtureIssueScript(scenarioName, config, cashTableId),
  );
}
