import { afterEach, describe, expect, test } from 'bun:test';
import {
  HOUSE_TRADER_STATUS_DETAIL_MAX,
  HOUSE_TRADER_STATUS_MAX_AGE_MS,
  HOUSE_TRADER_STATUS_MAX_FUTURE_MS,
  HOUSE_TRADER_STATUS_MAX_PAST_MS,
  HOUSE_TRADER_STATUS_REASONS,
} from '@clawville/shared';

import {
  bearerToken,
  classifyRiskState,
  clearHouseTraderStatuses,
  decideStatusWrite,
  houseTraderStatusBodySchema,
  isStatusFresh,
  normaliseStatusTimestamp,
  readConfiguredStatusToken,
  readHouseTraderStatus,
  recordHouseTraderStatus,
  sanitiseStatusDetail,
  statusAgeSeconds,
  statusTokenMatches,
  toHouseTraderRisk,
  type StoredHouseTraderStatus,
} from '../house-trader-status';

const WALLET = '4FMiFU1Dv4qwfMHn3YukvaonhwrPt1T7VZ3yGuNRyY9n';
const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function stored(overrides: Partial<StoredHouseTraderStatus> = {}): StoredHouseTraderStatus {
  return {
    wallet: WALLET,
    canEnter: false,
    reason: 'daily_loss_floor',
    detail: 'lifetime loss 14.95 of the 25.00 floor',
    dayLossUsd: 14.95,
    dayLossCapUsd: 25,
    roomNeededUsd: 10.25,
    at: '2026-09-20T11:59:30.000Z',
    atMs: Date.parse('2026-09-20T11:59:30.000Z'),
    receivedAtMs: NOW - 30_000,
    ...overrides,
  };
}

afterEach(() => {
  clearHouseTraderStatuses();
  delete process.env.HOUSE_TRADER_STATUS_TOKEN;
});

describe('classifyRiskState', () => {
  test('a risk limit that blocks entry is the only PAUSE', () => {
    // The founder case: Genesis cap-blocked at the daily loss floor while
    // `halted` still read false, so nothing on any surface said so.
    for (const reason of ['daily_loss_floor', 'halted', 'insufficient_usdc', 'gas_reserve'] as const) {
      expect(classifyRiskState(false, reason)).toBe('paused');
    }
  });

  test('the same reasons with canEnter true are LIVE, because the runner is the authority', () => {
    // A reason explains a block; `canEnter` decides whether there is one. A
    // runner that recovers keeps its last reason for a tick, and showing a red
    // badge over a trader that can buy right now is a false statement.
    for (const reason of ['daily_loss_floor', 'halted', 'insufficient_usdc', 'gas_reserve'] as const) {
      expect(classifyRiskState(true, reason)).toBe('live');
    }
  });

  test('a blind or unclassified runner is a FAULT whatever canEnter says', () => {
    // Kept separate from `paused` on purpose: a dead price feed is a broken
    // trader, not a deliberate risk decision, and merging the two would let an
    // outage read as prudence.
    for (const reason of ['price_feed_down', 'other'] as const) {
      expect(classifyRiskState(false, reason)).toBe('fault');
      expect(classifyRiskState(true, reason)).toBe('fault');
    }
  });

  test('working states are LIVE even when the runner cannot enter', () => {
    // Fully deployed and mid-swap are normal several times a day. Badging them
    // as paused would train every reader to ignore the badge, which costs us
    // the one case it exists for.
    for (const reason of ['at_max_positions', 'settling', 'ok'] as const) {
      expect(classifyRiskState(false, reason)).toBe('live');
      expect(classifyRiskState(true, reason)).toBe('live');
    }
  });

  test('every reason in the wire vocabulary classifies', () => {
    // Derived from the constant, so a reason added later without a rule fails
    // here instead of silently defaulting to `live` on a public board.
    for (const reason of HOUSE_TRADER_STATUS_REASONS) {
      for (const canEnter of [true, false]) {
        expect(['paused', 'live', 'fault']).toContain(classifyRiskState(canEnter, reason));
      }
    }
  });
});

describe('sanitiseStatusDetail', () => {
  test('keeps plain text unchanged', () => {
    expect(sanitiseStatusDetail('day loss 14.95 of 25.00')).toBe('day loss 14.95 of 25.00');
  });

  test('replaces control characters with a space instead of deleting them', () => {
    // Deleting would merge the words on either side and store an invented one.
    expect(sanitiseStatusDetail('floor\u0000reached')).toBe('floor reached');
    expect(sanitiseStatusDetail('line one\nline two\ttabbed')).toBe('line one line two tabbed');
    expect(sanitiseStatusDetail('ansi \u001b[31mred\u001b[0m')).toBe('ansi [31mred [0m');
  });

  test('drops every byte outside printable ASCII', () => {
    // The escapes are written as escapes on purpose: an em dash, an emoji and
    // DEL are all outside printable ASCII and must not survive to the board.
    const cleaned = sanitiseStatusDetail('halt \u2014 emoji \u{1F600} and DEL \u007f here')!;
    expect(cleaned).toBe('halt emoji and DEL here');
    for (const char of cleaned) {
      const code = char.charCodeAt(0);
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7e);
    }
  });

  test('collapses whitespace and trims', () => {
    expect(sanitiseStatusDetail('   too    many   spaces   ')).toBe('too many spaces');
  });

  test('an absent or entirely unprintable detail is null, never an empty string', () => {
    expect(sanitiseStatusDetail(undefined)).toBeNull();
    expect(sanitiseStatusDetail(null)).toBeNull();
    expect(sanitiseStatusDetail('   ')).toBeNull();
    expect(sanitiseStatusDetail('\u0000\u0001\u0002')).toBeNull();
  });

  test('caps at the published maximum', () => {
    // Deliberately NOT a repeated letter: a long run of one base58 character IS
    // a base58 run, so the address strip removes it whole and the cap is never
    // reached. `.` breaks the run every third character.
    const long = 'ab.'.repeat(60);
    expect(long.length).toBeGreaterThan(HOUSE_TRADER_STATUS_DETAIL_MAX);
    expect(sanitiseStatusDetail(long)).toHaveLength(HOUSE_TRADER_STATUS_DETAIL_MAX);
  });
});

/**
 * An operator note has no business carrying a wallet, and this text reaches a
 * public board AND a wall in the game world.
 *
 * EXACT-OUTPUT ASSERTIONS throughout, deliberately, because that is the one
 * pattern that has held. Four separate explanations of this bug were each true
 * of the samples we had looked at and false of the set: a six-shape probe
 * missed the uppercase `0X`, a sixteen-character window missed dense marks, and
 * two successive character classes each missed a whole category. `toBe(...)`
 * has no sample to fall outside of.
 *
 * A note carrying an address is dropped WHOLE, so those cases are all `null`.
 */
describe('sanitiseStatusDetail refuses any note carrying an address', () => {
  const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  test('a plain pubkey, an EVM address, or a long run', () => {
    expect(sanitiseStatusDetail(`floor reached ${PUBKEY}`)).toBeNull();
    expect(sanitiseStatusDetail(`spend ${PUBKEY} now`)).toBeNull();
    expect(sanitiseStatusDetail(PUBKEY)).toBeNull();
    expect(sanitiseStatusDetail('sent to 0xAb35De09f1cC2b7E4419b7B1bE1eD3fF9c6d20a1 ok')).toBeNull();
    expect(sanitiseStatusDetail(`note ${'z'.repeat(200)} end`)).toBeNull();
  });

  test('tfs-web probe: UNPREFIXED hex, which both other detectors miss', () => {
    // Strip the `0x` and neither detector fires: base58 EXCLUDES `0`, so the
    // zero inside almost any real address chops the run into pieces under 32.
    // On the first of these the longest base58 sub-run is 26. All three
    // rendered verbatim onto the board before `BARE_HEX_RUN_ANYWHERE`.
    expect(sanitiseStatusDetail('sent to 742d35Cc6634C0532925a3b844Bc454e4438f44e ok')).toBeNull();
    expect(sanitiseStatusDetail('burn 000000000000000000000000000000000000dead now')).toBeNull();
    expect(sanitiseStatusDetail(
      'sig a3f1c0de9b8074e2f5a6b7c8d9e0f1a2b3c4d5e6f70819a2b3c4d5e6f7081920 pending',
    )).toBeNull();
  });

  test('the bare-hex rule does not start eating ordinary numbers', () => {
    // 20 is a low threshold, so this is the guard that it stays a hex rule and
    // not a digit rule. A Solana slot is nine digits and a lamport figure runs
    // to about thirteen; neither comes close.
    expect(sanitiseStatusDetail('slot 301884412 confirmed')).toBe('slot 301884412 confirmed');
    expect(sanitiseStatusDetail('reserved 1250000000 lamports')).toBe('reserved 1250000000 lamports');
  });

  test('Codex probe: an uppercase 0X hex prefix', () => {
    // `/0x[0-9a-fA-F]{6,}/g` case-folded the DIGITS but not the literal `0x`,
    // so a checksummed address written with a capital X walked straight past.
    expect(sanitiseStatusDetail('burn 0X000000000000000000000000000000000000dEaD now')).toBeNull();
  });

  /**
   * EVERY SPLITTER FOUND SO FAR, in one table. Each of these, dropped into the
   * middle of a pubkey, broke the run into two sub-32 halves that the detector
   * missed; the render pass then turned the splitter into a SPACE and printed
   * both halves, which is a fully readable address.
   *
   * The last five are tfs-audit's, and the newline is the one that matters
   * most: it needs no attacker, only a Python traceback, which is the single
   * most likely thing to arrive in this field from this runner.
   */
  const SPLITTERS: Array<[string, string]> = [
    ['U+0301 combining acute (Mn)', '́'],
    ['U+1AB0 combining extended (Mn)', '᪰'],
    ['U+FE0F variation selector', '️'],
    ['U+200B zero width (Cf)', '​'],
    ['U+00AD soft hyphen (Cf)', '­'],
    ['U+202E bidi override (Cf)', '‮'],
    ['U+0001 C0 control (Cc)', '\u0001'],
    ['U+000A newline (Cc)', '\n'],
    ['U+0085 NEL (Cc)', '\u0085'],
    ['U+2028 line separator (Zl)', ' '],
    ['U+2029 paragraph separator (Zp)', ' '],
  ];

  test('no splitter smuggles a real pubkey through', () => {
    for (const [name, char] of SPLITTERS) {
      const split = `floor ${PUBKEY.slice(0, 20)}${char}${PUBKEY.slice(20)}`;
      expect({ name, out: sanitiseStatusDetail(split) }).toEqual({ name, out: null });
    }
  });

  test('no splitter smuggles a SHORT pair that joins into a run', () => {
    // Codex's shape rather than a real pubkey: two sixteen-character halves,
    // each harmless alone, which only become an address once the splitter goes.
    for (const [name, char] of SPLITTERS) {
      const split = `tag ${'1'.repeat(16)}${char}${'1'.repeat(16)} end`;
      expect({ name, out: sanitiseStatusDetail(split) }).toEqual({ name, out: null });
    }
  });

  test('a fullwidth look-alike address folds onto ASCII and is caught', () => {
    const fullwidth = PUBKEY.replace(/[0-9A-Za-z]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) + 0xfee0));
    expect(sanitiseStatusDetail(`at ${fullwidth} now`)).toBeNull();
  });

  test('leaves ordinary notes alone, including prose with no l, 0, O or I', () => {
    // THE FALSE POSITIVES THAT KEEP `\p{Zs}` OUT OF THE DETECTION STRIP. Both
    // measured. Joining across ordinary spaces turns each of these into one
    // base58 run, because base58 excludes only `l`, `0`, `O` and `I`.
    //   45 characters joined:
    expect(sanitiseStatusDetail('day trade entry refused by cap reset after ten minutes'))
      .toBe('day trade entry refused by cap reset after ten minutes');
    //   32 joined, EXACTLY on the threshold, and an ordinary status note for a
    //   state in this module's own reason enum. This is the one that should
    //   stop anyone adding `Zs` later. A comma after "positions" saves it,
    //   which is how thin the "that would never happen" argument is.
    expect(sanitiseStatusDetail('at max positions nothing to rotate yet'))
      .toBe('at max positions nothing to rotate yet');
    expect(sanitiseStatusDetail('at max positions, nothing to rotate yet'))
      .toBe('at max positions, nothing to rotate yet');
    expect(sanitiseStatusDetail('day loss 14.95 of 25.00, need 10.25 more'))
      .toBe('day loss 14.95 of 25.00, need 10.25 more');
    // 31 base58 characters is under the threshold and is not an address.
    // `z` and not `a` on purpose: `a` is a HEX digit, so 31 of them are caught
    // by the bare-hex rule and rightly so, which would make this assert the
    // opposite of what it was written to test.
    expect(sanitiseStatusDetail(`tag ${'z'.repeat(31)}`)).toBe(`tag ${'z'.repeat(31)}`);
  });

  test('a multi-line traceback with no address still renders, flattened', () => {
    // A newline only DROPS the note when it is hiding an address. An ordinary
    // traceback keeps its text, which is why the render pass still turns a
    // control character into a space rather than deleting it.
    expect(sanitiseStatusDetail('RuntimeError: cap reset\n  at loop.py line 41'))
      .toBe('RuntimeError: cap reset at loop.py line 41');
  });
});

describe('freshness', () => {
  test('is measured from SERVER receipt, with the clock injected', () => {
    expect(isStatusFresh(NOW - 1_000, NOW)).toBe(true);
    expect(isStatusFresh(NOW - HOUSE_TRADER_STATUS_MAX_AGE_MS, NOW)).toBe(true);
    expect(isStatusFresh(NOW - HOUSE_TRADER_STATUS_MAX_AGE_MS - 1, NOW)).toBe(false);
  });

  test('the ageout is two and a half missed heartbeats', () => {
    expect(HOUSE_TRADER_STATUS_MAX_AGE_MS).toBe(150_000);
  });

  test('age never reports negative', () => {
    expect(statusAgeSeconds(NOW, NOW)).toBe(0);
    expect(statusAgeSeconds(NOW + 5_000, NOW)).toBe(0);
    expect(statusAgeSeconds(NOW - 90_500, NOW)).toBe(90);
  });

  test('a stale report reads exactly like no report at all', () => {
    // Both mean "we were not told", so a reader never has to tell a dead feed
    // from an absent one to know the board is not claiming present knowledge.
    const status = stored({ receivedAtMs: NOW - HOUSE_TRADER_STATUS_MAX_AGE_MS - 1 });
    expect(toHouseTraderRisk(status, NOW)).toBeNull();
    expect(toHouseTraderRisk(null, NOW)).toBeNull();
  });

  test('a fresh report carries the classified state and its age', () => {
    expect(toHouseTraderRisk(stored(), NOW)).toEqual({
      state: 'paused',
      reason: 'daily_loss_floor',
      detail: 'lifetime loss 14.95 of the 25.00 floor',
      dayLossUsd: 14.95,
      dayLossCapUsd: 25,
      roomNeededUsd: 10.25,
      at: '2026-09-20T11:59:30.000Z',
      ageSeconds: 30,
    });
  });

  test('the risk block never carries the wallet it is keyed on', () => {
    // The wallet is the join key only. The public tape publishes "wallet
    // addresses are never included" and this block rides on that response.
    expect(JSON.stringify(toHouseTraderRisk(stored(), NOW))).not.toContain(WALLET);
    expect(JSON.stringify(toHouseTraderRisk(stored(), NOW))).not.toContain('wallet');
  });
});

describe('decideStatusWrite', () => {
  // HTTP does not promise delivery order, and a timeout produces a retry. The
  // decision is made on the RUNNER'S clock, because arrival order is not
  // evidence of which report describes the later state.
  const held = stored({ atMs: NOW - 30_000, at: '2026-09-20T11:59:30.000Z' });

  test('stores the first report for a wallet', () => {
    expect(decideStatusWrite(NOW, null, NOW)).toBe('store');
  });

  test('stores a strictly newer report', () => {
    expect(decideStatusWrite(held.atMs + 1, held, NOW)).toBe('store');
    expect(decideStatusWrite(NOW, held, NOW)).toBe('store');
  });

  test('drops a reordered older report', () => {
    // The case that matters: a delayed `canEnter: false` arriving behind the
    // newer `canEnter: true` would pin a pause on a trader that has recovered.
    expect(decideStatusWrite(held.atMs - 1, held, NOW)).toBe('older_report');
    expect(decideStatusWrite(held.atMs - 60_000, held, NOW)).toBe('older_report');
  });

  test('stops enforcing order once the held report has gone STALE', () => {
    // THE CLOCK-CORRECTION DEADLOCK. A runner whose clock ran fast banks a
    // future `at`; when it corrects itself, every later report is older than
    // what we hold and would be refused until the wall clock caught up. A stale
    // held report is already publishing `risk: null`, so there is nothing left
    // to protect and refusing on its behalf only prolongs the blackout.
    const stale = stored({
      atMs: NOW + 600_000,
      receivedAtMs: NOW - HOUSE_TRADER_STATUS_MAX_AGE_MS - 1,
    });
    // Far older than the banked timestamp, and it still takes over.
    expect(decideStatusWrite(NOW, stale, NOW)).toBe('store');
    // While it is still FRESH, the ordering rule does apply.
    const fresh = stored({ atMs: NOW + 30_000, receivedAtMs: NOW - 1_000 });
    expect(decideStatusWrite(NOW, fresh, NOW)).toBe('older_report');
  });

  test('STORES an equal timestamp, because dropping it aged a live pause away', () => {
    // A first version dropped this as a duplicate and refused to refresh the
    // receipt time. Against a runner that heartbeats an unchanged state, every
    // heartbeat was then dropped, `receivedAtMs` never moved, and a live pause
    // aged off the board at 150 s while the runner was still reporting it
    // correctly. Equal must store. It is not a replay hole: the plus or minus
    // ten minute window bounds a replayed body to a state at most ten minutes
    // old, and the next heartbeat corrects it within 60 s.
    expect(decideStatusWrite(held.atMs, held, NOW)).toBe('store');
  });

  test('has exactly two outcomes, so no name survives for a removed behaviour', () => {
    // `duplicate_report` was removed rather than inverted. A name kept around
    // for a behaviour that no longer exists is how it gets reintroduced.
    const outcomes = new Set([
      decideStatusWrite(held.atMs + 1, held, NOW),
      decideStatusWrite(held.atMs, held, NOW),
      decideStatusWrite(held.atMs - 1, held, NOW),
      decideStatusWrite(held.atMs, null, NOW),
    ]);
    expect([...outcomes].sort()).toEqual(['older_report', 'store']);
  });
});

describe('the store', () => {
  test('keeps one entry per wallet, last write wins', () => {
    recordHouseTraderStatus(stored({ reason: 'daily_loss_floor' }));
    recordHouseTraderStatus(stored({ reason: 'ok', canEnter: true }));
    expect(readHouseTraderStatus(WALLET)?.reason).toBe('ok');
    expect(readHouseTraderStatus('some-other-wallet')).toBeNull();
  });

  test('is hard-capped, because every re-pairing leaves a key behind', () => {
    // The route only admits a CURRENT slot wallet, but "current" moves without
    // a deploy, so a long-lived process accumulates wallets that were valid
    // when they wrote. Evicting is safe: a dropped entry reads as `risk: null`,
    // which is the honest "we were not told" value, never a wrong state.
    for (let index = 0; index < 40; index += 1) {
      recordHouseTraderStatus(stored({ wallet: `retired-wallet-${index}` }));
    }
    const survivors = Array.from({ length: 40 }, (_unused, index) => `retired-wallet-${index}`)
      .filter((wallet) => readHouseTraderStatus(wallet) !== null);
    expect(survivors.length).toBeLessThanOrEqual(16);
    // The SURVIVORS are the newest, so the desks reporting right now are the
    // ones that stay.
    expect(survivors).toContain('retired-wallet-39');
    expect(readHouseTraderStatus('retired-wallet-0')).toBeNull();
  });

  test('a desk that keeps reporting is never evicted as "oldest"', () => {
    // The re-report has to move the key to the end of the insertion order, or a
    // desk heartbeating every 60 s for a week is dropped the moment enough
    // retired wallets pile up behind it.
    recordHouseTraderStatus(stored({ wallet: WALLET }));
    for (let index = 0; index < 30; index += 1) {
      recordHouseTraderStatus(stored({ wallet: `churn-${index}` }));
      recordHouseTraderStatus(stored({ wallet: WALLET, reason: 'halted' }));
    }
    expect(readHouseTraderStatus(WALLET)?.reason).toBe('halted');
  });
});

describe('normaliseStatusTimestamp', () => {
  test('accepts a timestamp inside the skew window and normalises it to UTC', () => {
    expect(normaliseStatusTimestamp('2026-09-20T12:00:00.000Z', NOW))
      .toEqual({ ok: true, at: '2026-09-20T12:00:00.000Z', atMs: NOW });
    // An offset form normalises, so the public `at` is one shape, and `atMs`
    // travels with it so the ordering check never re-parses.
    expect(normaliseStatusTimestamp('2026-09-20T08:00:00.000-04:00', NOW))
      .toEqual({ ok: true, at: '2026-09-20T12:00:00.000Z', atMs: NOW });
  });

  test('separates "not a timestamp" from "outside the window"', () => {
    // Two different bugs and two different fixes: a format bug in the runner's
    // serialiser, versus a clock or a replay. Collapsing them sends the wrong
    // message to whoever has to fix it.
    expect(normaliseStatusTimestamp('not a date', NOW)).toEqual({ ok: false, code: 'unparseable' });
    expect(normaliseStatusTimestamp('', NOW)).toEqual({ ok: false, code: 'unparseable' });
    expect(normaliseStatusTimestamp(new Date(NOW - HOUSE_TRADER_STATUS_MAX_PAST_MS - 1_000).toISOString(), NOW))
      .toEqual({ ok: false, code: 'out_of_window' });
    // A FUTURE timestamp is refused too: it is the shape a replay takes, and it
    // would drive a negative age everywhere downstream.
    expect(normaliseStatusTimestamp(new Date(NOW + HOUSE_TRADER_STATUS_MAX_FUTURE_MS + 1_000).toISOString(), NOW))
      .toEqual({ ok: false, code: 'out_of_window' });
  });

  test('the FUTURE bound is much tighter than the past bound', () => {
    // Asymmetric on purpose. A future `at` gets STORED and then rejects every
    // later report as older until the wall clock catches up, so a runner whose
    // clock ran fast and then corrected itself blacks out the board for as long
    // as this bound allows. 60 s of that is survivable; the old symmetric 10
    // minutes is the lockout Codex found.
    expect(HOUSE_TRADER_STATUS_MAX_FUTURE_MS).toBe(60_000);
    expect(HOUSE_TRADER_STATUS_MAX_PAST_MS).toBe(600_000);
    expect(normaliseStatusTimestamp(new Date(NOW + 60_000).toISOString(), NOW).ok).toBe(true);
    expect(normaliseStatusTimestamp(new Date(NOW + 60_001).toISOString(), NOW))
      .toEqual({ ok: false, code: 'out_of_window' });
    // The past side is unchanged and still generous: a slow clock or a slow
    // network is ordinary, and a replayed body is bounded by it anyway.
    expect(normaliseStatusTimestamp(new Date(NOW - 599_000).toISOString(), NOW).ok).toBe(true);
    expect(normaliseStatusTimestamp(new Date(NOW - 600_001).toISOString(), NOW))
      .toEqual({ ok: false, code: 'out_of_window' });
  });

  test('the accept window is strictly wider than the freshness window', () => {
    // Otherwise a runner whose clock is legitimately behind, but inside the
    // accept window, would land already stale and never show at all.
    expect(HOUSE_TRADER_STATUS_MAX_PAST_MS).toBeGreaterThan(HOUSE_TRADER_STATUS_MAX_AGE_MS);
  });
});

describe('the body schema', () => {
  const valid = {
    wallet: WALLET,
    canEnter: false,
    reason: 'daily_loss_floor',
    detail: 'at the floor',
    dayLossUsd: 14.95,
    dayLossCapUsd: 25,
    roomNeededUsd: 10.25,
    at: '2026-09-20T12:00:00.000Z',
  };

  test('accepts the contract body, with detail optional', () => {
    expect(houseTraderStatusBodySchema.safeParse(valid).success).toBe(true);
    const withoutDetail: Record<string, unknown> = { ...valid };
    delete withoutDetail.detail;
    expect(houseTraderStatusBodySchema.safeParse(withoutDetail).success).toBe(true);
  });

  test('is strict, so a field the server would ignore is a refusal instead', () => {
    // A dropped field is how a runner ends up believing it reported something
    // the server never saw.
    expect(houseTraderStatusBodySchema.safeParse({ ...valid, positions: 3 }).success).toBe(false);
  });

  test('refuses "cannot enter, and nothing is wrong"', () => {
    // A contradiction, not a state. Under the classification rules it would
    // fall through to `live`, so the board would print a working trader over a
    // report that says the opposite. Refused rather than mapped.
    expect(houseTraderStatusBodySchema.safeParse({ ...valid, canEnter: false, reason: 'ok' }).success)
      .toBe(false);
  });

  test('ALLOWS the mirror case, because a recovering runner really reports it', () => {
    // `canEnter: true` with the reason that held it back is the tick a runner
    // recovers on, and the frozen contract classifies it `live`. It is also how
    // a `price_feed_down` fault reaches us from a runner that still believes it
    // could enter. Refusing it would drop honest reports.
    for (const reason of ['daily_loss_floor', 'price_feed_down', 'at_max_positions'] as const) {
      expect({ reason, ok: houseTraderStatusBodySchema.safeParse({ ...valid, canEnter: true, reason }).success })
        .toEqual({ reason, ok: true });
    }
  });

  test('refuses anything the board could not render honestly', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...valid, wallet: 'not base58 0OIl' },
      { ...valid, wallet: 'short' },
      { ...valid, reason: 'made_up' },
      { ...valid, canEnter: 'false' },
      // A zero cap would make "14.95 of 0.00" the headline.
      { ...valid, dayLossCapUsd: 0 },
      { ...valid, dayLossCapUsd: -1 },
      { ...valid, dayLossUsd: -1 },
      { ...valid, roomNeededUsd: -1 },
      { ...valid, dayLossUsd: Number.NaN },
      { ...valid, dayLossUsd: Number.POSITIVE_INFINITY },
      { ...valid, detail: 'x'.repeat(HOUSE_TRADER_STATUS_DETAIL_MAX + 1) },
      { ...valid, at: '' },
    ];
    for (const body of bad) {
      expect({ body, ok: houseTraderStatusBodySchema.safeParse(body).success })
        .toEqual({ body, ok: false });
    }
  });
});

describe('the bearer credential', () => {
  test('reads a token only from a Bearer header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('  Bearer   abc123  ')).toBe('abc123');
    // RFC 7235 makes the SCHEME case-insensitive. A runner or a proxy sending
    // `bearer` is compliant, and a 401 there looks exactly like a wrong secret,
    // which is the worst error message for a problem that is not a credential.
    expect(bearerToken('bearer abc123')).toBe('abc123');
    expect(bearerToken('BEARER abc123')).toBe('abc123');
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken('abc123')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  test('compares in constant time and matches only the exact token', () => {
    expect(statusTokenMatches('s3cret', 's3cret')).toBe(true);
    expect(statusTokenMatches('s3cret', 's3crey')).toBe(false);
    // Different lengths must not throw: both sides are digested to 32 bytes
    // first, which is also what keeps the secret's length out of the timing.
    expect(statusTokenMatches('short', 'a-much-longer-secret')).toBe(false);
    expect(statusTokenMatches('', '')).toBe(true);
  });

  test('an unset, empty or whitespace secret counts as NOT CONFIGURED', () => {
    // A blank secret would make `Authorization: Bearer ` a valid credential.
    delete process.env.HOUSE_TRADER_STATUS_TOKEN;
    expect(readConfiguredStatusToken()).toBeNull();
    process.env.HOUSE_TRADER_STATUS_TOKEN = '';
    expect(readConfiguredStatusToken()).toBeNull();
    process.env.HOUSE_TRADER_STATUS_TOKEN = '   ';
    expect(readConfiguredStatusToken()).toBeNull();
    process.env.HOUSE_TRADER_STATUS_TOKEN = '  s3cret  ';
    expect(readConfiguredStatusToken()).toBe('s3cret');
  });
});
