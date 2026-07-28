import type { Driver } from '../driver';
import { teardownGame } from '../teardown';
import type {
  ParityCheckpoint,
  ParityGame,
  Surface,
} from '../types';

type UnknownRecord = Record<string, unknown>;
const rec = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const outcomeOf = (wire: unknown): UnknownRecord => {
  const body = rec(wire) ?? {};
  return rec(rec(body.lastCoup)?.outcome ?? body.outcome) ?? body;
};

export function reachedFor(
  game: ParityGame,
  row: string,
  surface?: Surface,
): (wire: unknown) => boolean {
  return (wire) => {
    const body = rec(wire) ?? {};
    const outcome = outcomeOf(wire);
    if (game === 'blackjack') {
      const hands = arr(outcome.playerHands ?? body.playerHands);
      const cards = arr(rec(hands[0])?.cards ?? body.playerHand);
      if (row === 'B2') return cards.length >= 3;
      if (row === 'B3') return cards.length >= 3;
      if (row === 'B4') return arr(rec(outcome.dealer)?.cards).length >= 3;
      if (row === 'B5') return hands.some((hand) => rec(hand)?.isBust === true);
      if (row === 'B6') return hands.some((hand) => rec(hand)?.outcome === 'blackjack');
      if (row === 'B7') return hands.some((hand) => rec(hand)?.outcome === 'push');
      if (row === 'B8') return hands.length === 2 || body.didSplit === true;
      if (row === 'B9') {
        const dealerCards = arr(rec(outcome.dealer)?.cards);
        const terminalAceOffer = rec(dealerCards[0])?.rank === 'A';
        return (body.insuranceOffered === true || terminalAceOffer)
          && (body.tookInsurance === true || rec(outcome.insurance) !== null);
      }
      if (row === 'B1') return cards.length === 2;
      if (row === 'B-neg') {
        const dealer = arr(outcome.dealerHand ?? body.dealerHand);
        const directUpcard = rec(body.dealerUpcard);
        const directHole = rec(body.dealerHoleCard);
        return (body.status === 'in_progress' || outcome.status === 'in_progress')
          && (
            (dealer.length >= 1 && dealer.slice(1).every((card) => (
              card == null
              || rec(card)?.hidden === true
              || Object.keys(rec(card) ?? {}).length === 0
            )))
            || (directUpcard !== null && directHole === null)
          );
      }
      return false;
    }
    if (game === 'baccarat') {
      const player = rec(outcome.player) ?? {};
      const banker = rec(outcome.banker) ?? {};
      if (row === 'C1') return player.isNatural === true;
      if (row === 'C2') return banker.isNatural === true;
      if (row === 'C3') return arr(player.cards).length === 3;
      if (row === 'C4') return arr(banker.cards).length === 3;
      if (row === 'C5') return outcome.winner === 'tie';
      if (row === 'C7') return BigInt(String(outcome.commission ?? '0')) > 0n;
      return Boolean(outcome.winner);
    }
    const directView = rec(body.view);
    const hand = rec(
      body.hand
      ?? body.snapshot
      ?? body.state
      ?? rec(directView)?.table
      ?? body.live,
    ) ?? body;
    const terminal = rec(body.outcome ?? hand.outcome) ?? hand;
    const board = arr(
      terminal.board
      ?? hand.communityCards
      ?? hand.board
      ?? body.communityCards
      ?? body.board,
    );
    const ownHole = arr(
      body.humanHole
      ?? hand.humanHole
      ?? directView?.holeCards
      ?? terminal.humanHole,
    );
    if (row === 'H5' || row === 'H10') return terminal.endedAt === 'showdown';
    if (row === 'H6') return Boolean(terminal.endedAt && terminal.endedAt !== 'showdown');
    if (row === 'H2') return board.length >= 3;
    if (row === 'H3') return board.length >= 4;
    if (row === 'H4' || row === 'H9') return board.length >= 5;
    if (row === 'H1') return ownHole.length === 2;
    if (row === 'H8') {
      if (surface?.startsWith('holdem-felt-')) {
        const tableSeats = arr(body.seats).map(rec).filter(Boolean);
        const liveSeats = arr(rec(body.live)?.seats).map(rec).filter(Boolean);
        // Public cash projection field contract:
        // cash-table-manager.ts:749-760,779-785 emits
        // seats[].{avatarId,isSeeded,stackCt}; cove-cash-poker.ts:433-447
        // publishes that list plus live.seats[].{avatarId,chipStack,status}.
        // holdem-table-room.tsx:931-935 turns active/allin into exactly two
        // concealed felt cards, with cards:null.
        const requesterSeat = tableSeats.find((seat) => (
          seat?.isSeeded === false
          && typeof seat.avatarId === 'string'
          && typeof seat.stackCt === 'string'
        ));
        const requesterLiveSeat = liveSeats.find((seat) => (
          seat?.avatarId === requesterSeat?.avatarId
        ));
        const concealedHoleCardCount = (
          requesterLiveSeat?.status === 'active'
          || requesterLiveSeat?.status === 'allin'
        ) ? 2 : 0;
        return concealedHoleCardCount === 2
          && typeof requesterLiveSeat?.chipStack === 'number'
          && !('holeCards' in (requesterLiveSeat ?? {}));
      }
      return ownHole.length === 2;
    }
    if (row === 'H7') {
      const log = arr(body.publicActionLog);
      // Authoritative blind log types are 'post-sb'/'post-bb' (holdem-engine.ts
      // postBlind, HoldemLogType in @clawville/shared cove-holdem.ts).
      return ownHole.length === 2
        && (body.pot !== undefined || log.some((entry) => (
          ['post-sb', 'post-bb'].includes(String(rec(entry)?.type))
        )));
    }
    if (row === 'H-neg') {
      const publicSeats = arr(
        rec(body.live)?.seats
        ?? rec(rec(body.view)?.table)?.seats
        ?? body.seats,
      );
      const practicePublicShape = Array.isArray(body.humanHole)
        && Array.isArray(body.publicActionLog)
        && !('opponentHoleCards' in body);
      const entitlementReached = surface?.includes('felt')
        ? publicSeats.length > 0 || practicePublicShape
        : ownHole.length === 2;
      return entitlementReached
        && (publicSeats.length > 0 || practicePublicShape)
        && publicSeats.every((rawSeat) => {
          const seat = rec(rawSeat);
          return !seat || !('holeCards' in seat) || arr(seat.holeCards).length === 0;
        });
    }
    return false;
  };
}

export async function clickText(driver: Driver, labels: readonly string[]): Promise<boolean> {
  return driver.evalJson<boolean>(`(() => {
    const labels = ${JSON.stringify(labels)};
    const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      normalizedLabels.some((label) =>
        candidate.textContent?.trim().toLowerCase().startsWith(label)
      )
      && !candidate.disabled
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function waitAndClick(
  driver: Driver,
  labels: readonly string[],
  timeoutMs = 20_000,
): Promise<void> {
  await driver.waitFn(`(() => {
    const labels = ${JSON.stringify(labels)};
    const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
    return [...document.querySelectorAll('button')].some((candidate) =>
      normalizedLabels.some((label) =>
        candidate.textContent?.trim().toLowerCase().startsWith(label)
      )
      && !candidate.disabled
    );
  })()`, timeoutMs);
  if (!await clickText(driver, labels)) {
    throw new Error(`Action disappeared before click: ${labels.join('/')}`);
  }
}

async function waitAndClickWithFloor(
  driver: Driver,
  surface: Surface,
  labels: readonly string[],
  timeoutMs = 20_000,
): Promise<ActionFloor> {
  await driver.waitFn(`(() => {
    const labels = ${JSON.stringify(labels)};
    const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
    return [...document.querySelectorAll('button')].some((candidate) =>
      normalizedLabels.some((label) =>
        candidate.textContent?.trim().toLowerCase().startsWith(label)
      )
      && !candidate.disabled
    );
  })()`, timeoutMs);
  const floor = await captureActionFloor(driver, surface);
  if (!await clickText(driver, labels)) {
    throw new Error(`Action disappeared before click: ${labels.join('/')}`);
  }
  return floor;
}

export async function waitFor2DSurfaceReachable(
  driver: Driver,
  surface: Surface,
): Promise<void> {
  if (surface !== 'blackjack-2d' && surface !== 'baccarat-2d') return;
  const dialogSelector = surface === 'blackjack-2d'
    // BlackjackModal.tsx:1363-1367 emits this dialog label.
    ? '[aria-label="Blackjack table"]'
    // BaccaratModal.tsx:551-553 emits this dialog label.
    : '[aria-label="Baccarat table"]';
  await driver.waitFn(`(() => {
    const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
    if (!dialog) return false;
    // SceneTransition.tsx:193-205 emits a fixed aria-hidden black overlay at
    // z-index 9999, with opacity 0 and pointer-events none after its fade.
    const overlay = [...document.querySelectorAll('div[aria-hidden="true"]')]
      .find((candidate) => {
        const style = getComputedStyle(candidate);
        return style.position === 'fixed'
          && style.zIndex === '9999'
          && style.backgroundColor === 'rgb(0, 0, 0)';
      });
    if (!overlay) return false;
    const style = getComputedStyle(overlay);
    return Number(style.opacity) <= 0.001 && style.pointerEvents === 'none';
  })()`, 20_000);
  await driver.evalJson<boolean>(`new Promise((resolve) => {
    /* CV_2D_OVERLAY_PAINT */
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`);
}

interface PracticeHoldemActionStart {
  clicked: boolean;
  label: string | null;
  actionSeq: number;
  renderRevision: number;
  dealStep: string;
  correlationHand: string;
  actions: string[];
}

interface PracticeHoldemActionProgress {
  actionSeen: boolean;
  actionStatus: number | null;
  expectedRevision: number | null;
  renderRevision: number;
  dealStep: string;
  correlationHand: string;
  actions: string[];
}

async function advancePracticeHoldemStreet(
  driver: Driver,
  surface: Surface,
  expectedDealStep: string,
  expectedCorrelationHand: string,
): Promise<void> {
  const labels = ['Check', 'Call'] as const;
  const existing = await driver.evalJson<boolean>(`(() => {
    /* CV_PRACTICE_EXISTING_STEP */
    return (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .some((entry) => {
        if (entry.dealStep !== ${JSON.stringify(expectedDealStep)}) return false;
        try {
          return JSON.parse(entry.signature)[2]
            === ${JSON.stringify(expectedCorrelationHand)};
        } catch {
          return false;
        }
      });
  })()`);
  if (existing) return;

  await driver.waitFn(`(() => {
    const scope = document.querySelector('[data-testid="holdem-inline-betting"]');
    if (!scope) return false;
    const buttons = [...scope.querySelectorAll('button')];
    return ${JSON.stringify(labels)}.some((label) =>
      buttons.some((button) =>
        button.textContent?.trim().startsWith(label)
        && !button.disabled
        && button.getClientRects().length > 0
      )
    );
  })()`, 30_000);

  const started = await driver.evalJson<PracticeHoldemActionStart>(`(() => {
    /* CV_PRACTICE_ACTION_CLICK */
    const labels = ${JSON.stringify(labels)};
    const scope = document.querySelector('[data-testid="holdem-inline-betting"]');
    const buttons = scope ? [...scope.querySelectorAll('button')] : [];
    const visible = (button) => button.getClientRects().length > 0;
    const action = labels
      .map((label) => buttons.find((button) =>
        button.textContent?.trim().startsWith(label)
        && !button.disabled
        && visible(button)
      ))
      .find(Boolean);
    const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
    const records = window.__CV_WIRE_ALL?.() ?? [];
    const actionSeq = records
      .filter((record) => record.urlSuffix === 'holdem/action')
      .reduce((max, record) => Math.max(max, record.seq), 0);
    const snapshot = buttons
      .filter(visible)
      .map((button) =>
        button.textContent?.trim()
        + (button.disabled ? ' [disabled]' : '')
      );
    if (
      !action
      || !root
      || root.correlation?.hand !== ${JSON.stringify(expectedCorrelationHand)}
    ) {
      return {
        clicked: false,
        label: null,
        actionSeq,
        renderRevision: root?.renderRevision ?? 0,
        dealStep: root?.dealStep ?? 'missing',
        correlationHand: root?.correlation?.hand ?? '',
        actions: snapshot,
      };
    }
    const label = action.textContent?.trim() ?? '';
    const result = {
      clicked: true,
      label,
      actionSeq,
      renderRevision: root.renderRevision,
      dealStep: root.dealStep,
      correlationHand: root.correlation?.hand ?? '',
      actions: snapshot,
    };
    action.click();
    return result;
  })()`);
  if (!started.clicked || !started.correlationHand) {
    throw new Error(
      `Hold'em practice action disappeared before click (actions: ${
        started.actions.join(', ') || 'none'
      })`,
    );
  }
  if (started.correlationHand !== expectedCorrelationHand) {
    throw new Error(
      `Hold'em practice correlation changed before ${expectedDealStep}`,
    );
  }

  const deadline = Date.now() + 45_000;
  let latest: PracticeHoldemActionProgress | null = null;
  while (Date.now() < deadline) {
    latest = await driver.evalJson<PracticeHoldemActionProgress>(`(() => {
      /* CV_PRACTICE_ACTION_PROGRESS */
      const records = window.__CV_WIRE_SINCE?.(
        'holdem/action',
        ${started.actionSeq},
      ) ?? [];
      const action = records[records.length - 1] ?? null;
      const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
      const expected = (
        window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? []
      )
        .filter((entry) => {
          if (
            entry.revision <= ${started.renderRevision}
            || entry.dealStep !== ${JSON.stringify(expectedDealStep)}
          ) return false;
          try {
            return JSON.parse(entry.signature)[2]
              === ${JSON.stringify(started.correlationHand)};
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.revision - right.revision)[0] ?? null;
      const scope = document.querySelector('[data-testid="holdem-inline-betting"]');
      const buttons = scope ? [...scope.querySelectorAll('button')] : [];
      return {
        actionSeen: Boolean(action),
        actionStatus: action?.status ?? null,
        expectedRevision: expected?.revision ?? null,
        renderRevision: root?.renderRevision ?? 0,
        dealStep: root?.dealStep ?? 'missing',
        correlationHand: root?.correlation?.hand ?? '',
        actions: buttons
          .filter((button) => button.getClientRects().length > 0)
          .map((button) =>
            button.textContent?.trim()
            + (button.disabled ? ' [disabled]' : '')
          ),
      };
    })()`);
    if (
      latest.actionSeen
      && (
        latest.actionStatus === null
        || latest.actionStatus < 200
        || latest.actionStatus >= 300
      )
    ) {
      throw new Error(
        `Hold'em practice ${started.label} returned HTTP ${
          String(latest.actionStatus)
        }`,
      );
    }
    if (
      latest.actionSeen
      && latest.expectedRevision !== null
    ) {
      return;
    }
    if (
      latest.actionSeen
      && latest.expectedRevision === null
      && latest.correlationHand !== started.correlationHand
    ) {
      throw new Error(
        `Hold'em practice ${started.label} ended before ${expectedDealStep}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Hold'em practice ${started.label} did not reach ${expectedDealStep} within 45s`
    + ` (last step=${latest?.dealStep ?? 'missing'},`
    + ` revision=${latest?.renderRevision ?? 0},`
    + ` expectedRevision=${String(latest?.expectedRevision ?? 'missing')},`
    + ` actionStatus=${String(latest?.actionStatus ?? 'missing')},`
    + ` actions=${latest?.actions.join(', ') || 'none'})`,
  );
}

async function practiceHoldemCorrelation(
  driver: Driver,
  surface: Surface,
): Promise<string> {
  await driver.waitFn(
    `(() => {
      const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)});
      const hand = root?.correlation?.hand;
      return Boolean(
        hand
        && Number.isSafeInteger(root?.correlation?.handNumber)
        && !hand.endsWith(':idle')
      );
    })()`,
    30_000,
  );
  const correlation = await driver.evalJson<string>(
    `/* CV_PRACTICE_HAND */ window.__CV_READ_PARITY(${JSON.stringify(surface)}).correlation.hand`,
  );
  if (!correlation) {
    throw new Error("Hold'em practice correlation is unavailable");
  }
  return correlation;
}

export function isActiveHoldemCorrelation(root: {
  correlation?: { hand?: string; handNumber?: number | null };
} | null): boolean {
  const hand = root?.correlation?.hand;
  return Boolean(
    hand
    && Number.isSafeInteger(root?.correlation?.handNumber)
    && !hand.endsWith(':idle')
  );
}

export function isMatchingHoldemShowdown(
  current: { dealStep: string | null; correlationHand: string | null },
  expectedCorrelationHand: string,
): boolean {
  return current.dealStep === 'showdown'
    && current.correlationHand === expectedCorrelationHand;
}

async function advanceHoldemToShowdown(
  driver: Driver,
  surface: Surface,
): Promise<string> {
  await driver.waitFn(
    `(() => {
      const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)});
      const hand = root?.correlation?.hand;
      return Boolean(
        hand
        && Number.isSafeInteger(root?.correlation?.handNumber)
        && !hand.endsWith(':idle')
      );
    })()`,
    30_000,
  );
  const correlationHand = await driver.evalJson<string>(
    `window.__CV_READ_PARITY(${JSON.stringify(surface)}).correlation.hand`,
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const reachedShowdown = await driver.evalJson<boolean>(`(() => {
      const current = window.__CV_READ_PARITY?.(${JSON.stringify(surface)});
      const practiceFelt =
        ${JSON.stringify(surface)} === 'holdem-felt-practice';
      const entry = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
        .find((entry) => {
          if (
            entry.surface !== ${JSON.stringify(surface)}
            || entry.dealStep !== 'showdown'
            || (!practiceFelt && entry.revision !== current?.renderRevision)
          ) return false;
          try {
            return JSON.parse(entry.signature)[2] === ${JSON.stringify(correlationHand)};
          } catch {
            return false;
          }
        });
      const banner = document.querySelector(
        '[data-testid="holdem-settlement-narration"]',
      );
      const readText = (selector, bannerText = false) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const text = bannerText
          ? element.getAttribute('data-banner-text')
            ?? element.firstElementChild?.textContent
            ?? element.textContent
            ?? ''
          : element.textContent ?? '';
        return text.trim();
      };
      const settlementWire = practiceFelt
        ? (window.__CV_WIRE_ALL?.() ?? [])
          .filter((record) => (
            record.status >= 200
            && record.status < 300
            && record.handId === ${JSON.stringify(correlationHand)}
          ))
          .at(-1) ?? null
        : null;
      if (
        banner
        && (
          practiceFelt
            ? settlementWire
            : entry
              && current?.dealStep === 'showdown'
              && current.correlation?.hand === ${JSON.stringify(correlationHand)}
        )
      ) {
        window.__CV_HOLDEM_SETTLEMENT_WITNESS = {
          surface: ${JSON.stringify(surface)},
          revision: entry?.revision ?? current?.renderRevision ?? 0,
          correlationHand: ${JSON.stringify(correlationHand)},
          ...(settlementWire ? { wireSeq: settlementWire.seq } : {}),
          values: {
            'banner-text': readText(
              '[data-testid="holdem-settlement-narration"]',
              true,
            ),
            pot: readText('[data-testid="holdem-pot-amount"]'),
            'self-stack': readText('[data-testid="holdem-self-stack"]'),
            'on-felt': document.querySelector(
              '[data-cv-parity^="holdem-felt"]',
            )?.getAttribute('data-on-felt') === 'true',
          },
        };
      }
      const witness = window.__CV_HOLDEM_SETTLEMENT_WITNESS;
      if (practiceFelt) {
        return Boolean(
          entry
          && witness?.surface === ${JSON.stringify(surface)}
          && witness.correlationHand === ${JSON.stringify(correlationHand)}
          && witness.wireSeq === settlementWire?.seq
        );
      }
      return Boolean(
        entry
        && current?.dealStep === 'showdown'
        && current.correlation?.hand === ${JSON.stringify(correlationHand)}
        && banner
      );
    })()`);
    if (reachedShowdown) return correlationHand;
    const rejectedAction = await driver.evalJson<{
      status: number;
      message: string | null;
      fixtureHeaderInjected: boolean;
    } | null>(`(() => {
      const records = (window.__CV_WIRE_ALL?.() ?? [])
        .filter((entry) => entry.urlSuffix?.endsWith('/action'));
      const record = records[records.length - 1];
      if (!record || record.status < 400) return null;
      return {
        status: record.status,
        message: typeof record.responseBody?.message === 'string'
          ? record.responseBody.message
          : typeof record.responseBody?.error === 'string'
            ? record.responseBody.error
            : null,
        fixtureHeaderInjected: record.fixtureHeaderInjected === true,
      };
    })()`);
    if (rejectedAction) {
      const openArm = await driver.evalJson<{
        status: number;
        fixtureHeaderInjected: boolean;
      } | null>(`(() => {
        const records = (window.__CV_WIRE_ALL?.() ?? [])
          .filter((entry) => (
            entry.urlSuffix === 'holdem/session/open'
            || entry.urlSuffix?.endsWith('/sit')
          ));
        const record = records[records.length - 1];
        return record
          ? {
              status: record.status,
              fixtureHeaderInjected: record.fixtureHeaderInjected === true,
            }
          : null;
      })()`);
      throw new Error(
        `Hold'em driver action rejected HTTP ${rejectedAction.status}`
        + ` (${rejectedAction.message ?? '<none>'}, fixtureHeaderInjected=${
          rejectedAction.fixtureHeaderInjected
        }, sessionOpen=${
          openArm
            ? `HTTP ${openArm.status}/fixtureHeaderInjected=${openArm.fixtureHeaderInjected}`
            : '<not-captured>'
        })`,
      );
    }
    const current = await driver.evalJson<{
      dealStep: string | null;
      correlationHand: string | null;
    }>(`(() => {
      const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)});
      return {
        dealStep: root?.dealStep ?? null,
        correlationHand: root?.correlation?.hand ?? null,
      };
    })()`);
    if (isMatchingHoldemShowdown(current, correlationHand)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      continue;
    }
    if (!await clickText(driver, ['Check', 'Call'])) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      continue;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const diagnostic = await driver.evalJson<{
    journalTail: Array<{
      revision: number;
      dealStep: string;
      transition: string;
    }>;
    lastRejectedAction: {
      status: number;
      message: string | null;
      fixtureHeaderInjected: boolean;
    } | null;
  }>(`(() => {
    const journalTail = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .filter((entry) => {
        try {
          return JSON.parse(entry.signature)[2] === ${JSON.stringify(correlationHand)};
        } catch {
          return false;
        }
      })
      .slice(-12)
      .map(({ revision, dealStep, transition }) => ({
        revision,
        dealStep,
        transition,
      }));
    const rejected = (window.__CV_WIRE_ALL?.() ?? [])
      .filter((entry) => entry.urlSuffix?.endsWith('/action') && entry.status >= 400)
      .at(-1);
    return {
      journalTail,
      lastRejectedAction: rejected
        ? {
            status: rejected.status,
            message: typeof rejected.responseBody?.message === 'string'
              ? rejected.responseBody.message
              : null,
            fixtureHeaderInjected: rejected.fixtureHeaderInjected === true,
          }
        : null,
    };
  })()`);
  throw new Error(
    `Hold'em driver did not reach showdown on ${surface}`
    + ` for correlation ${correlationHand}`
    + ` (journalTail=${JSON.stringify(diagnostic.journalTail)},`
    + ` lastRejectedAction=${JSON.stringify(diagnostic.lastRejectedAction)})`,
  );
}

interface JournalStep {
  revision: number;
  dealStep: string;
}

interface BlackjackNegativeJournalStep extends JournalStep {
  terminalPaired: boolean;
}

interface ActionFloor {
  revision: number;
  correlationHand: string;
}

export async function captureActionFloor(
  driver: Driver,
  surface: Surface,
): Promise<ActionFloor> {
  const floor = await driver.evalJson<ActionFloor | null>(`(() => {
    /* CV_ACTION_REVISION_FLOOR */
    const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
    const correlationHand = root?.correlation?.hand;
    if (!root || typeof correlationHand !== 'string' || !correlationHand) {
      return null;
    }
    const revision = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .filter((entry) => {
        if (entry.surface !== ${JSON.stringify(surface)}) return false;
        try { return JSON.parse(entry.signature)[2] === correlationHand; }
        catch { return false; }
      })
      .reduce(
        (latest, entry) => Math.max(latest, entry.revision),
        root.renderRevision,
      );
    return { revision, correlationHand };
  })()`);
  if (!floor) {
    throw new Error(`Cannot capture action floor for ${surface}`);
  }
  return floor;
}

function applyActionFloor(
  checkpoint: ParityCheckpoint,
  floor: ActionFloor | null,
): ParityCheckpoint {
  return floor
    ? {
        ...checkpoint,
        actionFloorRevision: floor.revision,
        expectCorrelationHand:
          checkpoint.expectCorrelationHand ?? floor.correlationHand,
      }
    : checkpoint;
}

interface InsuranceHydration {
  handId: string;
  tookInsurance: true;
  playerCards: number;
  urlSuffix: 'blackjack/hand/current';
}

export async function hydrateInsuranceCurrentHand(
  driver: Driver,
): Promise<InsuranceHydration> {
  await driver.waitFn(`(() => (
    (window.__CV_WIRE_ALL?.() ?? []).some((record) =>
      record.method === 'POST'
      && record.urlSuffix === 'blackjack/action'
      && record.requestBody?.action === 'insure'
      && record.status >= 200
      && record.status < 300
    )
  ))()`, 20_000);
  const hydration = await driver.evalJson<InsuranceHydration>(`(async () => {
    /* CV_B9_CURRENT_HAND_HYDRATION */
    const ack = (window.__CV_WIRE_ALL?.() ?? [])
      .filter((record) =>
        record.method === 'POST'
        && record.urlSuffix === 'blackjack/action'
        && record.requestBody?.action === 'insure'
        && record.status >= 200
        && record.status < 300
      )
      .at(-1);
    if (!ack) throw new Error('B9 insurance ACK was not captured');
    // blackjack-api-client.ts:326-340 emits this authoritative existing GET.
    const response = await fetch(
      new URL(ack.url).origin + '/api/cove/blackjack/hand/current',
      { credentials: 'include' },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error('B9 current-hand hydration returned HTTP ' + response.status);
    }
    if (
      body?.status !== 'in_progress'
      || body.handId !== ack.responseBody?.handId
      || body.tookInsurance !== true
      || !Array.isArray(body.playerHands)
    ) {
      throw new Error('B9 current-hand hydration returned malformed live truth');
    }
    return {
      handId: body.handId,
      tookInsurance: true,
      playerCards: body.playerHands.reduce(
        (count, hand) => count + (Array.isArray(hand?.cards) ? hand.cards.length : 0),
        0,
      ),
      urlSuffix: 'blackjack/hand/current',
    };
  })()`);
  if (
    !hydration.handId
    || hydration.tookInsurance !== true
    || hydration.playerCards < 2
    || hydration.urlSuffix !== 'blackjack/hand/current'
  ) {
    throw new Error('B9 current-hand hydration proof was malformed');
  }
  return hydration;
}

async function nextBlackjackTerminalStep(
  driver: Driver,
  surface: Surface,
  floor: ActionFloor,
): Promise<JournalStep> {
  await driver.waitFn(`(() => (
    (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? []).some((entry) => {
      if (
        entry.revision <= ${floor.revision}
        || !['dealer-reveal', 'settled'].includes(entry.dealStep)
      ) return false;
      try {
        return JSON.parse(entry.signature)[2]
          === ${JSON.stringify(floor.correlationHand)};
      } catch {
        return false;
      }
    })
  ))()`, 45_000);
  const step = await driver.evalJson<JournalStep | null>(`(() => {
    /* CV_B9_TERMINAL_STEP */
    return (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .filter((entry) => {
        if (
          entry.revision <= ${floor.revision}
          || !['dealer-reveal', 'settled'].includes(entry.dealStep)
        ) return false;
        try {
          return JSON.parse(entry.signature)[2]
            === ${JSON.stringify(floor.correlationHand)};
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.revision - right.revision)
      .map((entry) => ({
        revision: entry.revision,
        dealStep: entry.dealStep,
      }))[0] ?? null;
  })()`);
  if (!step) throw new Error('B9 Stand produced no terminal journal revision');
  return step;
}

interface BlackjackHitReadiness {
  terminal: boolean;
  actionSeq: number;
}

interface BlackjackHitProgress {
  terminal: boolean;
  newerRevision: boolean;
  hitEnabled: boolean;
  actionStatus: number | null;
}

export async function submitBlackjackHitAndWait(
  driver: Driver,
  surface: Surface,
  correlationHand: string,
): Promise<ActionFloor | null> {
  await driver.waitFn(`(() => {
    const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
    if (
      !root
      || root.dealStep === 'settled'
      || root.correlation?.hand !== ${JSON.stringify(correlationHand)}
    ) return true;
    // BlackjackModal.tsx:1583-1592 emits the Hit action and disables it while
    // the request is pending.
    return [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.trim().startsWith('Hit') && !button.disabled
    );
  })()`, 20_000);
  const readiness = await driver.evalJson<BlackjackHitReadiness>(`(() => {
    /* CV_BLACKJACK_HIT_READY */
    const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
    const records = window.__CV_WIRE_ALL?.() ?? [];
    return {
      terminal: !root
        || root.dealStep === 'settled'
        || root.correlation?.hand !== ${JSON.stringify(correlationHand)},
      actionSeq: records
        .filter((record) => record.urlSuffix === 'blackjack/action')
        .reduce((latest, record) => Math.max(latest, record.seq), 0),
    };
  })()`);
  if (readiness.terminal) return null;

  const floor = await captureActionFloor(driver, surface);
  if (!await clickText(driver, ['Hit'])) {
    throw new Error('Hit disappeared after readiness proof');
  }
  await driver.waitFn(`(() => {
    const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
    const terminal = !root
      || root.dealStep === 'settled'
      || root.correlation?.hand !== ${JSON.stringify(correlationHand)};
    const newerRevision = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .some((entry) => {
        if (entry.revision <= ${floor.revision}) return false;
        try {
          return JSON.parse(entry.signature)[2]
            === ${JSON.stringify(correlationHand)};
        } catch {
          return false;
        }
      });
    const response = (window.__CV_WIRE_ALL?.() ?? [])
      .filter((record) =>
        record.seq > ${readiness.actionSeq}
        && record.urlSuffix === 'blackjack/action'
      )
      .at(-1);
    const hitEnabled = [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.trim().startsWith('Hit') && !button.disabled
    );
    return terminal
      || newerRevision
      || Boolean(response && response.status >= 200 && response.status < 300 && hitEnabled);
  })()`, 20_000);
  const progress = await driver.evalJson<BlackjackHitProgress>(`(() => {
    /* CV_BLACKJACK_HIT_PROGRESS */
    const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null;
    const response = (window.__CV_WIRE_ALL?.() ?? [])
      .filter((record) =>
        record.seq > ${readiness.actionSeq}
        && record.urlSuffix === 'blackjack/action'
      )
      .at(-1);
    return {
      terminal: !root
        || root.dealStep === 'settled'
        || root.correlation?.hand !== ${JSON.stringify(correlationHand)},
      newerRevision: (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
        .some((entry) => {
          if (entry.revision <= ${floor.revision}) return false;
          try {
            return JSON.parse(entry.signature)[2]
              === ${JSON.stringify(correlationHand)};
          } catch {
            return false;
          }
        }),
      hitEnabled: [...document.querySelectorAll('button')].some((button) =>
        button.textContent?.trim().startsWith('Hit') && !button.disabled
      ),
      actionStatus: response?.status ?? null,
    };
  })()`);
  if (
    progress.actionStatus !== null
    && (progress.actionStatus < 200 || progress.actionStatus >= 300)
  ) {
    throw new Error(`Blackjack Hit returned HTTP ${progress.actionStatus}`);
  }
  if (!progress.terminal && !progress.newerRevision && !progress.hitEnabled) {
    throw new Error('Blackjack Hit produced no bounded progress proof');
  }
  return floor;
}

export async function nextJournalStep(
  driver: Driver,
  surface: Surface,
  afterRevision: number,
  correlationHand: string,
): Promise<JournalStep | null> {
  return driver.evalJson<JournalStep | null>(`(() => {
    const entries = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .filter((entry) => {
        if (
          entry.surface !== ${JSON.stringify(surface)}
          || entry.revision <= ${afterRevision}
        ) return false;
        try {
          return JSON.parse(entry.signature)[2] === ${JSON.stringify(correlationHand)};
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.revision - right.revision);
    const entry = entries[0];
    return entry
      ? { revision: entry.revision, dealStep: entry.dealStep }
      : null;
  })()`);
}

export async function nextBlackjackNegativeJournalStep(
  driver: Driver,
  surface: Surface,
  afterRevision: number,
  correlationHand: string,
): Promise<BlackjackNegativeJournalStep | null> {
  return driver.evalJson<BlackjackNegativeJournalStep | null>(`(() => {
    /* CV_BLACKJACK_NEGATIVE_JOURNAL_STEP */
    const entries = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
      .filter((entry) => {
        if (
          entry.surface !== ${JSON.stringify(surface)}
          || entry.revision <= ${afterRevision}
        ) return false;
        try {
          return JSON.parse(entry.signature)[2] === ${JSON.stringify(correlationHand)};
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.revision - right.revision);
    const entry = entries[0];
    if (!entry) return null;
    const terminalPaired = (window.__CV_WIRE_ALL?.() ?? []).some((record) => {
      const body = record.responseBody;
      if (
        record.status < 200
        || record.status >= 300
        || (
          record.urlSuffix !== 'blackjack/action'
          && record.urlSuffix !== 'blackjack/hand/deal'
        )
        || typeof record.capturedAt !== 'number'
        || typeof entry.ts !== 'number'
        || record.capturedAt > entry.ts
        || !body
        || typeof body !== 'object'
        || Array.isArray(body)
      ) return false;
      // blackjack-api-client.ts SettledHandResponse (lines 208-224) emits these
      // authoritative fields. Requiring the full settled shape avoids treating
      // an unrelated status string as this hand's terminal response.
      return body.handId === ${JSON.stringify(correlationHand)}
        && body.status === 'settled'
        && typeof body.shoeId === 'string'
        && typeof body.handIndex === 'number'
        && body.outcome
        && typeof body.outcome === 'object'
        && !Array.isArray(body.outcome)
        && typeof body.balance === 'number'
        && typeof body.totalBet === 'string'
        && typeof body.totalPayout === 'string'
        && typeof body.net === 'string'
        && typeof body.dealtCount === 'number'
        && typeof body.reshuffleSuggested === 'boolean'
        && typeof body.idempotencyReplay === 'boolean';
    });
    return {
      revision: entry.revision,
      dealStep: entry.dealStep,
      terminalPaired,
    };
  })()`);
}

export function shouldEndHoldemNegativeTraversal(
  current: {
    dealStep: string;
    correlation?: { hand?: string };
  } | null,
  initialHand: string,
): boolean {
  return !current
    || current.dealStep === 'showdown'
    || current.correlation?.hand !== initialHand;
}

export function shouldEndBlackjackNegativeTraversal(
  root: {
    dealStep?: string;
    correlation?: { hand?: string };
  } | null,
  initialHand: string,
): boolean {
  return root === null
    || root.dealStep === 'settled'
    || root.correlation?.hand !== initialHand;
}

function checkpointFor(
  surface: Surface,
  token: string,
  index: number,
  finalIndex: number,
): ParityCheckpoint {
  const transitionToken = token === 'muck-fading' || token === 'idle';
  const generic = token.startsWith('every-');
  return {
    label: `${token}-${index + 1}`,
    surface,
    expectRevisionAdvance: true,
    ...(generic ? {} : { expectDealStep: transitionToken ? 'showdown' : token }),
    ...(token === 'muck-fading' ? { expectTransition: 'muck-fading' as const } : {}),
    ...(token === 'idle' ? { expectTransition: 'idle' as const } : {}),
    final: index === finalIndex && (
      token === 'settled' || token === 'showdown' || token === 'idle'
    ),
  };
}

export async function* driveScenario(
  game: ParityGame,
  row: string,
  surface: Surface,
  phases: readonly string[],
  driver: Driver,
): AsyncGenerator<ParityCheckpoint> {
  await waitFor2DSurfaceReachable(driver, surface);
  if (game === 'blackjack') {
    await waitAndClick(driver, ['Deal']);
    if (row === 'B-neg') {
      await driver.waitFn(
        `Boolean(window.__CV_READ_PARITY?.(${JSON.stringify(surface)}))`,
        20_000,
      );
      const initial = await driver.evalJson<{
        renderRevision: number;
        correlation: { hand: string };
        firstRevision: number;
      }>(`(() => {
        const root = window.__CV_READ_PARITY(${JSON.stringify(surface)});
        const revisions = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
          .filter((entry) => {
            if (entry.surface !== ${JSON.stringify(surface)}) return false;
            try { return JSON.parse(entry.signature)[2] === root.correlation.hand; }
            catch { return false; }
          })
          .map((entry) => entry.revision);
        return {
          ...root,
          firstRevision: Math.min(root.renderRevision, ...revisions),
        };
      })()`);
      let cursor = initial.firstRevision;
      yield {
        ...checkpointFor(surface, phases[0]!, 0, 0),
        expectRenderRevision: initial.firstRevision,
        expectCorrelationHand: initial.correlation.hand,
      };
      const deadline = Date.now() + 60_000;
      let read = 2;
      while (Date.now() < deadline) {
        const next = await nextBlackjackNegativeJournalStep(
          driver,
          surface,
          cursor,
          initial.correlation.hand,
        );
        if (next) {
          if (next.terminalPaired) return;
          cursor = next.revision;
          if (next.dealStep === 'settled') return;
          yield {
            label: `every-in-progress-read-${read}`,
            surface,
            expectRevisionAdvance: true,
            expectRenderRevision: next.revision,
            expectCorrelationHand: initial.correlation.hand,
          };
          read += 1;
          const currentAfterCheckpoint = await driver.evalJson<{
            dealStep?: string;
            correlation?: { hand?: string };
          } | null>(
            `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
          );
          if (shouldEndBlackjackNegativeTraversal(
            currentAfterCheckpoint,
            initial.correlation.hand,
          )) return;
          continue;
        }
        const current = await driver.evalJson<{
          dealStep?: string;
          correlation?: { hand?: string };
        } | null>(
          `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
        );
        if (shouldEndBlackjackNegativeTraversal(
          current,
          initial.correlation.hand,
        )) return;
        const floor = await submitBlackjackHitAndWait(
          driver,
          surface,
          initial.correlation.hand,
        );
        if (!floor) return;
      }
      const currentAtDeadline = await driver.evalJson<{
        dealStep?: string;
        correlation?: { hand?: string };
      } | null>(
        `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
      );
      if (shouldEndBlackjackNegativeTraversal(
        currentAtDeadline,
        initial.correlation.hand,
      )) return;
      throw new Error('Blackjack negative traversal exceeded 60s');
    }
    if (row === 'B9') {
      yield checkpointFor(surface, 'hole', 0, 2);
      const insureFloor = await waitAndClickWithFloor(
        driver,
        surface,
        ['Insure'],
      );
      const hydration = await hydrateInsuranceCurrentHand(driver);
      yield {
        ...applyActionFloor(
          checkpointFor(surface, 'player-turn', 1, 2),
          insureFloor,
        ),
        expectCorrelationHand: hydration.handId,
        expectResolvedWireSuffix: hydration.urlSuffix,
      };
      const standFloor = await waitAndClickWithFloor(
        driver,
        surface,
        ['Stand'],
      );
      const terminal = await nextBlackjackTerminalStep(
        driver,
        surface,
        standFloor,
      );
      if (terminal.dealStep === 'dealer-reveal') {
        yield {
          ...applyActionFloor(
            checkpointFor(surface, 'dealer-reveal', 2, 3),
            standFloor,
          ),
          expectRenderRevision: terminal.revision,
        };
      }
      yield {
        ...applyActionFloor(
          checkpointFor(
            surface,
            'settled',
            terminal.dealStep === 'dealer-reveal' ? 3 : 2,
            terminal.dealStep === 'dealer-reveal' ? 3 : 2,
          ),
          standFloor,
        ),
        final: true,
      };
      return;
    }
    let pendingActionFloor: ActionFloor | null = null;
    if (row === 'B4') {
      pendingActionFloor = await waitAndClickWithFloor(
        driver,
        surface,
        ['Stand'],
      );
    }
    for (let index = 0; index < phases.length; index += 1) {
      const phase = phases[index]!;
      const checkpoint = applyActionFloor(
        checkpointFor(surface, phase, index, phases.length - 1),
        pendingActionFloor,
      );
      yield row === 'B2' && phase === 'player-turn'
        ? { ...checkpoint, expectMinPlayerCards: 3 }
        : checkpoint;
      pendingActionFloor = null;
      if (row === 'B7' && phase === 'hole') {
        pendingActionFloor = await waitAndClickWithFloor(
          driver,
          surface,
          ['Stand'],
        );
      }
      if (row === 'B2' && phase === 'hole') {
        pendingActionFloor = await waitAndClickWithFloor(
          driver,
          surface,
          ['Hit'],
        );
      }
      if (row === 'B3' && phase === 'player-turn') {
        pendingActionFloor = await waitAndClickWithFloor(
          driver,
          surface,
          ['Double'],
        );
      }
      if (row === 'B5' && phase === 'player-turn') {
        const correlationHand = await driver.evalJson<string>(
          `window.__CV_READ_PARITY?.(${JSON.stringify(surface)})?.correlation?.hand ?? ''`,
        );
        if (!correlationHand) {
          throw new Error('B5 could not resolve its blackjack correlation');
        }
        for (let hits = 0; hits < 10; hits += 1) {
          const floor = await submitBlackjackHitAndWait(
            driver,
            surface,
            correlationHand,
          );
          if (!floor) break;
          pendingActionFloor = floor;
        }
      }
      if (row === 'B8' && phase === 'player-turn' && index === 1) {
        pendingActionFloor = await waitAndClickWithFloor(
          driver,
          surface,
          ['Split'],
        );
      } else if (row === 'B8' && phase === 'player-turn' && index > 2) {
        // Both split subhands must resolve before dealer reveal. A single Stand
        // only advances from subhand 0 to subhand 1.
        pendingActionFloor = await waitAndClickWithFloor(
          driver,
          surface,
          ['Stand'],
        );
        pendingActionFloor = await waitAndClickWithFloor(
          driver,
          surface,
          ['Stand'],
        );
      }
    }
    return;
  }

  if (game === 'baccarat') {
    if (row === 'C6') {
      // BaccaratModal.tsx:103-105 emits these exact uppercase radio labels.
      const bets = ['PLAYER', 'BANKER', 'TIE'] as const;
      for (let index = 0; index < bets.length; index += 1) {
        await waitAndClick(driver, [bets[index]!]);
        await waitAndClick(driver, ['Deal']);
        yield {
          label: `settled-${bets[index]!.toLowerCase()}`,
          surface,
          expectRevisionAdvance: true,
          expectDealStep: 'settled',
          final: index === bets.length - 1,
        };
        if (index < bets.length - 1) await waitAndClick(driver, ['Next Coup']);
      }
      return;
    }
    // BaccaratModal.tsx:103-105 emits these exact uppercase radio labels.
    const bet = row === 'C5' ? 'TIE' : row === 'C7' ? 'BANKER' : 'PLAYER';
    await waitAndClick(driver, [bet]);
    await waitAndClick(driver, ['Deal']);
    for (let index = 0; index < phases.length; index += 1) {
      yield checkpointFor(surface, phases[index]!, index, phases.length - 1);
    }
    return;
  }

  // Cash tables require the landed two-step Sit down -> Confirm buy-in flow.
  // Prove the seat hydrated before awaiting a correlated hand checkpoint.
  if (surface.endsWith('-3d')) {
    const alreadySeated = await driver.evalJson<boolean>(
      `(() => [...document.querySelectorAll('button')].some(
        (button) => button.textContent?.trim().startsWith('Walk Away')
          && !button.disabled
      ))()`,
    );
    if (!alreadySeated) {
      await waitAndClick(driver, ['Sit down', 'Sit', 'SIT'], 30_000);
      await waitAndClick(driver, ['Confirm buy-in'], 30_000);
    }
    await driver.waitFn(`(() => [...document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim().startsWith('Walk Away')
        && !button.disabled
    ))()`, 30_000);
  }
  if (row === 'H-neg') {
    if (surface.endsWith('-3d')) {
      await driver.waitFn(`(() => {
        const root = window.__CV_READ_PARITY?.(${JSON.stringify(surface)});
        if (!root || root.correlation?.handNumber == null) return false;
        if (
          ${JSON.stringify(surface)} === 'holdem-tray-3d'
          && root.slots.filter(
            (slot) => slot.slot.startsWith('hole-') && slot.facing === 'up'
          ).length !== 2
        ) return false;
        const tableId = root.correlation.hand.slice(
          0,
          root.correlation.hand.lastIndexOf(':'),
        );
        const hasWitness = (window.__CV_WIRE_ALL?.() ?? []).some((record) =>
          record.status === 200
          && record.handNumber === root.correlation.handNumber
          && record.urlSuffix.includes(
            'poker/cash/tables/' + tableId + '/state-for-agent'
          )
        );
        if (!hasWitness) return false;
        const revisions = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
          .filter((entry) => {
            if (entry.surface !== ${JSON.stringify(surface)}) return false;
            try { return JSON.parse(entry.signature)[2] === root.correlation.hand; }
            catch { return false; }
          })
          .map((entry) => entry.revision);
        window.__CV_HOLD_NEG_INITIAL = {
          ...root,
          firstRevision: ${JSON.stringify(surface)} === 'holdem-tray-3d'
            ? root.renderRevision
            : Math.min(root.renderRevision, ...revisions),
        };
        return true;
      })()`, 30_000);
    } else {
      await driver.waitFn(
        `Boolean(window.__CV_READ_PARITY?.(${JSON.stringify(surface)}))`,
        30_000,
      );
    }
    const initial = await driver.evalJson<{
      renderRevision: number;
      correlation: { hand: string };
      firstRevision: number;
    }>(surface.endsWith('-3d') ? 'window.__CV_HOLD_NEG_INITIAL' : `(() => {
      const root = window.__CV_READ_PARITY(${JSON.stringify(surface)});
      const revisions = (window.__CV_PARITY_JOURNAL?.(${JSON.stringify(surface)}) ?? [])
        .filter((entry) => {
          if (entry.surface !== ${JSON.stringify(surface)}) return false;
          try { return JSON.parse(entry.signature)[2] === root.correlation.hand; }
          catch { return false; }
        })
        .map((entry) => entry.revision);
      return {
        ...root,
        firstRevision: Math.min(root.renderRevision, ...revisions),
      };
    })()`);
    let cursor = initial.firstRevision;
    // SeatedHoldemHud.tsx:764-782 publishes its empty, client-only practice
    // tray before a hand exists as `practice:idle`. Its early null/zero
    // hand-number restamps have no successful server hand wire by design.
    const expectsNoWire = (
      surface === 'holdem-felt-practice'
      && initial.correlation.hand === ''
    ) || (
      surface === 'holdem-tray-practice'
      && initial.correlation.hand === 'practice:idle'
    );
    yield {
      ...checkpointFor(surface, phases[0]!, 0, 0),
      expectRenderRevision: initial.firstRevision,
      expectCorrelationHand: initial.correlation.hand,
      ...(surface.endsWith('-3d')
        ? { expectCausalCardJustification: true as const }
        : {}),
      ...(expectsNoWire
        ? { expectResolvedWire: '<none>' as const }
        : {}),
    };
    if (
      surface === 'holdem-felt-practice'
      && initial.correlation.hand === ''
    ) return;
    const deadline = Date.now() + 90_000;
    let read = 2;
    while (Date.now() < deadline) {
      const next = await nextJournalStep(
        driver,
        surface,
        cursor,
        initial.correlation.hand,
      );
      if (next) {
        cursor = next.revision;
        yield {
          label: `every-step-${read}`,
          surface,
          expectRevisionAdvance: true,
          expectRenderRevision: next.revision,
          expectCorrelationHand: initial.correlation.hand,
          ...(surface.endsWith('-3d')
            ? { expectCausalCardJustification: true as const }
            : {}),
          ...(expectsNoWire
            ? { expectResolvedWire: '<none>' as const }
            : {}),
        };
        read += 1;
        const currentAfterCheckpoint = await driver.evalJson<{
          dealStep: string;
          correlation?: { hand?: string };
        } | null>(
          `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
        );
        if (shouldEndHoldemNegativeTraversal(
          currentAfterCheckpoint,
          initial.correlation.hand,
        )) return;
        if (next.dealStep === 'showdown') return;
        continue;
      }
      const current = await driver.evalJson<{
        dealStep: string;
        correlation?: { hand?: string };
      } | null>(
        `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
      );
      if (shouldEndHoldemNegativeTraversal(
        current,
        initial.correlation.hand,
      )) return;
      await clickText(driver, ['Check', 'Call']);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const currentAtDeadline = await driver.evalJson<{
      dealStep: string;
      correlation?: { hand?: string };
    } | null>(
      `window.__CV_READ_PARITY?.(${JSON.stringify(surface)}) ?? null`,
    );
    if (shouldEndHoldemNegativeTraversal(
      currentAtDeadline,
      initial.correlation.hand,
    )) return;
    throw new Error(`Hold'em negative traversal exceeded 90s`);
  }
  // Fixture-gated first-deal recovery can consume the normal client retry
  // window before the practice action surface mounts.
  if (row === 'H6') await waitAndClick(driver, ['Fold'], 90_000);
  let terminalCorrelation: string | null = null;
  if (['H5', 'H6', 'H10'].includes(row)) {
    terminalCorrelation = await advanceHoldemToShowdown(driver, surface);
  }
  const practiceStreetCorrelation =
    ['H2', 'H3', 'H4'].includes(row)
    && surface.endsWith('-practice')
      ? await practiceHoldemCorrelation(driver, surface)
      : null;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index]!;
    const checkpoint = checkpointFor(
      surface,
      phase,
      index,
      phases.length - 1,
    );
    yield practiceStreetCorrelation
      ? {
          ...checkpoint,
          expectCorrelationHand: practiceStreetCorrelation,
        }
      : terminalCorrelation
        ? {
            ...checkpoint,
            expectCorrelationHand: terminalCorrelation,
          }
        : checkpoint;
    if (
      !phase.startsWith('every-')
      && !['showdown', 'muck-fading', 'idle'].includes(phase)
      && index < phases.length - 1
    ) {
      const nextPhase = phases[index + 1]!;
      if (
        ['H2', 'H3', 'H4'].includes(row)
        && surface.endsWith('-practice')
      ) {
        await advancePracticeHoldemStreet(
          driver,
          surface,
          nextPhase,
          practiceStreetCorrelation!,
        );
      } else {
        await waitAndClick(driver, ['Check', 'Call'], 30_000);
      }
    }
  }
}

export function teardownFor(
  game: ParityGame,
  surface: Surface,
): (driver: Driver, apiBase: string) => Promise<void> {
  return (driver, apiBase) => teardownGame(driver, game, surface, apiBase);
}
