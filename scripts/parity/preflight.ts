import type { Driver } from './driver';
import {
  reconcilePracticeHoldemSession,
  teardownGame,
} from './teardown';
import type { Surface } from './types';

export interface PreflightResult {
  clean: boolean;
  notes: string[];
}

async function browserRequest<T>(
  driver: Driver,
  apiBase: string,
  path: string,
  init: Record<string, unknown> = {},
): Promise<{ status: number; body: T | null }> {
  return driver.evalJson<{ status: number; body: T | null }>(`(async () => {
    const response = await fetch(
      ${JSON.stringify(apiBase.replace(/\/$/, ''))} + ${JSON.stringify(path)},
      { credentials: 'include', ...${JSON.stringify(init)} },
    );
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  })()`);
}

/**
 * Reconcile only states with a bounded, proof-bearing normal close path.
 * Anything else remains read-only and refuses the run with explicit notes.
 */
export async function preflight(
  driver: Driver,
  game: 'holdem' | 'blackjack' | 'baccarat',
  surface: Surface,
  apiBase: string,
): Promise<PreflightResult> {
  const notes: string[] = [];
  if (game === 'blackjack' || game === 'baccarat') {
    let current = await browserRequest<unknown>(
      driver,
      apiBase,
      `/api/cove/${game}/session/current`,
    );
    if (current.status === 200) {
      const uiReady = await driver.evalJson<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(
          game === 'blackjack'
            ? surface === 'blackjack-2d'
              // BlackjackModal.tsx:1363-1367 emits this dialog label.
              ? '[aria-label="Blackjack table"]'
              : '[data-testid="seated-blackjack-hud"]'
            : surface === 'baccarat-2d'
              // BaccaratModal.tsx:551-553 emits this dialog label.
              ? '[aria-label="Baccarat table"]'
              : '[aria-label="Baccarat controls"]',
        )}))`,
      );
      if (uiReady) {
        await teardownGame(driver, game, surface, apiBase);
        current = await browserRequest<unknown>(
          driver,
          apiBase,
          `/api/cove/${game}/session/current`,
        );
        if (current.status === 200) {
          notes.push(`${game}: reconciliation left an open shoe/session`);
        }
      } else {
        notes.push(`${game}: open shoe/session requires game-UI reconciliation`);
      }
    }
    if (![401, 403, 404].includes(current.status)) {
      notes.push(`${game}: unexpected preflight status ${current.status}`);
    }
  }
  if (game === 'holdem') {
    await reconcilePracticeHoldemSession(driver, apiBase);
    const staleCashSeat = await driver.evalJson<boolean>(`(async () => {
      const tableId = new URL(location.href).searchParams.get('tableId');
      if (!tableId) {
        return Boolean(document.querySelector('[data-testid="cash-table-room-hud"]'));
      }
      const [avatarResponse, tableResponse] = await Promise.all([
        fetch(${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/avatars/me', { credentials: 'include' }),
        fetch(
          ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/cove/poker/cash/tables/' + encodeURIComponent(tableId),
          { credentials: 'include' },
        ),
      ]);
      if (!avatarResponse.ok || !tableResponse.ok) return false;
      const avatar = (await avatarResponse.json()).avatar;
      const table = await tableResponse.json();
      return Boolean(
        avatar?.id && table.seats?.some((seat) => seat.avatarId === avatar.id)
      );
    })()`);
    if (staleCashSeat) {
      await driver.waitFn(
        `Boolean(document.querySelector('[data-testid="cash-table-room-hud"]'))`,
        15_000,
      );
      await teardownGame(driver, 'holdem', surface, apiBase);
      const remains = await driver.evalJson<boolean>(`(async () => {
        const tableId = new URL(location.href).searchParams.get('tableId');
        if (!tableId) return false;
        const [avatarResponse, tableResponse] = await Promise.all([
          fetch(${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/avatars/me', { credentials: 'include' }),
          fetch(
            ${JSON.stringify(apiBase.replace(/\/$/, ''))} + '/api/cove/poker/cash/tables/' + encodeURIComponent(tableId),
            { credentials: 'include' },
          ),
        ]);
        if (!avatarResponse.ok || !tableResponse.ok) return true;
        const avatar = (await avatarResponse.json()).avatar;
        const table = await tableResponse.json();
        return Boolean(
          avatar?.id && table.seats?.some((seat) => seat.avatarId === avatar.id)
        );
      })()`);
      if (remains) notes.push('holdem: cash seat remained after leave reconciliation');
    }
  }
  return { clean: notes.length === 0, notes };
}
